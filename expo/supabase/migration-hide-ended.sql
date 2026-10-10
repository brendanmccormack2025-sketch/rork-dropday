-- Posts that end ('archived') or stay 'incomplete' disappear for good (idempotent; run manually in the SQL editor).
-- Run after migration-trial-engine.sql and migration-survived-profile.sql.
--
-- Product rule: profiles show only survived posts (plus the creator's own testing and queued posts). A post that ends
-- or is incomplete is never shown to anyone, the creator included, and nobody is told: its media is deleted, it is
-- hidden from every read (feed, profile, post viewer, deep links), its reactions go with it, and no notification is
-- sent. The post row stays, with trial_post_state and trial_engine_log, so the survival bar (P50 of recent posts) still
-- works. Statuses and notification types are not renamed.
--
--  * trial_hide_on_status (trigger): the moment a root post becomes 'archived' or 'incomplete' (engine, legacy
--    function, anything), trial_hide_post() runs.
--  * trial_hide_post(): queues every file of the post and its reactions for deletion (trial_media_delete_queue),
--    marks them deleted (media_deleted_at), hides the reactions (status 'archived'), removes notifications about them.
--  * Row level security: a restrictive SELECT policy hides archived / incomplete rows from every client.
--  * A hidden post's status is final (a late legacy re-check can never bring it back).
--  * notifications: verdict_archived / verdict_incomplete rows are never inserted any more, whoever tries.
--  * profile_posts(): own profile = queued + testing + survived; others = survived. Nothing else.
--  * Files: SQL cannot delete Storage files, so they are queued and the Edge Function delete-media (see
--    supabase/functions/delete-media) removes them with the Storage API (dry run first).

-- ── 1. The deletion queue ─────────────────────────────────────────────────────
create table if not exists public.trial_media_delete_queue (
  id         bigint generated always as identity primary key,
  post_id    uuid not null,
  bucket     text not null,
  path       text not null,
  queued_at  timestamptz not null default now(),
  deleted_at timestamptz,
  error      text
);
create unique index if not exists trial_media_delete_queue_file_idx on public.trial_media_delete_queue (bucket, path);
create index if not exists trial_media_delete_queue_pending_idx on public.trial_media_delete_queue (id) where deleted_at is null;
alter table public.trial_media_delete_queue enable row level security;
revoke all on table public.trial_media_delete_queue from anon, authenticated;

-- ── 2. Hiding a post ──────────────────────────────────────────────────────────
create or replace function public.trial_hide_post(p_post_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
  n integer;
begin
  with recursive t as (
    select id from public.posts where id = p_post_id
    union all
    select c.id from public.posts c join t on c.parent_post_id = t.id
  )
  select coalesce(array_agg(id), '{}') into ids from t;

  -- every file of the post and its reactions: [bucket, path] from the public / signed URLs
  insert into public.trial_media_delete_queue (post_id, bucket, path)
  select f.id, m[1], m[2]
  from (
    select p.id, u.url
    from public.posts p
    cross join lateral (
      select p.media_url as url
      union all select p.thumbnail_url
      union all select p.audio_url
      union all select s from jsonb_array_elements_text(
        case when jsonb_typeof(to_jsonb(p.segments)) = 'array' then to_jsonb(p.segments) else '[]'::jsonb end) s
    ) u
    where p.id = any (ids) and u.url is not null
  ) f
  cross join lateral regexp_match(f.url, '/object/(?:public|sign|authenticated)/([^/]+)/([^?]+)') m
  where m is not null
  on conflict (bucket, path) do nothing;
  get diagnostics n = row_count;

  update public.posts
     set media_deleted_at = coalesce(media_deleted_at, now()),
         status = case when id = p_post_id then status else 'archived' end   -- reactions are hidden like their post
   where id = any (ids);

  delete from public.notifications where post_id = any (ids);
  return n;
end;
$$;
revoke all on function public.trial_hide_post(uuid) from public, anon, authenticated;

create or replace function public.trial_hide_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_post_id is null and new.status in ('archived', 'incomplete') and new.status is distinct from old.status then
    perform public.trial_hide_post(new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists trial_hide_on_status on public.posts;
create trigger trial_hide_on_status
  after update of status on public.posts
  for each row execute function public.trial_hide_on_status();

-- A hidden post stays hidden: nothing (a late legacy re-check, an admin) can bring it back.
create or replace function public.trial_hidden_is_final()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.parent_post_id is null and old.status in ('archived', 'incomplete') and old.media_deleted_at is not null
     and new.status not in ('archived', 'incomplete') then
    new.status := old.status;
  end if;
  return new;
end;
$$;
drop trigger if exists trial_hidden_is_final on public.posts;
create trigger trial_hidden_is_final
  before update of status on public.posts
  for each row execute function public.trial_hidden_is_final();

-- ── 3. Hidden from every read ─────────────────────────────────────────────────
drop policy if exists posts_hide_ended on public.posts;
create policy posts_hide_ended on public.posts
  as restrictive for select to anon, authenticated
  using (status not in ('archived', 'incomplete'));

-- ── 4. Nobody is told ─────────────────────────────────────────────────────────
do $$
begin
  if to_regclass('public.notifications') is not null then
    create or replace function public.trial_no_ended_notifications()
    returns trigger language plpgsql as $f$
    begin
      if new.type in ('verdict_archived', 'verdict_incomplete') then return null; end if;
      return new;
    end;
    $f$;
    drop trigger if exists trial_no_ended_notifications on public.notifications;
    create trigger trial_no_ended_notifications
      before insert on public.notifications
      for each row execute function public.trial_no_ended_notifications();
  end if;
end $$;

-- ── 5. Profiles: survived only (plus the creator's own testing and queued posts) ─
create or replace function public.profile_posts(p_user_id uuid, p_limit integer default 100)
returns table (post_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  hide_mature boolean := false;
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 300);
begin
  if me is null or p_user_id is null then return; end if;
  if p_user_id = me then
    return query
    select p.id
    from public.posts p
    where p.user_id = me and p.parent_post_id is null and p.moderation_status = 'active'
      and (
        p.status in ('queued', 'trial')
        or (p.survived_at is not null and p.status in ('survived', 'expired') and p.media_deleted_at is null)
      )
    order by p.created_at desc, p.id
    limit lim;
    return;
  end if;
  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature
  from public.profiles pr where pr.id = me;
  hide_mature := coalesce(hide_mature, false);
  return query
  select p.id
  from public.posts p
  where p.user_id = p_user_id and p.parent_post_id is null and p.moderation_status = 'active'
    and p.survived_at is not null and p.status in ('survived', 'expired')
    and p.media_deleted_at is null
    and (not hide_mature or not p.is_mature)
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = me and b.blocked_id = p.user_id) or (b.blocker_id = p.user_id and b.blocked_id = me)
    )
  order by p.created_at desc, p.id
  limit lim;
end;
$$;
grant execute on function public.profile_posts(uuid, integer) to authenticated;

-- ── 6. Backfill: every post that already ended / is incomplete disappears now ─
do $$
declare
  r record;
  roots integer := 0;
  queued_before bigint;
  queued_after bigint;
  reactions_hidden integer;
  notif_deleted integer := 0;
  k integer;
begin
  select count(*) into queued_before from public.trial_media_delete_queue;
  for r in select id from public.posts where parent_post_id is null and status in ('archived', 'incomplete') loop
    perform public.trial_hide_post(r.id);
    roots := roots + 1;
  end loop;
  select count(*) into queued_after from public.trial_media_delete_queue;
  select count(*) into reactions_hidden from public.posts c
    where c.parent_post_id is not null and c.status = 'archived' and c.media_deleted_at is not null;
  if to_regclass('public.notifications') is not null then
    delete from public.notifications where type in ('verdict_archived', 'verdict_incomplete');
    get diagnostics notif_deleted = row_count;
  end if;
  raise notice 'backfill: % ended/incomplete posts hidden, % reactions hidden, % files queued for deletion, % old verdict notifications deleted',
    roots, reactions_hidden, queued_after - queued_before, notif_deleted;
end $$;
-- Look at the queue:  select count(*) filter (where deleted_at is null) pending, count(*) filter (where deleted_at is not null) done from public.trial_media_delete_queue;
