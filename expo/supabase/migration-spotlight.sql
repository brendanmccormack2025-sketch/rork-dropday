-- Tryal Spotlight (Phase 2). Idempotent; run after migration-stranger-only.sql (it is last in MIGRATIONS_ORDER.txt).
--
-- An admin picks a creator, one of their survived posts and a category. The creator is offered it and chooses:
--   * full Spotlight       the picked post may also reach friends and contacts (never someone on the creator's hide list),
--   * strangers-only       only people who do not know the creator (the Phase 1 known-connections rule),
--   * decline.
-- NOTHING is shown to anyone before the creator says yes, and nothing reaches a known connection without a FULL yes. The
-- exposure rule lives in ONE function (spotlight_eligible) used by the feed boost and the profile
-- badge. A Spotlight is a temporary boost (spotlight_hours); the badge shows for badge_days; the same creator cannot be
-- offered a Spotlight again within rotation_days (a declined offer counts: nobody is pestered). No payments.
--
--   spotlight_admins / spotlight_config / spotlight_picks   tables (closed to apps; everything goes through the RPCs below)
--   admin_spotlight_creators / _posts / _offer / _list / _withdraw   admin only (spotlight_admins)
--   my_spotlight_offers / respond_spotlight_offer            the creator
--   profile_spotlight                                        the badge (eligibility enforced here)
--   get_feed_engine                                          redefined: Spotlight posts lead the feed (copy of the stranger-only one, plus
--                                                            a spotlight_category column for the label)

-- ── 1. configuration, admins, picks ─────────────────────────────────────────────────────
create table if not exists public.spotlight_config (
  id              boolean primary key default true check (id),
  rotation_days   integer not null default 30 check (rotation_days >= 0),
  offer_hours     integer not null default 72 check (offer_hours > 0),
  spotlight_hours integer not null default 72 check (spotlight_hours > 0),
  badge_days      integer not null default 30 check (badge_days >= 0)
);
insert into public.spotlight_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.spotlight_admins (
  user_id uuid primary key,
  created_at timestamptz not null default now()
);
-- the owner (constants/debug.ts OWNER_USER_ID); more admins are added here, in the SQL editor
insert into public.spotlight_admins (user_id) values ('aee21757-1ded-41a7-9392-bddbf0d657df') on conflict do nothing;

create table if not exists public.spotlight_picks (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null,
  post_id      uuid not null references public.posts (id) on delete cascade,
  category     text not null check (category in ('creator_of_the_day', 'rising_creators', 'most_creative', 'best_storytelling', 'most_improved', 'community_favorite')),
  status       text not null default 'offered' check (status in ('offered', 'full', 'strangers', 'declined', 'expired', 'ended', 'withdrawn')),
  chosen_by    uuid not null,
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  starts_at    timestamptz,
  ends_at      timestamptz
);
create index if not exists spotlight_picks_creator_idx on public.spotlight_picks (creator_id, created_at desc);
create index if not exists spotlight_picks_active_idx on public.spotlight_picks (status, ends_at) where status in ('full', 'strangers');
alter table public.spotlight_config enable row level security;
alter table public.spotlight_admins enable row level security;
alter table public.spotlight_picks enable row level security;
revoke all on table public.spotlight_config, public.spotlight_admins, public.spotlight_picks from anon, authenticated;

-- the new notification type (existing values are kept)
do $$
declare c record;
begin
  if to_regclass('public.notifications') is not null then
    for c in select conname from pg_constraint where conrelid = 'public.notifications'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%verdict_survived%'
    loop
      execute format('alter table public.notifications drop constraint %I', c.conname);
    end loop;
    alter table public.notifications add constraint notifications_type_check
      check (type in ('like', 'reaction', 'follow', 'follow_request', 'follow_accept',
                      'verdict_survived', 'verdict_archived', 'verdict_incomplete', 'verdict_unjudged', 'followed_post_survived',
                      'friend_request', 'friend_accept', 'message', 'spotlight_offer'));
  end if;
end $$;

-- ── 2. internals: expiry and THE exposure rule ────────────────────────────────────────────
-- Offers nobody answered in offer_hours expire; a Spotlight ends at ends_at. Done when the data is read (no cron needed).
create or replace function public.spotlight_expire()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.spotlight_config;
begin
  select * into cfg from public.spotlight_config where id;
  update public.spotlight_picks set status = 'ended' where status in ('full', 'strangers') and ends_at <= now();
  update public.spotlight_picks set status = 'expired'
   where status = 'offered' and created_at <= now() - (coalesce(cfg.offer_hours, 72) * interval '1 hour');
end;
$$;

-- May this viewer be shown this creator's Spotlight (the section, the feed boost, the badge)?
--   never the creator themselves, never a block either way, never someone on the creator's hide list;
--   strangers mode: never a known connection (Phase 1 known_connections); full mode: known connections may see it.
create or replace function public.spotlight_eligible(p_creator uuid, p_mode text, p_viewer uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_viewer is not null and p_creator is not null and p_viewer <> p_creator
    and not exists (select 1 from public.user_blocks b
                     where (b.blocker_id = p_viewer and b.blocked_id = p_creator) or (b.blocker_id = p_creator and b.blocked_id = p_viewer))
    and not public.trial_feed_hidden(p_creator, p_viewer)
    and (p_mode = 'full' or (p_mode = 'strangers' and not public.trial_is_silenced(p_creator, p_viewer)))
$$;

create or replace function public.spotlight_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and exists (select 1 from public.spotlight_admins a where a.user_id = auth.uid())
$$;
revoke all on function public.spotlight_expire(), public.spotlight_eligible(uuid, text, uuid), public.spotlight_is_admin() from public, anon, authenticated;

-- ── 3. admin: find a creator and a post, send the offer, see and withdraw picks ─────────────────
create or replace function public.admin_spotlight_creators(p_query text default '', p_limit integer default 20)
returns table (id uuid, username text, display_name text, avatar_url text, survived_posts integer, last_pick_at timestamptz, next_eligible_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.spotlight_config;
begin
  if not public.spotlight_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into cfg from public.spotlight_config where spotlight_config.id;
  return query
  select pr.id, pr.username::text, pr.display_name::text, pr.avatar_url::text,
         (select count(*)::integer from public.posts p where p.user_id = pr.id and p.parent_post_id is null and p.survived_at is not null
            and p.moderation_status = 'active' and p.media_deleted_at is null),
         lp.at,
         case when lp.at is null then null else lp.at + (cfg.rotation_days * interval '1 day') end
  from public.profiles pr
  left join lateral (select max(s.created_at) as at from public.spotlight_picks s where s.creator_id = pr.id and s.status not in ('withdrawn', 'expired')) lp on true
  where exists (select 1 from public.posts p where p.user_id = pr.id and p.parent_post_id is null and p.survived_at is not null
                  and p.moderation_status = 'active' and p.media_deleted_at is null)
    and (coalesce(trim(p_query), '') = '' or pr.username ilike '%' || trim(p_query) || '%' or pr.display_name ilike '%' || trim(p_query) || '%')
  order by lp.at nulls first, pr.username
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
end;
$$;

create or replace function public.admin_spotlight_posts(p_creator uuid)
returns table (post_id uuid, caption text, thumbnail_url text, survived_at timestamptz, likes bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.spotlight_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
  select p.id, p.caption::text, p.thumbnail_url::text, p.survived_at,
         (select count(*) from public.likes l where l.post_id = p.id and l.user_id <> p.user_id)
  from public.posts p
  where p.user_id = p_creator and p.parent_post_id is null and p.survived_at is not null
    and p.moderation_status = 'active' and p.media_deleted_at is null
  order by p.survived_at desc
  limit 50;
end;
$$;

create or replace function public.admin_spotlight_offer(p_creator uuid, p_post uuid, p_category text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.spotlight_config;
  pick uuid;
begin
  if not public.spotlight_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into cfg from public.spotlight_config where id;
  perform public.spotlight_expire();
  if p_category is null or p_category not in ('creator_of_the_day', 'rising_creators', 'most_creative', 'best_storytelling', 'most_improved', 'community_favorite') then
    raise exception 'unknown category';
  end if;
  if not exists (select 1 from public.posts p where p.id = p_post and p.user_id = p_creator and p.parent_post_id is null
                   and p.survived_at is not null and p.moderation_status = 'active' and p.media_deleted_at is null) then
    raise exception 'the post must be a survived post of that creator';
  end if;
  -- rotation: a creator who was offered or featured in the last rotation_days (a decline counts) is not offered again
  if exists (select 1 from public.spotlight_picks s
              where s.creator_id = p_creator and s.status not in ('withdrawn', 'expired')
                and s.created_at > now() - (cfg.rotation_days * interval '1 day')) then
    raise exception 'that creator was offered or featured within the last % days', cfg.rotation_days;
  end if;
  insert into public.spotlight_picks (creator_id, post_id, category, chosen_by)
  values (p_creator, p_post, p_category, auth.uid()) returning id into pick;
  -- the creator hears about it (actor = the creator, like the verdict rows: the admin is not shown)
  insert into public.notifications (recipient_id, actor_id, type, post_id) values (p_creator, p_creator, 'spotlight_offer', p_post);
  return pick;
end;
$$;

create or replace function public.admin_spotlight_list(p_limit integer default 50)
returns table (id uuid, creator_id uuid, username text, post_id uuid, category text, status text, created_at timestamptz, responded_at timestamptz, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.spotlight_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.spotlight_expire();
  return query
  select s.id, s.creator_id, pr.username::text, s.post_id, s.category, s.status, s.created_at, s.responded_at, s.starts_at, s.ends_at
  from public.spotlight_picks s left join public.profiles pr on pr.id = s.creator_id
  order by s.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

create or replace function public.admin_spotlight_withdraw(p_pick uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.spotlight_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update public.spotlight_picks set status = 'withdrawn', ends_at = least(coalesce(ends_at, now()), now())
   where id = p_pick and status in ('offered', 'full', 'strangers');
end;
$$;

-- ── 4. the creator: see the offers, choose ───────────────────────────────────────────────────
create or replace function public.my_spotlight_offers()
returns table (pick_id uuid, category text, post_id uuid, thumbnail_url text, status text, created_at timestamptz, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.spotlight_config;
begin
  if auth.uid() is null then return; end if;
  select * into cfg from public.spotlight_config where id;
  perform public.spotlight_expire();
  return query
  select s.id, s.category, s.post_id, p.thumbnail_url::text, s.status, s.created_at,
         case when s.status = 'offered' then s.created_at + (cfg.offer_hours * interval '1 hour') else s.ends_at end
  from public.spotlight_picks s join public.posts p on p.id = s.post_id
  where s.creator_id = auth.uid() and s.status in ('offered', 'full', 'strangers')
  order by s.created_at desc;
end;
$$;

-- p_choice: 'full' | 'strangers' | 'decline'. Only the creator, only an open offer. Returns the new status.
create or replace function public.respond_spotlight_offer(p_pick uuid, p_choice text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.spotlight_config;
  new_status text;
  n integer;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  new_status := case p_choice when 'full' then 'full' when 'strangers' then 'strangers' when 'decline' then 'declined' else null end;
  if new_status is null then raise exception 'unknown choice'; end if;
  select * into cfg from public.spotlight_config where id;
  perform public.spotlight_expire();
  update public.spotlight_picks
     set status = new_status, responded_at = now(),
         starts_at = case when new_status = 'declined' then null else now() end,
         ends_at = case when new_status = 'declined' then null else now() + (cfg.spotlight_hours * interval '1 hour') end
   where id = p_pick and creator_id = auth.uid() and status = 'offered';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'this offer is not open any more'; end if;
  return new_status;
end;
$$;

-- ── 5. what viewers see: the post leads their FEED (get_feed_engine below, with the category label) and the profile badge ──
-- (There is no Spotlight section: an earlier version had get_spotlight for an Explore row; it is gone.)
drop function if exists public.get_spotlight(integer);

-- The badge on a creator's profile: the category, for badge_days after the Spotlight started. The creator always sees their own;
-- anyone else only if they are eligible (so a known connection of a strangers-only Spotlight sees nothing).
create or replace function public.profile_spotlight(p_user_id uuid)
returns table (category text, starts_at timestamptz, active boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  cfg public.spotlight_config;
begin
  if me is null or p_user_id is null then return; end if;
  select * into cfg from public.spotlight_config where id;
  perform public.spotlight_expire();
  return query
  select s.category, s.starts_at, (s.status in ('full', 'strangers') and s.ends_at > now())
  from public.spotlight_picks s
  where s.creator_id = p_user_id and s.status in ('full', 'strangers', 'ended') and s.starts_at is not null
    and s.starts_at > now() - (cfg.badge_days * interval '1 day')
    and (p_user_id = me or public.spotlight_eligible(p_user_id, case when s.status = 'ended' then 'strangers' else s.status end, me))
  order by s.starts_at desc
  limit 1;
end;
$$;
-- (an ended Spotlight keeps its badge for badge_days; since the consent behind it is not remembered per mode once it ended, the
-- badge of an ended one is shown to strangers only: the safe side)

revoke all on function
  public.admin_spotlight_creators(text, integer), public.admin_spotlight_posts(uuid), public.admin_spotlight_offer(uuid, uuid, text),
  public.admin_spotlight_list(integer), public.admin_spotlight_withdraw(uuid), public.my_spotlight_offers(),
  public.respond_spotlight_offer(uuid, text), public.profile_spotlight(uuid)
  from public, anon;
grant execute on function
  public.admin_spotlight_creators(text, integer), public.admin_spotlight_posts(uuid), public.admin_spotlight_offer(uuid, uuid, text),
  public.admin_spotlight_list(integer), public.admin_spotlight_withdraw(uuid), public.my_spotlight_offers(),
  public.respond_spotlight_offer(uuid, text), public.profile_spotlight(uuid)
  to authenticated;

-- ── 6. the feed: the Spotlight boost (this is migration-stranger-only.sql's get_feed_engine plus the marked SPOTLIGHT parts) ──
-- (a new column: spotlight_category, the label for a Spotlight post; the function is dropped and made again)
drop function if exists public.get_feed_engine(integer, integer, uuid[]);
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
  full_spot uuid[] := '{}';    -- SPOTLIGHT: picked posts of a FULL spotlight: the one thing a known connection may get (never the hide list)
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
      and (not (p.user_id = any (known_to_me)) or p.id = any (full_spot))
    order by a.score desc, p.survived_at desc nulls last
    limit cfg.affinity_feed_boost
  ) x;

  -- The Spotlight posts this viewer is eligible for come FIRST (before the testing posts), each only until it has been seen;
  -- then the testing posts, then the creators the viewer engages with.
  front := spot_front
    || array(select a from unnest(assigned) a where not (a = any (spot_front)))
    || array(select b from unnest(boosted) b where not (b = any (assigned)) and not (b = any (spot_front)));
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
revoke all on function public.get_feed_engine(integer, integer, uuid[]) from public, anon;
grant execute on function public.get_feed_engine(integer, integer, uuid[]) to authenticated, service_role;
