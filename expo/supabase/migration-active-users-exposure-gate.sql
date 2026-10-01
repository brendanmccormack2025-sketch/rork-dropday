-- Exposure gate based on recently active users (idempotent).
--
-- Replaces the gate inside run_survival_checkpoint():
--   old: LEAST(100, GREATEST(5, CEIL(profiles * 0.25)))
--   new: LEAST(100, GREATEST(3, CEIL(active_users * 0.25)), GREATEST(1, active_users - 1))
-- where active_users = distinct users with any activity in the last 7 days:
--   post_raw_views.viewer_id, post_qualified_views.viewer_id, likes.user_id,
--   posts.user_id (posts includes video reactions via parent_post_id).
-- active_users is computed once per function run, not per post.
--
-- Everything else is copied unchanged from migration-notifications-early-survival.sql:
-- engagement formula + floor 2, early survival, 24h archive, incomplete (silent),
-- verdict + followed_post_survived notifications, and the */5 cron job.
--
-- Run manually in the Supabase SQL editor. Safe to re-run.

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
  -- Exposure gate: computed fresh every run (once, not per post) from the
  -- number of users active in the last 7 days.
  active_users integer;
  required_views integer;
begin
  select count(*)::int
  into active_users
  from (
    select viewer_id as uid from public.post_raw_views       where created_at >= now() - interval '7 days'
    union
    select viewer_id         from public.post_qualified_views where created_at >= now() - interval '7 days'
    union
    select user_id           from public.likes                where created_at >= now() - interval '7 days'
    union
    -- posts includes video reactions (parent_post_id is not null)
    select user_id           from public.posts                where created_at >= now() - interval '7 days'
  ) a;

  required_views := least(
    100,
    greatest(3, ceil(active_users * 0.25)),
    greatest(1, active_users - 1)
  )::int;

  with candidates as (
    select p.id, p.user_id, p.qualified_view_count,
           (p.checkpoint_at <= now()) as is_24h
    from public.posts p
    where p.status in ('trial', 'incomplete')
      and p.checkpoint_at is not null
  ),
  scored as (
    select
      c.id, c.user_id, c.qualified_view_count, c.is_24h,
      (select count(*) from public.posts   r where r.parent_post_id = c.id)                              as video_reactions,
      (select count(*) from public.likes   l where l.post_id = c.id)                                    as likes,
      (select count(*) from public.follows f where f.followee_id = c.user_id and f.status = 'accepted') as followers
    from candidates c
  ),
  updated as (
    update public.posts p
    set status = case
      -- EARLY SURVIVAL: gate AND engagement met — at ANY age.
      when s.qualified_view_count >= required_views
           and (s.video_reactions * 5) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
        then 'survived'
      -- Gate met, engagement missed: only a verdict at 24h+ (fail).
      when s.qualified_view_count >= required_views
        then 'archived'
      -- Gate unmet at 24h+: underexposed — park as incomplete (silent).
      else 'incomplete'
    end
    from scored s
    where p.id = s.id
      -- Only write rows where a decision is actually made. Young undecided
      -- posts (no gate yet, or gate-but-no-engagement before 24h) stay
      -- 'trial' and are left untouched.
      and (
        (s.qualified_view_count >= required_views
          and ((s.video_reactions * 5) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
               or s.is_24h))
        or (s.qualified_view_count < required_views and s.is_24h)
      )
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
  -- transition happens at most once (the UPDATE only touches trial/incomplete),
  -- so these can never duplicate.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_survived', u.pid
  from unnest(survived_ids, survived_users) as u(pid, uid);

  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_archived', u.pid
  from unnest(archived_ids, archived_users) as u(pid, uid);

  -- Follower fan-out: fire on the survive transition ONLY (archived posts
  -- never reach this). ONE INSERT...SELECT — no loop. Once per follower per
  -- post via the partial unique index + ON CONFLICT DO NOTHING.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select f.follower_id, s.uid, 'followed_post_survived', s.pid
  from unnest(survived_ids, survived_users) as s(pid, uid)
  join public.follows f
    on f.followee_id = s.uid
   and f.status = 'accepted'
  where f.follower_id <> s.uid
  on conflict (recipient_id, post_id) where type = 'followed_post_survived'
  do nothing;

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

-- ── Read-only check (run separately; not part of the migration) ─────────────
-- select a.active_users,
--        least(100, greatest(3, ceil(a.active_users * 0.25)), greatest(1, a.active_users - 1))::int as gate
-- from (
--   select count(*)::int as active_users
--   from (
--     select viewer_id as uid from public.post_raw_views       where created_at >= now() - interval '7 days'
--     union
--     select viewer_id         from public.post_qualified_views where created_at >= now() - interval '7 days'
--     union
--     select user_id           from public.likes                where created_at >= now() - interval '7 days'
--     union
--     select user_id           from public.posts                where created_at >= now() - interval '7 days'
--   ) u
-- ) a;
