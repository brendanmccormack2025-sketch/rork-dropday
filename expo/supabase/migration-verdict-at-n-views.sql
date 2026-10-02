-- Verdict at N qualified views, not at 24h (idempotent).
--
-- Based on run_survival_checkpoint() in migration-reactions-no-verdict-engagement.sql.
-- What changed versus that version (nothing else differs):
--   1. Declared a constant settle_interval = 10 minutes at the top of the function.
--   2. scored CTE: new column nth_view_at = created_at of the post's Nth
--      qualified view (N = required_views, ordered by created_at in
--      post_qualified_views, OFFSET N-1), computed once per candidate and only
--      for posts whose qualified_view_count >= required_views.
--   3. Archive rule: a post with the gate met and engagement below the bar is
--      now archived as soon as nth_view_at is at least settle_interval old,
--      instead of only when is_24h. Fallback: if the Nth view row is missing
--      (counter ahead of the rows) it is still archived at 24h+, as before.
--   4. New index post_qualified_views(post_id, created_at) for the lookup.
-- Unchanged: active-users gate, early survival (gate AND engagement met, at any
-- age, immediate), posts below the gate (trial until 24h, then silent
-- 'incomplete'), engagement formula and floor, reactions never judged,
-- verdict + follower notifications, and the */5 cron job.
--
-- Never re-run older migrations that define run_survival_checkpoint.
-- Run manually in the Supabase SQL editor.

-- Lets the Nth-view lookup read views in time order without sorting every
-- row of the post. (The primary key is (post_id, viewer_id), which cannot.)
create index if not exists post_qualified_views_post_created_idx
  on public.post_qualified_views (post_id, created_at);

create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  -- Settling window: an archive verdict waits until the post's Nth qualified
  -- view (N = required_views) is at least this old. Early survival ignores it.
  settle_interval constant interval := interval '10 minutes';
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
      and p.parent_post_id is null
  ),
  scored as (
    select
      c.id, c.user_id, c.qualified_view_count, c.is_24h,
      -- When the gate was actually met: created_at of the Nth qualified view
      -- (N = required_views). Looked up once per candidate, only for posts
      -- that already have N views; uses post_qualified_views(post_id, created_at).
      case when c.qualified_view_count >= required_views then (
        select v.created_at
        from public.post_qualified_views v
        where v.post_id = c.id
        order by v.created_at
        offset (required_views - 1)
        limit 1
      ) end as nth_view_at,
      (select count(distinct r.user_id) from public.posts r where r.parent_post_id = c.id and r.user_id <> c.user_id) as video_reactions,
      (select count(*) from public.likes   l where l.post_id = c.id)                                    as likes,
      (select count(*) from public.follows f where f.followee_id = c.user_id and f.status = 'accepted') as followers
    from candidates c
  ),
  updated as (
    update public.posts p
    set status = case
      -- EARLY SURVIVAL: gate AND engagement met — at ANY age.
      when s.qualified_view_count >= required_views
           and (s.video_reactions * 2) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
        then 'survived'
      -- Gate met, engagement missed: archived once settled (see WHERE below).
      when s.qualified_view_count >= required_views
        then 'archived'
      -- Gate unmet at 24h+: underexposed — park as incomplete (silent).
      else 'incomplete'
    end
    from scored s
    where p.id = s.id
      -- Only write rows where a decision is actually made. Posts below the
      -- gate stay 'trial' until 24h, then become 'incomplete'. Posts at or
      -- above the gate survive immediately when engagement is met; otherwise
      -- they stay 'trial' until the Nth qualified view is settle_interval old,
      -- then are archived. If the Nth view row cannot be found (counter ahead
      -- of the rows, e.g. after a viewer account was deleted) fall back to the
      -- old rule: archive at 24h+.
      and (
        (s.qualified_view_count >= required_views
          and ((s.video_reactions * 2) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
               or (s.nth_view_at is not null and s.nth_view_at <= now() - settle_interval)
               or (s.nth_view_at is null and s.is_24h)))
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

-- ── Read-only preview (run separately; not part of the migration) ────────────
-- Lists current trial/incomplete root posts with the verdict they would get now
-- under the new rule, next to the old rule for comparison.
--
-- with active as (
--   select count(*)::int as n from (
--     select viewer_id as uid from public.post_raw_views       where created_at >= now() - interval '7 days'
--     union
--     select viewer_id         from public.post_qualified_views where created_at >= now() - interval '7 days'
--     union
--     select user_id           from public.likes                where created_at >= now() - interval '7 days'
--     union
--     select user_id           from public.posts                where created_at >= now() - interval '7 days'
--   ) a
-- ), gate as (
--   select least(100, greatest(3, ceil(n * 0.25)), greatest(1, n - 1))::int as required_views
--   from active
-- ), scored as (
--   select
--     p.id, p.status, p.created_at, p.qualified_view_count,
--     (p.checkpoint_at <= now()) as is_24h,
--     g.required_views,
--     (select count(distinct r.user_id) from public.posts r where r.parent_post_id = p.id and r.user_id <> p.user_id) as video_reactions,
--     (select count(*) from public.likes l where l.post_id = p.id) as likes,
--     (select count(*) from public.follows f where f.followee_id = p.user_id and f.status = 'accepted') as followers,
--     case when p.qualified_view_count >= g.required_views then (
--       select v.created_at from public.post_qualified_views v
--       where v.post_id = p.id order by v.created_at offset (g.required_views - 1) limit 1
--     ) end as nth_view_at
--   from public.posts p
--   cross join gate g
--   where p.status in ('trial', 'incomplete')
--     and p.checkpoint_at is not null
--     and p.parent_post_id is null
-- )
-- select
--   s.id,
--   s.status as current_status,
--   s.qualified_view_count,
--   s.required_views,
--   s.video_reactions,
--   s.likes,
--   s.followers,
--   (s.video_reactions * 2) + s.likes as engagement,
--   greatest(2, power(s.followers, 1.3) * 0.02) as engagement_bar,
--   s.nth_view_at,
--   case
--     when s.qualified_view_count >= s.required_views
--          and (s.video_reactions * 2) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
--       then 'survived'
--     when s.qualified_view_count >= s.required_views
--          and ((s.nth_view_at is not null and s.nth_view_at <= now() - interval '10 minutes')
--               or (s.nth_view_at is null and s.is_24h))
--       then 'archived'
--     when s.qualified_view_count >= s.required_views then 'stays on trial (settling)'
--     when s.is_24h then 'incomplete'
--     else 'stays on trial'
--   end as verdict_new_rule,
--   case
--     when s.qualified_view_count >= s.required_views
--          and (s.video_reactions * 2) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
--       then 'survived'
--     when s.qualified_view_count >= s.required_views and s.is_24h then 'archived'
--     when s.qualified_view_count >= s.required_views then 'stays on trial'
--     when s.is_24h then 'incomplete'
--     else 'stays on trial'
--   end as verdict_old_rule
-- from scored s
-- order by s.created_at desc;
