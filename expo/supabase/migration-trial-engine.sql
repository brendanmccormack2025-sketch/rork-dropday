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
begin
  if auth.uid() is null then return; end if;
  if exists (select 1 from public.posts where id = p_post_id and user_id = auth.uid()) then return; end if;   -- own post: ignored
  insert into public.post_view_stats (post_id, viewer_id, watch_ms, duration_ms, completed)
  values (p_post_id, auth.uid(), greatest(0, coalesce(p_watch_ms, 0)), greatest(0, coalesce(p_duration_ms, 0)), coalesce(p_completed, false))
  on conflict (post_id, viewer_id) do update
    set watch_ms    = greatest(public.post_view_stats.watch_ms, excluded.watch_ms),
        duration_ms = greatest(public.post_view_stats.duration_ms, excluded.duration_ms),
        completed   = public.post_view_stats.completed or excluded.completed,
        updated_at  = now();
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
grant execute on function public.record_post_share(uuid) to authenticated;

-- ── 4. Engine tables (server side only: RLS on, no client policies) ──────────
create table if not exists public.trial_assignments (
  post_id     uuid not null references public.posts(id) on delete cascade,
  viewer_id   uuid not null references auth.users(id) on delete cascade,
  stage       integer not null,
  assigned_at timestamptz not null default now(),
  primary key (post_id, viewer_id)
);
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
create table if not exists public.trial_engine_state (
  id boolean primary key default true check (id),
  active_refreshed_at timestamptz,
  active_window_hours double precision not null default 24
);
insert into public.trial_engine_state (id) values (true) on conflict (id) do nothing;
alter table public.trial_active_users enable row level security;
alter table public.trial_engine_state enable row level security;

revoke all on table public.trial_engine_config, public.trial_assignments, public.trial_post_state, public.trial_engine_log,
  public.viewer_creator_affinity, public.trial_active_users, public.trial_engine_state, public.post_view_stats
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
         exists (select 1 from public.post_view_stats s where s.post_id = p_post_id and s.viewer_id = u.user_id)
           or exists (select 1 from public.post_raw_views r where r.post_id = p_post_id and r.viewer_id = u.user_id),
         exists (select 1 from public.trial_assignments t where t.post_id = p_post_id and t.viewer_id = u.user_id)
  from public.trial_active_users u
  join public.posts p on p.id = p_post_id
  left join public.viewer_creator_affinity a on a.viewer_id = u.user_id and a.creator_id = p.user_id
  where u.last_active >= now() - ((select active_window_hours from public.trial_engine_state where id) * interval '1 hour')
    and u.user_id <> p.user_id
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
create or replace function public.trial_post_scores(p_post_id uuid)
returns table (viewer_id uuid, score double precision)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (select * from public.trial_cfg()),
  post as (select id, user_id from public.posts where id = p_post_id),
  viewers as (
    select v.viewer_id, min(v.first_at) as first_at
    from (
      select s.viewer_id, s.created_at as first_at from public.post_view_stats s where s.post_id = p_post_id
      union all
      select r.viewer_id, r.created_at from public.post_raw_views r where r.post_id = p_post_id
    ) v
    join post on post.user_id <> v.viewer_id
    group by v.viewer_id
  ),
  base as (
    select vw.viewer_id, vw.first_at,
           coalesce(s.watch_ms, 0) as watch_ms, coalesce(s.duration_ms, 0) as duration_ms,
           coalesce(s.completed, false) as completed, coalesce(s.shared, false) as shared,
           exists (select 1 from public.likes l where l.post_id = p_post_id and l.user_id = vw.viewer_id) as liked,
           exists (select 1 from public.posts r where r.parent_post_id = p_post_id and r.user_id = vw.viewer_id) as reacted
    from viewers vw
    left join public.post_view_stats s on s.post_id = p_post_id and s.viewer_id = vw.viewer_id
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
  )
  select r.viewer_id,
    least(1.0,
      (case when r.completed or r.watch_ms >= cfg.swipe_seconds * 1000 then
          cfg.w_watch * (case when r.watch_ms >= cfg.watch_fraction * r.duration_ms and r.duration_ms > 0
                                   or r.watch_ms >= cfg.watch_seconds * 1000 then 1 else 0 end)
          + cfg.w_complete * (case when r.completed then 1 else 0 end)
        else 0 end)
      + (cfg.w_like * (case when r.liked then 1 else 0 end)
         + cfg.w_share * (case when r.shared then 1 else 0 end)
         + cfg.w_reaction * (case when r.reacted then 1 else 0 end))
        * (case when coalesce(r.total, 0) < cfg.norm_min_sample then 1
                else least(cfg.norm_max, greatest(cfg.norm_min, cfg.norm_ref_rate / greatest(r.engaged::double precision / r.total, 0.01))) end)
    )
    * (case when pr.created_at > r.first_at - (cfg.new_account_hours * interval '1 hour') then cfg.new_account_weight else 1 end)
    * (case when coalesce(af.score, 0) >= cfg.affinity_threshold then cfg.affinity_weight else 1 end)
    as score
  from rated r
  cross join cfg
  join post on true
  left join public.profiles pr on pr.id = r.viewer_id
  left join public.viewer_creator_affinity af on af.viewer_id = r.viewer_id and af.creator_id = post.user_id;
$$;

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

create or replace function public.trial_assign_cohort(p_post_id uuid, p_stage integer)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer;
  remaining integer;
  want integer;
  n integer;
begin
  select count(*), count(*) filter (where not exposed and not assigned) into total, remaining from public.trial_pool(p_post_id);
  want := least(public.trial_cohort_size(total, p_stage), remaining);
  if want <= 0 then return 0; end if;
  insert into public.trial_assignments (post_id, viewer_id, stage)
  select p_post_id, c.user_id, p_stage
  from public.trial_pool(p_post_id) c
  where not c.exposed and not c.assigned
  order by c.affinity asc, random()
  limit want
  on conflict (post_id, viewer_id) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

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
  alpha double precision;
  beta double precision;
  p double precision;
  pool_total integer;
  pool_left integer;
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
  select count(*), count(*) filter (where not exposed and not assigned) into pool_total, pool_left from public.trial_pool(p_post_id);

  alpha := cfg.prior_strength * p_bar + sum_s;
  beta  := cfg.prior_strength * (1 - p_bar) + (n - sum_s);
  p := 1 - public.trial_beta_cdf(p_bar, alpha, beta);
  mean_s := case when n > 0 then sum_s / n else null end;

  -- minimums never exceed the people actually available
  min_survive := least(public.trial_clamp_int(ceil(cfg.survive_fraction * pool_total), cfg.survive_min, cfg.survive_max), greatest(cfg.survive_floor, pool_total));
  min_fail    := least(public.trial_clamp_int(ceil(cfg.fail_fraction * pool_total),    cfg.fail_min,    cfg.fail_max),    greatest(cfg.fail_floor,    pool_total));

  if n >= min_survive and p >= cfg.p_survive then
    verdict := 'survived';
  elsif n >= min_fail and p <= cfg.p_fail then
    verdict := 'failed';
  elsif p >= cfg.p_expand then
    -- expand once the current cohort has mostly seen the post (or has had time)
    select count(*), count(*) filter (where exists (select 1 from public.post_view_stats s where s.post_id = p_post_id and s.viewer_id = t.viewer_id)
                                          or exists (select 1 from public.post_raw_views r where r.post_id = p_post_id and r.viewer_id = t.viewer_id))
      into assigned_stage, exposed_stage
    from public.trial_assignments t where t.post_id = p_post_id and t.stage = st.stage;
    ready := assigned_stage = 0
          or exposed_stage >= cfg.expand_ready_fraction * assigned_stage
          or (exposed_stage >= 1 and st.stage_started_at <= now() - (cfg.expand_stall_minutes * interval '1 minute'));
    if ready and pool_left > 0 then
      verdict := 'expand';
    end if;
  end if;

  if verdict = 'testing' and now() >= post.checkpoint_at then
    verdict := 'incomplete';   -- 24 h and still no decision
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
    insert into public.trial_engine_log (post_id, stage, n, score_mean, p_above_bar, bar, pool, decision)
    values (p_post_id, st.stage, n, mean_s, p, p_bar, pool_total, verdict);
    update public.trial_post_state set last_logged_n = n where post_id = p_post_id;
  end if;
  return verdict;
end;
$$;

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

  select coalesce(array_agg(x.post_id order by x.assigned_at), '{}') into assigned
  from (
    select t.post_id, t.assigned_at from public.trial_assignments t
    join public.posts p on p.id = t.post_id
    where t.viewer_id = me and p.status = 'trial' and p.parent_post_id is null and p.moderation_status = 'active'
      and not exists (select 1 from public.post_raw_views r where r.post_id = t.post_id and r.viewer_id = me)
      and not exists (select 1 from public.post_view_stats s where s.post_id = t.post_id and s.viewer_id = me)
  ) x;

  select coalesce(array_agg(x.id), '{}') into boosted
  from (
    select p.id from public.posts p
    join public.viewer_creator_affinity a on a.creator_id = p.user_id and a.viewer_id = me and a.score >= cfg.affinity_threshold
    where p.status = 'survived' and p.parent_post_id is null and p.moderation_status = 'active'
      and (p.distribution_expires_at is null or p.distribution_expires_at > now())
      and p.user_id <> me
      and not exists (select 1 from public.post_raw_views r where r.post_id = p.id and r.viewer_id = me)
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
            or (p.status = 'trial' and exists (select 1 from public.trial_assignments t where t.post_id = p.id and t.viewer_id = me)))
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
