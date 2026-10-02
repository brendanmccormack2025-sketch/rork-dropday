-- ============================================================================
-- Post lifecycle, part 2 of 2: expiry (idempotent)
-- ============================================================================
-- !! RUN THIS ONLY AFTER THE CLIENT HANDLES THE 'expired' STATUS !!
-- Installed app builds that do not know 'expired' crash when they render such a
-- post (TrialStatusBadge has no entry for it) and their feed queries still
-- return it. Ship a client that handles 'expired' first (status badge entry and
-- an allow-list of statuses in the feed, profile and reaction queries).
--
-- Requires migration-lifecycle.sql to have been run first (it defines
-- expire_posts(), the 'expired' value in the status CHECK, and the lifecycle
-- columns). This file stops with an error if that is not the case.
--
-- What this file does:
--   A. Schedules the cron job 'expire-posts' (every 5 minutes) that calls
--      expire_posts(). The only step that runs by default.
--   B. OPTIONAL, commented out: convert the legacy posts that migration-
--      lifecycle.sql archived (listed in posts_legacy_status_backup) to 'expired'.
--   C. OPTIONAL, commented out: backfill the distribution window for survivors
--      that have none. Real survivors get a fresh 24 hours; hand-boosted ones
--      expire now. Pick ONE rule per group and uncomment it.
-- Nothing here deletes a row or a file.
--
-- Run manually in the Supabase SQL editor. Safe to re-run.

-- ── Safety checks ───────────────────────────────────────────────────────────
do $$
begin
  if to_regprocedure('public.expire_posts()') is null then
    raise exception 'public.expire_posts() is missing: run migration-lifecycle.sql first.';
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.posts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%expired%'
  ) then
    raise exception 'posts status CHECK does not allow ''expired'': run migration-lifecycle.sql first.';
  end if;
end $$;

-- ── A. Schedule the expiry job ──────────────────────────────────────────────
select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'expire-posts';

select cron.schedule(
  'expire-posts',
  '*/5 * * * *',
  $cron$
    select public.expire_posts();
  $cron$
);

-- ── B. OPTIONAL: legacy archived posts -> expired (uncomment to run) ────────
-- Only rows still 'archived' that migration-lifecycle.sql archived (they are in
-- the backup table, are root posts and have no checkpoint_at).
--
-- update public.posts p
-- set status = 'expired',
--     expired_at = now()
-- from public.posts_legacy_status_backup b
-- where b.post_id = p.id
--   and p.status = 'archived'
--   and p.parent_post_id is null
--   and p.checkpoint_at is null;

-- ── C. OPTIONAL: survivors that have no distribution window ─────────────────
-- Survivors from before the lifecycle columns have distribution_expires_at NULL,
-- so expire_posts() ignores them forever. First look at them:
--
--   select p.id, p.created_at, p.survived_at,
--          exists (select 1 from public.notifications n
--                  where n.post_id = p.id and n.type = 'verdict_survived') as survived_by_verdict
--   from public.posts p
--   where p.status = 'survived' and p.parent_post_id is null and p.distribution_expires_at is null
--   order by p.created_at;
--
-- "Real" survivors = the survival function judged them (a verdict_survived
-- notification exists for the post). "Hand-boosted" = status set to 'survived'
-- by hand (no such notification). This is a heuristic: check the list above.
--
-- C1. Save the current values first, so the step can be undone exactly:
--
-- create table if not exists public.posts_survivor_backfill_backup (
--   post_id                 uuid primary key,
--   old_status              text not null,
--   old_survived_at         timestamptz,
--   old_distribution_started_at timestamptz,
--   old_distribution_expires_at timestamptz,
--   saved_at                timestamptz not null default now()
-- );
-- alter table public.posts_survivor_backfill_backup enable row level security;
--
-- insert into public.posts_survivor_backfill_backup
--   (post_id, old_status, old_survived_at, old_distribution_started_at, old_distribution_expires_at)
-- select p.id, p.status, p.survived_at, p.distribution_started_at, p.distribution_expires_at
-- from public.posts p
-- where p.status = 'survived' and p.parent_post_id is null and p.distribution_expires_at is null
-- on conflict (post_id) do nothing;
--
-- C2. Real survivors: a fresh 24-hour window from now.
--
-- update public.posts p
-- set survived_at = coalesce(p.survived_at, now()),
--     distribution_started_at = coalesce(p.distribution_started_at, now()),
--     distribution_expires_at = now() + interval '24 hours'
-- where p.status = 'survived' and p.parent_post_id is null and p.distribution_expires_at is null
--   and exists (select 1 from public.notifications n
--               where n.post_id = p.id and n.type = 'verdict_survived');
--
-- C3. Hand-boosted survivors: expire now.
--
-- update public.posts p
-- set status = 'expired',
--     expired_at = now()
-- where p.status = 'survived' and p.parent_post_id is null and p.distribution_expires_at is null
--   and not exists (select 1 from public.notifications n
--                   where n.post_id = p.id and n.type = 'verdict_survived');

-- ── Rollback notes (comments; run the statements you need, in this order) ───
-- 1. Stop the job:
--      select cron.unschedule(jobid) from cron.job where jobname = 'expire-posts';
-- 2. Undo C (only if you ran C1-C3): restore exactly from the backup table.
--      update public.posts p
--      set status = b.old_status,
--          survived_at = b.old_survived_at,
--          distribution_started_at = b.old_distribution_started_at,
--          distribution_expires_at = b.old_distribution_expires_at,
--          expired_at = null
--      from public.posts_survivor_backfill_backup b
--      where b.post_id = p.id;
--      -- then optionally: drop table if exists public.posts_survivor_backfill_backup;
-- 3. Undo B (only if you ran B): legacy posts back to 'archived'.
--      update public.posts p
--      set status = 'archived', expired_at = null
--      from public.posts_legacy_status_backup b
--      where b.post_id = p.id
--        and p.status = 'expired'
--        and p.parent_post_id is null
--        and p.checkpoint_at is null;
-- 4. Undo what the running job did (if it already ran). Posts it expired had a
--    distribution window; reactions it expired were 'trial' (new reactions are
--    forced to 'trial'), so this is exact for client-created rows and
--    approximate if you edited statuses by hand:
--      update public.posts set status = 'survived', expired_at = null
--      where status = 'expired' and parent_post_id is null
--        and distribution_expires_at is not null;
--      update public.posts set status = 'trial', expired_at = null
--      where status = 'expired' and parent_post_id is not null;
