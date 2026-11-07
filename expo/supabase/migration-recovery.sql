-- Tryal Recovery Boost (Phase 4). Idempotent; run after migration-harassment.sql (it is last in MIGRATIONS_ORDER.txt).
--
-- A creator who has been harassed gets a one-time lift for their NEXT post. "Harassed" is confirmed, never claimed:
--   * REPORTS: reports against the SAME account about content or messages AIMED AT this creator (a message to them; a reaction or
--     reply under their post) from at least min_reporters DISTINCT reporters, each reporter account at least min_account_days old
--     and NOT a known connection of the creator in either direction (Phase 1's known_connections: contacts, email, friends, hide
--     list), never the creator and never the offender. Dismissed reports do not count. (Anti-collusion.)
--   * OWNER: a hide / remove by the owner in the review queue (admin_report_resolve) on such content confirms it at once.
-- Then the creator gets an in-app notification (recovery_offer) and an offer screen; it names nobody. They accept or say "not now".
-- If they accept, their next post (created after accepting) is boosted: for boost_hours, up to boost_max_viewers FRESH strangers
-- (never viewed anything of theirs) are assigned it and it leads their assigned posts. Same server-side rules as every post: never a
-- known connection, never the creator, blocks and the mature rule honoured. Never the post involved in the incident; at most one
-- boost per window_days. All numbers are in recovery_config.

-- ── 1. configuration and tables ───────────────────────────────────────────────────────
create table if not exists public.recovery_config (
  id                    boolean primary key default true check (id),
  min_reporters         integer not null default 3,
  min_account_days      integer not null default 7,
  lookback_days         integer not null default 60,
  window_days           integer not null default 30,
  offer_valid_days      integer not null default 14,
  accept_valid_days     integer not null default 60,
  decline_cooldown_days integer not null default 14,
  boost_hours           integer not null default 72,
  boost_max_viewers     integer not null default 50
);
insert into public.recovery_config (id) values (true) on conflict (id) do nothing;

create table if not exists public.recovery_offers (
  id               uuid primary key default gen_random_uuid(),
  creator_id       uuid not null,
  offender_id      uuid not null,
  source           text not null check (source in ('reports', 'owner')),
  incident_post_ids uuid[] not null default '{}',
  status           text not null default 'offered' check (status in ('offered', 'accepted', 'used', 'declined', 'expired', 'lapsed')),
  created_at       timestamptz not null default now(),
  responded_at     timestamptz,
  accepted_at      timestamptz,
  boost_post_id    uuid references public.posts (id) on delete set null,
  boost_started_at timestamptz,
  boost_ends_at    timestamptz
);
create index if not exists recovery_offers_creator_idx on public.recovery_offers (creator_id, created_at desc);
create table if not exists public.recovery_boost_viewers (
  offer_id    uuid not null references public.recovery_offers (id) on delete cascade,
  viewer_id   uuid not null,
  assigned_at timestamptz not null default now(),
  primary key (offer_id, viewer_id)
);
alter table public.recovery_config enable row level security;
alter table public.recovery_offers enable row level security;
alter table public.recovery_boost_viewers enable row level security;
revoke all on table public.recovery_config, public.recovery_offers, public.recovery_boost_viewers from anon, authenticated;

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
                      'friend_request', 'friend_accept', 'message', 'spotlight_offer', 'recovery_offer'));
  end if;
end $$;

-- ── 2. who a report is aimed at ─────────────────────────────────────────────────────────
-- (creator, offender, incident post) for a report: a message goes to the other person in its conversation; a reaction or reply is
-- aimed at the creator of the post it sits under (and of the reaction it answers). A report on someone's own plain post is aimed
-- at nobody.
create or replace function public.recovery_aims(p_report uuid)
returns table (creator uuid, offender uuid, incident_post uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  r public.reports;
  m record;
  p public.posts;
  root uuid;
  parent_owner uuid;
  root_owner uuid;
begin
  select * into r from public.reports where id = p_report;
  if not found then return; end if;
  if r.target_type = 'message' then
    select cm.sender_id, cm.post_id, c.user_a, c.user_b into m
      from public.chat_messages cm join public.chat_conversations c on c.id = cm.conversation_id where cm.id = r.target_id;
    if found then
      return query select case when m.user_a = m.sender_id then m.user_b else m.user_a end, m.sender_id, m.post_id;
    end if;
  elsif r.target_type in ('post', 'reaction') then
    select * into p from public.posts where id = r.target_id;
    if found and p.parent_post_id is not null then
      root := public.root_post_of(p.id);
      select user_id into parent_owner from public.posts where id = p.parent_post_id;
      select user_id into root_owner from public.posts where id = root;
      if root_owner is not null then return query select root_owner, p.user_id, root; end if;
      if parent_owner is not null and parent_owner is distinct from root_owner then return query select parent_owner, p.user_id, root; end if;
    end if;
  end if;
end;
$$;

-- Does this reporter count for this creator? (anti-collusion)
create or replace function public.recovery_reporter_counts(p_creator uuid, p_reporter uuid, p_offender uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_reporter is not null and p_reporter <> p_creator and p_reporter <> p_offender
    and exists (select 1 from public.profiles pr where pr.id = p_reporter
                  and pr.created_at <= now() - ((select min_account_days from public.recovery_config where id) * interval '1 day'))
    and not exists (select 1 from public.known_connections k
                     where (k.user_id = p_creator and k.other_id = p_reporter) or (k.user_id = p_reporter and k.other_id = p_creator))
$$;

-- ── 3. offers ─────────────────────────────────────────────────────────────────────────────
create or replace function public.recovery_expire()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.recovery_config;
begin
  select * into cfg from public.recovery_config where id;
  update public.recovery_offers set status = 'expired' where status = 'offered' and created_at <= now() - (cfg.offer_valid_days * interval '1 day');
  update public.recovery_offers set status = 'lapsed' where status = 'accepted' and accepted_at <= now() - (cfg.accept_valid_days * interval '1 day');
end;
$$;

-- Make an offer if the creator may have one: none open, none boosted within window_days, no recent decline. Returns its id or null.
create or replace function public.recovery_offer(p_creator uuid, p_offender uuid, p_source text, p_incident uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.recovery_config;
  id uuid;
begin
  if p_creator is null or p_offender is null or p_creator = p_offender then return null; end if;
  select * into cfg from public.recovery_config where recovery_config.id;
  perform public.recovery_expire();
  if exists (select 1 from public.recovery_offers o where o.creator_id = p_creator and o.status in ('offered', 'accepted')) then return null; end if;
  if exists (select 1 from public.recovery_offers o where o.creator_id = p_creator and o.status = 'used'
              and o.accepted_at > now() - (cfg.window_days * interval '1 day')) then return null; end if;
  if exists (select 1 from public.recovery_offers o where o.creator_id = p_creator and o.status = 'declined'
              and o.responded_at > now() - (cfg.decline_cooldown_days * interval '1 day')) then return null; end if;
  insert into public.recovery_offers (creator_id, offender_id, source, incident_post_ids)
  values (p_creator, p_offender, p_source, coalesce(p_incident, '{}')) returning recovery_offers.id into id;
  insert into public.notifications (recipient_id, actor_id, type) values (p_creator, p_creator, 'recovery_offer');
  return id;
end;
$$;

-- Count the qualifying distinct reporters against this offender for this creator; at min_reporters, make the offer.
create or replace function public.recovery_evaluate(p_creator uuid, p_offender uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.recovery_config;
  n integer;
  incident uuid[];
begin
  select * into cfg from public.recovery_config where id;
  select count(distinct r.reporter_id)::integer, coalesce(array_agg(distinct a.incident_post) filter (where a.incident_post is not null), '{}')
    into n, incident
  from public.reports r
  cross join lateral public.recovery_aims(r.id) a
  where a.creator = p_creator and a.offender = p_offender
    and r.status <> 'dismissed'
    and r.created_at > now() - (cfg.lookback_days * interval '1 day')
    and public.recovery_reporter_counts(p_creator, r.reporter_id, p_offender);
  if n >= cfg.min_reporters then
    perform public.recovery_offer(p_creator, p_offender, 'reports', incident);
  end if;
end;
$$;

create or replace function public.reports_recovery_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare a record;
begin
  for a in select distinct creator, offender from public.recovery_aims(new.id) loop
    perform public.recovery_evaluate(a.creator, a.offender);
  end loop;
  return new;
end;
$$;
drop trigger if exists zzz_reports_recovery on public.reports;
create trigger zzz_reports_recovery after insert on public.reports
  for each row execute function public.reports_recovery_trigger();

-- The review queue's resolve (migration-harassment.sql) with one addition: hiding or removing content aimed at a creator is the
-- owner's confirmation, and offers them a Recovery Boost at once.
create or replace function public.admin_report_resolve(p_report uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.reports;
  a record;
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_action not in ('dismiss', 'reviewed', 'hide', 'remove') then raise exception 'unknown action'; end if;
  select * into r from public.reports where id = p_report;
  if not found then raise exception 'unknown report'; end if;
  if p_action in ('hide', 'remove') then
    -- the owner's confirmation first, while the message still carries the post it shared (that post is the incident)
    for a in select ra.creator, ra.offender, ra.incident_post from public.recovery_aims(p_report) ra loop
      perform public.recovery_offer(a.creator, a.offender, 'owner', case when a.incident_post is null then '{}'::uuid[] else array[a.incident_post] end);
    end loop;
    if r.target_type in ('post', 'reaction') then
      update public.posts set moderation_status = case when p_action = 'remove' then 'removed' else 'hidden' end where id = r.target_id;
    elsif r.target_type = 'message' then
      update public.chat_messages set deleted_at = coalesce(deleted_at, now()), body = null, post_id = null where id = r.target_id;
    end if;
  end if;
  update public.reports set status = case when p_action = 'dismiss' then 'dismissed' else 'reviewed' end
   where target_type = r.target_type and target_id = r.target_id and status = 'pending';
end;
$$;

-- ── 4. the creator's side ───────────────────────────────────────────────────────────────
-- (never says who or how many: the offer names nobody)
create or replace function public.my_recovery_offer()
returns table (offer_id uuid, status text, created_at timestamptz, expires_at timestamptz, boost_hours integer, boost_max_viewers integer)
language plpgsql
security definer
set search_path = public
as $$
declare cfg public.recovery_config;
begin
  if auth.uid() is null then return; end if;
  select * into cfg from public.recovery_config where id;
  perform public.recovery_expire();
  return query
  select o.id, o.status, o.created_at,
         case when o.status = 'offered' then o.created_at + (cfg.offer_valid_days * interval '1 day')
              when o.status = 'accepted' then o.accepted_at + (cfg.accept_valid_days * interval '1 day')
              else o.boost_ends_at end,
         cfg.boost_hours, cfg.boost_max_viewers
  from public.recovery_offers o
  where o.creator_id = auth.uid() and o.status in ('offered', 'accepted', 'used')
  order by o.created_at desc
  limit 1;
end;
$$;

-- p_accept true: accept (the next post is boosted); false: not now (declined, it will not come back for decline_cooldown_days)
create or replace function public.respond_recovery_offer(p_offer uuid, p_accept boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  perform public.recovery_expire();
  update public.recovery_offers
     set status = case when p_accept then 'accepted' else 'declined' end, responded_at = now(),
         accepted_at = case when p_accept then now() else null end
   where id = p_offer and creator_id = auth.uid() and status = 'offered';
  get diagnostics n = row_count;
  if n = 0 then raise exception 'this offer is not open any more'; end if;
  return case when p_accept then 'accepted' else 'declined' end;
end;
$$;

-- ── 5. the boost ─────────────────────────────────────────────────────────────────────────
-- The creator's NEXT post (created after accepting) is the boosted one. Never a post involved in the incident.
create or replace function public.recovery_attach_boost()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.recovery_config;
  o public.recovery_offers;
begin
  if new.parent_post_id is not null then return new; end if;
  select * into cfg from public.recovery_config where id;
  select * into o from public.recovery_offers where creator_id = new.user_id and status = 'accepted' order by accepted_at limit 1;
  if not found or new.id = any (o.incident_post_ids) then return new; end if;
  update public.recovery_offers
     set status = 'used', boost_post_id = new.id, boost_started_at = now(), boost_ends_at = now() + (cfg.boost_hours * interval '1 hour')
   where id = o.id;
  return new;
end;
$$;
drop trigger if exists zzz_posts_recovery_boost on public.posts;
create trigger zzz_posts_recovery_boost after insert on public.posts
  for each row execute function public.recovery_attach_boost();

-- The posts boosted right now: still testing, inside the boost window, and never an incident post.
create or replace function public.recovery_boosted_posts()
returns uuid[]
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_agg(o.boost_post_id), '{}')
  from public.recovery_offers o
  join public.posts p on p.id = o.boost_post_id
  where o.status = 'used' and o.boost_ends_at > now() and not (o.boost_post_id = any (o.incident_post_ids))
    and p.status = 'trial' and p.parent_post_id is null and p.moderation_status = 'active' and p.media_deleted_at is null
$$;

-- Give this viewer the boosted posts they are eligible for: a FRESH stranger (never viewed anything of the creator, no affinity),
-- by the same rules as any testing post (not the creator, not a known connection, not blocked, the mature rule), up to
-- boost_max_viewers per boost. The viewer's feed then carries it as an assigned post (and it leads those).
create or replace function public.recovery_boost_assign(p_viewer uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  cfg public.recovery_config;
  hide_mature boolean := false;
  o record;
  got integer := 0;
begin
  if p_viewer is null then return 0; end if;
  select * into cfg from public.recovery_config where id;
  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature from public.profiles pr where pr.id = p_viewer;
  hide_mature := coalesce(hide_mature, false);
  for o in
    select ro.id as offer_id, p.id as post_id, p.user_id as creator, p.is_mature
    from public.recovery_offers ro
    join public.posts p on p.id = ro.boost_post_id
    where p.id = any (public.recovery_boosted_posts())
  loop
    continue when o.creator = p_viewer;
    continue when hide_mature and o.is_mature;
    continue when public.trial_is_silenced(o.creator, p_viewer);                                   -- known connections never
    continue when exists (select 1 from public.user_blocks b where (b.blocker_id = p_viewer and b.blocked_id = o.creator) or (b.blocker_id = o.creator and b.blocked_id = p_viewer));
    continue when exists (select 1 from public.reports r where r.reporter_id = p_viewer and r.target_type = 'post' and r.target_id = o.post_id);
    continue when exists (select 1 from public.post_raw_views v join public.posts q on q.id = v.post_id where v.viewer_id = p_viewer and q.user_id = o.creator);   -- fresh only
    continue when exists (select 1 from public.viewer_creator_affinity a where a.viewer_id = p_viewer and a.creator_id = o.creator and a.score > 0);
    continue when exists (select 1 from public.trial_assignments t where t.post_id = o.post_id and t.viewer_id = p_viewer);
    continue when (select count(*) from public.recovery_boost_viewers v where v.offer_id = o.offer_id) >= cfg.boost_max_viewers;
    insert into public.trial_assignments (post_id, viewer_id, stage)
      select o.post_id, p_viewer, s.stage from public.trial_post_state s where s.post_id = o.post_id and s.decision is null
      on conflict (post_id, viewer_id) do nothing;
    if found then
      insert into public.recovery_boost_viewers (offer_id, viewer_id) values (o.offer_id, p_viewer) on conflict do nothing;
      got := got + 1;
    end if;
  end loop;
  return got;
end;
$$;

-- ── 6. the owner's list ───────────────────────────────────────────────────────────────────
create or replace function public.admin_recovery_list(p_limit integer default 50)
returns table (id uuid, creator_id uuid, creator_username text, source text, status text, created_at timestamptz, accepted_at timestamptz, boost_post_id uuid, boost_ends_at timestamptz, boosted_viewers integer)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.mod_is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform public.recovery_expire();
  return query
  select o.id, o.creator_id, pr.username::text, o.source, o.status, o.created_at, o.accepted_at, o.boost_post_id, o.boost_ends_at,
         (select count(*)::integer from public.recovery_boost_viewers v where v.offer_id = o.id)
  from public.recovery_offers o left join public.profiles pr on pr.id = o.creator_id
  order by o.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200);
end;
$$;

revoke all on function
  public.recovery_aims(uuid), public.recovery_reporter_counts(uuid, uuid, uuid), public.recovery_expire(), public.recovery_offer(uuid, uuid, text, uuid[]),
  public.recovery_evaluate(uuid, uuid), public.reports_recovery_trigger(), public.recovery_attach_boost(), public.recovery_boosted_posts(),
  public.recovery_boost_assign(uuid)
  from public, anon, authenticated;
revoke all on function public.my_recovery_offer(), public.respond_recovery_offer(uuid, boolean), public.admin_recovery_list(integer), public.admin_report_resolve(uuid, text) from public, anon;
grant execute on function public.my_recovery_offer(), public.respond_recovery_offer(uuid, boolean), public.admin_recovery_list(integer), public.admin_report_resolve(uuid, text) to authenticated;

-- ── 7. the feed: a copy of migration-spotlight.sql's get_feed_engine plus the marked RECOVERY BOOST parts ──────────
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
