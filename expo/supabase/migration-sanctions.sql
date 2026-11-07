-- Tryal account sanctions and owner alerts (Terms / App Store guideline 1.2). Idempotent; run after migration-recovery.sql.
--
--   * SUSPEND (N days) / BAN: owner-only actions in the review queue. A sanctioned account cannot post, react, like or message:
--     enforced by BEFORE INSERT triggers on posts (posts and reactions), likes and chat_messages, so every build, old or new,
--     obeys. Its posts and reactions are hidden from everyone else (moderation_status 'hidden', which every read already honours);
--     the posts hidden by a sanction are remembered and come back when it is lifted or a suspension ends. The app shows
--     "Your account is suspended until ..." / "banned" at sign-in (my_sanction()).
--   * UNSUSPEND / UNBAN: owner-only. A suspension also ends by itself (sanctions_expire(), every 5 minutes and on every read).
--   * EVERY action is logged (moderation_log): sanctions, lifts, expiries, and every report resolved in the queue.
--   * OWNER ALERT: a new report notifies every admin (in-app notification report_alert, and a push when send-push is deployed
--     with this release: see push_claim_batch below).

-- ── 1. tables ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.account_sanctions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null,
  kind       text not null check (kind in ('suspend', 'ban')),
  until      timestamptz,
  reason     text,
  created_by uuid,
  created_at timestamptz not null default now(),
  lifted_at  timestamptz,
  lifted_by  uuid,
  check ((kind = 'ban' and until is null) or (kind = 'suspend' and until is not null))
);
create index if not exists account_sanctions_active_idx on public.account_sanctions (user_id) where lifted_at is null;

create table if not exists public.sanction_hidden_posts (
  sanction_id uuid not null references public.account_sanctions (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  primary key (sanction_id, post_id)
);

create table if not exists public.moderation_log (
  id          uuid primary key default gen_random_uuid(),
  actor       uuid,
  action      text not null,
  target_user uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists moderation_log_created_idx on public.moderation_log (created_at desc);

alter table public.account_sanctions enable row level security;
alter table public.sanction_hidden_posts enable row level security;
alter table public.moderation_log enable row level security;
revoke all on table public.account_sanctions, public.sanction_hidden_posts, public.moderation_log from anon, authenticated;

-- the new notification type (existing values are kept)
do $$
declare c record;
begin
  if to_regclass('public.notifications') is not null then
    for c in select conname from pg_constraint where conrelid = 'public.notifications'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verdict_survived%'
    loop
      execute format('alter table public.notifications drop constraint %I', c.conname);
    end loop;
    alter table public.notifications add constraint notifications_type_check
      check (type in ('like', 'reaction', 'follow', 'follow_request', 'follow_accept',
                      'verdict_survived', 'verdict_archived', 'verdict_incomplete', 'verdict_unjudged', 'followed_post_survived',
                      'friend_request', 'friend_accept', 'message', 'spotlight_offer', 'recovery_offer', 'report_alert'));
  end if;
end $$;

-- ── 2. who is sanctioned, expiry, restore ──────────────────────────────────────────────────
create or replace function public.account_sanction_of(p_user uuid)
returns table (id uuid, kind text, until timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.until from public.account_sanctions s
  where s.user_id = p_user and s.lifted_at is null and (s.kind = 'ban' or s.until > now())
  order by s.created_at desc limit 1
$$;

-- posts and reactions hidden BY a sanction come back (those hidden for another reason, e.g. by reports, stay hidden)
create or replace function public.sanction_restore_posts(p_sanction uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update public.posts set moderation_status = 'active'
   where id in (select h.post_id from public.sanction_hidden_posts h where h.sanction_id = p_sanction) and moderation_status = 'hidden';
  get diagnostics n = row_count;
  delete from public.sanction_hidden_posts where sanction_id = p_sanction;
  return n;
end;
$$;

-- a suspension that has run out ends by itself
create or replace function public.sanctions_expire()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  n integer := 0;
begin
  for s in select * from public.account_sanctions where lifted_at is null and kind = 'suspend' and until <= now() loop
    update public.account_sanctions set lifted_at = now() where id = s.id;
    perform public.sanction_restore_posts(s.id);
    insert into public.moderation_log (actor, action, target_user, detail) values (null, 'suspension_ended', s.user_id, jsonb_build_object('sanction_id', s.id));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ── 3. enforcement: a sanctioned account cannot post, react, like or message ───────────────────
create or replace function public.sanction_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  who uuid;
  s record;
begin
  -- (plain IFs: a CASE would look for sender_id on a posts row too)
  if tg_table_name = 'chat_messages' then
    who := new.sender_id;
  else
    who := new.user_id;
  end if;
  select * into s from public.account_sanction_of(who);
  if found then
    if s.kind = 'ban' then
      raise exception 'Your account is banned.' using errcode = '42501';
    else
      raise exception 'Your account is suspended until %.', to_char(s.until at time zone 'UTC', 'YYYY-MM-DD HH24:MI "UTC"') using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists zzy_sanction_guard on public.posts;
create trigger zzy_sanction_guard before insert on public.posts for each row execute function public.sanction_guard();
drop trigger if exists zzy_sanction_guard on public.likes;
create trigger zzy_sanction_guard before insert on public.likes for each row execute function public.sanction_guard();
drop trigger if exists zzy_sanction_guard on public.chat_messages;
create trigger zzy_sanction_guard before insert on public.chat_messages for each row execute function public.sanction_guard();

-- ── 4. the owner's actions ──────────────────────────────────────────────────────────────────
create or replace function public.admin_sanction_user(p_user uuid, p_kind text, p_days integer default null, p_reason text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  old record;
  sid uuid;
  hidden integer;
  until_at timestamptz;
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_kind not in ('suspend', 'ban') then raise exception 'unknown action'; end if;
  if p_user is null or p_user = auth.uid() or exists (select 1 from public.spotlight_admins a where a.user_id = p_user) then
    raise exception 'that account cannot be sanctioned';
  end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown account'; end if;
  if p_kind = 'suspend' then
    if p_days is null or p_days < 1 or p_days > 365 then raise exception 'a suspension is 1 to 365 days'; end if;
    until_at := now() + (p_days * interval '1 day');
  end if;
  -- a new sanction replaces the one in force
  for old in select id, kind from public.account_sanctions where user_id = p_user and lifted_at is null loop
    update public.account_sanctions set lifted_at = now(), lifted_by = auth.uid() where id = old.id;
    perform public.sanction_restore_posts(old.id);
  end loop;
  insert into public.account_sanctions (user_id, kind, until, reason, created_by)
  values (p_user, p_kind, until_at, nullif(btrim(coalesce(p_reason, '')), ''), auth.uid()) returning id into sid;
  -- their posts and reactions leave every read at once (the ones hidden for another reason are left as they are)
  with h as (update public.posts set moderation_status = 'hidden' where user_id = p_user and moderation_status = 'active' returning id)
  insert into public.sanction_hidden_posts (sanction_id, post_id) select sid, h.id from h;
  select count(*)::integer into hidden from public.sanction_hidden_posts where sanction_id = sid;
  insert into public.moderation_log (actor, action, target_user, detail)
  values (auth.uid(), p_kind, p_user, jsonb_build_object('sanction_id', sid, 'days', p_days, 'until', until_at, 'reason', p_reason, 'hidden_posts', hidden));
  return sid;
end;
$$;

create or replace function public.admin_lift_sanction(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  restored integer;
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from public.account_sanctions where user_id = p_user and lifted_at is null order by created_at desc limit 1;
  if not found then raise exception 'no sanction in force'; end if;
  update public.account_sanctions set lifted_at = now(), lifted_by = auth.uid() where user_id = p_user and lifted_at is null;
  restored := public.sanction_restore_posts(s.id);
  insert into public.moderation_log (actor, action, target_user, detail)
  values (auth.uid(), case when s.kind = 'ban' then 'unban' else 'unsuspend' end, p_user, jsonb_build_object('sanction_id', s.id, 'restored_posts', restored));
end;
$$;

create or replace function public.admin_sanctions_list(p_active_only boolean default true)
returns table (id uuid, user_id uuid, username text, kind text, until timestamptz, reason text, created_at timestamptz, lifted_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.sanctions_expire();
  return query
  select s.id, s.user_id, p.username::text, s.kind, s.until, s.reason, s.created_at, s.lifted_at
  from public.account_sanctions s left join public.profiles p on p.id = s.user_id
  where (not coalesce(p_active_only, true)) or s.lifted_at is null
  order by s.created_at desc limit 100;
end;
$$;

create or replace function public.admin_moderation_log(p_limit integer default 50)
returns table (id uuid, actor_username text, action text, target_username text, detail jsonb, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select l.id, a.username::text, l.action, t.username::text, l.detail, l.created_at
  from public.moderation_log l
  left join public.profiles a on a.id = l.actor
  left join public.profiles t on t.id = l.target_user
  order by l.created_at desc limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

-- what the app shows at sign-in: null row = fine
create or replace function public.my_sanction()
returns table (kind text, until timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  perform public.sanctions_expire();
  return query select s.kind, s.until from public.account_sanction_of(auth.uid()) s;
end;
$$;

-- every report resolved in the queue is in the log
create or replace function public.reports_status_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status is distinct from old.status and public.mod_is_admin() then
    insert into public.moderation_log (actor, action, detail)
    values (auth.uid(), 'report_' || new.status, jsonb_build_object('report_id', new.id, 'target_type', new.target_type, 'target_id', new.target_id));
  end if;
  return new;
end;
$$;
drop trigger if exists zzz_reports_status_log on public.reports;
create trigger zzz_reports_status_log after update of status on public.reports for each row execute function public.reports_status_log();

-- ── 5. owner alert: a new report notifies every admin ──────────────────────────────────────────
create or replace function public.reports_owner_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select a.user_id, new.reporter_id, 'report_alert', case when new.target_type in ('post', 'reaction') then new.target_id end
  from public.spotlight_admins a
  where a.user_id <> new.reporter_id;
  return new;
end;
$$;
drop trigger if exists zzz_reports_owner_alert on public.reports;
create trigger zzz_reports_owner_alert after insert on public.reports for each row execute function public.reports_owner_alert();

-- ── 6. the push for it (needs the send-push edge function of this release: it maps the type to a route and a text) ──
-- push_claim_batch from migration-push.sql with two additions: 'report_alert' is a category ('admin') that only the master switch
-- can turn off.
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
      when 'report_alert' then 'admin'
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
                      when 'admin' then true   -- the owner's report alerts are not a user category: only the master switch applies
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
-- ── 7. a suspension ends by itself ─────────────────────────────────────────────────────────────
do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.unschedule(j.jobid) from cron.job j where j.jobname = 'sanctions-expire';
    perform cron.schedule('sanctions-expire', '*/5 * * * *', 'select public.sanctions_expire()');
  end if;
exception when others then
  raise notice 'could not schedule sanctions-expire (%): suspensions still end when the data is read', sqlerrm;
end $$;

-- ── 8. grants ───────────────────────────────────────────────────────────────────────────────────
revoke all on function
  public.account_sanction_of(uuid), public.sanction_restore_posts(uuid), public.sanctions_expire(), public.sanction_guard(),
  public.reports_status_log(), public.reports_owner_alert()
  from public, anon, authenticated;
revoke all on function public.admin_sanction_user(uuid, text, integer, text), public.admin_lift_sanction(uuid), public.admin_sanctions_list(boolean),
  public.admin_moderation_log(integer), public.my_sanction() from public, anon;
grant execute on function public.admin_sanction_user(uuid, text, integer, text), public.admin_lift_sanction(uuid), public.admin_sanctions_list(boolean),
  public.admin_moderation_log(integer), public.my_sanction() to authenticated;
