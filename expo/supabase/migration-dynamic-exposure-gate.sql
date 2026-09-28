-- ============================================================================
-- Dynamic exposure gate: qualified-view threshold scales with user base size
-- ============================================================================
-- Problem: the checkpoint's exposure gate was a hardcoded qualified views >= 100.
-- With a small beta user base, posts can't reach 100 real qualified viewers, so
-- they sit in 'incomplete' forever — and since followers can't see a post until
-- it survives, the growth loop deadlocks.
--
-- Fix: compute the requirement LIVE inside run_survival_checkpoint() on every
-- run, from the current total profile count (no stored/cached value that could
-- go stale):
--
--   requirement = LEAST(100, GREATEST(5, CEIL(total_users * 0.25)))
--
-- "Total users" source: total rows in public.profiles. There is NO existing
-- activity tracking (profiles has no last_active / last_seen column), so per
-- the spec we use the simple total rather than building new tracking.
--
-- Everything else is unchanged: the 24h-AND-exposure dual condition, the
-- 'incomplete' parked status, indefinite re-checks on the 15-min cron, the
-- engagement math, and verdict notifications.
-- Idempotent: create or replace — safe to re-run.
-- ============================================================================

create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  processed integer;
  survived_ids uuid[];
  survived_users uuid[];
  archived_ids uuid[];
  archived_users uuid[];
  -- Computed fresh on every run from the live profile count — never cached.
  -- Floors at 5 (so the gate can't be trivially passed by 0-4 users), caps at
  -- 100 (so the original full-scale target is preserved as the user base grows).
  required_views integer;
begin
  select least(100, greatest(5, ceil((select count(*) from public.profiles) * 0.25)))::int
  into required_views;

  with candidates as (
    select p.id, p.user_id, p.qualified_view_count
    from public.posts p
    where p.status in ('trial', 'incomplete')
      and p.checkpoint_at is not null
      -- checkpoint_at <= now() applies to BOTH statuses: a post that reaches
      -- the view minimum before its 24h mark stays 'trial' and untouched
      -- until checkpoint_at passes. The gate only ever extends the window
      -- (via 'incomplete' re-checks); it never shortens it.
      and p.checkpoint_at <= now()
  ),
  scored as (
    select
      c.id,
      c.qualified_view_count,
      (select count(*) from public.posts   r where r.parent_post_id = c.id)                               as video_reactions,
      (select count(*) from public.likes   l where l.post_id = c.id)                                     as likes,
      (select count(*) from public.follows f where f.followee_id = c.user_id and f.status = 'accepted')  as followers
    from candidates c
  ),
  updated as (
    update public.posts p
    set status = case
      -- Exposure gate: below the current user-scaled qualified-view requirement
      -- the engagement signal can't be judged fairly — park as 'incomplete' and
      -- re-check on the next run. Only reached for candidates that already
      -- passed checkpoint_at <= now(), so a real verdict requires BOTH
      -- checkpoint_at <= now() AND views >= required_views.
      when s.qualified_view_count < required_views
        then 'incomplete'
      -- Unchanged engagement math: video_reactions * 5 + likes
      -- vs follower-scaled expected value.
      when (s.video_reactions * 5) + s.likes >= greatest(3, power(s.followers, 1.3) * 0.02)
        then 'survived'
      else 'archived'
    end
    from scored s
    where p.id = s.id
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

  -- Verdict notifications: one row per transitioned post, delivered to the
  -- post's creator (actor = creator — a system verdict, not another user's
  -- action). No duplicate risk: the UPDATE above only touches trial/incomplete
  -- posts, so each transition happens at most once and is captured in this
  -- same call; the function is security definer, bypassing notifications RLS.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_survived', u.pid
  from unnest(survived_ids, survived_users) as u(pid, uid);

  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_archived', u.pid
  from unnest(archived_ids, archived_users) as u(pid, uid);

  return processed;
end;
$$;

-- No cron changes needed: the existing 'survival-checkpoint' job (*/15 min)
-- calls run_survival_checkpoint(), which is replaced in place above.
