-- Tryal: TRYAL FRIENDS and OPEN MESSAGES (idempotent). Run AFTER migration-sanctions.sql: it is the LAST file in MIGRATIONS_ORDER.txt.
--
-- 1. TRYAL FRIENDS (invisible: no button, no list; felt in the feed). A viewer who liked or video-reacted to one of a creator's
--    posts that has already been judged (survived, unjudged, expired ...; not one still on trial) is that creator's Tryal friend.
--    * They get the creator's new posts, testing ones included, pushed near the top of their feed (after Spotlight), newest
--      first, each until they have seen it. Survived posts reach them through the normal survived tiers too.
--    * They can open the creator's testing posts (RLS posts_testing_readable).
--    * They NEVER decide: never assigned as testers (trial_is_silenced, read by the test pool and on-demand assignment) and
--      never counted in a verdict (trial_post_score_details, excluded as 'fan'). Strangers decide.
--    * A like on a post still on trial does not make anyone a Tryal friend, so testers' own likes always count for that post.
--    * Real life always wins: anyone the creator knows (contacts either way, email either way, the hide list, added friends;
--      known_connections, unchanged) never gets the creator's posts. Messaging changes nothing here.
-- 2. OPEN MESSAGES. Anyone can message anyone (a Message button on profiles), with these rules, enforced on every message:
--    * people who are not friends: both must be adults (no adult <-> under-18, no under-18 <-> under-18 strangers);
--    * the recipient's "Who can message me": everyone (the new default) | friends | friends_7d | nobody;
--    * blocks, the word filter, the unanswered-message limit and sanctions are unchanged.
--    Messaging never makes anyone a friend or "known".
--
-- Redefines: trial_is_silenced, trial_post_score_details (from migration-trial-engine.sql); posts_testing_readable (from
-- migration-known-connections.sql); get_feed_engine (a copy of migration-recovery.sql's plus the marked TRYAL FRIENDS parts);
-- chat_conversation_for, my_conversations (from migration-friends-messages.sql); chat_messages_guard, my_controls,
-- set_dm_policy (from migration-harassment.sql).

-- ── 1. Tryal friends ──────────────────────────────────────────────────────────────
-- (an earlier draft of this file defined the Tryal friend by friend request; that rule is gone)
-- The creator's fans: everyone who liked or video-reacted to one of the creator's posts that is no longer on trial.
create or replace function public.trial_fans_of(p_creator uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select l.user_id from public.likes l join public.posts p on p.id = l.post_id
   where p.user_id = p_creator and p.parent_post_id is null and p.status not in ('trial', 'queued') and l.user_id <> p_creator
  union
  select r.user_id from public.posts r join public.posts p on p.id = r.parent_post_id
   where p.user_id = p_creator and p.parent_post_id is null and p.status not in ('trial', 'queued') and r.user_id <> p_creator
$$;

create or replace function public.trial_is_fan(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_creator is not null and p_viewer is not null and p_creator <> p_viewer and (
    exists (select 1 from public.likes l join public.posts p on p.id = l.post_id
             where l.user_id = p_viewer and p.user_id = p_creator and p.parent_post_id is null and p.status not in ('trial', 'queued'))
    or exists (select 1 from public.posts r join public.posts p on p.id = r.parent_post_id
                where r.user_id = p_viewer and p.user_id = p_creator and p.parent_post_id is null and p.status not in ('trial', 'queued')))
$$;

-- A Tryal friend = a fan the creator does not know (real life always wins).
create or replace function public.trial_is_supporter(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.trial_is_fan(p_creator, p_viewer)
     and not exists (select 1 from public.known_connections k where k.user_id = p_creator and k.other_id = p_viewer)
$$;

-- The creators this viewer is a Tryal friend of, as one array (read once per feed page).
create or replace function public.trial_supporter_creators(p_viewer uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct s.creator), '{}')
  from (
    select p.user_id as creator from public.likes l join public.posts p on p.id = l.post_id
     where l.user_id = p_viewer and p.parent_post_id is null and p.status not in ('trial', 'queued')
    union
    select p.user_id from public.posts r join public.posts p on p.id = r.parent_post_id
     where r.user_id = p_viewer and p.parent_post_id is null and p.status not in ('trial', 'queued')
  ) s
  where s.creator <> p_viewer
    and not exists (select 1 from public.known_connections k where k.user_id = s.creator and k.other_id = p_viewer)
$$;

-- Silenced (never a tester for the creator's posts, never in the test pool) = known OR a fan. migration-stranger-only.sql's
-- version plus the fan.
create or replace function public.trial_is_silenced(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.known_connections k where k.user_id = p_creator and k.other_id = p_viewer)
      or public.trial_is_fan(p_creator, p_viewer)
$$;

-- The verdict's viewers: migration-trial-engine.sql's version, with fans excluded like known people.
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
  known as (   -- build in silence: people the creator knows (contact / email / hide list / friends), and the creator's Tryal
               -- friends ('fan': they liked or reacted to an earlier, already judged post; migration-tryal-friends.sql)
    select x.viewer_id, string_agg(distinct x.src, '+') as ks
    from (
      select k.other_id as viewer_id, k.source as src
      from public.known_connections k, cfg, post
      where cfg.build_in_silence and k.user_id = post.user_id
      union all
      select f.viewer_id, 'fan'::text from post cross join lateral public.trial_fans_of(post.user_id) f(viewer_id)
    ) x
    group by x.viewer_id
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

-- Testing posts: readable by Tryal friends too (migration-known-connections.sql's version plus one line).
create or replace function public.posts_testing_readable(p_post_id uuid, p_creator uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  opened boolean := false;
begin
  if me is null then return false; end if;
  if me = p_creator then return true; end if;
  if not public.trial_is_silenced(p_creator, me) then return true; end if;
  if public.trial_is_supporter(p_creator, me) then return true; end if;   -- TRYAL FRIENDS
  if to_regclass('public.chat_messages') is not null then
    execute 'select exists (select 1 from public.chat_messages m join public.chat_conversations c on c.id = m.conversation_id
                             where m.post_id = $1 and m.sender_id = $2 and m.deleted_at is null and $3 in (c.user_a, c.user_b))'
      into opened using p_post_id, p_creator, me;
  end if;
  return opened;
end;
$$;
revoke all on function public.posts_testing_readable(uuid, uuid) from public, anon;
grant execute on function public.posts_testing_readable(uuid, uuid) to authenticated;

-- The feed.
create or replace function public.get_feed_engine(p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_seen uuid[] DEFAULT '{}'::uuid[])
 returns table (post_id uuid, "position" integer, page_rows integer, spotlight_category text)
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
  spot_front uuid[] := '{}';   -- SPOTLIGHT: active, consented, unseen picks this viewer is eligible for (a temporary boost)
  rec_posts uuid[] := '{}';    -- RECOVERY BOOST: the boosted posts of the moment (testing posts; they lead the viewer's assigned posts)
  full_spot uuid[] := '{}';    -- SPOTLIGHT: picked posts of a FULL spotlight: the one thing a known connection may get (never the hide list)
  supporting uuid[] := '{}';   -- TRYAL FRIENDS (migration-tryal-friends.sql): creators whose posts this viewer liked or reacted to
  friend_front uuid[] := '{}'; -- TRYAL FRIENDS: those creators' newest posts (testing or fresh survived) this viewer has not seen yet
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
  -- TRYAL FRIENDS: creators whose (already judged) posts this viewer liked or reacted to, never someone who knows the viewer.
  supporting := public.trial_supporter_creators(me);
  select coalesce(max(c.value) filter (where c.key = 'distribution_hours'), 24)::double precision into dist_h from public.trial_config c;

  -- SPOTLIGHT (migration-spotlight.sql). Only with the creator's consent, decided here like every other exposure rule:
  --  * full: the picked post may also reach known connections (friends, contacts) -- but never someone on the creator's hide list;
  --  * strangers: the boost only goes to eligible strangers.
  perform public.spotlight_expire();
  select coalesce(array_agg(sp.post_id), '{}') into full_spot
    from public.spotlight_picks sp
    where sp.status = 'full' and sp.ends_at > now() and not public.trial_feed_hidden(sp.creator_id, me);
  select coalesce(array_agg(x.post_id order by x.starts_at desc, x.post_id), '{}') into spot_front
  from (
    select sp.post_id, sp.starts_at
    from public.spotlight_picks sp
    join public.posts p on p.id = sp.post_id
    where sp.status in ('full', 'strangers') and sp.ends_at > now()
      and public.spotlight_eligible(sp.creator_id, sp.status, me)
      and p.parent_post_id is null and p.moderation_status = 'active' and p.media_deleted_at is null
      and (p.status = 'survived' or (p.status = 'expired' and p.survived_at is not null))
      and (not hide_mature or not p.is_mature)
      and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
      and not exists (select 1 from public.post_raw_views v where v.post_id = p.id and v.viewer_id = me)
      and not (p.id = any (seen))
  ) x;

  -- TRYAL FRIENDS: pushed to the top (after Spotlight), newest first, each only until this viewer has seen it. They are never
  -- assigned as testers and never count toward a verdict (trial_is_silenced / trial_post_score_details below): strangers decide.
  if coalesce(cardinality(supporting), 0) > 0 then
    select coalesce(array_agg(x.id order by x.created_at desc, x.id), '{}') into friend_front
    from (
      select p.id, p.created_at
      from public.posts p
      where p.user_id = any (supporting)
        and p.parent_post_id is null and p.moderation_status = 'active' and p.media_deleted_at is null
        and (p.status = 'trial'
             or (p.status = 'survived' and coalesce(p.survived_at, p.created_at) >= now() - (dist_h * interval '1 hour')))
        and (not hide_mature or not p.is_mature)
        and not exists (select 1 from public.feed_blocked_ids() b(id) where b.id = p.user_id)
        and not exists (select 1 from public.reports r where r.reporter_id = me and r.target_type = 'post' and r.target_id = p.id)
        and not exists (select 1 from public.post_raw_views v where v.post_id = p.id and v.viewer_id = me)
        and not (p.id = any (seen))
      order by p.created_at desc
      limit 20
    ) x;
  end if;

  -- RECOVERY BOOST (migration-recovery.sql): eligible FRESH strangers are assigned a boosted post; it then leads their assigned posts.
  perform public.recovery_expire();
  perform public.recovery_boost_assign(me);
  rec_posts := public.recovery_boosted_posts();

  if p_offset = 0 and not use_seen then
    begin
      perform public.trial_assign_on_demand(me);
    exception when others then
      null;
    end;
  end if;

  select coalesce(array_agg(x.post_id order by (x.post_id = any (rec_posts)) desc, x.rr, x.created_at, x.post_id), '{}') into assigned
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
      and (not (p.user_id = any (known_to_me)) or p.id = any (full_spot))
    order by a.score desc, p.survived_at desc nulls last
    limit cfg.affinity_feed_boost
  ) x;

  -- The Spotlight posts this viewer is eligible for come FIRST (before the testing posts), each only until it has been seen;
  -- then new posts from the viewer's Tryal friends, then the testing posts, then the creators the viewer engages with.
  front := spot_front
    || array(select f from unnest(friend_front) f where not (f = any (spot_front)))
    || array(select a from unnest(assigned) a where not (a = any (spot_front)) and not (a = any (friend_front)))
    || array(select b from unnest(boosted) b where not (b = any (assigned)) and not (b = any (spot_front)) and not (b = any (friend_front)));
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
      and (not (p.user_id = any (known_to_me)) or p.id = any (full_spot))
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
    return query select null::uuid, -1, avail, null::text;
    return;
  end if;
  return query
    select o.id, (p_offset + o.ord)::integer, avail,
           case when o.id = any (spot_front)
                then (select sp.category from public.spotlight_picks sp
                       where sp.post_id = o.id and sp.status in ('full', 'strangers') and sp.ends_at > now()
                       order by sp.starts_at desc limit 1)
           end
    from unnest(out_ids) with ordinality as o(id, ord);
end;
$function$;

-- ── 2. open messages ─────────────────────────────────────────────────────────────────
alter table public.creator_controls alter column dm_policy set default 'everyone';
alter table public.creator_controls drop constraint if exists creator_controls_dm_policy_check;
alter table public.creator_controls add constraint creator_controls_dm_policy_check
  check (dm_policy in ('everyone', 'friends', 'friends_7d', 'nobody'));

-- May p_from message p_to although they are not friends? Raises the reason if not.
create or replace function public.chat_check_stranger(p_from uuid, p_to uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  pol text;
begin
  if public.friends_is_minor(p_from) or public.friends_is_minor(p_to) then
    raise exception 'you cannot message this person' using errcode = '42501';
  end if;
  select dm_policy into pol from public.creator_controls where user_id = p_to;
  if coalesce(pol, 'everyone') <> 'everyone' then
    raise exception 'This person is not taking messages from people who are not their friends.' using errcode = '42501';
  end if;
end;
$$;

-- The caller's conversation with someone (made on demand): a friend, or an adult who takes messages from everyone. Never a
-- blocked person. (migration-friends-messages.sql's version, friends only, is replaced.)
create or replace function public.chat_conversation_for(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cid uuid;
begin
  if me is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_other is null or p_other = me or not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'you cannot message this person' using errcode = '42501';
  end if;
  if public.friends_blocked(me, p_other) then
    raise exception 'you cannot message this person' using errcode = '42501';
  end if;
  if not public.friends_are(me, p_other)
     and not exists (select 1 from public.chat_conversations where user_a = least(me, p_other) and user_b = greatest(me, p_other)) then
    perform public.chat_check_stranger(me, p_other);
  end if;
  insert into public.chat_conversations (user_a, user_b) values (least(me, p_other), greatest(me, p_other))
  on conflict (user_a, user_b) do nothing;
  select id into cid from public.chat_conversations where user_a = least(me, p_other) and user_b = greatest(me, p_other);
  return cid;
end;
$$;

-- The Messages list: every conversation, friends or not (migration-friends-messages.sql's version without the friends-only line).
create or replace function public.my_conversations()
returns table (other_id uuid, username text, display_name text, avatar_url text, last_text text, last_was_post boolean,
               last_at timestamptz, unread integer)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.username, o.display_name, o.avatar_url,
         lm.body, coalesce(lm.was_post, false), c.last_message_at,
         (select count(*)::integer from public.chat_messages m
           where m.conversation_id = c.id and m.sender_id <> auth.uid() and m.deleted_at is null
             and m.created_at > coalesce((select r.last_read_at from public.chat_reads r where r.conversation_id = c.id and r.user_id = auth.uid()), 'epoch'))
  from public.chat_conversations c
  join public.profiles o on o.id = case when c.user_a = auth.uid() then c.user_b else c.user_a end
  left join lateral (
    select m.body, m.was_post from public.chat_messages m
     where m.conversation_id = c.id and m.deleted_at is null order by m.created_at desc limit 1
  ) lm on true
  where auth.uid() in (c.user_a, c.user_b)
    and not public.friends_blocked(c.user_a, c.user_b)
    and lm.was_post is not null
  order by c.last_message_at desc
$$;

-- Every message, whatever app sends it (migration-harassment.sql's version plus the not-friends rule).
create or replace function public.chat_messages_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.chat_conversations;
  other uuid;
  cfg public.harassment_config;
  pol text;
  since timestamptz;
begin
  select * into c from public.chat_conversations where id = new.conversation_id;
  if not found then return new; end if;
  other := case when c.user_a = new.sender_id then c.user_b else c.user_a end;
  select * into cfg from public.harassment_config where id;
  -- 1. the words
  perform public.text_check(new.body);
  -- 2. who may message the recipient (people who are not friends: adults only, and only when the recipient takes messages from
  --    everyone; migration-tryal-friends.sql)
  if not public.friends_are(new.sender_id, other) then
    perform public.chat_check_stranger(new.sender_id, other);
  end if;
  select dm_policy into pol from public.creator_controls where user_id = other;
  if pol = 'nobody' then
    raise exception 'This person is not taking messages right now.' using errcode = '42501';
  elsif pol = 'friends_7d' then
    select created_at into since from public.friendships where user_a = least(new.sender_id, other) and user_b = greatest(new.sender_id, other);
    if since is null or since > now() - (cfg.friend_min_days * interval '1 day') then
      raise exception 'This person only takes messages from people who have been friends for % days.', cfg.friend_min_days using errcode = '42501';
    end if;
  end if;
  -- 3. no endless one-sided messaging
  if public.harassment_unanswered(new.conversation_id, new.sender_id) >= cfg.unanswered_limit then
    raise exception 'Wait for a reply before sending more.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.my_controls()
returns table (dm_policy text)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.dm_policy from public.creator_controls c where c.user_id = auth.uid()), 'everyone')
$$;

create or replace function public.set_dm_policy(p_policy text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '28000'; end if;
  if p_policy not in ('everyone', 'friends', 'friends_7d', 'nobody') then raise exception 'unknown policy'; end if;
  insert into public.creator_controls (user_id, dm_policy) values (auth.uid(), p_policy)
  on conflict (user_id) do update set dm_policy = excluded.dm_policy, updated_at = now();
end;
$$;

-- ── 3. grants ───────────────────────────────────────────────────────────────────────
revoke all on function public.trial_fans_of(uuid), public.trial_is_fan(uuid, uuid), public.trial_is_supporter(uuid, uuid),
  public.trial_supporter_creators(uuid), public.trial_is_silenced(uuid, uuid), public.trial_post_score_details(uuid),
  public.chat_check_stranger(uuid, uuid), public.chat_messages_guard()
  from public, anon, authenticated;
revoke all on function public.chat_conversation_for(uuid), public.my_conversations(), public.my_controls(), public.set_dm_policy(text) from public, anon;
grant execute on function public.chat_conversation_for(uuid), public.my_conversations(), public.my_controls(), public.set_dm_policy(text) to authenticated;
