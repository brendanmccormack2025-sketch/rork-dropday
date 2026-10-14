-- Tryal: friends (mutual, free) and 1:1 direct messages between friends (idempotent).
-- Run BEFORE migration-known-connections.sql (which adds the 'friend' branch to the known_connections view when the
-- friendships table exists; run that file again if you run this one on its own) and after migration-hide-ended.sql. Run
-- manually in the Supabase SQL editor.
--
-- There are no followers in Tryal. People become friends by
--   * an invite link: every user has a personal link whose token is SIGNED (HMAC-SHA256 over "user.version" with a secret
--     in Supabase Vault). Opening it while signed in (or after sign-up) makes both people friends at once, once.
--     Rotating the link (rotate_my_invite) kills the old one. A token cannot be forged, and it can only ever make the person
--     who opens it a friend of the person it was issued for.
--   * username search -> friend request -> accept / decline. (An adult cannot send a request to a minor: a minor, by
--     existing age_tier rules 'under_13' / 'teen', must start it or share a link.)
-- Phone contacts are NOT used here: the contacts list only lets the app offer "Invite" next to a contact. Nothing says
-- "X is on Tryal" from an unverified number.
--
-- Messages: text and shared posts, friends only, never with a blocked user (either direction). Only the two people in a
-- chat can read it (RLS), and nobody can write to the tables directly (only the functions below).
--
-- Sharing posts: a SURVIVED post (in its 24 hours) can be sent to any friend. A post still TESTING cannot be sent to anyone
-- the creator knows (known_connections: contacts either direction, the hide list, the creator's friends): rejected here, not
-- only hidden in the app. The creator may send their own testing post to their friends. Whoever opens a post from a message
-- is recorded in message_post_opens; from then on that person's views, watch time, likes and reactions never enter the
-- verdict or the exposure of that post (a trigger on the three view tables refuses their rows).
--
-- SETUP (once): the invite secret in Vault, e.g. in the SQL editor
--   select vault.create_secret('<64+ random characters>', 'tryal_invite_secret');
-- Changing it later invalidates every invite link in circulation.
--
-- Realtime: the migration adds chat_messages to the supabase_realtime publication (the app subscribes to it; RLS decides
-- who receives what).

create extension if not exists pgcrypto with schema extensions;

-- ── tables ───────────────────────────────────────────────────────────────────
create table if not exists public.friendships (
  user_a     uuid not null references auth.users(id) on delete cascade,
  user_b     uuid not null references auth.users(id) on delete cascade,
  via        text not null default 'request' check (via in ('invite', 'request')),
  created_at timestamptz not null default now(),
  primary key (user_a, user_b),
  check (user_a < user_b)                    -- one row per pair, in a fixed order
);
create index if not exists friendships_b_idx on public.friendships (user_b);

create table if not exists public.friend_requests (
  requester_id uuid not null references auth.users(id) on delete cascade,
  addressee_id uuid not null references auth.users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists friend_requests_addressee_idx on public.friend_requests (addressee_id);

create table if not exists public.invite_versions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version integer not null default 1
);

create table if not exists public.chat_conversations (
  id              uuid primary key default gen_random_uuid(),
  user_a          uuid not null references auth.users(id) on delete cascade,
  user_b          uuid not null references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  unique (user_a, user_b),
  check (user_a < user_b)
);

create table if not exists public.chat_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  sender_id       uuid not null references auth.users(id) on delete cascade,
  body            text check (body is null or char_length(body) <= 2000),
  post_id         uuid references public.posts(id) on delete set null,
  was_post        boolean not null default false,          -- a shared post that was later deleted still says "This post isn't available"
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);
create index if not exists chat_messages_conv_idx on public.chat_messages (conversation_id, created_at desc);

create table if not exists public.chat_reads (
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  last_read_at    timestamptz not null default 'epoch',
  primary key (conversation_id, user_id)
);

-- who opened a post from a message (their views, likes and reactions never count for it)
create table if not exists public.message_post_opens (
  post_id    uuid not null references public.posts(id) on delete cascade,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  message_id uuid references public.chat_messages(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);

alter table public.friendships enable row level security;
alter table public.friend_requests enable row level security;
alter table public.invite_versions enable row level security;
alter table public.chat_conversations enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_reads enable row level security;
alter table public.message_post_opens enable row level security;
revoke all on table public.friendships, public.friend_requests, public.invite_versions, public.chat_conversations,
  public.chat_messages, public.chat_reads, public.message_post_opens from anon, authenticated;

-- ── notifications and reports learn the new values (existing values are kept) ─
do $$
declare
  c record;
begin
  if to_regclass('public.notifications') is not null then
    for c in
      select conname from pg_constraint
      where conrelid = 'public.notifications'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%verdict_survived%'
    loop
      execute format('alter table public.notifications drop constraint %I', c.conname);
    end loop;
    alter table public.notifications
      add constraint notifications_type_check
      check (type in ('like', 'reaction', 'follow', 'follow_request', 'follow_accept',
                      'verdict_survived', 'verdict_archived', 'verdict_incomplete', 'followed_post_survived',
                      'friend_request', 'friend_accept', 'message'));
  end if;
  if to_regclass('public.reports') is not null then
    for c in
      select conname from pg_constraint
      where conrelid = 'public.reports'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%target_type%'
    loop
      execute format('alter table public.reports drop constraint %I', c.conname);
    end loop;
    alter table public.reports
      add constraint reports_target_type_check check (target_type in ('post', 'reaction', 'message'));
  end if;
end $$;
create unique index if not exists notif_one_unread_message
  on public.notifications (recipient_id, actor_id) where type = 'message' and read is not true;

-- ── internals (not callable by apps) ─────────────────────────────────────────
create or replace function public.friends_blocked(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = p_a and b.blocked_id = p_b) or (b.blocker_id = p_b and b.blocked_id = p_a)
  )
$$;

create or replace function public.friends_are(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.friendships f where f.user_a = least(p_a, p_b) and f.user_b = greatest(p_a, p_b))
$$;

-- under 18 by the existing rules (age_tier: 'under_13' / 'teen'; no birthdate counts as adult, as everywhere else)
create or replace function public.friends_is_minor(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select public.age_tier(pr.birthdate) in ('under_13', 'teen') from public.profiles pr where pr.id = p_user), false)
$$;

create or replace function public.friends_notify(p_to uuid, p_actor uuid, p_type text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_type = 'message' then
    insert into public.notifications (recipient_id, actor_id, type) values (p_to, p_actor, p_type)
    on conflict (recipient_id, actor_id) where type = 'message' and read is not true do nothing;
  else
    insert into public.notifications (recipient_id, actor_id, type) values (p_to, p_actor, p_type);
  end if;
exception when others then
  null;   -- a notification problem must never block a friendship or a message
end;
$$;

create or replace function public.friends_make(p_a uuid, p_b uuid, p_via text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  insert into public.friendships (user_a, user_b, via) values (least(p_a, p_b), greatest(p_a, p_b), p_via)
  on conflict do nothing;
  get diagnostics n = row_count;
  delete from public.friend_requests
   where (requester_id = p_a and addressee_id = p_b) or (requester_id = p_b and addressee_id = p_a);
  return n > 0;
end;
$$;

create or replace function public.friends_secret()
returns text
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'tryal_invite_secret' limit 1;
  if s is null or length(s) < 16 then
    raise exception 'invite secret is not configured' using errcode = '55000';
  end if;
  return s;
end;
$$;

create or replace function public.friends_sign(p_user uuid, p_version integer)
returns text
language sql
stable
security definer
set search_path = public, extensions
as $$
  select left(encode(hmac(replace(p_user::text, '-', '') || '.' || p_version::text, public.friends_secret(), 'sha256'), 'hex'), 32)
$$;

-- ── invite links ─────────────────────────────────────────────────────────────
-- token = <user id without dashes>.<version>.<32 hex signature>
create or replace function public.my_invite_token()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v integer;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into public.invite_versions (user_id) values (auth.uid()) on conflict do nothing;
  select version into v from public.invite_versions where user_id = auth.uid();
  return replace(auth.uid()::text, '-', '') || '.' || v::text || '.' || public.friends_sign(auth.uid(), v);
end;
$$;

-- A new link; the old one stops working.
create or replace function public.rotate_my_invite()
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into public.invite_versions (user_id, version) values (auth.uid(), 2)
  on conflict (user_id) do update set version = public.invite_versions.version + 1;
  return public.my_invite_token();
end;
$$;

-- Returns the inviter's id. Friends at once and once (opening it again changes nothing).
create or replace function public.redeem_invite(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  parts text[];
  inviter uuid;
  v integer;
  cur integer;
  made boolean;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_token is null or length(p_token) > 120 or p_token !~ '^[0-9a-f]{32}\.[0-9]{1,6}\.[0-9a-f]{32}$' then
    raise exception 'invalid invite' using errcode = '22023';
  end if;
  parts := string_to_array(p_token, '.');
  inviter := (substr(parts[1], 1, 8) || '-' || substr(parts[1], 9, 4) || '-' || substr(parts[1], 13, 4) || '-' || substr(parts[1], 17, 4) || '-' || substr(parts[1], 21, 12))::uuid;
  v := parts[2]::integer;
  -- the signature must match what this server would sign (never leaks which part was wrong)
  if public.friends_sign(inviter, v) <> parts[3] then
    raise exception 'invalid invite' using errcode = '22023';
  end if;
  select version into cur from public.invite_versions where user_id = inviter;
  if v <> coalesce(cur, 1) then
    raise exception 'invalid invite' using errcode = '22023';       -- an old link (rotated)
  end if;
  if not exists (select 1 from auth.users where id = inviter) then
    raise exception 'invalid invite' using errcode = '22023';
  end if;
  if inviter = auth.uid() then
    raise exception 'that is your own invite' using errcode = '22023';
  end if;
  if public.friends_blocked(inviter, auth.uid()) then
    raise exception 'invalid invite' using errcode = '22023';
  end if;
  made := public.friends_make(inviter, auth.uid(), 'invite');
  if made then
    perform public.friends_notify(inviter, auth.uid(), 'friend_accept');
  end if;
  return inviter;
end;
$$;

-- ── friend requests ──────────────────────────────────────────────────────────
create or replace function public.send_friend_request(p_to uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_to is null or p_to = me or not exists (select 1 from public.profiles where id = p_to) then
    raise exception 'cannot send a request to that person' using errcode = '22023';
  end if;
  if public.friends_blocked(me, p_to) then
    raise exception 'cannot send a request to that person' using errcode = '42501';
  end if;
  if public.friends_are(me, p_to) then return 'friends'; end if;
  -- an adult cannot start a friendship with a minor; the minor starts it (or shares a link)
  if public.friends_is_minor(p_to) and not public.friends_is_minor(me) then
    raise exception 'cannot send a request to that person' using errcode = '42501';
  end if;
  -- they already asked me: that is a yes
  if exists (select 1 from public.friend_requests where requester_id = p_to and addressee_id = me) then
    perform public.friends_make(me, p_to, 'request');
    perform public.friends_notify(p_to, me, 'friend_accept');
    return 'friends';
  end if;
  insert into public.friend_requests (requester_id, addressee_id) values (me, p_to) on conflict do nothing;
  perform public.friends_notify(p_to, me, 'friend_request');
  return 'requested';
end;
$$;

create or replace function public.respond_friend_request(p_from uuid, p_accept boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if not exists (select 1 from public.friend_requests where requester_id = p_from and addressee_id = me) then
    raise exception 'no such request' using errcode = '22023';
  end if;
  if p_accept and not public.friends_blocked(me, p_from) then
    perform public.friends_make(me, p_from, 'request');
    perform public.friends_notify(p_from, me, 'friend_accept');
  else
    delete from public.friend_requests where requester_id = p_from and addressee_id = me;
  end if;
end;
$$;

create or replace function public.cancel_friend_request(p_to uuid)
returns void
language sql
security definer
set search_path = public
as $$ delete from public.friend_requests where requester_id = auth.uid() and addressee_id = p_to $$;

create or replace function public.remove_friend(p_other uuid)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.friendships where user_a = least(auth.uid(), p_other) and user_b = greatest(auth.uid(), p_other)
$$;

-- Username search: prefix match, never yourself, never someone blocked either way, never under 13.
create or replace function public.search_people(p_query text)
returns table (id uuid, username text, display_name text, avatar_url text, relation text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.avatar_url,
         case when public.friends_are(auth.uid(), p.id) then 'friend'
              when exists (select 1 from public.friend_requests r where r.requester_id = auth.uid() and r.addressee_id = p.id) then 'requested'
              when exists (select 1 from public.friend_requests r where r.requester_id = p.id and r.addressee_id = auth.uid()) then 'incoming'
              else 'none' end
  from public.profiles p
  where auth.uid() is not null
    and length(btrim(p_query)) >= 2
    and p.username ilike replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and p.id <> auth.uid()
    and not public.friends_blocked(auth.uid(), p.id)
    and coalesce(public.age_tier(p.birthdate), 'unknown') <> 'under_13'
  order by p.username
  limit 20
$$;

create or replace function public.my_friends()
returns table (id uuid, username text, display_name text, avatar_url text, since timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.avatar_url, f.created_at
  from public.friendships f
  join public.profiles p on p.id = case when f.user_a = auth.uid() then f.user_b else f.user_a end
  where auth.uid() in (f.user_a, f.user_b) and not public.friends_blocked(auth.uid(), p.id)
  order by p.username
$$;

create or replace function public.my_friend_requests()
returns table (id uuid, username text, display_name text, avatar_url text, direction text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.username, p.display_name, p.avatar_url,
         case when r.addressee_id = auth.uid() then 'incoming' else 'outgoing' end, r.created_at
  from public.friend_requests r
  join public.profiles p on p.id = case when r.addressee_id = auth.uid() then r.requester_id else r.addressee_id end
  where auth.uid() in (r.requester_id, r.addressee_id) and not public.friends_blocked(auth.uid(), p.id)
  order by r.created_at desc
$$;

-- ── conversations and messages ───────────────────────────────────────────────
-- The caller's conversation with a friend (made on demand). Friends only, never a blocked person.
create or replace function public.chat_conversation_for(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_other is null or p_other = me or not public.friends_are(me, p_other) then
    raise exception 'you can only message friends' using errcode = '42501';
  end if;
  if public.friends_blocked(me, p_other) then
    raise exception 'you cannot message this person' using errcode = '42501';
  end if;
  insert into public.chat_conversations (user_a, user_b) values (least(me, p_other), greatest(me, p_other))
  on conflict (user_a, user_b) do nothing;
  select id into cid from public.chat_conversations where user_a = least(me, p_other) and user_b = greatest(me, p_other);
  return cid;
end;
$$;

create or replace function public.send_message(p_to uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
  mid uuid;
  txt text := btrim(coalesce(p_body, ''));
begin
  if txt = '' or char_length(txt) > 2000 then
    raise exception 'a message needs 1 to 2000 characters' using errcode = '22023';
  end if;
  cid := public.chat_conversation_for(p_to);
  insert into public.chat_messages (conversation_id, sender_id, body) values (cid, auth.uid(), txt) returning id into mid;
  update public.chat_conversations set last_message_at = now() where id = cid;
  perform public.friends_notify(p_to, auth.uid(), 'message');
  return mid;
end;
$$;

-- Can this post be shown to this person through a message right now? (also decides "This post isn't available")
create or replace function public.chat_post_available(p_post_id uuid, p_recipient uuid, p_sender uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.parent_post_id is null
      and p.moderation_status = 'active'
      and (
        -- survived and inside its 24 hours: any friend
        (p.status = 'survived' and p.distribution_expires_at > now())
        or
        -- still testing: only to people the creator does not know; the creator may send it to their own friends
        (p.status = 'trial' and (
           p.user_id = p_sender
           or p.user_id = p_recipient
           or not exists (select 1 from public.known_connections k where k.user_id = p.user_id and k.other_id = p_recipient)
        ))
      )
  );
end;
$$;

-- THE rule for sending a post to a person (used by send_post_to_friend and by friends_for_post, so what the app shows and
-- what the server accepts cannot differ). Does not check friendship or blocks between sender and recipient.
create or replace function public.chat_can_send_post(p_post_id uuid, p_sender uuid, p_to uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p record;
begin
  select * into p from public.posts where id = p_post_id;
  if not found or p.parent_post_id is not null or p.moderation_status <> 'active' then return false; end if;
  if p.is_mature and public.friends_is_minor(p_to) then return false; end if;
  if p.status = 'survived' and p.distribution_expires_at > now() then
    return true;                                                -- a survived post: any friend
  elsif p.status = 'trial' then
    if p.user_id = p_sender then return true; end if;           -- the creator, to their own friends
    if p.user_id = p_to then return false; end if;
    if not public.trial_exposed(p.id, p_sender) then return false; end if;                 -- no guessing of ids
    if public.friends_blocked(p.user_id, p_to) then return false; end if;
    -- the creator's known people (contacts either direction, hide list, friends) never get it before it survives
    return not exists (select 1 from public.known_connections k where k.user_id = p.user_id and k.other_id = p_to);
  end if;
  return false;
end;
$$;

create or replace function public.send_post_to_friend(p_to uuid, p_post_id uuid, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cid uuid;
  mid uuid;
  note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if note is not null and char_length(note) > 2000 then
    raise exception 'that note is too long' using errcode = '22023';
  end if;
  cid := public.chat_conversation_for(p_to);                    -- friends only, not blocked
  if not public.chat_can_send_post(p_post_id, me, p_to) then
    raise exception 'this post cannot be sent to that person' using errcode = '42501';
  end if;
  insert into public.chat_messages (conversation_id, sender_id, body, post_id, was_post) values (cid, me, note, p_post_id, true) returning id into mid;
  update public.chat_conversations set last_message_at = now() where id = cid;
  perform public.friends_notify(p_to, me, 'message');
  return mid;
end;
$$;

-- The friends this post may be sent to: the list "Send to friend" shows. People the creator knows are simply not in it.
create or replace function public.friends_for_post(p_post_id uuid)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  select f.id, f.username, f.display_name, f.avatar_url
  from public.my_friends() f
  where auth.uid() is not null and public.chat_can_send_post(p_post_id, auth.uid(), f.id)
$$;

create or replace function public.delete_my_message(p_message_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.chat_messages set deleted_at = now(), body = null, post_id = null
   where id = p_message_id and sender_id = auth.uid() and deleted_at is null
$$;

create or replace function public.report_message(p_message_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select cm.*, c.user_a, c.user_b into m from public.chat_messages cm join public.chat_conversations c on c.id = cm.conversation_id where cm.id = p_message_id;
  if not found or auth.uid() not in (m.user_a, m.user_b) or m.sender_id = auth.uid() then
    raise exception 'cannot report this message' using errcode = '42501';
  end if;
  insert into public.reports (reporter_id, target_type, target_id, reason)
  values (auth.uid(), 'message', p_message_id, case when p_reason in ('spam', 'harassment', 'nudity', 'other') then p_reason else 'other' end)
  on conflict (reporter_id, target_type, target_id) do nothing;
end;
$$;

create or replace function public.mark_conversation_read(p_other uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  select id into cid from public.chat_conversations
   where user_a = least(auth.uid(), p_other) and user_b = greatest(auth.uid(), p_other);
  if cid is null then return; end if;
  insert into public.chat_reads (conversation_id, user_id, last_read_at) values (cid, auth.uid(), now())
  on conflict (conversation_id, user_id) do update set last_read_at = now();
  update public.notifications set read = true where recipient_id = auth.uid() and actor_id = p_other and type = 'message' and read is not true;
end;
$$;

create or replace function public.my_conversations()
returns table (other_id uuid, username text, display_name text, avatar_url text, last_text text, last_was_post boolean,
               last_at timestamptz, unread integer)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.username, o.display_name, o.avatar_url,
         lm.body, coalesce(lm.was_post, false), c.last_message_at,
         (select count(*)::integer from public.chat_messages m
           where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.deleted_at is null
             and m.created_at > coalesce((select r.last_read_at from public.chat_reads r where r.conversation_id = c.id and r.user_id = auth.uid()), 'epoch'))
  from public.chat_conversations c
  join public.profiles o on o.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  left join lateral (
    select m.body, m.was_post from public.chat_messages m
     where m.conversation_id = c.id and m.deleted_at is null order by m.created_at desc limit 1
  ) lm on true
  where auth.uid() in (c.user_a, c.user_b)
    and public.friends_are(c.user_a, c.user_b)
    and not public.friends_blocked(c.user_a, c.user_b)
    and lm.was_post is not null
  order by c.last_message_at desc
$$;

create or replace function public.my_unread_messages()
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(unread), 0)::integer from public.my_conversations()
$$;

-- The caller opens the post of a message. Whether it is still available is decided here, at the time of opening.
-- The open is recorded (message_post_opens): from then on this person's views of that post never count for it.
create or replace function public.open_shared_post(p_message_id uuid)
returns table (post_id uuid, available boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  ok boolean;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select cm.id, cm.sender_id, cm.post_id as pid, cm.deleted_at, c.user_a, c.user_b into m
    from public.chat_messages cm join public.chat_conversations c on c.id = cm.conversation_id where cm.id = p_message_id;
  if not found or auth.uid() not in (m.user_a, m.user_b) or public.friends_blocked(m.user_a, m.user_b) then
    raise exception 'message not found' using errcode = '42501';
  end if;
  if m.pid is null or m.deleted_at is not null then
    return query select null::uuid, false;
    return;
  end if;
  ok := public.chat_post_available(m.pid, auth.uid(), m.sender_id);
  if ok then
    insert into public.message_post_opens (post_id, viewer_id, message_id) values (m.pid, auth.uid(), p_message_id)
    on conflict do nothing;
  end if;
  return query select m.pid, ok;
end;
$$;

-- ── message-sourced views never count ───────────────────────────────────────────
-- BEFORE INSERT on the three view tables: a row for (post, viewer) is refused when that viewer opened the post from a
-- message. Whatever function or client writes it, they never become a viewer of the post, so their watch time, likes and
-- reactions have no viewer row to attach to in the verdict, and they never count as exposed.
create or replace function public.message_sourced_view_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.message_post_opens o where o.post_id = new.post_id and o.viewer_id = new.viewer_id) then
    return null;
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['post_raw_views', 'post_qualified_views', 'post_view_stats'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists trg_message_sourced_view_guard on public.%I', t);
      execute format('create trigger trg_message_sourced_view_guard before insert on public.%I for each row execute function public.message_sourced_view_guard()', t);
    end if;
  end loop;
end $$;

-- ── RLS: only the two people of a chat read it ──────────────────────────────────
create or replace function public.chat_can_read(p_conversation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.chat_conversations c
    where c.id = p_conversation_id and auth.uid() in (c.user_a, c.user_b)
      and not public.friends_blocked(c.user_a, c.user_b)
  )
$$;

drop policy if exists friendships_select on public.friendships;
create policy friendships_select on public.friendships for select to authenticated using (auth.uid() in (user_a, user_b));
drop policy if exists friend_requests_select on public.friend_requests;
create policy friend_requests_select on public.friend_requests for select to authenticated using (auth.uid() in (requester_id, addressee_id));
drop policy if exists chat_conversations_select on public.chat_conversations;
create policy chat_conversations_select on public.chat_conversations for select to authenticated using (public.chat_can_read(id));
drop policy if exists chat_messages_select on public.chat_messages;
create policy chat_messages_select on public.chat_messages for select to authenticated using (public.chat_can_read(conversation_id));
drop policy if exists chat_reads_select on public.chat_reads;
create policy chat_reads_select on public.chat_reads for select to authenticated using (user_id = auth.uid());
grant select on table public.friendships, public.friend_requests, public.chat_conversations, public.chat_messages, public.chat_reads to authenticated;

-- ── Realtime ─────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages') then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ── friends are known people ────────────────────────────────────────────────────
-- known_connections gets its 'friend' branch from migration-known-connections.sql, which runs after this file (it adds the
-- branch when this table exists). If you run this file on its own, run migration-known-connections.sql again afterwards.


-- ── who may call what ────────────────────────────────────────────────────────────
revoke all on function
  public.friends_blocked(uuid, uuid), public.friends_are(uuid, uuid), public.friends_is_minor(uuid),
  public.friends_notify(uuid, uuid, text), public.friends_make(uuid, uuid, text), public.friends_secret(),
  public.friends_sign(uuid, integer), public.chat_post_available(uuid, uuid, uuid), public.chat_can_send_post(uuid, uuid, uuid),
  public.message_sourced_view_guard()
  from public, anon, authenticated;
revoke all on function
  public.my_invite_token(), public.rotate_my_invite(), public.redeem_invite(text), public.send_friend_request(uuid),
  public.respond_friend_request(uuid, boolean), public.cancel_friend_request(uuid), public.remove_friend(uuid),
  public.search_people(text), public.my_friends(), public.my_friend_requests(), public.chat_conversation_for(uuid),
  public.send_message(uuid, text), public.send_post_to_friend(uuid, uuid, text), public.delete_my_message(uuid),
  public.report_message(uuid, text), public.mark_conversation_read(uuid), public.my_conversations(),
  public.my_unread_messages(), public.open_shared_post(uuid), public.chat_can_read(uuid), public.friends_for_post(uuid)
  from public, anon;
grant execute on function
  public.my_invite_token(), public.rotate_my_invite(), public.redeem_invite(text), public.send_friend_request(uuid),
  public.respond_friend_request(uuid, boolean), public.cancel_friend_request(uuid), public.remove_friend(uuid),
  public.search_people(text), public.my_friends(), public.my_friend_requests(), public.chat_conversation_for(uuid),
  public.send_message(uuid, text), public.send_post_to_friend(uuid, uuid, text), public.delete_my_message(uuid),
  public.report_message(uuid, text), public.mark_conversation_read(uuid), public.my_conversations(),
  public.my_unread_messages(), public.open_shared_post(uuid), public.chat_can_read(uuid), public.friends_for_post(uuid)
  to authenticated;
