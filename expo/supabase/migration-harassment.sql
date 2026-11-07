-- Tryal harassment protection (Phase 3). Idempotent; run after migration-spotlight.sql (it is last in MIGRATIONS_ORDER.txt).
--
-- Everything is enforced in the database, on the tables every path writes to (so no client, old or new, can go around it):
--   * WORD FILTER   an admin-managed block-list (word_filter_terms), checked by BEFORE triggers on chat_messages.body (DMs) and
--                   posts.caption / posts.text_overlays (captions). Matching ignores case, punctuation and look-alike characters
--                   (0/o, 1/i/l, 3/e, 4/a, 5/s/$, 7/t, 8/b, @/a) and letters spaced out (k y s) and whole words / phrases only. A hit raises a generic error that does
--                   not name the term.
--   * UNWANTED CONTACT   harassment_flags: many messages without a reply (flag at unanswered_flag_after; refused from
--                   unanswered_limit until the other person replies), messaging while blocked by several people, and a user whose
--                   reactions one creator keeps removing.
--   * CREATOR CONTROLS   who may DM me (dm_policy: friends | friends_7d | nobody), remove a reaction on my post (with its replies),
--                   limit interactions on one post (open | established | closed).
--   * REVIEW QUEUE  owner-only (the spotlight_admins list): reports (post, reaction, message), flags and the word list.
-- The existing reports, blocks and the 3-reports auto-hide are untouched.

-- ── 1. configuration and tables ───────────────────────────────────────────────────────
create table if not exists public.harassment_config (
  id                      boolean primary key default true check (id),
  unanswered_flag_after   integer not null default 8,
  unanswered_limit        integer not null default 20,
  unanswered_window_hours integer not null default 72,
  blocked_by_threshold    integer not null default 3,
  removal_flag_after      integer not null default 3,
  removal_window_days     integer not null default 30,
  new_account_days        integer not null default 7,
  friend_min_days         integer not null default 7
);
insert into public.harassment_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.word_filter_terms (
  term       text primary key,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.harassment_flags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  target_id  uuid,
  kind       text not null check (kind in ('unanswered_messages', 'blocked_by_many', 'removed_reactions')),
  detail     jsonb not null default '{}'::jsonb,
  status     text not null default 'open' check (status in ('open', 'reviewed', 'dismissed')),
  created_at timestamptz not null default now()
);
create index if not exists harassment_flags_status_idx on public.harassment_flags (status, created_at desc);
create index if not exists harassment_flags_user_idx on public.harassment_flags (user_id, kind, created_at desc);

create table if not exists public.creator_controls (
  user_id    uuid primary key,
  dm_policy  text not null default 'friends' check (dm_policy in ('friends', 'friends_7d', 'nobody')),
  updated_at timestamptz not null default now()
);

create table if not exists public.post_interaction_limits (
  post_id    uuid primary key references public.posts (id) on delete cascade,
  creator_id uuid not null,
  mode       text not null check (mode in ('established', 'closed')),
  updated_at timestamptz not null default now()
);

create table if not exists public.reaction_removals (
  reaction_id uuid primary key references public.posts (id) on delete cascade,
  root_post_id uuid not null,
  creator_id  uuid not null,
  reactor_id  uuid not null,
  created_at  timestamptz not null default now()
);
create index if not exists reaction_removals_idx on public.reaction_removals (creator_id, reactor_id, created_at desc);

alter table public.harassment_config enable row level security;
alter table public.word_filter_terms enable row level security;
alter table public.harassment_flags enable row level security;
alter table public.creator_controls enable row level security;
alter table public.post_interaction_limits enable row level security;
alter table public.reaction_removals enable row level security;
revoke all on table public.harassment_config, public.word_filter_terms, public.harassment_flags, public.creator_controls,
  public.post_interaction_limits, public.reaction_removals from anon, authenticated;

-- ── 2. the word filter ────────────────────────────────────────────────────────────────
-- lower case, look-alike characters folded, everything that is not a letter or digit becomes one space
create or replace function public.text_normalize(p_text text)
returns text
language sql
immutable
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_text, '')), '013457@$l8', 'oieastaasib'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

-- a run of single characters ("k y s", "k.y.s") joined into one word, so spacing out the letters does not get around the list
create or replace function public.text_join_singles(p_norm text)
returns text
language plpgsql
immutable
as $$
declare
  tok text;
  buf text := '';
  out_t text := '';
begin
  foreach tok in array string_to_array(p_norm, ' ') loop
    if char_length(tok) = 1 then
      buf := buf || tok;
    else
      if buf <> '' then out_t := out_t || ' ' || buf; buf := ''; end if;
      out_t := out_t || ' ' || tok;
    end if;
  end loop;
  if buf <> '' then out_t := out_t || ' ' || buf; end if;
  return btrim(out_t);
end;
$$;

-- the first block-listed term found in the text (whole words / phrases), or null
create or replace function public.text_blocked_term(p_text text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  norm text := public.text_normalize(p_text);
  hay text := ' ' || norm || ' ';
  hay2 text := ' ' || public.text_join_singles(norm) || ' ';
  t record;
  nt text;
begin
  if norm = '' then return null; end if;
  for t in select w.term from public.word_filter_terms w loop
    nt := ' ' || public.text_normalize(t.term) || ' ';
    if strpos(hay, nt) > 0 or strpos(hay2, nt) > 0 then return t.term; end if;
  end loop;
  return null;
end;
$$;

-- raises the same generic error whatever the term is (the list cannot be probed one word at a time)
create or replace function public.text_check(p_text text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if p_text is not null and p_text <> '' and public.text_blocked_term(p_text) is not null then
    raise exception 'This contains words that are not allowed on Tryal.' using errcode = '22023';
  end if;
end;
$$;

-- starter list: threats only; the owner adds and removes terms in the admin screen
insert into public.word_filter_terms (term) values ('kill yourself'), ('kys'), ('go die') on conflict do nothing;

create or replace function public.posts_text_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare o jsonb;
begin
  if tg_op = 'INSERT' or new.caption is distinct from old.caption then
    perform public.text_check(new.caption);
  end if;
  if (tg_op = 'INSERT' or new.text_overlays is distinct from old.text_overlays)
     and new.text_overlays is not null and jsonb_typeof(new.text_overlays) = 'array' then
    for o in select * from jsonb_array_elements(new.text_overlays) loop
      if jsonb_typeof(o) = 'object' then perform public.text_check(o ->> 'text'); end if;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists zzz_posts_text_guard on public.posts;
create trigger zzz_posts_text_guard before insert or update of caption, text_overlays on public.posts
  for each row execute function public.posts_text_guard();

-- ── 3. unwanted contact: the guard on every message, and the flags ───────────────────────
create or replace function public.harassment_unanswered(p_conversation uuid, p_sender uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::integer
  from public.chat_messages m
  where m.conversation_id = p_conversation and m.sender_id = p_sender and m.deleted_at is null
    and m.created_at > now() - ((select unanswered_window_hours from public.harassment_config where id) * interval '1 hour')
    and m.created_at > coalesce((select max(r.created_at) from public.chat_messages r where r.conversation_id = p_conversation and r.sender_id <> p_sender), 'epoch'::timestamptz)
$$;

create or replace function public.harassment_flag(p_user uuid, p_target uuid, p_kind text, p_detail jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- one open flag per (user, target, kind) per day: the queue is not flooded
  if exists (select 1 from public.harassment_flags f
              where f.user_id = p_user and f.kind = p_kind and f.target_id is not distinct from p_target
                and f.status = 'open' and f.created_at > now() - interval '24 hours') then return; end if;
  insert into public.harassment_flags (user_id, target_id, kind, detail) values (p_user, p_target, p_kind, coalesce(p_detail, '{}'::jsonb));
end;
$$;

create or replace function public.chat_messages_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_conversations;
  other uuid;
  cfg public.harassment_config;
  pol text;
  since timestamptz;
begin
  select * into c from public.chat_conversations where id = new.conversation_id;
  if not found then return new; end if;
  other := case when c.user_a = new.sender_id then c.user_b else c.user_a end;
  select * into cfg from public.harassment_config where id;
  -- 1. the words
  perform public.text_check(new.body);
  -- 2. who may message the recipient
  select dm_policy into pol from public.creator_controls where user_id = other;
  if pol = 'nobody' then
    raise exception 'This person is not taking messages right now.' using errcode = '42501';
  elsif pol = 'friends_7d' then
    select created_at into since from public.friendships where user_a = least(new.sender_id, other) and user_b = greatest(new.sender_id, other);
    if since is null or since > now() - (cfg.friend_min_days * interval '1 day') then
      raise exception 'This person only takes messages from people who have been friends for % days.', cfg.friend_min_days using errcode = '42501';
    end if;
  end if;
  -- 3. no endless one-sided messaging
  if public.harassment_unanswered(new.conversation_id, new.sender_id) >= cfg.unanswered_limit then
    raise exception 'Wait for a reply before sending more.' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists trg_chat_messages_guard on public.chat_messages;
create trigger trg_chat_messages_guard before insert on public.chat_messages
  for each row execute function public.chat_messages_guard();

create or replace function public.chat_messages_flags()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_conversations;
  other uuid;
  cfg public.harassment_config;
  n integer;
  blockers integer;
begin
  select * into c from public.chat_conversations where id = new.conversation_id;
  if not found then return new; end if;
  other := case when c.user_a = new.sender_id then c.user_b else c.user_a end;
  select * into cfg from public.harassment_config where id;
  n := public.harassment_unanswered(new.conversation_id, new.sender_id);
  if n >= cfg.unanswered_flag_after then
    perform public.harassment_flag(new.sender_id, other, 'unanswered_messages', jsonb_build_object('messages', n, 'conversation_id', new.conversation_id));
  end if;
  select count(distinct b.blocker_id)::integer into blockers from public.user_blocks b where b.blocked_id = new.sender_id;
  if blockers >= cfg.blocked_by_threshold then
    perform public.harassment_flag(new.sender_id, null, 'blocked_by_many', jsonb_build_object('blocked_by', blockers));
  end if;
  return new;
end;
$$;
drop trigger if exists trg_chat_messages_flags on public.chat_messages;
create trigger trg_chat_messages_flags after insert on public.chat_messages
  for each row execute function public.chat_messages_flags();

-- ── 4. creator controls ───────────────────────────────────────────────────────────────
-- the root post of a post or reaction (walks up parent_post_id)
create or replace function public.root_post_of(p_post uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  with recursive up as (
    select id, parent_post_id, 0 as depth from public.posts where id = p_post
    union all
    select p.id, p.parent_post_id, up.depth + 1 from public.posts p join up on p.id = up.parent_post_id where up.depth < 50
  )
  select id from up where parent_post_id is null limit 1
$$;

create or replace function public.my_controls()
returns table (dm_policy text)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.dm_policy from public.creator_controls c where c.user_id = auth.uid()), 'friends')
$$;

create or replace function public.set_dm_policy(p_policy text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_policy not in ('friends', 'friends_7d', 'nobody') then raise exception 'unknown policy'; end if;
  insert into public.creator_controls (user_id, dm_policy) values (auth.uid(), p_policy)
  on conflict (user_id) do update set dm_policy = excluded.dm_policy, updated_at = now();
end;
$$;

create or replace function public.my_post_interaction_mode(p_post uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select l.mode from public.post_interaction_limits l
                    join public.posts p on p.id = l.post_id
                   where l.post_id = p_post and p.user_id = auth.uid()), 'open')
$$;

-- only the creator of a ROOT post; 'open' removes the limit
create or replace function public.set_post_interactions(p_post uuid, p_mode text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_mode not in ('open', 'established', 'closed') then raise exception 'unknown mode'; end if;
  if not exists (select 1 from public.posts p where p.id = p_post and p.user_id = auth.uid() and p.parent_post_id is null) then
    raise exception 'only the creator of a post can limit it' using errcode = '42501';
  end if;
  if p_mode = 'open' then
    delete from public.post_interaction_limits where post_id = p_post;
  else
    insert into public.post_interaction_limits (post_id, creator_id, mode) values (p_post, auth.uid(), p_mode)
    on conflict (post_id) do update set mode = excluded.mode, updated_at = now();
  end if;
end;
$$;

-- may this person like / react to this post right now? (the creator always may)
create or replace function public.interaction_check(p_user uuid, p_post uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  root uuid := public.root_post_of(p_post);
  lim public.post_interaction_limits;
  cfg public.harassment_config;
  joined timestamptz;
begin
  if root is null then return; end if;
  select * into lim from public.post_interaction_limits where post_id = root;
  if not found or lim.creator_id = p_user then return; end if;
  if lim.mode = 'closed' then
    raise exception 'Interactions are limited on this post.' using errcode = '42501';
  end if;
  select * into cfg from public.harassment_config where id;
  select created_at into joined from public.profiles where id = p_user;
  if joined is not null and joined > now() - (cfg.new_account_days * interval '1 day') then
    raise exception 'Interactions are limited on this post.' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.likes_interaction_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.interaction_check(new.user_id, new.post_id);
  return new;
end;
$$;
drop trigger if exists zzz_likes_interaction_guard on public.likes;
create trigger zzz_likes_interaction_guard before insert on public.likes
  for each row execute function public.likes_interaction_guard();

create or replace function public.reactions_interaction_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_post_id is not null then perform public.interaction_check(new.user_id, new.parent_post_id); end if;
  return new;
end;
$$;
drop trigger if exists zzz_reactions_interaction_guard on public.posts;
create trigger zzz_reactions_interaction_guard before insert on public.posts
  for each row execute function public.reactions_interaction_guard();

-- the creator of a post removes a reaction on it (with every reply under it). The reactor is not told.
create or replace function public.remove_reaction_on_my_post(p_reaction uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  r public.posts;
  root uuid;
  cfg public.harassment_config;
  n integer;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  select * into r from public.posts where id = p_reaction;
  if not found or r.parent_post_id is null then raise exception 'not a reaction' using errcode = '42501'; end if;
  root := public.root_post_of(p_reaction);
  if root is null or not exists (select 1 from public.posts p where p.id = root and p.user_id = me) or r.user_id = me then
    raise exception 'you can only remove reactions on your own post' using errcode = '42501';
  end if;
  insert into public.reaction_removals (reaction_id, root_post_id, creator_id, reactor_id) values (p_reaction, root, me, r.user_id)
  on conflict (reaction_id) do nothing;
  -- the reaction and everything under it leaves the post
  with recursive sub as (
    select id from public.posts where id = p_reaction
    union all
    select p.id from public.posts p join sub on p.parent_post_id = sub.id
  )
  update public.posts set moderation_status = 'hidden' where id in (select id from sub) and moderation_status = 'active';
  delete from public.notifications where type = 'reaction' and actor_id = r.user_id and recipient_id = me and post_id in (p_reaction, root);
  select * into cfg from public.harassment_config where id;
  select count(*)::integer into n from public.reaction_removals x
   where x.creator_id = me and x.reactor_id = r.user_id and x.created_at > now() - (cfg.removal_window_days * interval '1 day');
  if n >= cfg.removal_flag_after then
    perform public.harassment_flag(r.user_id, me, 'removed_reactions', jsonb_build_object('removed', n));
  end if;
end;
$$;

-- ── 5. the review queue (owner only: the spotlight_admins list) ────────────────────────────
create or replace function public.mod_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.spotlight_is_admin()
$$;

create or replace function public.admin_reports_queue(p_status text default 'pending', p_limit integer default 50)
returns table (report_id uuid, target_type text, target_id uuid, reason text, status text, created_at timestamptz,
               reporter_username text, reported_user_id uuid, reported_username text, preview text, thumbnail_url text, report_count integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select r.id, r.target_type::text, r.target_id, r.reason::text, r.status::text, r.created_at,
         rp.username::text,
         coalesce(p.user_id, m.sender_id),
         up.username::text,
         left(coalesce(p.caption, m.body, ''), 300),
         p.thumbnail_url::text,
         (select count(*)::integer from public.reports x where x.target_type = r.target_type and x.target_id = r.target_id)
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts p on r.target_type in ('post', 'reaction') and p.id = r.target_id
  left join public.chat_messages m on r.target_type = 'message' and m.id = r.target_id
  left join public.profiles up on up.id = coalesce(p.user_id, m.sender_id)
  where r.status = coalesce(nullif(p_status, ''), 'pending')
  order by r.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- p_action: dismiss | reviewed | hide | remove. Every report on the same target gets the same outcome.
create or replace function public.admin_report_resolve(p_report uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare r public.reports;
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_action not in ('dismiss', 'reviewed', 'hide', 'remove') then raise exception 'unknown action'; end if;
  select * into r from public.reports where id = p_report;
  if not found then raise exception 'unknown report'; end if;
  if p_action in ('hide', 'remove') then
    if r.target_type in ('post', 'reaction') then
      update public.posts set moderation_status = case when p_action = 'remove' then 'removed' else 'hidden' end where id = r.target_id;
    elsif r.target_type = 'message' then
      update public.chat_messages set deleted_at = coalesce(deleted_at, now()), body = null, post_id = null where id = r.target_id;
    end if;
  end if;
  update public.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'reviewed' end
   where target_type = r.target_type and target_id = r.target_id and status = 'pending';
end;
$$;

create or replace function public.admin_flags_list(p_status text default 'open', p_limit integer default 50)
returns table (id uuid, user_id uuid, username text, target_id uuid, target_username text, kind text, detail jsonb, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select f.id, f.user_id, u.username::text, f.target_id, t.username::text, f.kind, f.detail, f.status, f.created_at
  from public.harassment_flags f
  left join public.profiles u on u.id = f.user_id
  left join public.profiles t on t.id = f.target_id
  where f.status = coalesce(nullif(p_status, ''), 'open')
  order by f.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function public.admin_flag_resolve(p_flag uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('reviewed', 'dismissed') then raise exception 'unknown status'; end if;
  update public.harassment_flags set status = p_status where id = p_flag;
end;
$$;

create or replace function public.admin_filter_terms()
returns table (term text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select w.term from public.word_filter_terms w order by w.term;
end;
$$;

create or replace function public.admin_filter_add(p_term text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare t text := btrim(coalesce(p_term, ''));
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if char_length(public.text_normalize(t)) < 2 then raise exception 'a term needs at least 2 letters'; end if;
  insert into public.word_filter_terms (term, created_by) values (lower(t), auth.uid()) on conflict do nothing;
end;
$$;

create or replace function public.admin_filter_remove(p_term text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from public.word_filter_terms where term = lower(btrim(coalesce(p_term, '')));
end;
$$;

-- ── 6. grants: internals are not callable by apps; the app's own functions are ────────────────
revoke all on function
  public.text_normalize(text), public.text_join_singles(text), public.text_blocked_term(text), public.text_check(text), public.posts_text_guard(),
  public.harassment_unanswered(uuid, uuid), public.harassment_flag(uuid, uuid, text, jsonb), public.chat_messages_guard(),
  public.chat_messages_flags(), public.root_post_of(uuid), public.interaction_check(uuid, uuid), public.likes_interaction_guard(),
  public.reactions_interaction_guard(), public.mod_is_admin()
  from public, anon, authenticated;

revoke all on function
  public.my_controls(), public.set_dm_policy(text), public.my_post_interaction_mode(uuid), public.set_post_interactions(uuid, text),
  public.remove_reaction_on_my_post(uuid), public.admin_reports_queue(text, integer), public.admin_report_resolve(uuid, text),
  public.admin_flags_list(text, integer), public.admin_flag_resolve(uuid, text), public.admin_filter_terms(),
  public.admin_filter_add(text), public.admin_filter_remove(text)
  from public, anon;
grant execute on function
  public.my_controls(), public.set_dm_policy(text), public.my_post_interaction_mode(uuid), public.set_post_interactions(uuid, text),
  public.remove_reaction_on_my_post(uuid), public.admin_reports_queue(text, integer), public.admin_report_resolve(uuid, text),
  public.admin_flags_list(text, integer), public.admin_flag_resolve(uuid, text), public.admin_filter_terms(),
  public.admin_filter_add(text), public.admin_filter_remove(text)
  to authenticated;
