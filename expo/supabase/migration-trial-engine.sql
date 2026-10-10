-- Dynamic Progressive Testing engine ("every post earns its next batch of viewers") — LIVE, with a switch back.
-- (idempotent; run manually in the Supabase SQL editor)
--
-- WHAT IT REPLACES: the verdict logic of run_survival_checkpoint() (latest definition: migration-lifecycle.sql).
-- The lifecycle itself is reused, not duplicated: statuses (trial / incomplete / survived / archived / expired),
-- survived_at / distribution_* columns, expire_posts(), the reaction-parent guard and the existing notification path.
-- The existing function is RENAMED run_survival_checkpoint_legacy() and run_survival_checkpoint() becomes a switch:
--   trial_engine_config.engine_mode = 'live'   -> run_trial_engine()            (this file)
--   trial_engine_config.engine_mode = 'legacy' -> run_survival_checkpoint_legacy()   (exactly the old behavior)
-- The existing 5-minute cron job 'survival-checkpoint' keeps calling run_survival_checkpoint(), so no new verdict job.
--
-- NOTE ON THE CONFIG TABLE: public.trial_config already exists as a key/value table used by the legacy function
-- (gate_min, settle_minutes, distribution_hours ...). It is left alone (legacy still reads it, and the survived
-- distribution window still comes from its 'distribution_hours'). The engine's single-row, typed config is
-- public.trial_engine_config.
--
-- Switch back and forth at any time:
--   update public.trial_engine_config set engine_mode = 'legacy';   -- old behavior
--   update public.trial_engine_config set engine_mode = 'live';     -- the engine
--
-- Needs: migration-lifecycle.sql (posts.status incl. 'incomplete', survived/distribution columns), the qualified /
-- raw view tables, user_blocks (migration-moderation.sql), pg_cron. NEVER re-run older migrations that define
-- run_survival_checkpoint (they would replace the switch).

-- ── 1. Config (single row, edit in the dashboard) ────────────────────────────
create table if not exists public.trial_engine_config (
  id boolean primary key default true check (id),
  engine_mode text not null default 'live' check (engine_mode in ('live', 'legacy')),

  -- per-viewer score (0..1)
  watch_fraction        double precision not null default 0.5,   -- meaningful watch: >= this share of the video ...
  watch_seconds         double precision not null default 6,     -- ... or >= this many seconds
  swipe_seconds         double precision not null default 2,     -- a swipe under this earns no watch credit (still an exposure)
  w_watch               double precision not null default 0.4,
  w_complete            double precision not null default 0.3,
  w_like                double precision not null default 0.3,
  w_share               double precision not null default 0.5,
  w_reaction            double precision not null default 0.6,
  norm_min              double precision not null default 0.5,   -- viewers who like/react to most posts count less
  norm_max              double precision not null default 1.5,
  norm_ref_rate         double precision not null default 0.15,  -- engagement rate that counts as "normal" (factor 1)
  norm_window           integer          not null default 30,    -- their last N viewed posts
  norm_min_sample       integer          not null default 5,
  new_account_hours     double precision not null default 24,
  new_account_weight    double precision not null default 0.5,

  -- active pool
  pool_min_users        integer          not null default 30,    -- fewer active users than this -> widen the window
  pool_window_hours     double precision not null default 24,
  pool_window2_hours    double precision not null default 72,
  pool_window3_hours    double precision not null default 168,

  -- cohorts
  cohort_fraction       double precision not null default 0.10,
  cohort_min            integer          not null default 3,
  cohort_max            integer          not null default 500,
  cohort_growth         double precision not null default 2,
  expand_ready_fraction double precision not null default 0.8,   -- expand once this share of the current cohort has seen it ...
  expand_stall_minutes  integer          not null default 60,    -- ... or after this long with at least one view

  -- decision (Bayesian)
  prior_strength        double precision not null default 4,
  p_expand              double precision not null default 0.60,
  p_survive             double precision not null default 0.80,
  p_fail                double precision not null default 0.15,
  survive_fraction      double precision not null default 0.20,
  survive_min           integer          not null default 5,
  survive_max           integer          not null default 150,
  survive_floor         integer          not null default 2,
  fail_fraction         double precision not null default 0.15,
  fail_min              integer          not null default 4,
  fail_max              integer          not null default 100,
  fail_floor            integer          not null default 3,
  decision_hours        double precision not null default 24,    -- no decision by then -> 'incomplete'

  -- bar
  bar_base              double precision not null default 0.30,
  bar_percentile        double precision not null default 0.60,
  bar_full_posts        integer          not null default 200,
  bar_window_days       integer          not null default 7,

  -- affinity
  affinity_threshold    double precision not null default 0.6,   -- at or above = "high affinity"
  affinity_weight       double precision not null default 0.5,   -- their score counts x this in the creator's verdict
  affinity_half_life_days double precision not null default 14,
  affinity_feed_boost   integer          not null default 3,     -- survived posts boosted to a viewer, per page

  updated_at timestamptz not null default now()
);
insert into public.trial_engine_config (id) values (true) on conflict (id) do nothing;
-- on-demand assignment and stalled cohorts (added after the first release; idempotent)
alter table public.trial_engine_config
  add column if not exists stall_minutes       integer not null default 30,   -- an assignment nobody opened for this long frees its slot
  add column if not exists ondemand_batch      integer not null default 10,   -- most posts one feed request can newly assign to a viewer
  add column if not exists ondemand_max_unseen integer not null default 20,   -- stop assigning while this many assigned posts are unseen
  add column if not exists small_pool_everyone integer not null default 50,   -- active pool this small or smaller: everybody gets every testing post
  add column if not exists prior_min           double precision not null default 1,     -- prior strength k = clamp(prior_pool_fraction * pool, prior_min, prior_strength)
  add column if not exists prior_pool_fraction double precision not null default 0.25,
  add column if not exists fraud_weights_min_pool integer not null default 50,   -- new-account / like-everything / affinity weights only above this active pool
  add column if not exists exhausted_fail_ratio double precision not null default 0.67,   -- pool exhausted: ended below ratio * bar
  add column if not exists known_source_follows boolean not null default false,   -- old follows count as "people you know" (off: DropDay-era follows are ignored)
  add column if not exists build_in_silence    boolean not null default true;           -- people you know never see (or influence) your post while it is on trial
alter table public.trial_engine_config enable row level security;   -- no policies: dashboard / service role only

create or replace function public.trial_cfg()
returns public.trial_engine_config
language sql
stable
security definer
set search_path = public
as $$ select * from public.trial_engine_config where id limit 1 $$;

-- ── 2. A new notification type for "Trial incomplete" ────────────────────────
do $$
declare
  c record;
begin
  if to_regclass('public.notifications') is null then
    return;
  end if;
  for c in
    select conname from pg_constraint
    where conrelid = 'public.notifications'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%verdict_survived%'
  loop
    execute format('alter table public.notifications drop constraint %I', c.conname);
  end loop;
  alter table public.notifications
    add constraint notifications_type_check
    check (type in ('like', 'reaction', 'follow', 'follow_request', 'follow_accept',
                    'verdict_survived', 'verdict_archived', 'verdict_incomplete', 'followed_post_survived'));
end $$;

-- ── 3. Watch time per view (was not recorded: raw views are impressions, qualified views a 3 s flag) ───
create table if not exists public.post_view_stats (
  post_id     uuid not null references public.posts(id) on delete cascade,
  viewer_id   uuid not null references auth.users(id) on delete cascade,
  watch_ms    integer not null default 0,
  duration_ms integer not null default 0,
  completed   boolean not null default false,
  shared      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (post_id, viewer_id)
);
create index if not exists post_view_stats_viewer_idx on public.post_view_stats (viewer_id, updated_at desc);
create index if not exists post_view_stats_updated_idx on public.post_view_stats (updated_at);
alter table public.post_view_stats enable row level security;       -- written only through the functions below

create or replace function public.record_view_progress(
  p_post_id uuid, p_watch_ms integer, p_duration_ms integer, p_completed boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  w integer;
  done boolean;
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then return; end if;   -- own post: ignored
  insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms, completed)
  values (p_post_id, auth.uid(), greatest(0, coalesce(p_watch_ms, 0)), greatest(0, coalesce(p_duration_ms, 0)), coalesce(p_completed, false))
  on conflict (post_id, viewer_id) do update
    set watch_ms    = greatest(public.post_view_stats.watch_ms, excluded.watch_ms),
        duration_ms = greatest(public.post_view_stats.duration_ms, excluded.duration_ms),
        completed   = public.post_view_stats.completed or excluded.completed,
        updated_at  = now()
  returning watch_ms, completed into w, done;
  -- The watch-time report is the most reliable signal the app sends, so it also guarantees the impression and the
  -- qualified view (3 s) exist, even if those two calls were lost (not signed in yet, offline, older build).
  insert into public.post_raw_views (post_id, viewer_id) values (p_post_id, auth.uid()) on conflict (post_id, viewer_id) do nothing;
  if w >= 3000 or done then
    insert into public.post_qualified_views (post_id, viewer_id) values (p_post_id, auth.uid()) on conflict (post_id, viewer_id) do nothing;
  end if;
end;
$$;

create or replace function public.record_post_share(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then return; end if;
  insert into public.post_view_stats (post_id, viewer_id, shared) values (p_post_id, auth.uid(), true)
  on conflict (post_id, viewer_id) do update set shared = true, updated_at = now();
end;
$$;

grant execute on function public.record_view_progress(uuid, integer, integer, boolean) to authenticated;

-- Backfill: watch-time rows whose impression / qualified view were never recorded (their counters follow via the triggers).
insert into public.post_raw_views (post_id, viewer_id, created_at)
select s.post_id, s.viewer_id, s.created_at
from public.post_view_stats s join public.posts p on p.id = s.post_id
where p.user_id <> s.viewer_id
on conflict (post_id, viewer_id) do nothing;
insert into public.post_qualified_views (post_id, viewer_id, created_at)
select s.post_id, s.viewer_id, s.created_at
from public.post_view_stats s join public.posts p on p.id = s.post_id
where p.user_id <> s.viewer_id and (s.watch_ms >= 3000 or s.completed)
on conflict (post_id, viewer_id) do nothing;
grant execute on function public.record_post_share(uuid) to authenticated;

-- ── 4. Engine tables (server side only: RLS on, no client policies) ──────────
create table if not exists public.trial_assignments (
  post_id     uuid not null references public.posts(id) on delete cascade,
  viewer_id   uuid not null references auth.users(id) on delete cascade,
  stage       integer not null,
  assigned_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);
alter table public.trial_assignments add column if not exists released_at timestamptz;   -- slot given back (never opened); null = active
create index if not exists trial_assignments_viewer_idx on public.trial_assignments (viewer_id, assigned_at);
alter table public.trial_assignments enable row level security;

create table if not exists public.trial_post_state (
  post_id          uuid primary key references public.posts(id) on delete cascade,
  stage            integer not null default 1,
  stage_started_at timestamptz not null default now(),
  decision         text,                       -- null while testing; 'survived' | 'failed' | 'incomplete'
  decided_at       timestamptz,
  posterior_mean   double precision,           -- Beta posterior mean at the decision (feeds the bar)
  last_logged_n    integer,
  created_at       timestamptz not null default now()
);
alter table public.trial_post_state add column if not exists stage_target integer;   -- viewers the current cohort should hold (not capped by who is online now)
create index if not exists trial_post_state_decided_idx on public.trial_post_state (decided_at) where decision is not null;
alter table public.trial_post_state enable row level security;

create table if not exists public.trial_engine_log (
  id           bigint generated always as identity primary key,
  post_id      uuid not null,
  stage        integer,
  n            integer,
  score_mean   double precision,
  p_above_bar  double precision,
  bar          double precision,
  pool         integer,
  decision     text,
  created_at   timestamptz not null default now()
);
alter table public.trial_engine_log add column if not exists reason text;   -- why: confidence | pool_exhausted | checkpoint_24h | expand
create index if not exists trial_engine_log_created_idx on public.trial_engine_log (created_at desc);
create index if not exists trial_engine_log_post_idx on public.trial_engine_log (post_id, created_at desc);
alter table public.trial_engine_log enable row level security;

create table if not exists public.viewer_creator_affinity (
  viewer_id  uuid not null,
  creator_id uuid not null,
  score      double precision not null,
  updated_at timestamptz not null default now(),
  primary key (viewer_id, creator_id)
);
create index if not exists viewer_creator_affinity_creator_idx on public.viewer_creator_affinity (creator_id);
alter table public.viewer_creator_affinity enable row level security;

-- Who was active recently (rebuilt every engine run): the pool is read from here.
create table if not exists public.trial_active_users (
  user_id     uuid primary key,
  last_active timestamptz not null
);
-- Who opened the feed (so a user who only looks, and has no views yet, is in the pool): one row per user.
create table if not exists public.trial_feed_opens (
  user_id   uuid primary key,
  last_open timestamptz not null default now()
);
alter table public.trial_feed_opens enable row level security;
create table if not exists public.trial_engine_state (
  id boolean primary key default true check (id),
  active_refreshed_at timestamptz,
  active_window_hours double precision not null default 24
);
insert into public.trial_engine_state (id) values (true) on conflict (id) do nothing;
alter table public.trial_active_users enable row level security;
alter table public.trial_engine_state enable row level security;

revoke all on table public.trial_engine_config, public.trial_assignments, public.trial_post_state, public.trial_engine_log,
  public.viewer_creator_affinity, public.trial_active_users, public.trial_feed_opens, public.trial_engine_state, public.post_view_stats
  from anon, authenticated;

-- ── 5. Math: Beta distribution (no extensions) ───────────────────────────────
create or replace function public.trial_lgamma(x double precision)
returns double precision
language plpgsql
immutable
as $$
declare
  coef constant double precision[] := array[0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7];
  xx double precision; a double precision; t double precision;
begin
  if x < 0.5 then
    return ln(pi() / abs(sin(pi() * x))) - public.trial_lgamma(1 - x);
  end if;
  xx := x - 1;
  a := coef[1];
  t := xx + 7.5;
  for i in 1..8 loop
    a := a + coef[i + 1] / (xx + i);
  end loop;
  return 0.5 * ln(2 * pi()) + (xx + 0.5) * ln(t) - t + ln(a);
end;
$$;

create or replace function public.trial_betacf(a double precision, b double precision, x double precision)
returns double precision
language plpgsql
immutable
as $$
declare
  fpmin constant double precision := 1e-30;
  qab double precision := a + b; qap double precision := a + 1; qam double precision := a - 1;
  c double precision := 1; d double precision; h double precision; aa double precision; del double precision;
  m2 integer;
begin
  d := 1 - qab * x / qap;
  if abs(d) < fpmin then d := fpmin; end if;
  d := 1 / d;
  h := d;
  for m in 1..300 loop
    m2 := 2 * m;
    aa := m * (b - m) * x / ((qam + m2) * (a + m2));
    d := 1 + aa * d; if abs(d) < fpmin then d := fpmin; end if;
    c := 1 + aa / c; if abs(c) < fpmin then c := fpmin; end if;
    d := 1 / d;
    h := h * d * c;
    aa := -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d := 1 + aa * d; if abs(d) < fpmin then d := fpmin; end if;
    c := 1 + aa / c; if abs(c) < fpmin then c := fpmin; end if;
    d := 1 / d;
    del := d * c;
    h := h * del;
    exit when abs(del - 1) < 3e-12;
  end loop;
  return h;
end;
$$;

-- P(X <= x) for X ~ Beta(a, b)
create or replace function public.trial_beta_cdf(x double precision, a double precision, b double precision)
returns double precision
language plpgsql
immutable
as $$
declare
  bt double precision;
begin
  if x <= 0 then return 0; end if;
  if x >= 1 then return 1; end if;
  bt := exp(public.trial_lgamma(a + b) - public.trial_lgamma(a) - public.trial_lgamma(b) + a * ln(x) + b * ln(1 - x));
  if x < (a + 1) / (a + b + 2) then
    return bt * public.trial_betacf(a, b, x) / a;
  end if;
  return 1 - bt * public.trial_betacf(b, a, 1 - x) / b;
end;
$$;

create or replace function public.trial_clamp_int(v double precision, lo integer, hi integer)
returns integer
language sql
immutable
as $$ select least(hi, greatest(lo, v))::integer $$;

-- ── 6. Active pool ───────────────────────────────────────────────────────────
-- Rebuilds who was active in the last 7 days (any view, like, post/reaction or watch) and picks the pool window:
-- 24h, else 72h, else 7d when fewer than pool_min_users are active.
create or replace function public.trial_refresh_active()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  since timestamptz := now() - (cfg.pool_window3_hours * interval '1 hour');
  w double precision;
  c integer;
begin
  delete from public.trial_active_users;
  insert into public.trial_active_users (user_id, last_active)
  select a.uid, max(a.ts)
  from (
    select viewer_id as uid, created_at as ts from public.post_raw_views       where created_at >= since
    union all
    select viewer_id,         created_at          from public.post_qualified_views where created_at >= since
    union all
    select viewer_id,         updated_at          from public.post_view_stats      where updated_at >= since
    union all
    select user_id,           created_at          from public.likes                where created_at >= since
    union all
    select user_id,           created_at          from public.posts                where created_at >= since   -- incl. video reactions
    union all
    select user_id,           last_open           from public.trial_feed_opens     where last_open >= since
  ) a
  group by a.uid;

  w := cfg.pool_window_hours;
  select count(*) into c from public.trial_active_users where last_active >= now() - (cfg.pool_window_hours * interval '1 hour');
  if c < cfg.pool_min_users then
    w := cfg.pool_window2_hours;
    select count(*) into c from public.trial_active_users where last_active >= now() - (cfg.pool_window2_hours * interval '1 hour');
    if c < cfg.pool_min_users then
      w := cfg.pool_window3_hours;
    end if;
  end if;
  update public.trial_engine_state set active_refreshed_at = now(), active_window_hours = w where id;
end;
$$;

-- ── People you know ──────────────────────────────────────────────────────────
-- ONE place that says who knows whom. Rows are directional pairs (both directions are listed). Today the only source is
-- follows (either direction, any status: over-hiding is the safe side). The messaging feature's friends table and
-- contacts matching are added later as extra UNION ALL branches here; the engine and the feed only ever call
-- trial_is_silenced() and never change.
create or replace view public.known_connections as
  select f.follower_id as user_id, f.followee_id as other_id, 'follow'::text as source from public.follows f
   where (select known_source_follows from public.trial_engine_config where id)
  union all
  select f.followee_id, f.follower_id, 'follow'::text from public.follows f
   where (select known_source_follows from public.trial_engine_config where id);
  -- union all select ... from public.friends ...        (messaging, later)
  -- union all select ... from public.contact_matches ...  (contacts, later)
revoke all on public.known_connections from anon, authenticated;

-- Build in silence: while a post is on trial, a viewer who knows its creator never gets it and never counts toward its
-- verdict. Once it survives, nothing here applies.
create or replace function public.trial_is_silenced(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select c.build_in_silence
     and exists (select 1 from public.known_connections k where k.user_id = p_creator and k.other_id = p_viewer)
  from public.trial_cfg() c
$$;

-- Small-app rule: with this few active people (the creator not counted), everybody is in every cohort.
create or replace function public.trial_pool_at_most(p_creator uuid, p_n integer)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) <= p_n
  from (
    select 1 from public.trial_active_users u
    where u.user_id <> coalesce(p_creator, '00000000-0000-0000-0000-000000000000'::uuid)
      and u.last_active >= now() - ((select active_window_hours from public.trial_engine_state where id) * interval '1 hour')
    limit p_n + 1
  ) x
$$;
create or replace function public.trial_small_pool(p_creator uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.trial_pool_at_most(p_creator, (select small_pool_everyone from public.trial_engine_config where id))
$$;

-- Prior strength: a tiny pool cannot carry a prior as heavy as a big one.
create or replace function public.trial_prior_strength(p_pool integer)
returns double precision
language sql
stable
as $$
  select greatest(c.prior_min, least(c.prior_strength, c.prior_pool_fraction * p_pool)) from public.trial_cfg() c
$$;

-- One definition of "this viewer has seen the post": a raw view OR a qualified view OR a watch-time row.
create or replace function public.trial_exposed(p_post_id uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.post_raw_views r where r.post_id = p_post_id and r.viewer_id = p_viewer)
      or exists (select 1 from public.post_qualified_views q where q.post_id = p_post_id and q.viewer_id = p_viewer)
      or exists (select 1 from public.post_view_stats s where s.post_id = p_post_id and s.viewer_id = p_viewer)
$$;

-- Eligible viewers for a post: active, not the creator, not blocked either way. `exposed` = has seen it, `assigned` =
-- already in a cohort. Total pool = all rows; remaining pool = not exposed and not assigned.
create or replace function public.trial_pool(p_post_id uuid)
returns table (user_id uuid, affinity double precision, exposed boolean, assigned boolean)
language sql
stable
security definer
set search_path = public
as $$
  select u.user_id,
         coalesce(a.score, 0),
         public.trial_exposed(p_post_id, u.user_id),
         exists (select 1 from public.trial_assignments t where t.post_id = p_post_id and t.viewer_id = u.user_id)
  from public.trial_active_users u
  join public.posts p on p.id = p_post_id
  left join public.viewer_creator_affinity a on a.viewer_id = u.user_id and a.creator_id = p.user_id
  where u.last_active >= now() - ((select active_window_hours from public.trial_engine_state where id) * interval '1 hour')
    and u.user_id <> p.user_id
    and not public.trial_is_silenced(p.user_id, u.user_id)
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = u.user_id and b.blocked_id = p.user_id)
         or (b.blocker_id = p.user_id and b.blocked_id = u.user_id)
    );
$$;

-- ── 7. Per-viewer score (0..1) ───────────────────────────────────────────────
-- meaningful watch +w_watch; completed +w_complete; like +w_like; share +w_share; video reaction +w_reaction.
-- A swipe under swipe_seconds earns no watch credit but is still an exposure (a row with score 0). The like / share /
-- reaction part is scaled by the viewer's recent engagement rate (0.5..1.5: someone who likes everything counts less).
-- The total is capped at 1, then x new_account_weight for an account under 24 h old, then x affinity_weight when the
-- viewer has high affinity with the creator. The creator's own activity is ignored; each viewer counts once.
create or replace function public.trial_post_score_details(p_post_id uuid)
returns table (
  viewer_id uuid, username text, sources text, watch_ms integer, meaningful boolean, completed boolean,
  liked boolean, reacted boolean, shared boolean, like_factor double precision, weight double precision,
  score double precision, excluded boolean, excluded_reason text
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.trial_cfg()),
  post as (select id, user_id from public.posts where id = p_post_id),
  -- Fraud-style weights (new account, like-everything, high affinity) only matter at scale: in a tiny app every viewer is 1.0.
  scale as (select not public.trial_pool_at_most((select user_id from post), (select fraud_weights_min_pool from cfg)) as on),
  src as (
    select s.viewer_id, 'stats'::text as src, s.created_at as at from public.post_view_stats s where s.post_id = p_post_id
    union all
    select r.viewer_id, 'raw', r.created_at from public.post_raw_views r where r.post_id = p_post_id
    union all
    select q.viewer_id, 'qualified', q.created_at from public.post_qualified_views q where q.post_id = p_post_id
  ),
  viewers as (
    select src.viewer_id, string_agg(distinct src.src, '+' order by src.src) as sources, min(src.at) as first_at
    from src group by src.viewer_id
  ),
  known as (   -- build in silence: people the creator knows (follow / contact / hide list / friends)
    select k.other_id as viewer_id, string_agg(distinct k.source, '+') as ks
    from public.known_connections k, cfg, post
    where cfg.build_in_silence and k.user_id = post.user_id
    group by k.other_id
  ),
  base as (
    select vw.viewer_id, vw.sources, vw.first_at,
           -- a qualified view (3 s watched) whose watch time never arrived (older app, killed app, failed write) is not lost:
           -- it counts as a meaningful watch
           coalesce(s.watch_ms, case when 'qualified' = any (string_to_array(vw.sources, '+'))
                                     then (select (watch_seconds * 1000)::integer from cfg) else 0 end) as watch_ms,
           coalesce(s.duration_ms, 0) as duration_ms,
           coalesce(s.completed, false) as completed, coalesce(s.shared, false) as shared,
           exists (select 1 from public.likes l where l.post_id = p_post_id and l.user_id = vw.viewer_id) as liked,
           exists (select 1 from public.posts r where r.parent_post_id = p_post_id and r.user_id = vw.viewer_id) as reacted,
           (vw.viewer_id = (select user_id from post)) as is_creator,
           kn.ks
    from viewers vw
    left join public.post_view_stats s on s.post_id = p_post_id and s.viewer_id = vw.viewer_id
    left join known kn on kn.viewer_id = vw.viewer_id
  ),
  rated as (
    select b.*, rt.total, rt.engaged
    from base b
    left join lateral (
      select count(*) as total,
             count(*) filter (where exists (select 1 from public.likes l where l.user_id = b.viewer_id and l.post_id = x.post_id)
                                 or exists (select 1 from public.posts rr where rr.user_id = b.viewer_id and rr.parent_post_id = x.post_id)) as engaged
      from (select s2.post_id from public.post_view_stats s2 where s2.viewer_id = b.viewer_id
            order by s2.updated_at desc limit (select norm_window from cfg)) x
    ) rt on true
  ),
  calc as (
    select r.*, cfg.*, sc.on as weights_on,
           (r.watch_ms >= cfg.watch_fraction * r.duration_ms and r.duration_ms > 0) or r.watch_ms >= cfg.watch_seconds * 1000 as meaningful,
           case when not sc.on or coalesce(r.total, 0) < cfg.norm_min_sample then 1
                else least(cfg.norm_max, greatest(cfg.norm_min, cfg.norm_ref_rate / greatest(r.engaged::double precision / r.total, 0.01))) end as like_factor,
           (case when sc.on and pr.created_at > r.first_at - (cfg.new_account_hours * interval '1 hour') then cfg.new_account_weight else 1 end)
             * (case when sc.on and coalesce(af.score, 0) >= cfg.affinity_threshold then cfg.affinity_weight else 1 end) as weight,
           pr.username
    from rated r
    cross join cfg
    cross join scale sc
    join post on true
    left join public.profiles pr on pr.id = r.viewer_id
    left join public.viewer_creator_affinity af on af.viewer_id = r.viewer_id and af.creator_id = post.user_id
  )
  select c.viewer_id, c.username, c.sources, c.watch_ms, c.meaningful, c.completed, c.liked, c.reacted, c.shared,
         c.like_factor, c.weight,
         least(1.0,
           (case when c.completed or c.watch_ms >= c.swipe_seconds * 1000 then
               c.w_watch * (case when c.meaningful then 1 else 0 end) + c.w_complete * (case when c.completed then 1 else 0 end)
             else 0 end)
           + (c.w_like * (case when c.liked then 1 else 0 end)
              + c.w_share * (case when c.shared then 1 else 0 end)
              + c.w_reaction * (case when c.reacted then 1 else 0 end)) * c.like_factor
         ) * c.weight as score,
         (c.is_creator or c.ks is not null) as excluded,
         case when c.is_creator then 'creator' when c.ks is not null then 'known: ' || c.ks end as excluded_reason
  from calc c
$$;

-- What the engine uses: every counted viewer once, with its final score.
create or replace function public.trial_post_scores(p_post_id uuid)
returns table (viewer_id uuid, score double precision)
language sql
stable
security definer
set search_path = public
as $$
  select d.viewer_id, d.score from public.trial_post_score_details(p_post_id) d where not d.excluded
$$;

-- Debug (SQL editor only): per viewer of a post, why it scored what it did.
--   select * from public.trial_debug_post('730792b2') order by excluded, score desc;
create or replace function public.trial_debug_post(p_id_prefix text)
returns table (
  post_id uuid, viewer_id uuid, username text, sources text, watch_ms integer, meaningful boolean, completed boolean,
  liked boolean, reacted boolean, shared boolean, like_factor double precision, weight double precision,
  score double precision, excluded boolean, excluded_reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pid uuid;
  cnt integer;
begin
  select count(*), min(id::text)::uuid into cnt, pid from public.posts where id::text like p_id_prefix || '%';
  if cnt <> 1 then raise exception 'prefix matches % posts', cnt; end if;
  return query
    select pid, d.viewer_id, d.username, d.sources, d.watch_ms, d.meaningful, d.completed, d.liked, d.reacted, d.shared,
           d.like_factor, d.weight, d.score, d.excluded, d.excluded_reason
    from public.trial_post_score_details(pid) d;
end;
$$;
revoke all on function public.trial_debug_post(text), public.trial_post_score_details(uuid), public.trial_exposed(uuid, uuid) from public, anon, authenticated;

-- ── 8. The bar ───────────────────────────────────────────────────────────────
-- bar = (1 - w) * bar_base + w * P60(recent judged posts' posterior means), w = min(1, judged_last_7d / 200).
create or replace function public.trial_current_bar()
returns double precision
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  judged integer;
  pct double precision;
  w double precision;
begin
  select count(*), percentile_cont(cfg.bar_percentile) within group (order by posterior_mean)
  into judged, pct
  from public.trial_post_state
  where decision in ('survived', 'failed')
    and posterior_mean is not null
    and decided_at >= now() - (cfg.bar_window_days * interval '1 day');
  w := least(1, judged::double precision / cfg.bar_full_posts);
  return (1 - w) * cfg.bar_base + w * coalesce(pct, cfg.bar_base);
end;
$$;

-- ── 9. Cohorts ───────────────────────────────────────────────────────────────
-- first cohort = clamp(round(fraction * pool), cohort_min, cohort_max); each next one grows x cohort_growth; always
-- capped by the remaining pool. Strangers first (lowest affinity), then random.
create or replace function public.trial_cohort_size(p_pool integer, p_stage integer)
returns integer
language sql
stable
as $$
  select floor(public.trial_clamp_int(floor(c.cohort_fraction * p_pool + 0.5), c.cohort_min, c.cohort_max)::double precision
               * power(c.cohort_growth, greatest(p_stage, 1) - 1))::integer
  from public.trial_cfg() c
$$;

-- Slots, not a one-time draw: a stage has a target (stage_target, from the pool at the time the stage opened, NOT capped by
-- who is online right now). Whoever is eligible fills the open slots, at post time, on every engine run, and on demand when
-- a viewer opens the feed (trial_assign_on_demand), so a user who becomes active later is not left out.
create or replace function public.trial_fill_open_slots(p_post_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  st public.trial_post_state;
  open_slots integer;
  n integer := 0;
begin
  select * into st from public.trial_post_state where post_id = p_post_id and decision is null for update;
  if st.post_id is null then return 0; end if;
  select coalesce(st.stage_target, public.trial_cohort_size(0, st.stage)) - count(*) into open_slots
  from public.trial_assignments a where a.post_id = p_post_id and a.stage = st.stage and a.released_at is null;
  if public.trial_small_pool((select user_id from public.posts where id = p_post_id)) then
    open_slots := 1000000;   -- small app: the whole eligible pool, and later newcomers too
  end if;
  if open_slots <= 0 then return 0; end if;
  insert into public.trial_assignments (post_id, viewer_id, stage)
  select p_post_id, c.user_id, st.stage
  from public.trial_pool(p_post_id) c
  where not c.exposed and not c.assigned
  order by c.affinity asc, random()
  limit open_slots
  on conflict (post_id, viewer_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Opens a stage: sets its target from the current pool, then fills what it can.
create or replace function public.trial_assign_cohort(p_post_id uuid, p_stage integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
begin
  select count(*) into total from public.trial_pool(p_post_id);
  update public.trial_post_state set stage_target = public.trial_cohort_size(total, p_stage) where post_id = p_post_id;
  return public.trial_fill_open_slots(p_post_id);
end;
$$;

-- A stalled slot: assigned to someone who never opened the post for stall_minutes. It is given back (released_at), so
-- other active viewers can fill it. No data is not a negative signal: nothing here touches the verdict.
create or replace function public.trial_release_stalled(p_post_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  n integer;
begin
  if public.trial_small_pool((select user_id from public.posts where id = p_post_id)) then return 0; end if;   -- nobody is short of a slot
  update public.trial_assignments t
     set released_at = now()
   where t.post_id = p_post_id and t.released_at is null
     and t.assigned_at <= now() - (cfg.stall_minutes * interval '1 minute')
     and not public.trial_exposed(t.post_id, t.viewer_id);
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Backfill for posts that were already testing before slots existed.
update public.trial_post_state s
   set stage_target = public.trial_cohort_size(greatest(1, (select count(*) from public.trial_assignments a where a.post_id = s.post_id and a.stage = s.stage)::integer), s.stage)
 where s.stage_target is null and s.decision is null;

-- On-demand assignment: called when a viewer loads the feed. Assigns the viewer to testing posts whose current cohort
-- has open slots (stalled slots are given back first), strangers first, with the same safety filters as get_feed. One
-- post at a time under a row lock (skipped, then retried once, when another request holds it), so concurrent requests
-- can never put more viewers in a cohort than its target.
create or replace function public.trial_assign_on_demand(p_viewer uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  hide_mature boolean := false;
  unseen integer;
  got integer := 0;
  c record;
  skipped uuid[] := '{}';
  pass integer;
  cand uuid[];
  pid uuid;
  open_slots integer;
  n integer;
begin
  if p_viewer is null or cfg.engine_mode <> 'live' then return 0; end if;

  -- the viewer is active now (counts toward the pool immediately; the engine run keeps them via trial_feed_opens)
  insert into public.trial_feed_opens (user_id, last_open) values (p_viewer, now())
    on conflict (user_id) do update set last_open = now();
  insert into public.trial_active_users (user_id, last_active) values (p_viewer, now())
    on conflict (user_id) do update set last_active = greatest(public.trial_active_users.last_active, now());

  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature
  from public.profiles pr where pr.id = p_viewer;
  hide_mature := coalesce(hide_mature, false);

  select count(*) into unseen
  from public.trial_assignments t join public.posts p on p.id = t.post_id
  where t.viewer_id = p_viewer and t.released_at is null and p.status = 'trial'
    and not public.trial_exposed(t.post_id, p_viewer);
  if unseen >= cfg.ondemand_max_unseen then return 0; end if;

  select coalesce(array_agg(x.post_id order by x.ord), '{}') into cand
  from (
    select s.post_id, row_number() over (order by coalesce(af.score, 0) asc, p.qualified_view_count asc, p.created_at asc) as ord
    from public.trial_post_state s
    join public.posts p on p.id = s.post_id
    left join public.viewer_creator_affinity af on af.viewer_id = p_viewer and af.creator_id = p.user_id
    where s.decision is null
      and p.status = 'trial' and p.parent_post_id is null and p.checkpoint_at > now()
      and p.user_id <> p_viewer and p.moderation_status = 'active' and p.media_deleted_at is null
      and (not hide_mature or not p.is_mature)
      and not public.trial_is_silenced(p.user_id, p_viewer)
      and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
      and not exists (select 1 from public.reports r where r.reporter_id = p_viewer and r.target_type = 'post' and r.target_id = p.id)
      and not exists (select 1 from public.trial_assignments t where t.post_id = s.post_id and t.viewer_id = p_viewer and t.released_at is null)
      and not public.trial_exposed(s.post_id, p_viewer)
    limit cfg.ondemand_batch * 5
  ) x;

  for pass in 1..2 loop
    skipped := '{}';
    foreach pid in array cand loop
      exit when got >= cfg.ondemand_batch or unseen + got >= cfg.ondemand_max_unseen;
      perform 1 from public.trial_post_state where post_id = pid and decision is null for update skip locked;
      if not found then
        skipped := skipped || pid;
        continue;
      end if;
      perform public.trial_release_stalled(pid);
      select coalesce(s.stage_target, public.trial_cohort_size(0, s.stage)) - count(a.viewer_id) into open_slots
      from public.trial_post_state s
      left join public.trial_assignments a on a.post_id = s.post_id and a.stage = s.stage and a.released_at is null
      where s.post_id = pid
      group by s.stage_target, s.stage;
      if public.trial_small_pool((select user_id from public.posts where id = pid)) then open_slots := 1; end if;
      if coalesce(open_slots, 0) > 0 then
        insert into public.trial_assignments (post_id, viewer_id, stage)
        select pid, p_viewer, s.stage from public.trial_post_state s where s.post_id = pid
        on conflict (post_id, viewer_id) do update
          set released_at = null, stage = excluded.stage, assigned_at = now()
          where public.trial_assignments.released_at is not null;
        get diagnostics n = row_count;
        got := got + n;
      end if;
    end loop;
    exit when pass = 2 or coalesce(cardinality(skipped), 0) = 0;
    cand := skipped;
    perform pg_sleep(0.05);   -- the other request holding a post finishes within milliseconds
  end loop;
  return got;
end;
$$;
revoke all on function public.trial_assign_on_demand(uuid) from public, anon, authenticated;
revoke all on function public.trial_fill_open_slots(uuid) from public, anon, authenticated;
revoke all on function public.trial_release_stalled(uuid) from public, anon, authenticated;

create or replace function public.trial_start_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  refreshed timestamptz;
begin
  if (select engine_mode from public.trial_engine_config where id) <> 'live' then return; end if;
  if not exists (select 1 from public.posts where id = p_post_id and parent_post_id is null and status = 'trial') then return; end if;
  if exists (select 1 from public.trial_post_state where post_id = p_post_id) then return; end if;
  select active_refreshed_at into refreshed from public.trial_engine_state where id;
  if refreshed is null or refreshed < now() - interval '5 minutes' then
    perform public.trial_refresh_active();
  end if;
  insert into public.trial_post_state (post_id, stage) values (p_post_id, 1) on conflict do nothing;
  perform public.trial_assign_cohort(p_post_id, 1);
end;
$$;

-- A new root post starts testing at once (never blocks the insert).
create or replace function public.trial_start_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.parent_post_id is null then
    begin
      perform public.trial_start_post(new.id);
    exception when others then
      null;   -- the engine's next run starts it
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists trial_start_on_insert on public.posts;
create trigger trial_start_on_insert
  after insert on public.posts
  for each row execute function public.trial_start_on_insert();

-- ── 10. The decision ─────────────────────────────────────────────────────────
-- Returns 'testing' | 'expand' | 'survived' | 'failed' | 'incomplete'.
create or replace function public.trial_evaluate_post(p_post_id uuid, p_bar double precision)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  post record;
  st public.trial_post_state;
  n integer;
  sum_s double precision;
  mean_s double precision;
  k double precision;
  alpha double precision;
  beta double precision;
  p double precision;
  pool_total integer;
  pool_left integer;
  pool_unexposed integer;
  reason text := 'testing';
  min_survive integer;
  min_fail integer;
  assigned_stage integer;
  exposed_stage integer;
  ready boolean;
  verdict text := 'testing';
  window_h double precision;
begin
  select * into post from public.posts where id = p_post_id;
  select * into st from public.trial_post_state where post_id = p_post_id for update;
  if post.id is null or st.post_id is null or st.decision is not null then return 'testing'; end if;

  select count(*), coalesce(sum(score), 0) into n, sum_s from public.trial_post_scores(p_post_id);
  select count(*), count(*) filter (where not exposed and not assigned), count(*) filter (where not exposed) into pool_total, pool_left, pool_unexposed from public.trial_pool(p_post_id);

  k := public.trial_prior_strength(pool_total);
  alpha := k * p_bar + sum_s;
  beta  := k * (1 - p_bar) + (n - sum_s);
  p := 1 - public.trial_beta_cdf(p_bar, alpha, beta);
  mean_s := case when n > 0 then sum_s / n else null end;

  -- minimums never exceed the people actually available
  min_survive := least(public.trial_clamp_int(ceil(cfg.survive_fraction * pool_total), cfg.survive_min, cfg.survive_max), greatest(cfg.survive_floor, pool_total));
  min_fail    := least(public.trial_clamp_int(ceil(cfg.fail_fraction * pool_total),    cfg.fail_min,    cfg.fail_max),    greatest(cfg.fail_floor,    pool_total));

  if n >= min_survive and p >= cfg.p_survive then
    verdict := 'survived'; reason := 'confidence';
  elsif n >= min_fail and p <= cfg.p_fail then
    verdict := 'failed'; reason := 'confidence';
  elsif pool_total >= 1 and pool_unexposed = 0 and n >= 1 then
    -- POOL EXHAUSTED: every eligible (non-known) viewer has seen it and nobody is left to assign, so waiting 24 h cannot
    -- add information. Decide on the posterior mean: survive above the bar, ended well below it, otherwise incomplete.
    reason := 'pool_exhausted';
    if alpha / (alpha + beta) > p_bar then
      verdict := 'survived';
    elsif alpha / (alpha + beta) < cfg.exhausted_fail_ratio * p_bar then
      verdict := 'failed';
    else
      verdict := 'incomplete';
    end if;
  elsif p >= cfg.p_expand then
    -- expand once the current cohort has mostly seen the post (or has had time)
    select count(*), count(*) filter (where public.trial_exposed(p_post_id, t.viewer_id))
      into assigned_stage, exposed_stage
    from public.trial_assignments t where t.post_id = p_post_id and t.stage = st.stage and t.released_at is null;
    -- (the new stage's open slots are filled by whoever shows up, so a small or empty pool no longer blocks expansion;
    -- an empty cohort is not "ready": no data means refill the slots, never expand or fail)
    ready := assigned_stage > 0
         and (exposed_stage >= cfg.expand_ready_fraction * assigned_stage
              or (exposed_stage >= 1 and st.stage_started_at <= now() - (cfg.expand_stall_minutes * interval '1 minute')));
    if ready then
      verdict := 'expand'; reason := 'expand';
    end if;
  end if;

  if verdict = 'testing' and now() >= post.checkpoint_at then
    verdict := 'incomplete'; reason := 'checkpoint_24h';   -- 24 h and still no decision
  end if;

  if verdict = 'expand' then
    update public.trial_post_state set stage = st.stage + 1, stage_started_at = now() where post_id = p_post_id;
    perform public.trial_assign_cohort(p_post_id, st.stage + 1);
  elsif verdict in ('survived', 'failed', 'incomplete') then
    update public.trial_post_state
       set decision = verdict, decided_at = now(), posterior_mean = alpha / (alpha + beta)
     where post_id = p_post_id;
    perform public.trial_apply_decision(p_post_id, verdict);
  end if;

  select active_window_hours into window_h from public.trial_engine_state where id;
  -- log every decision, and a 'testing' line only when the number of viewers moved
  if verdict <> 'testing' or st.last_logged_n is distinct from n then
    insert into public.trial_engine_log (post_id, stage, n, score_mean, p_above_bar, bar, pool, decision, reason)
    values (p_post_id, st.stage, n, mean_s, p, p_bar, pool_total, verdict, case when verdict = 'testing' then null else reason end);
    update public.trial_post_state set last_logged_n = n where post_id = p_post_id;
  end if;
  return verdict;
end;
$$;

-- Admin (SQL editor only): re-open a post that was decided and evaluate it again under the current rules. A post that
-- survived is never re-opened. Matches a post id prefix: select public.trial_admin_reevaluate('730792b2');
create or replace function public.trial_admin_reevaluate(p_id_prefix text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
  cnt integer;
  st text;
begin
  select count(*), min(id::text)::uuid into cnt, pid from public.posts where id::text like p_id_prefix || '%';
  if cnt <> 1 then raise exception 'prefix matches % posts', cnt; end if;
  select status into st from public.posts where id = pid;
  if st = 'survived' or st = 'expired' then return 'not re-opened: ' || st; end if;
  if st in ('incomplete', 'archived') then
    update public.posts set status = 'trial' where id = pid;
  end if;
  update public.trial_post_state set decision = null, decided_at = null where post_id = pid;
  return public.run_trial_engine_post(pid);
end;
$$;

-- one post through the same steps as a normal engine run
create or replace function public.run_trial_engine_post(p_post_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.trial_refresh_active();
  perform public.trial_release_stalled(p_post_id);
  perform public.trial_fill_open_slots(p_post_id);
  return public.trial_evaluate_post(p_post_id, public.trial_current_bar());
end;
$$;
revoke all on function public.trial_admin_reevaluate(text), public.run_trial_engine_post(uuid) from public, anon, authenticated;

-- Writes the verdict into the existing lifecycle (same columns / statuses / notifications as the legacy function).
create or replace function public.trial_apply_decision(p_post_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
  dist_hours numeric;
begin
  select user_id into creator from public.posts where id = p_post_id;
  if p_decision = 'survived' then
    select coalesce(max(value) filter (where key = 'distribution_hours'), 24) into dist_hours from public.trial_config;
    update public.posts
       set status = 'survived', survived_at = now(), distribution_started_at = now(),
           distribution_expires_at = now() + (dist_hours * interval '1 hour')
     where id = p_post_id and status = 'trial';
    insert into public.notifications (recipient_id, actor_id, type, post_id) values (creator, creator, 'verdict_survived', p_post_id);
  elsif p_decision = 'failed' then
    update public.posts set status = 'archived' where id = p_post_id and status = 'trial';
    insert into public.notifications (recipient_id, actor_id, type, post_id) values (creator, creator, 'verdict_archived', p_post_id);
  elsif p_decision = 'incomplete' then
    update public.posts set status = 'incomplete' where id = p_post_id and status = 'trial';
    insert into public.notifications (recipient_id, actor_id, type, post_id) values (creator, creator, 'verdict_incomplete', p_post_id);
  end if;
end;
$$;

-- One engine run (every 5 minutes through run_survival_checkpoint): refresh the active pool, start posts that have
-- no cohort yet, evaluate every post that is still testing. Returns how many posts got a final decision.
create or replace function public.run_trial_engine()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  bar double precision;
  r record;
  d text;
  decided integer := 0;
begin
  perform public.trial_refresh_active();
  bar := public.trial_current_bar();

  for r in
    select p.id from public.posts p
    where p.parent_post_id is null and p.status = 'trial' and p.checkpoint_at is not null
      and not exists (select 1 from public.trial_post_state s where s.post_id = p.id)
    order by p.created_at
    limit 500
  loop
    perform public.trial_start_post(r.id);
  end loop;

  for r in
    select s.post_id from public.trial_post_state s
    join public.posts p on p.id = s.post_id
    where s.decision is null and p.status = 'trial' and p.parent_post_id is null
    order by s.created_at
    limit 2000
  loop
    perform public.trial_release_stalled(r.post_id);   -- slots nobody opened are given back ...
    perform public.trial_fill_open_slots(r.post_id);    -- ... and offered to other active viewers
    d := public.trial_evaluate_post(r.post_id, bar);
    if d in ('survived', 'failed', 'incomplete') then decided := decided + 1; end if;
  end loop;
  return decided;
end;
$$;

-- ── 11. The switch: run_survival_checkpoint() keeps its name and its cron job ─
do $$
begin
  if to_regprocedure('public.run_survival_checkpoint_legacy()') is null
     and to_regprocedure('public.run_survival_checkpoint()') is not null then
    alter function public.run_survival_checkpoint() rename to run_survival_checkpoint_legacy;
  end if;
end $$;

create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select engine_mode from public.trial_engine_config where id) = 'legacy' then
    return public.run_survival_checkpoint_legacy();
  end if;
  return public.run_trial_engine();
end;
$$;

-- ── 12. Affinity (viewer -> creator), with time decay ─────────────────────────
-- Built from likes, video reactions, meaningful watches and follows over the last 90 days; each event counts
-- 0.5 ^ (age / half-life). score = 1 - exp(-raw / 2), so one like is about 0.22, a follow about 0.78.
create or replace function public.trial_refresh_affinity()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  n integer;
  started timestamptz := now();
begin
  insert into public.viewer_creator_affinity (viewer_id, creator_id, score, updated_at)
  select e.viewer, e.creator, 1 - exp(-sum(e.w * power(0.5, extract(epoch from now() - e.ts) / 86400.0 / cfg.affinity_half_life_days)) / 2.0), now()
  from (
    select l.user_id as viewer, p.user_id as creator, 1.0 as w, l.created_at as ts
      from public.likes l join public.posts p on p.id = l.post_id
      where l.created_at >= now() - interval '90 days' and l.user_id <> p.user_id
    union all
    select r.user_id, p.user_id, 2.0, r.created_at
      from public.posts r join public.posts p on p.id = r.parent_post_id
      where r.created_at >= now() - interval '90 days' and r.user_id <> p.user_id
    union all
    select s.viewer_id, p.user_id, 0.3, s.updated_at
      from public.post_view_stats s join public.posts p on p.id = s.post_id
      where s.updated_at >= now() - interval '90 days' and p.user_id <> s.viewer_id
        and (s.completed or s.watch_ms >= cfg.watch_seconds * 1000)
    union all
    select f.follower_id, f.followee_id, 3.0, coalesce(f.created_at, now())
      from public.follows f where f.follower_id <> f.followee_id
  ) e
  group by e.viewer, e.creator
  on conflict (viewer_id, creator_id) do update set score = excluded.score, updated_at = excluded.updated_at;
  get diagnostics n = row_count;
  delete from public.viewer_creator_affinity where updated_at < started;   -- relationships that decayed out
  return n;
end;
$$;

-- ── 13. The feed: assigned testing posts first, testing posts only for assigned viewers ─
-- Wraps the existing get_feed(p_limit, p_offset) (defined in the dashboard, not in these migrations). In 'legacy'
-- mode it simply returns get_feed. In 'live' mode: (1) the viewer's assigned, unseen testing posts come first,
-- (2) a few survived posts from high-affinity creators are boosted, (3) get_feed's rows follow, minus testing posts
-- the viewer is not assigned to (their own are kept). page_rows is the number of source rows (so the app can tell the
-- end of the feed even when filtering removed rows); an empty page returns one sentinel row with a null post_id.
create or replace function public.get_feed_engine(p_limit integer default 20, p_offset integer default 0)
returns table (post_id uuid, "position" integer, page_rows integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cfg public.trial_engine_config := public.trial_cfg();
  hide_mature boolean := false;
  assigned uuid[] := '{}';
  boosted uuid[] := '{}';
  front uuid[];
  a_count integer;
  take_front uuid[];
  rest_limit integer;
  rest_offset integer;
  rest_ids uuid[] := '{}';
  src_rows integer := 0;
  feed_ok boolean := to_regprocedure('public.get_feed(integer,integer)') is not null;
  out_ids uuid[];
begin
  if cfg.engine_mode = 'legacy' or me is null then
    if feed_ok then
      return query execute 'select f.post_id, f.position::integer, (select count(*)::integer from public.get_feed($1, $2)) from public.get_feed($1, $2) f' using p_limit, p_offset;
    end if;
    return;
  end if;

  -- The same safety filters as get_feed (supabase/get_feed.sql): blocked either way, reported by me, mature content
  -- for under-18s, moderation, deleted media. Assigned posts do NOT depend on get_feed's pool_b (legacy view cap and
  -- checkpoint time): a cohort the engine opens later is served to its viewers whatever the legacy counters say.
  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature
  from public.profiles pr where pr.id = me;
  hide_mature := coalesce(hide_mature, false);

  -- A viewer who became active after the posts were created is assigned to open slots now (first page only).
  -- Never allowed to break the feed.
  if p_offset = 0 then
    begin
      perform public.trial_assign_on_demand(me);
    exception when others then
      null;
    end;
  end if;

  select coalesce(array_agg(x.post_id order by x.assigned_at), '{}') into assigned
  from (
    select t.post_id, t.assigned_at from public.trial_assignments t
    join public.posts p on p.id = t.post_id
    where t.viewer_id = me and t.released_at is null and p.status = 'trial' and p.parent_post_id is null and p.moderation_status = 'active'
      and p.user_id <> me and p.media_deleted_at is null
      and (not hide_mature or not p.is_mature)
      and not public.trial_is_silenced(p.user_id, me)
      and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
      and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
      and not public.trial_exposed(t.post_id, me)
  ) x;

  select coalesce(array_agg(x.id), '{}') into boosted
  from (
    select p.id from public.posts p
    join public.viewer_creator_affinity a on a.creator_id = p.user_id and a.viewer_id = me and a.score >= cfg.affinity_threshold
    where p.status = 'survived' and p.parent_post_id is null and p.moderation_status = 'active'
      and (p.distribution_expires_at is null or p.distribution_expires_at > now())
      and p.user_id <> me and p.media_deleted_at is null
      and (not hide_mature or not p.is_mature)
      and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
      and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
      and not public.trial_exposed(p.id, me)
    order by a.score desc, p.survived_at desc nulls last
    limit cfg.affinity_feed_boost
  ) x;

  front := assigned || array(select b from unnest(boosted) b where not (b = any (assigned)));
  a_count := coalesce(cardinality(front), 0);

  if p_offset < a_count then
    take_front := front[p_offset + 1 : least(a_count, p_offset + p_limit)];
    rest_limit := p_limit - coalesce(cardinality(take_front), 0);
    rest_offset := 0;
  else
    take_front := '{}';
    rest_limit := p_limit;
    rest_offset := p_offset - a_count;
  end if;

  if feed_ok and rest_limit > 0 then
    execute $q$
      select coalesce(array_agg(f.post_id order by f.position), '{}'), count(*)::integer
      from public.get_feed($1, $2) f
    $q$ into rest_ids, src_rows using rest_limit, rest_offset;
  end if;

  -- drop testing posts this viewer is not assigned to (own posts stay), and anything already placed in front
  rest_ids := array(
    select u.id
    from unnest(rest_ids) with ordinality as u(id, ord)
    join public.posts p on p.id = u.id
    where not (u.id = any (front))
      and ((p.status = 'survived' and (p.distribution_expires_at is null or p.distribution_expires_at > now())
            or (p.status = 'trial' and not public.trial_is_silenced(p.user_id, me) and exists (select 1 from public.trial_assignments t where t.post_id = p.id and t.viewer_id = me and t.released_at is null)))
           or (p.user_id = me and p.status in ('trial', 'incomplete', 'survived')))   -- 'incomplete' / 'archived' / 'expired': never served to others
    order by u.ord
  );

  out_ids := coalesce(take_front, '{}') || rest_ids;
  if coalesce(cardinality(out_ids), 0) = 0 then
    return query select null::uuid, -1, coalesce(cardinality(take_front), 0) + src_rows;
    return;
  end if;
  return query
    select o.id, (p_offset + o.ord)::integer, coalesce(cardinality(take_front), 0) + src_rows
    from unnest(out_ids) with ordinality as o(id, ord);
end;
$$;

grant execute on function public.get_feed_engine(integer, integer) to authenticated;

-- The creator's testing-progress indicator: a 0..1 fraction, no numbers. Own posts only.
create or replace function public.trial_post_progress(p_post_id uuid)
returns double precision
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  cfg public.trial_engine_config := public.trial_cfg();
  n integer;
  pool_total integer;
  need integer;
begin
  if not exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then return null; end if;
  select count(*) into n from public.trial_post_scores(p_post_id);
  select count(*) into pool_total from public.trial_pool(p_post_id);
  need := least(public.trial_clamp_int(ceil(cfg.survive_fraction * pool_total), cfg.survive_min, cfg.survive_max), greatest(cfg.survive_floor, pool_total));
  return least(1.0, n::double precision / greatest(need, 1));
end;
$$;
grant execute on function public.trial_post_progress(uuid) to authenticated;

-- ── 14. Cron ─────────────────────────────────────────────────────────────────
-- Verdicts: the existing 5-minute job 'survival-checkpoint' already calls run_survival_checkpoint() (now the switch).
-- Re-created here so it exists on a database that never had it. Affinity: hourly.
select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'survival-checkpoint';
select cron.schedule('survival-checkpoint', '*/5 * * * *', $cron$ select public.run_survival_checkpoint(); $cron$);

select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'trial-affinity';
select cron.schedule('trial-affinity', '7 * * * *', $cron$ select public.trial_refresh_affinity(); $cron$);

-- Rollback (comment): update public.trial_engine_config set engine_mode = 'legacy';  -- instant, nothing else needed.
-- Full removal: drop trigger trial_start_on_insert on public.posts; then recreate the legacy name:
--   drop function public.run_survival_checkpoint(); alter function public.run_survival_checkpoint_legacy() rename to run_survival_checkpoint;
