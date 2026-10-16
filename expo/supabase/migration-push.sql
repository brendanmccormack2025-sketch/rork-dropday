-- Tryal: Expo push notifications, the database side (idempotent). Run AFTER migration-friends-messages.sql (message
-- notifications) and BEFORE migration-known-connections.sql (which stays last). The Edge Function that sends them is
-- supabase/functions/send-push (deployed and scheduled by ship.sh, see FUNCTIONS.txt).
--
-- How it works: rows in public.notifications are created in SQL as before. Every minute pg_cron calls send-push, which asks
-- push_claim_batch() for the rows that need a push, sends them to Expo, and reports back (push_mark_*). A cron batch (not an
-- insert webhook) because it is the more reliable shape: nothing is lost if a call fails, every row is retried with a back-off,
-- duplicates collapse in one place, and like milestones are decided with the final counts. The price is up to a minute of delay.
--
--   * Tokens: the app saves its Expo push token on sign-in (register_push_token). A token belongs to one person at a time
--     (signing in on the same phone as someone else moves it). Expo says DeviceNotRegistered -> the token is deleted
--     (push_remove_tokens), also from the receipts checked a few minutes later (push_tickets).
--   * Settings: push_prefs (all on by default except message previews). No token or switched off -> the row is skipped for good.
--   * What is pushed: verdict_survived, reaction, like MILESTONES (1, 5, 10, 25 likes on a post, each once), friend_request,
--     friend_accept, message. Every other type is skipped.
--   * Message text is never put in a push unless the person turned previews on AND is an adult (age_tier). The default text is
--     "<name> sent you a message" / "<name> sent you a post".
--   * A row older than a day is not pushed. Rows that existed before this migration are marked skipped (no flood).

-- ── columns on notifications ───────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.notifications') is null then
    raise exception 'public.notifications does not exist';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'push_skip_reason') then
    alter table public.notifications
      add column push_sent_at timestamptz,
      add column push_attempts integer not null default 0,
      add column push_retry_at timestamptz,
      add column push_skip_reason text,
      add column push_error text;
    -- first run only: everything that exists now was never meant to be pushed
    update public.notifications set push_skip_reason = 'before push existed';
  end if;
end $$;
create index if not exists notifications_push_pending_idx on public.notifications (created_at)
  where push_sent_at is null and push_skip_reason is null;

-- ── tables ───────────────────────────────────────────────────────────────────
create table if not exists public.push_tokens (
  token      text primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  platform   text not null default 'ios' check (platform in ('ios', 'android', 'web')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (token ~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$')
);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id);

create table if not exists public.push_prefs (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  enabled         boolean not null default true,
  survived        boolean not null default true,
  reactions       boolean not null default true,
  likes           boolean not null default true,
  friends         boolean not null default true,
  messages        boolean not null default true,
  message_preview boolean not null default false,
  updated_at      timestamptz not null default now()
);

-- like milestones already pushed for a post (each only once, even if the rows are processed late)
create table if not exists public.push_like_milestones (
  post_id   uuid not null references public.posts(id) on delete cascade,
  milestone integer not null,
  sent_at   timestamptz not null default now(),
  primary key (post_id, milestone)
);

-- tickets Expo gave us: their receipts are checked a few minutes later (that is where DeviceNotRegistered usually shows)
create table if not exists public.push_tickets (
  ticket_id  text primary key,
  token      text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_tickets_created_idx on public.push_tickets (created_at);

alter table public.push_tokens enable row level security;
alter table public.push_prefs enable row level security;
alter table public.push_like_milestones enable row level security;
alter table public.push_tickets enable row level security;
revoke all on table public.push_tokens, public.push_prefs, public.push_like_milestones, public.push_tickets from anon, authenticated;

-- ── the app's side (a signed-in person, their own rows only) ─────────────────────
create or replace function public.register_push_token(p_token text, p_platform text default 'ios')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_token is null or p_token !~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$' then
    raise exception 'invalid push token' using errcode = '22023';
  end if;
  insert into public.push_tokens (token, user_id, platform)
  values (p_token, auth.uid(), case when p_platform in ('ios', 'android', 'web') then p_platform else 'ios' end)
  on conflict (token) do update set user_id = auth.uid(), platform = excluded.platform, updated_at = now();
end;
$$;

create or replace function public.remove_push_token(p_token text)
returns void
language sql
security definer
set search_path = public
as $$ delete from public.push_tokens where token = p_token and user_id = auth.uid() $$;

create or replace function public.get_push_prefs()
returns table (enabled boolean, survived boolean, reactions boolean, likes boolean, friends boolean, messages boolean, message_preview boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.enabled, true), coalesce(p.survived, true), coalesce(p.reactions, true), coalesce(p.likes, true),
         coalesce(p.friends, true), coalesce(p.messages, true), coalesce(p.message_preview, false)
  from (select 1) one left join public.push_prefs p on p.user_id = auth.uid()
$$;

-- p_prefs: any of enabled / survived / reactions / likes / friends / messages / message_preview as booleans
create or replace function public.set_push_prefs(p_prefs jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  insert into public.push_prefs (user_id) values (auth.uid()) on conflict do nothing;
  update public.push_prefs set
    enabled         = coalesce((p_prefs->>'enabled')::boolean, enabled),
    survived        = coalesce((p_prefs->>'survived')::boolean, survived),
    reactions       = coalesce((p_prefs->>'reactions')::boolean, reactions),
    likes           = coalesce((p_prefs->>'likes')::boolean, likes),
    friends         = coalesce((p_prefs->>'friends')::boolean, friends),
    messages        = coalesce((p_prefs->>'messages')::boolean, messages),
    message_preview = coalesce((p_prefs->>'message_preview')::boolean, message_preview),
    updated_at      = now()
  where user_id = auth.uid();
end;
$$;

revoke all on function public.register_push_token(text, text), public.remove_push_token(text), public.get_push_prefs(),
  public.set_push_prefs(jsonb) from public, anon;
grant execute on function public.register_push_token(text, text), public.remove_push_token(text), public.get_push_prefs(),
  public.set_push_prefs(jsonb) to authenticated;

-- ── the sender's side (service role only) ────────────────────────────────────────
-- The like milestones: 1, 5, 10, 25.
create or replace function public.push_like_milestone(p_likes integer)
returns integer
language sql
immutable
as $$
  select max(m) from unnest(array[1, 5, 10, 25]) as m where m <= p_likes
$$;

-- Claims up to p_limit rows that need a push and returns them as JSON, with everything the sender needs. Rows that need no push
-- are marked skipped here (with the reason). A claimed row is retried in 2 minutes unless push_mark_sent clears it, so a crashed
-- run loses nothing.
create or replace function public.push_claim_batch(p_limit integer default 200)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  out jsonb := '[]'::jsonb;
  prefs record;
  toks text[];
  cat text;
  ms integer;
  likes_n integer;
  last_post boolean;
  last_body text;
  actor_name text;
  minor boolean;
  skip text;
begin
  for r in
    select n.* from public.notifications n
    where n.push_sent_at is null and n.push_skip_reason is null and n.push_attempts < 5
      and n.created_at > now() - interval '1 day'
      and (n.push_retry_at is null or n.push_retry_at <= now())
    order by n.created_at
    limit greatest(1, least(coalesce(p_limit, 200), 500))
    for update skip locked
  loop
    skip := null; ms := null; last_post := null; last_body := null;
    cat := case r.type
      when 'verdict_survived' then 'survived'
      when 'reaction' then 'reactions'
      when 'like' then 'likes'
      when 'friend_request' then 'friends'
      when 'friend_accept' then 'friends'
      when 'message' then 'messages'
      else null end;
    if cat is null then
      skip := 'type is not pushed';
    elsif r.actor_id is not null and r.actor_id = r.recipient_id then
      skip := 'own action';
    end if;

    if skip is null then
      select coalesce(p.enabled, true) as enabled,
             case cat when 'survived' then coalesce(p.survived, true) when 'reactions' then coalesce(p.reactions, true)
                      when 'likes' then coalesce(p.likes, true) when 'friends' then coalesce(p.friends, true)
                      else coalesce(p.messages, true) end as cat_on,
             coalesce(p.message_preview, false) as preview
        into prefs from (select 1) one left join public.push_prefs p on p.user_id = r.recipient_id;
      if not prefs.enabled or not prefs.cat_on then skip := 'user setting'; end if;
    end if;

    if skip is null then
      select array_agg(t.token order by t.updated_at desc) into toks from public.push_tokens t where t.user_id = r.recipient_id;
      if toks is null then skip := 'no token'; end if;
    end if;

    if skip is null and r.actor_id is not null and exists (
      select 1 from public.user_blocks b where (b.blocker_id = r.recipient_id and b.blocked_id = r.actor_id) or (b.blocker_id = r.actor_id and b.blocked_id = r.recipient_id)
    ) then
      skip := 'blocked';
    end if;

    if skip is null and r.type = 'like' then
      -- the creator's own like never counts toward a milestone
      select count(*) into likes_n from public.likes l join public.posts p on p.id = l.post_id where l.post_id = r.post_id and l.user_id <> p.user_id;
      ms := public.push_like_milestone(likes_n);
      if ms is null or exists (select 1 from public.push_like_milestones x where x.post_id = r.post_id and x.milestone >= ms) then
        skip := 'not a like milestone';
      else
        insert into public.push_like_milestones (post_id, milestone) values (r.post_id, ms) on conflict do nothing;
      end if;
    end if;

    if skip is null and r.type = 'message' then
      if r.read is true then
        skip := 'already read';
      else
        select m.was_post, m.body into last_post, last_body
          from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id
         where m.sender_id = r.actor_id and m.deleted_at is null
           and c.user_a = least(r.actor_id, r.recipient_id) and c.user_b = greatest(r.actor_id, r.recipient_id)
         order by m.created_at desc limit 1;
        if not found then skip := 'message is gone'; end if;
      end if;
    end if;

    if skip is not null then
      update public.notifications set push_skip_reason = skip where id = r.id;
      continue;
    end if;

    select coalesce(nullif(btrim(p.display_name), ''), p.username) into actor_name from public.profiles p where p.id = r.actor_id;
    minor := public.friends_is_minor(r.recipient_id);
    update public.notifications set push_attempts = push_attempts + 1, push_retry_at = now() + interval '2 minutes' where id = r.id;
    out := out || jsonb_build_object(
      'id', r.id, 'type', r.type, 'recipient_id', r.recipient_id, 'actor_id', r.actor_id, 'post_id', r.post_id,
      'created_at', r.created_at, 'attempts', r.push_attempts + 1,
      'actor_name', actor_name, 'recipient_minor', minor, 'tokens', to_jsonb(toks),
      'milestone', ms,
      -- a reaction whose post is itself a reaction is a reply to the recipient's reaction
      'on_reaction', case when r.type = 'reaction' then exists (select 1 from public.posts p where p.id = r.post_id and p.parent_post_id is not null) end,
      'last_was_post', case when r.type = 'message' then coalesce(last_post, false) end,
      -- the text of a message leaves the database only for an adult who turned previews on
      'preview', case when r.type = 'message' and not minor and prefs.preview and not coalesce(last_post, false) then left(last_body, 120) end
    );
  end loop;
  return out;
end;
$$;

create or replace function public.push_mark_sent(p_ids uuid[])
returns void
language sql
security definer
set search_path = public
as $$ update public.notifications set push_sent_at = now(), push_retry_at = null, push_error = null where id = any(p_ids) $$;

-- Back-off 1, 5, 15, 60 minutes; after the 5th attempt the row is given up on.
create or replace function public.push_mark_retry(p_ids uuid[], p_error text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.notifications n set
    push_error = left(p_error, 300),
    push_retry_at = now() + case n.push_attempts when 1 then interval '1 minute' when 2 then interval '5 minutes' when 3 then interval '15 minutes' else interval '60 minutes' end,
    push_skip_reason = case when n.push_attempts >= 5 then 'gave up: ' || left(coalesce(p_error, 'unknown'), 100) end
  where n.id = any(p_ids) and n.push_sent_at is null
$$;

create or replace function public.push_mark_skipped(p_ids uuid[], p_reason text)
returns void
language sql
security definer
set search_path = public
as $$ update public.notifications set push_skip_reason = left(p_reason, 120), push_retry_at = null where id = any(p_ids) and push_sent_at is null $$;

create or replace function public.push_remove_tokens(p_tokens text[])
returns integer
language sql
security definer
set search_path = public
as $$ with d as (delete from public.push_tokens where token = any(p_tokens) returning 1) select count(*)::integer from d $$;

create or replace function public.push_save_tickets(p_tickets jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.push_tickets (ticket_id, token)
  select t->>'id', t->>'token' from jsonb_array_elements(coalesce(p_tickets, '[]'::jsonb)) t where t->>'id' is not null
  on conflict do nothing
$$;

-- tickets old enough for their receipt (Expo keeps receipts for 24 hours; older tickets are dropped)
create or replace function public.push_due_tickets(p_limit integer default 300)
returns table (ticket_id text, token text)
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_tickets where created_at < now() - interval '24 hours';
  return query select t.ticket_id, t.token from public.push_tickets t where t.created_at < now() - interval '5 minutes' order by t.created_at limit p_limit;
end;
$$;

create or replace function public.push_finish_tickets(p_ids text[])
returns void
language sql
security definer
set search_path = public
as $$ delete from public.push_tickets where ticket_id = any(p_ids) $$;

revoke all on function public.push_like_milestone(integer), public.push_claim_batch(integer), public.push_mark_sent(uuid[]),
  public.push_mark_retry(uuid[], text), public.push_mark_skipped(uuid[], text), public.push_remove_tokens(text[]),
  public.push_save_tickets(jsonb), public.push_due_tickets(integer), public.push_finish_tickets(text[]) from public, anon, authenticated;
grant execute on function public.push_like_milestone(integer), public.push_claim_batch(integer), public.push_mark_sent(uuid[]),
  public.push_mark_retry(uuid[], text), public.push_mark_skipped(uuid[], text), public.push_remove_tokens(text[]),
  public.push_save_tickets(jsonb), public.push_due_tickets(integer), public.push_finish_tickets(text[]) to service_role;
