-- Survived posts stay on the creator's profile for good (idempotent; run manually in the Supabase SQL editor).
-- Run after migration-lifecycle.sql and migration-trial-engine.sql.
--
-- What changes
--   * A survived post leaves the FEED after its 24 h window (status 'expired', survived_at stays) but is never removed
--     from the profile, and its media is never deleted. Only ended ('archived') and 'incomplete' posts (and their
--     reactions) may have media deleted, 7 days (trial_config.retention_days) after the verdict, as before.
--   * Reactions to a survived post stay visible with it: expire_posts() no longer expires them when the post's feed
--     window ends (only when the post itself ended).
--   * profile_posts(): the server-side list of whose posts a viewer may see on a profile.
--       other people's profile: survived posts only (survived_at set), newest first. Never failed / ended / incomplete /
--       queued / still-testing posts. Build in silence is not involved: a known viewer sees the same survived posts.
--       own profile: queued, testing, survived (forever) and recent ended / incomplete posts (privately).
--
-- BEFORE this migration: nothing in the repo deleted media. expire_posts() only changed status / expired_at, and
-- media_deleted_at was written by no SQL in this repo (migration-media-deletion.sql is the manual list for moderated
-- 'removed' posts). The retention job described in CLAUDE.md ("about 7 days after expiry, after a dry run") does not
-- exist here, so it would have been external or planned. Whatever runs it must use trial_media_deletion_candidates()
-- below; the trigger is the safety net if it does not.

-- ── 1. Safety net: media of survived posts can never be marked deleted ────────
create or replace function public.protect_survived_media()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  root_survived boolean;
begin
  if new.media_deleted_at is not distinct from old.media_deleted_at then return new; end if;
  if new.media_deleted_at is null then return new; end if;   -- clearing it is always fine
  root_survived := old.survived_at is not null
    or exists (
      with recursive up as (
        select p.id, p.parent_post_id, p.survived_at from public.posts p where p.id = old.parent_post_id
        union all
        select p.id, p.parent_post_id, p.survived_at from public.posts p join up on p.id = up.parent_post_id
      )
      select 1 from up where up.survived_at is not null
    );
  if root_survived then
    raise warning 'media of a survived post (or its reactions) is never deleted: % ignored', old.id;
    new.media_deleted_at := old.media_deleted_at;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_survived_media on public.posts;
create trigger protect_survived_media
  before update of media_deleted_at on public.posts
  for each row execute function public.protect_survived_media();

-- ── 2. What a media-deletion job may delete (a dry run: it only lists) ────────
-- Ended ('archived') and 'incomplete' root posts, retention_days after their verdict, and the reactions under them.
-- Survived posts (survived_at set, whatever their status now) and everything under them are never listed.
create or replace function public.trial_media_deletion_candidates()
returns table (post_id uuid, kind text, eligible_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with recursive cfg as (select coalesce((select value from public.trial_config where key = 'retention_days'), 7) as days),
  ended as (
    select p.id, p.status as kind,
           coalesce(s.decided_at, p.expired_at, p.created_at + interval '24 hours') + (cfg.days * interval '1 day') as eligible_at
    from public.posts p
    left join public.trial_post_state s on s.post_id = p.id
    cross join cfg
    where p.parent_post_id is null and p.survived_at is null and p.media_deleted_at is null
      and p.status in ('archived', 'incomplete')
  ),
  tree as (
    select c.id, c.parent_post_id, e.eligible_at from public.posts c join ended e on c.parent_post_id = e.id
    union all
    select c.id, c.parent_post_id, t.eligible_at from public.posts c join tree t on c.parent_post_id = t.id
  )
  select e.id, e.kind, e.eligible_at from ended e where e.eligible_at <= now()
  union all
  select t.id, 'reaction'::text, t.eligible_at
  from tree t join public.posts p on p.id = t.id
  where p.media_deleted_at is null and p.survived_at is null and t.eligible_at <= now();
$$;
revoke all on function public.trial_media_deletion_candidates() from public, anon, authenticated;

-- ── 3. expire_posts(): survived posts leave the feed; their reactions stay ────
create or replace function public.expire_posts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  total integer := 0;
  n integer;
  guard integer := 0;
begin
  -- survived posts whose 24 h distribution window has ended: out of the feed (survived_at stays; nothing is deleted)
  update public.posts p
  set status = 'expired',
      expired_at = now()
  where p.status = 'survived'
    and p.distribution_expires_at is not null
    and p.distribution_expires_at <= now();
  get diagnostics n = row_count;
  total := total + n;

  -- reactions follow their post only when the post ENDED ('archived', or expired without ever surviving)
  loop
    update public.posts c
    set status = 'expired',
        expired_at = now()
    from public.posts p
    where c.parent_post_id = p.id
      and c.status <> 'expired'
      and (p.status = 'archived' or (p.status = 'expired' and p.survived_at is null));
    get diagnostics n = row_count;
    total := total + n;

    guard := guard + 1;
    exit when n = 0 or guard >= 5;
  end loop;

  return total;
end;
$$;

-- Reactions the old function already expired under posts that survived: visible again.
with recursive tree as (
  select p.id from public.posts p where p.parent_post_id is null and p.survived_at is not null
  union all
  select c.id from public.posts c join tree t on c.parent_post_id = t.id
)
update public.posts r
   set status = 'trial', expired_at = null
  from tree
 where r.id = tree.id and r.parent_post_id is not null and r.status = 'expired';

-- ── 4. Who sees which posts on a profile ──────────────────────────────────────
create or replace function public.profile_posts(p_user_id uuid, p_limit integer default 100)
returns table (post_id uuid)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  retention numeric := coalesce((select value from public.trial_config where key = 'retention_days'), 7);
  hide_mature boolean := false;
  lim integer := least(greatest(coalesce(p_limit, 100), 1), 300);
begin
  if me is null or p_user_id is null then return; end if;
  if p_user_id = me then
    return query
    select p.id
    from public.posts p
    left join public.trial_post_state s on s.post_id = p.id
    where p.user_id = me and p.parent_post_id is null and p.moderation_status = 'active'
      and (
        p.status in ('queued', 'trial')
        or (p.survived_at is not null and p.status in ('survived', 'expired') and p.media_deleted_at is null)
        or (p.status in ('archived', 'incomplete') and p.media_deleted_at is null
            and coalesce(s.decided_at, p.created_at) > now() - (retention * interval '1 day'))
      )
    order by p.created_at desc, p.id
    limit lim;
    return;
  end if;
  select coalesce(public.age_tier(pr.birthdate) in ('under_13', 'teen'), false) into hide_mature
  from public.profiles pr where pr.id = me;
  hide_mature := coalesce(hide_mature, false);
  return query
  select p.id
  from public.posts p
  where p.user_id = p_user_id and p.parent_post_id is null and p.moderation_status = 'active'
    and p.survived_at is not null and p.status in ('survived', 'expired')   -- only posts that survived: never testing, ended, incomplete or queued
    and p.media_deleted_at is null
    and (not hide_mature or not p.is_mature)
    and not exists (
      select 1 from public.user_blocks b
      where (b.blocker_id = me and b.blocked_id = p.user_id) or (b.blocker_id = p.user_id and b.blocked_id = me)
    )
  order by p.created_at desc, p.id
  limit lim;
end;
$$;
grant execute on function public.profile_posts(uuid, integer) to authenticated;

-- ── 5. Existing data: survived posts whose media was already deleted ──────────
do $$
declare
  n integer;
begin
  select count(*) into n from public.posts where survived_at is not null and media_deleted_at is not null;
  raise notice 'survived posts with media already deleted: % (they are not faked back; profiles hide posts with missing media)', n;
end $$;
-- Same list, to look at:
--   select id, user_id, status, survived_at, expired_at, media_deleted_at from public.posts
--   where survived_at is not null and media_deleted_at is not null order by media_deleted_at;
