-- Live get_feed() as defined in the Supabase dashboard (saved verbatim so it is in the repo).
-- Depends on (dashboard-defined, not in the repo): feed_settings(), trial_required_views(), feed_blocked_ids(),
-- feed_seen_ids(uuid[]); and age_tier() from migration-age-gating.sql.
-- Note: pool_b (testing posts) is limited by the legacy view cap and checkpoint_at; the progressive-testing engine
-- does not rely on it (see get_feed_engine in migration-trial-engine.sql).

CREATE OR REPLACE FUNCTION public.get_feed(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0)
 RETURNS TABLE(post_id uuid, "position" integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
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

  v_step := case
    when cfg.testing_ratio <= 0 then 1000000
    else greatest(2, round(1.0 / cfg.testing_ratio))::int
  end;

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
               b.qualified_view_count,
               b.created_at,
               b.id
           ) as k
    from pool_b b
  ),
  merged as (
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
$function$;
