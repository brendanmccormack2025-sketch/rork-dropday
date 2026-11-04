-- Tryal: STRANGER-ONLY distribution (idempotent). Run AFTER migration-live-snapshot.sql and migration-known-connections.sql; it is the
-- LAST file in MIGRATIONS_ORDER.txt. Replaces what the snapshot recorded (get_feed_engine, chat_can_send_post, chat_post_available)
-- with the stranger-only versions; the snapshot stays the record of what was live. Nothing here is a setting.
--
--  1. Known people (contacts by phone or email, friends, the creator's hide list; migration-known-connections.sql) never get a
--     creator's posts anywhere: not the feed (any tier: trial assignments, the affinity boost, survived posts, the older-survived
--     fallback), not Explore, not creator search, not suggested creators. The check runs in the database before anything is
--     returned. A known person who opens the creator's PROFILE still sees the survived posts. A viewer's own posts are not in
--     their feed.
--  2. Survived posts stay on the creator's profile for good and are shown only to eligible strangers: fresh survivors first,
--     then older survivors when the feed would run dry, then "all caught up" (client).
--  3. Sharing: a creator may send their OWN posts (trial or survived) to their friends. Nobody may send someone else's post to a
--     known person of that post's creator (chat_can_send_post / chat_post_available).
--  4. Trial rules for NEW posts: "incomplete" is not a failure. A post nobody could judge yet (too few strangers, or borderline)
--     stays on trial and keeps being shown to strangers until the cap (trial_engine_config.max_test_hours, default 72 h from the
--     trial start). At the cap it survives if it meets the bar, otherwise it fails. A post that fails is DELETED: media queued for
--     the delete-media job first, then the post, its reactions and everything hanging on it. Survived posts are never deleted.
--     Existing archived / incomplete rows are left alone. The anonymous numbers behind the moving bar are kept (trial_bar_samples:
--     a score and a time, no post, no person).
--  5. The silence switch (build_in_silence) can no longer be turned off, and the per-friend exception (friend_test_optin) is gone.

-- ── 1. configuration ───────────────────────────────────────────────────────────
alter table public.trial_engine_config add column if not exists max_test_hours double precision not null default 72;   -- hard cap of a trial
update public.trial_engine_config set build_in_silence = true where not build_in_silence;
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.trial_engine_config'::regclass and conname = 'trial_engine_config_stranger_only') then
    alter table public.trial_engine_config add constraint trial_engine_config_stranger_only check (build_in_silence);
  end if;
end $$;

-- ── 2. who knows me ───────────────────────────────────────────────────────────────
-- Silenced = the creator knows the viewer (any source). Not a setting any more.
create or replace function public.trial_is_silenced(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.known_connections k where k.user_id = p_creator and k.other_id = p_viewer)
$$;

-- The creators who know this viewer, as one array (read once per feed page, not once per post).
create or replace function public.trial_creators_who_know(p_viewer uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct k.user_id), '{}') from public.known_connections k where k.other_id = p_viewer
$$;
revoke all on function public.trial_is_silenced(uuid, uuid), public.trial_creators_who_know(uuid) from public, anon, authenticated;

-- ── 3. the per-friend exception is gone (migration-known-connections.sql dropped the table; this makes it certain) ──
drop trigger if exists friend_test_optin_cleanup on public.friendships;
drop function if exists public.friend_test_optin_cleanup();
drop function if exists public.set_friend_can_test(uuid, boolean);
drop function if exists public.friend_can_test(uuid);
drop table if exists public.friend_test_optin;

-- ── 4. the trial: cap, no 'incomplete', deletion of failed posts ────────────────────────
-- 4a. anonymous numbers behind the moving bar survive the deletion of a failed post
create table if not exists public.trial_bar_samples (
  id             bigint generated always as identity primary key,
  decision       text not null check (decision in ('survived', 'failed')),
  posterior_mean double precision not null,
  decided_at     timestamptz not null default now()
);
create index if not exists trial_bar_samples_decided_idx on public.trial_bar_samples (decided_at);
alter table public.trial_bar_samples enable row level security;
revoke all on table public.trial_bar_samples from anon, authenticated;

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
  select count(*), percentile_cont(cfg.bar_percentile) within group (order by s.posterior_mean)
  into judged, pct
  from (
    select posterior_mean, decided_at from public.trial_post_state where decision in ('survived', 'failed')
    union all
    select posterior_mean, decided_at from public.trial_bar_samples
  ) s
  where s.posterior_mean is not null
    and s.decided_at >= now() - (cfg.bar_window_days * interval '1 day');
  w := least(1, judged::double precision / cfg.bar_full_posts);
  return (1 - w) * cfg.bar_base + w * coalesce(pct, cfg.bar_base);
end;
$$;

-- 4b. the cap: a trial lasts max_test_hours from its start (checkpoint_at is what every engine function reads as "the end")
create or replace function public.trial_cap_checkpoint()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h double precision;
begin
  if new.status = 'trial' and new.parent_post_id is null and new.checkpoint_at is not null
     and (tg_op = 'INSERT' or new.checkpoint_at is distinct from old.checkpoint_at) then
    select max_test_hours into h from public.trial_engine_config where id;
    new.checkpoint_at := coalesce(new.testing_started_at, new.created_at, now()) + (coalesce(h, 72) * interval '1 hour');
  end if;
  return new;
end;
$$;
drop trigger if exists zzz_trial_cap_checkpoint on public.posts;   -- 'zzz': after trg_set_checkpoint_at and zz_trial_queue
create trigger zzz_trial_cap_checkpoint
  before insert or update of checkpoint_at on public.posts
  for each row execute function public.trial_cap_checkpoint();
revoke all on function public.trial_cap_checkpoint() from public, anon, authenticated;

-- 4c. a failed post is deleted for good: media queued first (the delete-media job removes the files), then the post row; its
-- reactions, likes, views, assignments and scores go with it (foreign keys), shares in messages become "isn't available".
create or replace function public.trial_delete_failed_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.posts where id = p_post_id and parent_post_id is null and status = 'trial' and survived_at is null) then
    return;   -- never a survived post, never a reaction, never one that is not on trial
  end if;
  perform public.trial_hide_post(p_post_id);        -- queues every file of the post and its reactions, removes their notifications
  delete from public.posts where id = p_post_id;    -- reactions go with it (parent_post_id on delete cascade)
end;
$$;
revoke all on function public.trial_delete_failed_post(uuid) from public, anon, authenticated;

create or replace function public.trial_apply_decision(p_post_id uuid, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  creator uuid;
  dist_hours numeric;
  mean double precision;
begin
  select user_id into creator from public.posts where id = p_post_id;
  select posterior_mean into mean from public.trial_post_state where post_id = p_post_id;
  if p_decision = 'survived' then
    select coalesce(max(value) filter (where key = 'distribution_hours'), 24) into dist_hours from public.trial_config;
    update public.posts
       set status = 'survived', survived_at = now(), distribution_started_at = now(),
           distribution_expires_at = now() + (dist_hours * interval '1 hour')
     where id = p_post_id and status = 'trial';
    insert into public.notifications (recipient_id, actor_id, type, post_id) values (creator, creator, 'verdict_survived', p_post_id);
  elsif p_decision = 'failed' then
    -- the number behind the bar stays (no post, no person); the post is deleted; nobody is told
    if mean is not null then
      insert into public.trial_bar_samples (decision, posterior_mean) values ('failed', mean);
    end if;
    perform public.trial_delete_failed_post(p_post_id);
  elsif p_decision = 'incomplete' then
    -- not produced by the engine any more (a borderline post stays on trial until the cap); kept for old callers
    update public.posts set status = 'incomplete' where id = p_post_id and status = 'trial';
  end if;
  -- a testing slot just freed up: the creator's oldest queued post starts its trial
  perform public.trial_start_next_queued(creator);
end;
$$;
revoke all on function public.trial_apply_decision(uuid, text) from public, anon, authenticated;

-- 4d. the verdict: the same engine as before, except that "borderline" and "too few strangers" keep testing until the cap, and
-- the cap decides (survive on the bar, otherwise fail). (The two marked changes are the only differences from
-- migration-trial-engine.sql.)
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
  active integer;
  need_active integer;
begin
  select * into post from public.posts where id = p_post_id;
  select * into st from public.trial_post_state where post_id = p_post_id for update;
  if post.id is null or st.post_id is null or st.decision is not null then return 'testing'; end if;

  select count(*), coalesce(sum(score), 0) into n, sum_s from public.trial_post_scores(p_post_id);
  -- Watching is not enough to survive: strangers must actively respond (like, share or video reaction), at least
  -- min_active of them or min_active_fraction of those who saw it, whichever is more.
  select count(*) into active from public.trial_post_score_details(p_post_id) d
   where not d.excluded and (d.liked or d.shared or d.reacted);
  need_active := greatest(cfg.min_active, ceil(cfg.min_active_fraction * n)::integer);
  -- pool_unexposed = viewers who could still show up for this post: they have been active since it was created and their
-- slot was not given back for inactivity. Inactive / released viewers do not block a decision (they count again if they
-- return before it: opening the feed makes them active and on-demand assignment revives their slot).
  select count(*), count(*) filter (where not exposed and not assigned),
         count(*) filter (where not exposed and last_active >= coalesce(post.testing_started_at, post.created_at) and not released)
    into pool_total, pool_left, pool_unexposed from public.trial_pool(p_post_id);

  k := public.trial_prior_strength(pool_total);
  alpha := k * p_bar + sum_s;
  beta  := k * (1 - p_bar) + (n - sum_s);
  p := 1 - public.trial_beta_cdf(p_bar, alpha, beta);
  mean_s := case when n > 0 then sum_s / n else null end;

  -- minimums never exceed the people actually available
  min_survive := least(public.trial_clamp_int(ceil(cfg.survive_fraction * pool_total), cfg.survive_min, cfg.survive_max), greatest(cfg.survive_floor, pool_total));
  min_fail    := least(public.trial_clamp_int(ceil(cfg.fail_fraction * pool_total),    cfg.fail_min,    cfg.fail_max),    greatest(cfg.fail_floor,    pool_total));

  if n >= min_survive and p >= cfg.p_survive and active >= need_active then
    verdict := 'survived'; reason := 'confidence';
  elsif n >= min_fail and p <= cfg.p_fail
        and (n >= cfg.min_exhausted_viewers or now() >= post.checkpoint_at) then   -- never ENDED early on fewer strangers (surviving early is fine)
    verdict := 'failed'; reason := 'confidence';
  elsif pool_total >= 1 and pool_unexposed = 0 and n >= 1
        and (n >= cfg.min_exhausted_viewers or now() >= post.checkpoint_at) then
    -- POOL EXHAUSTED: every eligible (non-known) viewer has seen it and nobody is left to assign. Decided early only once
    -- at least min_exhausted_viewers strangers judged it (a tiny early-days pool must not settle a post after an hour on
    -- two or three swipes): with fewer, it keeps testing so people who open the app later still get it, and at 24 h it is
    -- decided here on the same rule instead of a blanket incomplete.
    -- Decide on the posterior mean: survive above the bar, fail well below it, otherwise keep testing (no 'incomplete' any more).
    reason := 'pool_exhausted';
    if active < need_active then
      verdict := 'failed';                           -- everyone available saw it and too few responded: Tryal ended
    elsif alpha / (alpha + beta) >= p_bar - 1e-9 then   -- a tie survives
      verdict := 'survived';
    elsif alpha / (alpha + beta) < cfg.exhausted_fail_ratio * p_bar then
      verdict := 'failed';
    else
      verdict := 'testing';                          -- borderline is not a failure: it stays on trial (see the cap below)
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

  -- THE CAP (checkpoint_at = trial start + max_test_hours, see the trigger below): a post that could not be judged yet (too
  -- few strangers saw it, or it is borderline) is NOT a failure: it stays on trial and keeps being shown to strangers. At
  -- the cap it survives if it meets the bar (and enough strangers responded), otherwise it fails and is deleted.
  if verdict = 'testing' and now() >= post.checkpoint_at then
    reason := 'checkpoint_cap';
    if n >= 1 and active >= need_active and alpha / (alpha + beta) >= p_bar - 1e-9 then
      verdict := 'survived';
    else
      verdict := 'failed';
    end if;
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
revoke all on function public.trial_evaluate_post(uuid, double precision) from public, anon, authenticated;

-- ── 5. the feed ───────────────────────────────────────────────────────────────────
-- get_feed_engine as recorded in migration-live-snapshot.sql, with: no legacy path (the dashboard get_feed is not
-- stranger-aware), the viewer's own posts out, and known people excluded from every survived tier (and the affinity boost).
create or replace function public.get_feed_engine(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_seen uuid[] DEFAULT '{}'::uuid[])
 returns table (post_id uuid, "position" integer, page_rows integer)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  me uuid := auth.uid();
  cfg public.trial_engine_config := public.trial_cfg();
  hide_mature boolean := false;
  seen uuid[] := coalesce(p_seen, '{}');
  use_seen boolean := coalesce(cardinality(p_seen), 0) > 0;
  assigned uuid[] := '{}';
  boosted uuid[] := '{}';
  front uuid[];
  a_count integer;
  take_front uuid[];
  rest_limit integer;
  rest_offset integer;
  rest_ids uuid[] := '{}';
  src_rows integer := 0;
  out_ids uuid[];
  avail integer;
  known_to_me uuid[] := '{}';   -- creators who know me (contacts, email, friends, their hide list): never in my feed
  dist_h double precision := 24;
begin
  -- (No legacy path: the dashboard get_feed is not stranger-aware, so it is never used.)
  if me is null then
    return;
  end if;

  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature
  from public.profiles pr where pr.id = me;
  hide_mature := coalesce(hide_mature, false);
  -- STRANGER-ONLY: decided here, in the database, before any content is returned. Known people never get a creator's posts,
  -- testing OR survived (they can still open the creator's profile on purpose).
  known_to_me := public.trial_creators_who_know(me);
  select coalesce(max(c.value) filter (where c.key = 'distribution_hours'), 24)::double precision into dist_h from public.trial_config c;

  if p_offset = 0 and not use_seen then
    begin
      perform public.trial_assign_on_demand(me);
    exception when others then
      null;
    end;
  end if;

  select coalesce(array_agg(x.post_id order by x.rr, x.created_at, x.post_id), '{}') into assigned
  from (
    select t.post_id, p.created_at,
           row_number() over (partition by p.user_id order by p.created_at, p.id) as rr
    from public.trial_assignments t
    join public.posts p on p.id = t.post_id
    where t.viewer_id = me and t.released_at is null and p.status = 'trial' and p.parent_post_id is null and p.moderation_status = 'active'
      and p.user_id <> me and p.media_deleted_at is null
      and (not hide_mature or not p.is_mature)
      and not (p.user_id = any (known_to_me))
      and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
      and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
      and not public.trial_exposed(t.post_id, me)
      and not (t.post_id = any (seen))
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
      and not (p.id = any (seen))
      and not (p.user_id = any (known_to_me))
    order by a.score desc, p.survived_at desc nulls last
    limit cfg.affinity_feed_boost
  ) x;

  front := assigned || array(select b from unnest(boosted) b where not (b = any (assigned)));
  a_count := coalesce(cardinality(front), 0);

  if use_seen then
    take_front := front[1 : least(a_count, p_limit)];
    rest_limit := p_limit - coalesce(cardinality(take_front), 0);
    rest_offset := 0;
  elsif p_offset < a_count then
    take_front := front[p_offset + 1 : least(a_count, p_offset + p_limit)];
    rest_limit := p_limit - coalesce(cardinality(take_front), 0);
    rest_offset := 0;
  else
    take_front := '{}';
    rest_limit := p_limit;
    rest_offset := p_offset - a_count;
  end if;

  -- SURVIVED POSTS of STRANGERS, after every testing post. Fresh ones first (survived within the distribution window); then,
  -- when the feed would otherwise run dry, older survived posts (they are never deleted). Never the viewer's own posts and
  -- never a creator who knows the viewer. Each tier: unseen before seen, every creator's best before anyone's second, most
  -- liked first. When nothing is left the app shows "all caught up".
  select coalesce(array_agg(x.id order by x.older, x.was_seen, x.creator_rank, x.score desc, x.survived_at desc nulls last, x.id), '{}')
    into rest_ids
  from (
    select p.id, p.survived_at, e.score, f.older,
           exists (select 1 from public.post_raw_views v where v.post_id = p.id and v.viewer_id = me) as was_seen,
           row_number() over (
             partition by p.user_id, f.older
             order by e.score desc, p.survived_at desc nulls last, p.id) as creator_rank
    from public.posts p
    cross join lateral (
      select (coalesce(p.survived_at, p.created_at) < now() - (dist_h * interval '1 hour')) as older
    ) f
    cross join lateral (
      select (select count(*) from public.likes l where l.post_id = p.id and l.user_id <> p.user_id)
             + cfg.survived_reaction_weight
               * (select count(distinct r.user_id) from public.posts r where r.parent_post_id = p.id and r.user_id <> p.user_id)
             as score
    ) e
    where (p.status = 'survived' or (p.status = 'expired' and p.survived_at is not null))
      and p.parent_post_id is null and p.moderation_status = 'active' and p.media_deleted_at is null
      and (not hide_mature or not p.is_mature)
      and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
      and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
      and p.user_id <> me
      and not (p.user_id = any (known_to_me))
      and not (p.id = any (front)) and not (p.id = any (seen))
  ) x;
  src_rows := coalesce(cardinality(rest_ids), 0);

  if use_seen then
    avail := a_count + src_rows;
    rest_ids := rest_ids[1 : greatest(rest_limit, 0)];
  else
    rest_ids := rest_ids[rest_offset + 1 : rest_offset + greatest(rest_limit, 0)];
    avail := coalesce(cardinality(take_front), 0) + coalesce(cardinality(rest_ids), 0);
  end if;

  out_ids := coalesce(take_front, '{}') || coalesce(rest_ids, '{}');
  if coalesce(cardinality(out_ids), 0) = 0 then
    return query select null::uuid, -1, avail;
    return;
  end if;
  return query
    select o.id, (p_offset + o.ord)::integer, avail
    from unnest(out_ids) with ordinality as o(id, ord);
end;
$function$;

-- ── 6. sharing posts in messages ───────────────────────────────────────────────────
-- The creator may send their OWN posts (trial or survived) to their friends. Nobody may send someone else's post to a known
-- person of its creator (or to the creator). Someone else's trial post only if the sender has seen it themselves.
create or replace function public.chat_can_send_post(p_post_id uuid, p_sender uuid, p_to uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  p record;
  alive boolean;
begin
  select * into p from public.posts where id = p_post_id;
  if not found or p.parent_post_id is not null or p.moderation_status <> 'active' or p.media_deleted_at is not null then return false; end if;
  if p.is_mature and public.friends_is_minor(p_to) then return false; end if;
  alive := p.status in ('trial', 'survived') or (p.status = 'expired' and p.survived_at is not null);
  if not alive then return false; end if;
  if p.user_id = p_sender then return true; end if;                       -- the creator, to their own friends
  if p.user_id = p_to then return false; end if;
  if public.friends_blocked(p.user_id, p_to) then return false; end if;
  -- someone else's post: never to a known person of its creator
  if exists (select 1 from public.known_connections k where k.user_id = p.user_id and k.other_id = p_to) then return false; end if;
  if p.status = 'trial' then return public.trial_exposed(p.id, p_sender); end if;   -- no guessing of ids
  return true;
end;
$$;

create or replace function public.chat_post_available(p_post_id uuid, p_recipient uuid, p_sender uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  return exists (
    select 1 from public.posts p
    where p.id = p_post_id
      and p.parent_post_id is null
      and p.moderation_status = 'active'
      and p.media_deleted_at is null
      and not (p.is_mature and public.friends_is_minor(p_recipient))
      and (p.status in ('trial', 'survived') or (p.status = 'expired' and p.survived_at is not null))
      and (
        p.user_id = p_sender                 -- the creator's own post, sent to a friend
        or p.user_id = p_recipient           -- the creator opening what was sent to them
        or (not public.friends_blocked(p.user_id, p_recipient)
            and not exists (select 1 from public.known_connections k where k.user_id = p.user_id and k.other_id = p_recipient))
      )
  );
end;
$$;
revoke all on function public.chat_can_send_post(uuid, uuid, uuid), public.chat_post_available(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.chat_can_send_post(uuid, uuid, uuid), public.chat_post_available(uuid, uuid, uuid) to service_role;

-- ── 7. discovery: Explore, creator search, suggested creators ─────────────────────────
-- All three answer only about the signed-in person and never return the person themselves, anyone who knows them, anyone
-- blocked either way, or an under-13 profile. (The profile of a single person stays readable by id: a known person who visits
-- a profile sees its survived posts.)
create or replace function public.stranger_creator_ids()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(p.id), '{}')
    from public.profiles p
   where auth.uid() is not null
     and p.id <> auth.uid()
     and not exists (select 1 from public.known_connections k where k.user_id = p.id and k.other_id = auth.uid())
     and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.id)
     and coalesce(public.age_tier(p.birthdate), 'unknown') <> 'under_13'
$$;
revoke all on function public.stranger_creator_ids() from public, anon, authenticated;

-- Explore: strangers ranked by strangers' likes + reactions on their survived posts (same shape as before).
drop function if exists public.get_explore_creators();   -- (the old one had other attributes; the client reads id as a string either way)
create function public.get_explore_creators()
returns table (id text, username text, display_name text, avatar_url text, total_engagement bigint)
language sql
stable
security definer
set search_path = public
as $$
  with ok as (select unnest(public.stranger_creator_ids()) as uid)
  select p.id::text, p.username, p.display_name, p.avatar_url,
         (coalesce((select count(*) from public.likes l join public.posts x on x.id = l.post_id
                     where x.user_id = p.id and l.user_id <> p.id and x.survived_at is not null), 0)
          + coalesce((select count(*) from public.posts r join public.posts x on x.id = r.parent_post_id
                       where x.user_id = p.id and r.user_id <> p.id and x.survived_at is not null), 0))::bigint as total_engagement
    from public.profiles p
    join ok on ok.uid = p.id
   where exists (select 1 from public.posts s where s.user_id = p.id and s.parent_post_id is null and s.survived_at is not null
                   and s.moderation_status = 'active' and s.media_deleted_at is null)
   order by 5 desc, p.username
   limit 20
$$;
revoke all on function public.get_explore_creators() from public, anon;
grant execute on function public.get_explore_creators() to authenticated;

-- Suggested creators: strangers with a survived post, newest survivor first.
create or replace function public.suggested_creators(p_limit integer default 20)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  with ok as (select unnest(public.stranger_creator_ids()) as uid)
  select p.id, p.username, p.display_name, p.avatar_url
    from public.profiles p
    join ok on ok.uid = p.id
    join lateral (select max(s.survived_at) as at from public.posts s
                   where s.user_id = p.id and s.parent_post_id is null and s.survived_at is not null
                     and s.moderation_status = 'active' and s.media_deleted_at is null) latest on latest.at is not null
   order by latest.at desc
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;
revoke all on function public.suggested_creators(integer) from public, anon;
grant execute on function public.suggested_creators(integer) to authenticated;

-- Creator search by username or display name (strangers only).
create or replace function public.search_creators(p_query text, p_limit integer default 20)
returns table (id uuid, username text, display_name text, avatar_url text)
language sql
stable
security definer
set search_path = public
as $$
  with ok as (select unnest(public.stranger_creator_ids()) as uid),
       q as (select replace(replace(replace(btrim(coalesce(p_query, '')), '\', '\\'), '%', '\%'), '_', '\_') as t)
  select p.id, p.username, p.display_name, p.avatar_url
    from public.profiles p
    join ok on ok.uid = p.id
    cross join q
   where length(q.t) >= 1
     and (p.username ilike '%' || q.t || '%' or coalesce(p.display_name, '') ilike '%' || q.t || '%')
   order by (p.username ilike q.t || '%') desc, p.username
   limit greatest(1, least(coalesce(p_limit, 20), 50))
$$;
revoke all on function public.search_creators(text, integer) from public, anon;
grant execute on function public.search_creators(text, integer) to authenticated;
