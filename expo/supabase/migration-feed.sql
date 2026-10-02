-- ============================================================================
-- For You feed order: get_feed(p_limit, p_offset) (idempotent)
-- ============================================================================
-- Returns ordered post ids for the signed-in viewer so the client can stop
-- ranking the newest 300 posts on the device. Run manually in the Supabase SQL
-- editor. Safe to re-run. Requires migration-lifecycle.sql (lifecycle columns,
-- trial_config) to have been run. Does not change run_survival_checkpoint().
--
-- POOLS
--   A  active survivors: root posts, status 'survived' AND
--      distribution_expires_at > now(). A survivor with a NULL window is not in
--      the pool (it is never boosted).
--   B  testing: root posts with status 'trial' or 'incomplete', qualified views
--      still below the current exposure gate (trial_required_views(), same
--      formula and trial_config values as run_survival_checkpoint), and
--      checkpoint_at still in the future (past its 24h deadline = about to
--      expire, not served). The viewer's own posts are excluded (see below).
--
-- ORDER
--   Pool A: seen-by-viewer last; then score DESC; then id.
--     score = ((distinct reactors * reaction_weight + non-author likes * like_weight) + 1)
--             / (qualified_view_count + feed_smoothing)
--             * 1 / (1 + hours_since_survived_at / feed_decay_hours)
--     (hours counted from survived_at, else distribution_started_at, else created_at)
--   Pool B: seen-by-viewer last; then fewest qualified views; then oldest
--     created_at; then id. feed_testing_mode 0 = this order. Mode 1 is reserved
--     for a future relevance order: its branch is a marked placeholder that
--     currently falls back to mode 0.
--   Interleave: every step-th position comes from Pool B, where
--     step = greatest(2, round(1 / feed_testing_ratio)) (0.33 -> every 3rd
--     slot; ratio <= 0 -> testing posts only fill after survivors run out). The
--     rest are Pool A, best first. When one pool runs out the other fills the
--     remaining positions. No randomness: same data, same order, so paging by
--     offset is stable while the data does not change.
--
-- FILTERS REPLICATED FROM THE CLIENT FEED (PostsProvider feedQuery + context)
--   1. root posts only                       (.is("parent_post_id", null))
--   2. moderation_status = 'active'          (.eq("moderation_status","active"))
--   3. status not archived                   (.neq("status","archived")) -> the pools
--      only contain trial/incomplete/survived, which is stricter
--   4. mature content hidden for teen viewers (is_mature, viewer tier from
--      profiles.birthdate; client: tier === 'teen'). Here under_13 is hidden as
--      well (stricter; the client does not hide for under_13). Unknown/adult see all.
--   5. posts by users the viewer blocked     (filterBlocked via user_blocks). Here in
--      BOTH directions (the client only filters blocks the viewer made).
--   6. posts the viewer reported             (filterBlocked via reports, target_type 'post')
--   Not replicated: follower eligibility / follow boost (no follower system), the
--   300-newest window, random jitter, the "no two in a row from one author" shuffle
--   and the 90-second own-post self boost.
--
-- THE VIEWER'S OWN POSTS
--   record_qualified_view() ignores the author's own views (migration-qualified-
--   views.sql), so an author can never add to their own post's exposure count.
--   Own testing posts are therefore NOT in Pool B. Own active survivors stay in
--   Pool A. (record_raw_view() counts the author's impressions, which only affects
--   the "seen" demotion.)
--
-- WHY HELPER FUNCTIONS
--   get_feed is SECURITY INVOKER (RLS and auth.uid() apply), but the tables it
--   needs are protected: trial_config has RLS with no policies; post_qualified_
--   views and post_raw_views have no SELECT policy; user_blocks only shows the
--   viewer the blocks they made (the reverse direction is invisible to them).
--   Four small SECURITY DEFINER helpers expose only what the caller needs:
--   trial_required_views(), feed_settings(), feed_blocked_ids(), feed_seen_ids().
--   Each is scoped to auth.uid() or returns configuration, and is executable by
--   signed-in users only.

-- ── 1. Config (trial_config; defaults never overwrite an existing row) ──────
insert into public.trial_config (key, value) values
  ('feed_testing_ratio', 0.33),
  ('feed_decay_hours',   12),
  ('feed_smoothing',     5),
  ('feed_testing_mode',  0)
on conflict (key) do nothing;

-- ── 2. Indexes ──────────────────────────────────────────────────────────────
-- Pool A lookup (also created by migration-lifecycle.sql under the same name).
create index if not exists posts_status_distribution_expires_idx
  on public.posts (status, distribution_expires_at);

-- Pool B lookup: testing root posts by deadline.
create index if not exists posts_testing_checkpoint_idx
  on public.posts (checkpoint_at)
  where status in ('trial', 'incomplete') and parent_post_id is null;

-- "Has the viewer seen these posts": by viewer, then post. The primary keys are
-- (post_id, viewer_id), which cannot serve a lookup by viewer.
create index if not exists post_qualified_views_viewer_post_idx
  on public.post_qualified_views (viewer_id, post_id);
create index if not exists post_raw_views_viewer_post_idx
  on public.post_raw_views (viewer_id, post_id);

-- ── 3. Helpers (SECURITY DEFINER, read-only) ────────────────────────────────

-- Current exposure gate. Same formula and trial_config keys/defaults as
-- run_survival_checkpoint() in migration-lifecycle.sql.
create or replace function public.trial_required_views()
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_gate_min           numeric;
  v_gate_fraction      numeric;
  v_active_window_days numeric;
  v_active_since       timestamptz;
  active_users         integer;
begin
  select
    coalesce(max(value) filter (where key = 'gate_min'),           3),
    coalesce(max(value) filter (where key = 'gate_fraction'),      0.25),
    coalesce(max(value) filter (where key = 'active_window_days'), 7)
  into v_gate_min, v_gate_fraction, v_active_window_days
  from public.trial_config;

  v_active_since := now() - (v_active_window_days * interval '1 day');

  select count(*)::int
  into active_users
  from (
    select viewer_id as uid from public.post_raw_views       where created_at >= v_active_since
    union
    select viewer_id         from public.post_qualified_views where created_at >= v_active_since
    union
    select user_id           from public.likes                where created_at >= v_active_since
    union
    select user_id           from public.posts                where created_at >= v_active_since
  ) a;

  return least(
    100,
    greatest(v_gate_min, ceil(active_users * v_gate_fraction)),
    greatest(1, active_users - 1)
  )::int;
end;
$$;

-- Feed constants from trial_config, with defaults when a row is missing.
create or replace function public.feed_settings()
returns table (
  testing_ratio   numeric,
  decay_hours     numeric,
  smoothing       numeric,
  testing_mode    integer,
  reaction_weight numeric,
  like_weight     numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(max(value) filter (where key = 'feed_testing_ratio'), 0.33),
    greatest(coalesce(max(value) filter (where key = 'feed_decay_hours'), 12), 0.01),
    greatest(coalesce(max(value) filter (where key = 'feed_smoothing'), 5), 0),
    coalesce(max(value) filter (where key = 'feed_testing_mode'), 0)::int,
    coalesce(max(value) filter (where key = 'reaction_weight'), 2),
    coalesce(max(value) filter (where key = 'like_weight'), 1)
  from public.trial_config;
$$;

-- Users the signed-in viewer blocked OR who blocked the viewer.
create or replace function public.feed_blocked_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select b.blocked_id from public.user_blocks b where b.blocker_id = auth.uid()
  union
  select b.blocker_id from public.user_blocks b where b.blocked_id = auth.uid();
$$;

-- Which of the given posts the signed-in viewer has already seen (qualified or raw view).
create or replace function public.feed_seen_ids(p_post_ids uuid[])
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select v.post_id from public.post_qualified_views v
  where v.viewer_id = auth.uid() and v.post_id = any (p_post_ids)
  union
  select v.post_id from public.post_raw_views v
  where v.viewer_id = auth.uid() and v.post_id = any (p_post_ids);
$$;

-- ── 4. get_feed ─────────────────────────────────────────────────────────────
create or replace function public.get_feed(p_limit integer default 20, p_offset integer default 0)
returns table (post_id uuid, "position" integer)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_uid         uuid    := auth.uid();
  v_limit       integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset      integer := greatest(coalesce(p_offset, 0), 0);
  cfg           record;
  v_required    integer;
  v_step        integer;
  v_hide_mature boolean := false;
begin
  if v_uid is null then
    return;
  end if;

  select * into cfg from public.feed_settings();
  v_required := public.trial_required_views();

  -- Every v_step-th slot is a testing post. A huge step when the ratio is <= 0
  -- means testing posts only appear after the survivors run out.
  v_step := case
    when cfg.testing_ratio <= 0 then 1000000
    else greatest(2, round(1.0 / cfg.testing_ratio))::int
  end;

  -- Same tiers as public.age_tier(): mature content is hidden for under_13 and teen.
  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false)
  into v_hide_mature
  from public.profiles pr
  where pr.id = v_uid;
  v_hide_mature := coalesce(v_hide_mature, false);

  return query
  with blocked as (
    select u as id from public.feed_blocked_ids() u
  ),
  pool_a as (
    select p.id, p.user_id, p.created_at, p.qualified_view_count,
           coalesce(p.survived_at, p.distribution_started_at, p.created_at) as survived_ref
    from public.posts p
    where p.status = 'survived'
      and p.distribution_expires_at > now()
      and p.parent_post_id is null
      and p.moderation_status = 'active'
      and p.media_deleted_at is null
      and (not v_hide_mature or not p.is_mature)
      and not exists (select 1 from blocked b where b.id = p.user_id)
      and not exists (
        select 1 from public.reports r
        where r.reporter_id = v_uid and r.target_type = 'post' and r.target_id = p.id
      )
  ),
  pool_b as (
    select p.id, p.created_at, p.qualified_view_count
    from public.posts p
    where p.status in ('trial', 'incomplete')
      and p.checkpoint_at > now()
      and p.qualified_view_count < v_required
      and p.user_id <> v_uid
      and p.parent_post_id is null
      and p.moderation_status = 'active'
      and p.media_deleted_at is null
      and (not v_hide_mature or not p.is_mature)
      and not exists (select 1 from blocked b where b.id = p.user_id)
      and not exists (
        select 1 from public.reports r
        where r.reporter_id = v_uid and r.target_type = 'post' and r.target_id = p.id
      )
  ),
  seen as (
    select u as id
    from public.feed_seen_ids(
      (select array_agg(c.id) from (select id from pool_a union all select id from pool_b) c)
    ) u
  ),
  scored_a as (
    select a.id,
           (a.id in (select id from seen)) as was_seen,
           ((coalesce(rx.n, 0) * cfg.reaction_weight + coalesce(lk.n, 0) * cfg.like_weight) + 1.0)
             / (a.qualified_view_count + cfg.smoothing)
           * (1.0 / (1.0 + (greatest(0, extract(epoch from (now() - a.survived_ref))) / 3600.0) / cfg.decay_hours))
             as score
    from pool_a a
    left join lateral (
      select count(distinct r.user_id) as n
      from public.posts r
      where r.parent_post_id = a.id and r.user_id <> a.user_id
    ) rx on true
    left join lateral (
      select count(*) as n
      from public.likes l
      where l.post_id = a.id and l.user_id <> a.user_id
    ) lk on true
  ),
  ranked_a as (
    select s.id, row_number() over (order by s.was_seen, s.score desc, s.id) as j
    from scored_a s
  ),
  ranked_b as (
    select b.id,
           row_number() over (
             order by
               (b.id in (select id from seen)),
               -- feed_testing_mode: 0 = fewest qualified views first (current behavior).
               -- 1 = RESERVED for a future relevance-based order. PLACEHOLDER: not
               -- implemented, falls back to mode 0. Put the relevance key here.
               case when cfg.testing_mode = 1 then b.qualified_view_count
                    else b.qualified_view_count end,
               b.created_at,
               b.id
           ) as k
    from pool_b b
  ),
  merged as (
    -- Pool A items take the non-multiples of v_step, Pool B items the multiples.
    -- Ordering by these virtual positions interleaves the pools; if one pool is
    -- empty the other simply follows in order.
    select a.id, (a.j + ((a.j - 1) / (v_step - 1)))::bigint as vpos from ranked_a a
    union all
    select b.id, (b.k * v_step)::bigint as vpos from ranked_b b
  ),
  final as (
    select m.id, row_number() over (order by m.vpos) as pos
    from merged m
  )
  select f.id, f.pos::integer
  from final f
  order by f.pos
  offset v_offset
  limit v_limit;
end;
$$;

-- ── 5. Permissions: signed-in users only ────────────────────────────────────
revoke all on function public.get_feed(integer, integer)    from public, anon;
revoke all on function public.trial_required_views()        from public, anon;
revoke all on function public.feed_settings()               from public, anon;
revoke all on function public.feed_blocked_ids()            from public, anon;
revoke all on function public.feed_seen_ids(uuid[])         from public, anon;

grant execute on function public.get_feed(integer, integer) to authenticated;
grant execute on function public.trial_required_views()     to authenticated;
grant execute on function public.feed_settings()            to authenticated;
grant execute on function public.feed_blocked_ids()         to authenticated;
grant execute on function public.feed_seen_ids(uuid[])      to authenticated;

-- ── PERFORMANCE NOTE ────────────────────────────────────────────────────────
-- Scores are computed inside the function, per request, only for Pool A (posts
-- still inside their 24h window) and Pool B is only sorted; nothing outside the
-- two pools is read. trial_required_views() also counts the distinct users
-- active in the last active_window_days on every call. That is fine at the
-- current scale. It becomes necessary to precompute when a request takes more
-- than tens of milliseconds, roughly when there are thousands of posts in the
-- 24h window or many feed calls per second: store the gate and a per-post score
-- on a schedule (a score column on posts plus a cron job) and make this
-- function read them. The signature get_feed(p_limit, p_offset) ->
-- (post_id, position) is meant to stay as it is when that happens.

-- ── Read-only previews (run separately, in the SQL editor) ──────────────────
-- The editor has no signed-in user: set one inside a transaction. Replace the uuid.
--
-- 1) The ordering for a sample viewer:
-- begin;
-- select set_config('request.jwt.claim.sub', '<VIEWER-USER-UUID>', true);
-- select f."position", f.post_id, p.status, p.qualified_view_count, p.user_id
-- from public.get_feed(40, 0) f
-- join public.posts p on p.id = f.post_id
-- order by f."position";
-- rollback;
--
-- 2) Pool sizes and the current gate:
-- select public.trial_required_views() as gate,
--   (select count(*) from public.posts where parent_post_id is null and status = 'survived'
--      and distribution_expires_at > now() and moderation_status = 'active') as pool_a_active_survivors,
--   (select count(*) from public.posts where parent_post_id is null and status = 'survived'
--      and distribution_expires_at is null) as survivors_without_window_not_boosted,
--   (select count(*) from public.posts where parent_post_id is null and status in ('trial', 'incomplete')
--      and checkpoint_at > now() and qualified_view_count < public.trial_required_views()
--      and moderation_status = 'active') as pool_b_testing_before_viewer_filters;
--
-- 3) Which posts would be boosted (Pool A) and their scores, best first
--    (reaction/like weights 2/1, smoothing 5, decay 12 h unless trial_config says otherwise):
-- select p.id, p.qualified_view_count,
--   (select count(distinct r.user_id) from public.posts r where r.parent_post_id = p.id and r.user_id <> p.user_id) as reactors,
--   (select count(*) from public.likes l where l.post_id = p.id and l.user_id <> p.user_id) as likes,
--   coalesce(p.survived_at, p.distribution_started_at, p.created_at) as survived_ref,
--   p.distribution_expires_at
-- from public.posts p
-- where p.parent_post_id is null and p.status = 'survived' and p.distribution_expires_at > now()
--   and p.moderation_status = 'active'
-- order by p.distribution_expires_at desc;
--
-- 4) Config in effect:
-- select * from public.trial_config where key like 'feed\_%' order by key;

-- ── Rollback (comments; run what you need) ──────────────────────────────────
-- drop function if exists public.get_feed(integer, integer);
-- drop function if exists public.feed_seen_ids(uuid[]);
-- drop function if exists public.feed_blocked_ids();
-- drop function if exists public.feed_settings();
-- drop function if exists public.trial_required_views();
-- delete from public.trial_config
--   where key in ('feed_testing_ratio', 'feed_decay_hours', 'feed_smoothing', 'feed_testing_mode');
-- drop index if exists public.posts_testing_checkpoint_idx;
-- drop index if exists public.post_qualified_views_viewer_post_idx;
-- drop index if exists public.post_raw_views_viewer_post_idx;
-- (posts_status_distribution_expires_idx also belongs to migration-lifecycle.sql: keep it.)
