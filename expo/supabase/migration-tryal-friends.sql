-- Tryal: TRYAL FRIENDS ARE SUPPORTERS (idempotent). Run AFTER migration-sanctions.sql: it is the LAST file in MIGRATIONS_ORDER.txt.
-- Redefines get_feed_engine (a copy of migration-recovery.sql's, plus the marked TRYAL FRIENDS parts) and posts_testing_readable.
--
-- Two kinds of people a creator "knows":
--   * real life: phone contacts (either direction), email matches, the hide list, and friends made through an INVITE LINK (a
--     link travels outside the app, so that person came from the creator's life). Unchanged: they never get the creator's posts.
--   * a TRYAL FRIEND (supporter): a friendship made inside the app with a friend request (friendships.via = 'request') and NO
--     other link between the two (no contact match either way, no email match either way, not on the creator's hide list).
--     Real life always wins: the moment a contact / email match appears, or the creator hides them, they are known again.
-- A supporter:
--   * gets the creator's new posts, testing ones included, pushed near the top of the feed (after Spotlight), newest first,
--     each until they have seen it; survived posts also reach them through the normal survived tiers;
--   * can open the creator's testing posts (RLS);
--   * NEVER counts toward a verdict and is NEVER assigned as a tester: the verdict, the test pool, Recovery Boost and Spotlight
--     read known_connections, which is NOT changed here. Strangers decide; supporters cheer.

-- ── 1. who is a supporter ─────────────────────────────────────────────────────────
create or replace function public.trial_is_supporter(p_creator uuid, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_creator is not null and p_viewer is not null and p_creator <> p_viewer
     and exists (select 1 from public.friendships f
                  where f.via = 'request'
                    and f.user_a = least(p_creator, p_viewer) and f.user_b = greatest(p_creator, p_viewer))
     and not exists (select 1 from public.known_connections k
                      where k.user_id = p_creator and k.other_id = p_viewer and k.source <> 'friend')
$$;

-- The creators this viewer supports, as one array (read once per feed page).
create or replace function public.trial_supporter_creators(p_viewer uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(distinct s.creator), '{}')
  from (
    select case when f.user_a = p_viewer then f.user_b else f.user_a end as creator
    from public.friendships f
    where f.via = 'request' and p_viewer in (f.user_a, f.user_b)
  ) s
  where not exists (select 1 from public.known_connections k
                     where k.user_id = s.creator and k.other_id = p_viewer and k.source <> 'friend')
$$;
revoke all on function public.trial_is_supporter(uuid, uuid), public.trial_supporter_creators(uuid) from public, anon, authenticated;

-- ── 2. testing posts: readable by supporters too ─────────────────────────────────────
-- migration-known-connections.sql's version plus one line: a supporter of the creator may read their testing posts.
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

-- ── 3. the feed ─────────────────────────────────────────────────────────────────────
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
  supporting uuid[] := '{}';   -- TRYAL FRIENDS (migration-tryal-friends.sql): creators this viewer met on Tryal and supports
  friend_front uuid[] := '{}'; -- TRYAL FRIENDS: their newest posts (testing or fresh survived) this viewer has not seen yet
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
  -- TRYAL FRIENDS: a friend made ON Tryal (a friend request, no contact / email / hide-list link) is a supporter, not someone from
  -- the creator's real life: they get the creator's posts, testing included. They still never count toward a verdict (that rule
  -- reads known_connections, unchanged) and are never assigned as testers.
  supporting := public.trial_supporter_creators(me);
  known_to_me := array(select k from unnest(known_to_me) k where not (k = any (supporting)));
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

  -- TRYAL FRIENDS: pushed to the top (after Spotlight), newest first, each only until this viewer has seen it.
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

-- ── 4. internals stay internal ───────────────────────────────────────────────────────
revoke all on function public.trial_is_supporter(uuid, uuid), public.trial_supporter_creators(uuid) from public, anon, authenticated;
