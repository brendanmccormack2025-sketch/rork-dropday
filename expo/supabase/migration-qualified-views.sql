-- ============================================================================
-- Qualified views / exposure gate for the survival checkpoint
-- ============================================================================
-- Adds an exposure gate on top of migration-survival-checkpoint.sql:
--   A post can't receive a verdict (survived/archived) until it has actually
--   been SEEN enough to judge fairly.
--   Qualified view = a viewer watching the post for >= 3 seconds.
--   Gate: at the 24hr checkpoint, qualified_view_count >= 100 else 'incomplete'.
--   'incomplete' posts are re-checked on every 15-min cron run (indefinitely)
--   until the gate passes; then the existing engagement math issues the
--   real verdict.
-- Separate from view_count (raw impressions) — qualified views are a stricter,
-- deduplicated-per-viewer subset.
-- Idempotent: safe to re-run.
-- ============================================================================

-- 1. Column -------------------------------------------------------------------
alter table public.posts
  add column if not exists qualified_view_count integer not null default 0;

-- 2. Extend the status constraint to include 'incomplete' -----------------------
do $$
begin
  alter table public.posts drop constraint if exists posts_status_check;
  alter table public.posts
    add constraint posts_status_check
    check (status in ('trial', 'survived', 'archived', 'incomplete'));
exception
  when duplicate_object then null; -- constraint already exists (re-run)
end $$;

-- 3. Per-viewer dedupe table -----------------------------------------------------
create table if not exists public.post_qualified_views (
  post_id    uuid not null references public.posts(id) on delete cascade,
  viewer_id  uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);

alter table public.post_qualified_views enable row level security;

drop policy if exists pv_qualified_views_insert on public.post_qualified_views;
create policy pv_qualified_views_insert
  on public.post_qualified_views
  for insert to authenticated
  with check (viewer_id = auth.uid());

-- 4. Denormalized counter maintenance ---------------------------------------------
-- Fires only on real inserts; 'on conflict do nothing' never triggers it,
-- so a viewer can never double-count.
create or replace function public.sync_qualified_view_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts
  set qualified_view_count = qualified_view_count + 1
  where id = new.post_id;
  return new;
end;
$$;

drop trigger if exists trg_sync_qualified_view_count on public.post_qualified_views;
create trigger trg_sync_qualified_view_count
  after insert on public.post_qualified_views
  for each row
  execute function public.sync_qualified_view_count();

-- 5. RPC called by the client when a viewer crosses the 3-second threshold --------
create or replace function public.record_qualified_view(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  -- The author's own watches don't count toward exposure.
  if exists (
    select 1 from public.posts
    where id = p_post_id and user_id = auth.uid()
  ) then
    return;
  end if;
  insert into public.post_qualified_views (post_id, viewer_id)
  values (p_post_id, auth.uid())
  on conflict (post_id, viewer_id) do nothing;
end;
$$;

grant execute on function public.record_qualified_view(uuid) to authenticated;

-- 6. Checkpoint function: exposure gate + incomplete re-check -----------------------
-- Candidate selection now picks up 'incomplete' posts too (re-checked every
-- run, indefinitely, until they qualify). Engagement math is unchanged and
-- only evaluated once the exposure gate passes.
-- The checkpoint also writes a verdict_survived / verdict_archived
-- notification row for the post's creator whenever a real verdict is
-- issued; 'incomplete' is a parked state, not a verdict, and stays silent.
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
begin
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
      -- Exposure gate: below 100 qualified views the engagement signal can't be
      -- judged fairly — park as 'incomplete' and re-check on the next run.
      -- Only reached for candidates that already passed checkpoint_at <= now(),
      -- so a real verdict requires BOTH checkpoint_at <= now() AND views >= 100.
      when s.qualified_view_count < 100
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
