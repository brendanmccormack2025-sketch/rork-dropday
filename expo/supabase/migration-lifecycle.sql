-- ============================================================================
-- Post lifecycle, part 1 of 2: columns, config, survival rules, guards (idempotent)
-- ============================================================================
-- Based on run_survival_checkpoint() in migration-verdict-at-n-views.sql, which
-- this file supersedes. Run manually in the Supabase SQL editor. Safe to re-run.
-- Never re-run older migrations that define run_survival_checkpoint.
--
-- Part 2 is migration-lifecycle-expiry.sql: run it ONLY after the client handles
-- the 'expired' status. This file does not schedule the 'expire-posts' cron job
-- and never sets any post to 'expired'.
--
-- What this migration does (details inline):
--   1. posts: survived_at, distribution_started_at, distribution_expires_at,
--      expired_at, media_deleted_at; status CHECK also allows 'expired'.
--      'trial' stays the stored name for "testing". No status or notification
--      type is renamed.
--   2. trial_config table (thresholds), read once per survival run.
--   3. run_survival_checkpoint(): same verdict rules as verdict-at-n-views,
--      config-driven; follower term and followed_post_survived fan-out REMOVED
--      (the bar is just floor_points); survive sets the distribution window;
--      rows whose status would not change are never rewritten.
--      The post author's own likes no longer count toward engagement (like the
--      author's own reactions).
--   4. expire_posts() is DEFINED here but NOT scheduled and never called.
--   5. BEFORE INSERT trigger: a reaction cannot be added to an archived or
--      expired parent, or to a parent that does not exist.
--   6. Indexes.
--   7. Legacy posts (no checkpoint_at) become 'archived' (the backup table keeps
--      their original status; see the rollback notes at the bottom).
--   8. BEFORE INSERT trigger force_post_defaults: signed-in API users cannot
--      set status, counters or lifecycle timestamps on insert.
-- Not touched: RLS on posts, the existing triggers (trg_set_checkpoint_at,
-- trg_notify_reaction, trg_reaction_count_insert/delete, the likes triggers,
-- the follows triggers), the moderation_status and media_type CHECKs, storage,
-- and the survival-checkpoint cron job name and schedule.

-- ── 1. Columns + status CHECK ───────────────────────────────────────────────
alter table public.posts add column if not exists survived_at              timestamptz;
alter table public.posts add column if not exists distribution_started_at  timestamptz;
alter table public.posts add column if not exists distribution_expires_at  timestamptz;
alter table public.posts add column if not exists expired_at               timestamptz;
alter table public.posts add column if not exists media_deleted_at         timestamptz;

-- Find the status CHECK at runtime (its name is not known here): the check
-- constraint(s) on posts whose definition mentions 'survived'. Drop it and
-- re-add it as posts_status_check with 'expired' included. Re-running finds
-- the constraint this block added, drops it, and re-adds it.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.posts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%survived%'
  loop
    execute format('alter table public.posts drop constraint %I', c.conname);
  end loop;

  alter table public.posts
    add constraint posts_status_check
    check (status in ('trial', 'incomplete', 'survived', 'archived', 'expired'));
end $$;

-- ── 2. trial_config ─────────────────────────────────────────────────────────
-- Server-side only: RLS is enabled with no policies, so API roles cannot read
-- or write it. Edit it in the SQL editor / dashboard as the postgres role.
create table if not exists public.trial_config (
  key        text primary key,
  value      numeric not null,
  updated_at timestamptz default now()
);

alter table public.trial_config enable row level security;

insert into public.trial_config (key, value) values
  ('gate_min',            3),
  ('gate_fraction',       0.25),
  ('floor_points',        2),
  ('reaction_weight',     2),
  ('like_weight',         1),
  ('settle_minutes',      10),
  ('distribution_hours',  24),
  ('retention_days',      7),
  ('active_window_days',  7)
on conflict (key) do nothing;

-- ── 3. run_survival_checkpoint() ────────────────────────────────────────────
create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- trial_config values, read ONCE per run. The defaults below apply when a
  -- row is missing.
  v_gate_min             numeric;
  v_gate_fraction        numeric;
  v_floor_points         numeric;
  v_reaction_weight      numeric;
  v_like_weight          numeric;
  v_settle_minutes       numeric;
  v_distribution_hours   numeric;
  v_active_window_days   numeric;
  v_settle_interval      interval;
  v_distribution_window  interval;
  v_active_since         timestamptz;
  processed integer;
  survived_ids uuid[];
  survived_users uuid[];
  archived_ids uuid[];
  archived_users uuid[];
  active_users integer;
  required_views integer;
begin
  select
    coalesce(max(value) filter (where key = 'gate_min'),           3),
    coalesce(max(value) filter (where key = 'gate_fraction'),      0.25),
    coalesce(max(value) filter (where key = 'floor_points'),       2),
    coalesce(max(value) filter (where key = 'reaction_weight'),    2),
    coalesce(max(value) filter (where key = 'like_weight'),        1),
    coalesce(max(value) filter (where key = 'settle_minutes'),     10),
    coalesce(max(value) filter (where key = 'distribution_hours'), 24),
    coalesce(max(value) filter (where key = 'active_window_days'), 7)
  into v_gate_min, v_gate_fraction, v_floor_points, v_reaction_weight,
       v_like_weight, v_settle_minutes, v_distribution_hours, v_active_window_days
  from public.trial_config;

  v_settle_interval     := v_settle_minutes * interval '1 minute';
  v_distribution_window := v_distribution_hours * interval '1 hour';
  v_active_since        := now() - (v_active_window_days * interval '1 day');

  -- Exposure gate: computed once per run from users active in the window.
  select count(*)::int
  into active_users
  from (
    select viewer_id as uid from public.post_raw_views       where created_at >= v_active_since
    union
    select viewer_id         from public.post_qualified_views where created_at >= v_active_since
    union
    select user_id           from public.likes                where created_at >= v_active_since
    union
    -- posts includes video reactions (parent_post_id is not null)
    select user_id           from public.posts                where created_at >= v_active_since
  ) a;

  required_views := least(
    100,
    greatest(v_gate_min, ceil(active_users * v_gate_fraction)),
    greatest(1, active_users - 1)
  )::int;

  with candidates as (
    -- Root posts only: reactions are never judged. 'incomplete' posts are only
    -- looked at again once they have reached the gate; below the gate they are
    -- left alone (no re-scoring, no rewrite).
    select p.id, p.user_id, p.qualified_view_count,
           (p.checkpoint_at <= now()) as is_24h
    from public.posts p
    where p.parent_post_id is null
      and p.checkpoint_at is not null
      and (p.status = 'trial'
           or (p.status = 'incomplete' and p.qualified_view_count >= required_views))
  ),
  scored as (
    select
      c.id, c.user_id, c.qualified_view_count, c.is_24h,
      -- When the gate was actually met: created_at of the Nth qualified view
      -- (N = required_views). Only looked up for posts that already have N views.
      case when c.qualified_view_count >= required_views then (
        select v.created_at
        from public.post_qualified_views v
        where v.post_id = c.id
        order by v.created_at
        offset (required_views - 1)
        limit 1
      ) end as nth_view_at,
      (select count(distinct r.user_id) from public.posts r where r.parent_post_id = c.id and r.user_id <> c.user_id) as video_reactions,
      (select count(*) from public.likes l where l.post_id = c.id and l.user_id <> c.user_id) as likes
    from candidates c
  ),
  decided as (
    -- verdict is NULL when nothing should change for this post this run.
    select
      s.id, s.user_id,
      case
        when s.qualified_view_count >= required_views then
          case
            -- Gate met and engagement met: survive immediately, at any age.
            when (s.video_reactions * v_reaction_weight) + (s.likes * v_like_weight) >= v_floor_points
              then 'survived'
            -- Gate met, engagement missed: archive once the Nth view is
            -- settled (older than settle_minutes). If the Nth view row cannot
            -- be found (counter ahead of the rows) fall back to 24h+.
            when (s.nth_view_at is not null and s.nth_view_at <= now() - v_settle_interval)
              or (s.nth_view_at is null and s.is_24h)
              then 'archived'
            -- else: still settling, leave as 'trial'
          end
        -- Below the gate: parked silently as 'incomplete' at 24h+ (once).
        when s.is_24h then 'incomplete'
      end as verdict
    from scored s
  ),
  updated as (
    update public.posts p
    set status = d.verdict,
        survived_at = case when d.verdict = 'survived' then now() else p.survived_at end,
        distribution_started_at = case when d.verdict = 'survived' then now() else p.distribution_started_at end,
        distribution_expires_at = case when d.verdict = 'survived' then now() + v_distribution_window else p.distribution_expires_at end
    from decided d
    where p.id = d.id
      and d.verdict is not null
    returning p.id, p.user_id, p.status as final_status
  )
  select
    count(*),
    coalesce(array_agg(u.id)      filter (where u.final_status = 'survived'), '{}'),
    coalesce(array_agg(u.user_id) filter (where u.final_status = 'survived'), '{}'),
    coalesce(array_agg(u.id)      filter (where u.final_status = 'archived'), '{}'),
    coalesce(array_agg(u.user_id) filter (where u.final_status = 'archived'), '{}')
  into processed, survived_ids, survived_users, archived_ids, archived_users
  from updated u;

  -- Verdict notifications: creator only; 'incomplete' stays silent. Each
  -- transition happens at most once (only 'trial' and gated 'incomplete' posts
  -- are ever updated), so these cannot duplicate.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_survived', u.pid
  from unnest(survived_ids, survived_users) as u(pid, uid);

  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_archived', u.pid
  from unnest(archived_ids, archived_users) as u(pid, uid);

  return processed;
end;
$$;

-- Cron: same job name, every 5 minutes (unchanged)
select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'survival-checkpoint';

select cron.schedule(
  'survival-checkpoint',
  '*/5 * * * *',
  $cron$
    select public.run_survival_checkpoint();
  $cron$
);

-- ── 4. expire_posts() (defined, NOT scheduled) ───────────────────────────────
-- Survived posts whose distribution window has ended become 'expired'.
-- Reactions (parent_post_id not null) become 'expired' when their parent is
-- expired or archived; repeated so replies to reactions follow in the same call.
-- Deletes nothing: no row, no file. Nothing calls it until
-- migration-lifecycle-expiry.sql schedules the 'expire-posts' cron job.
create or replace function public.expire_posts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer := 0;
  n integer;
  guard integer := 0;
begin
  update public.posts p
  set status = 'expired',
      expired_at = now()
  where p.status = 'survived'
    and p.distribution_expires_at is not null
    and p.distribution_expires_at <= now();
  get diagnostics n = row_count;
  total := total + n;

  loop
    update public.posts c
    set status = 'expired',
        expired_at = now()
    from public.posts p
    where c.parent_post_id = p.id
      and c.status <> 'expired'
      and p.status in ('expired', 'archived');
    get diagnostics n = row_count;
    total := total + n;

    guard := guard + 1;
    exit when n = 0 or guard >= 5;
  end loop;

  return total;
end;
$$;

-- ── 5. Reactions need a live parent ─────────────────────────────────────────
create or replace function public.check_reaction_parent()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_status text;
begin
  if new.parent_post_id is null then
    return new;
  end if;

  select p.status into parent_status
  from public.posts p
  where p.id = new.parent_post_id;

  if not found then
    raise exception 'Cannot react: the post does not exist.'
      using errcode = 'foreign_key_violation';
  end if;

  if parent_status in ('archived', 'expired') then
    raise exception 'Cannot react: this post is no longer available (trial ended or expired).'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists check_reaction_parent on public.posts;
create trigger check_reaction_parent
  before insert on public.posts
  for each row
  execute function public.check_reaction_parent();

-- ── 8. force_post_defaults ──────────────────────────────────────────────────
-- Signed-in API users (auth.uid() is not null) cannot choose their own status,
-- counters or lifecycle timestamps. The SQL editor and the service role have no
-- auth.uid(), so they are not affected. moderation_status, is_mature and every
-- other column are left exactly as sent.
--
-- Trigger order: PostgreSQL fires triggers of the same timing and event in
-- alphabetical order by trigger name. check_reaction_parent < force_post_defaults
-- < trg_set_checkpoint_at, so this runs before trg_set_checkpoint_at.
create or replace function public.force_post_defaults()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is not null then
    new.status                  := 'trial';
    new.qualified_view_count    := 0;
    new.view_count              := 0;
    new.like_count              := 0;
    new.reaction_count          := 0;
    new.survived_at             := null;
    new.distribution_started_at := null;
    new.distribution_expires_at := null;
    new.expired_at              := null;
    new.media_deleted_at        := null;
  end if;
  return new;
end;
$$;

drop trigger if exists force_post_defaults on public.posts;
create trigger force_post_defaults
  before insert on public.posts
  for each row
  execute function public.force_post_defaults();

-- ── 6. Indexes ──────────────────────────────────────────────────────────────
create index if not exists posts_status_distribution_expires_idx
  on public.posts (status, distribution_expires_at);

create index if not exists post_qualified_views_post_created_idx
  on public.post_qualified_views (post_id, created_at);

-- created_at indexes used by the active-users count in run_survival_checkpoint
create index if not exists likes_created_at_idx
  on public.likes (created_at);
create index if not exists post_raw_views_created_at_idx
  on public.post_raw_views (created_at);
create index if not exists post_qualified_views_created_at_idx
  on public.post_qualified_views (created_at);

-- ── 7. Legacy posts ─────────────────────────────────────────────────────────
-- Root posts from before the survival system (checkpoint_at is null) that are
-- still 'trial' or 'survived' become 'archived' (hidden from other users by the
-- existing client filters; shown to their owner as "Trial ended"). Their
-- original status is saved first so the change can be undone exactly (see the
-- rollback notes below). run_survival_checkpoint() ignores posts without
-- checkpoint_at, so they are never judged again.
create table if not exists public.posts_legacy_status_backup (
  post_id    uuid primary key,
  old_status text not null,
  saved_at   timestamptz not null default now()
);

alter table public.posts_legacy_status_backup enable row level security;

insert into public.posts_legacy_status_backup (post_id, old_status)
select p.id, p.status
from public.posts p
where p.parent_post_id is null
  and p.checkpoint_at is null
  and p.status in ('trial', 'survived')
on conflict (post_id) do nothing;

update public.posts p
set status = 'archived'
where p.parent_post_id is null
  and p.checkpoint_at is null
  and p.status in ('trial', 'survived');

-- ── Read-only previews (run separately; safe to run BEFORE this migration) ───
-- They use literal defaults (no trial_config) and only columns that exist today.
-- (to_jsonb(p) ->> '...' reads a column that may not exist yet as NULL.)
--
-- 1) Counts by status (root posts vs reactions):
-- select status, parent_post_id is not null as is_reaction, count(*) as posts
-- from public.posts
-- group by 1, 2
-- order by 1, 2;
--
-- 2) Legacy posts (root posts with no checkpoint_at, still trial/survived):
--    the ones this migration archives. Count, then the list:
-- select status, count(*) as legacy_posts
-- from public.posts
-- where parent_post_id is null and checkpoint_at is null and status in ('trial', 'survived')
-- group by status
-- order by status;
--
-- select id, user_id, status, created_at
-- from public.posts
-- where parent_post_id is null and checkpoint_at is null and status in ('trial', 'survived')
-- order by created_at;
--
-- 3) Survived posts with no distribution_expires_at (expire_posts() would ignore
--    them; see migration-lifecycle-expiry.sql step C):
-- select p.id, p.created_at, p.checkpoint_at
-- from public.posts p
-- where p.status = 'survived'
--   and p.parent_post_id is null
--   and to_jsonb(p) ->> 'distribution_expires_at' is null
-- order by p.created_at;
--
-- 4) Posts that would flip to archived on the next survival run (gate met, bar
--    missed, Nth view settled). Literal defaults: gate_min 3, gate_fraction 0.25,
--    floor_points 2, reaction_weight 2, like_weight 1, settle 10 minutes, active
--    window 7 days. The author's own likes are not counted.
-- with active as (
--   select count(*)::int as n from (
--     select viewer_id as uid from public.post_raw_views       where created_at >= now() - interval '7 days'
--     union select viewer_id         from public.post_qualified_views where created_at >= now() - interval '7 days'
--     union select user_id           from public.likes                where created_at >= now() - interval '7 days'
--     union select user_id           from public.posts                where created_at >= now() - interval '7 days'
--   ) a
-- ), gate as (
--   select least(100, greatest(3, ceil(n * 0.25)), greatest(1, n - 1))::int as required_views from active
-- ), scored as (
--   select p.id, p.status, p.qualified_view_count, g.required_views,
--          (select count(distinct r.user_id) from public.posts r where r.parent_post_id = p.id and r.user_id <> p.user_id) * 2
--            + (select count(*) from public.likes l where l.post_id = p.id and l.user_id <> p.user_id) * 1 as engagement,
--          case when p.qualified_view_count >= g.required_views then (
--            select v.created_at from public.post_qualified_views v where v.post_id = p.id
--            order by v.created_at offset (g.required_views - 1) limit 1) end as nth_view_at,
--          (p.checkpoint_at <= now()) as is_24h
--   from public.posts p cross join gate g
--   where p.parent_post_id is null and p.checkpoint_at is not null and p.status in ('trial', 'incomplete')
-- )
-- select id, status as current_status, qualified_view_count, required_views, engagement, nth_view_at
-- from scored
-- where qualified_view_count >= required_views
--   and engagement < 2
--   and ((nth_view_at is not null and nth_view_at <= now() - interval '10 minutes')
--        or (nth_view_at is null and is_24h));

-- ── Rollback notes (comments; run the statements you need, in this order) ───
-- If migration-lifecycle-expiry.sql was run, roll that file back FIRST (its own
-- rollback section), then:
-- a) Put legacy posts back exactly as they were (only rows this file archived;
--    run_survival_checkpoint never touches them):
--      update public.posts p
--      set status = b.old_status
--      from public.posts_legacy_status_backup b
--      where b.post_id = p.id
--        and p.status = 'archived'
--        and p.parent_post_id is null
--        and p.checkpoint_at is null;
-- b) Remove the new triggers and functions:
--      drop trigger if exists force_post_defaults on public.posts;
--      drop trigger if exists check_reaction_parent on public.posts;
--      drop function if exists public.force_post_defaults();
--      drop function if exists public.check_reaction_parent();
--      drop function if exists public.expire_posts();
-- c) Restore the previous 4-value status CHECK (only if no row is 'expired'):
--      alter table public.posts drop constraint if exists posts_status_check;
--      alter table public.posts add constraint posts_status_check
--        check (status in ('trial', 'survived', 'archived', 'incomplete'));
-- d) Restore the previous survival function: re-run migration-verdict-at-n-views.sql
--    (the version this file replaced; it also re-registers 'survival-checkpoint').
-- e) The new columns, trial_config and posts_legacy_status_backup can stay; they
--    are unused by the old function. To remove them:
--      alter table public.posts drop column if exists survived_at,
--        drop column if exists distribution_started_at, drop column if exists distribution_expires_at,
--        drop column if exists expired_at, drop column if exists media_deleted_at;
--      drop table if exists public.trial_config;
--      drop table if exists public.posts_legacy_status_backup;
