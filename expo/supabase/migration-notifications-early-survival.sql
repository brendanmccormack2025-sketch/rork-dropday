-- ============================================================================
-- Notifications completion + early survival — ONE combined migration
-- ============================================================================
-- Part A — Notifications:
--   A1. extra_count column (like-collapse: "X and N others liked your post")
--   A2. Backfill/cleanup BEFORE unique indexes:
--         likes: keep newest row per post_id, set extra_count from current likes
--         follow/follow_request: keep newest row per (recipient_id, actor_id)
--   A3. CHECK constraint gains 'followed_post_survived'
--   A4. Dedupe indexes (retries/re-likes/re-follows can never duplicate):
--         unique (post_id)                where type = 'like'
--         unique (recipient_id, actor_id) where type in ('follow','follow_request')
--         unique (recipient_id, post_id)  where type = 'followed_post_survived'
--   A5. notify_on_like(): upsert — one row per post; on conflict resurface as
--       unread (actor = latest liker, read=false, created_at=now(), extra_count
--       recomputed from current likes). Unlike→re-like never duplicates.
--   A6. notify_on_reaction(): keeps the direct-parent insert ("on my post" /
--       "on my reaction"); ADDS a second insert for the ORIGINAL post's author
--       when the parent is itself a reaction — skipped when the reaction owner
--       IS the original author (they already got insert 1) or the reactor.
--   A7. notify_on_follow(): ON CONFLICT DO NOTHING — re-follow never duplicates.
-- Part B — Survival logic (same run_survival_checkpoint, one edit):
--   B1. EARLY SURVIVAL: gate (LEAST(100, GREATEST(5, CEIL(profiles*0.25))))
--       AND engagement met → 'survived' at ANY age. 24h wait no longer gates
--       survival.
--   B2. FAIL AT 24H: gate met + engagement missed + 24h+ → 'archived'.
--   B3. UNDEREXPOSED: 24h+ + gate unmet → 'incomplete' (silent, re-checked
--       every run until the gate is met). Young + undecided posts are left
--       untouched ('trial').
--   B4. Single evaluation preserved: UPDATE only touches trial/incomplete.
--   B5. verdict notifications unchanged; follower fan-out ('followed_post_
--       survived') fires in the survive branch only, as ONE INSERT...SELECT,
--       once per follower per post (ON CONFLICT DO NOTHING).
--   B6. Cron re-registered: 'survival-checkpoint' now every 5 minutes
--       (same job name) so early survival is checked promptly.
-- Idempotent: safe to re-run.
-- ============================================================================

-- ── A1. extra_count column ──────────────────────────────────────────────────
alter table public.notifications
  add column if not exists extra_count integer not null default 0;

-- ── A2. Dedupe cleanup (must precede the unique indexes) ────────────────────
-- Likes: keep only the newest row per post_id.
delete from public.notifications n
where n.type = 'like'
  and exists (
    select 1 from public.notifications k
    where k.type = 'like'
      and k.post_id = n.post_id
      and (k.created_at, k.id) > (n.created_at, n.id)
  );

-- Likes: set extra_count from the CURRENT likes table (likers other than the
-- displayed actor) — self-correcting even if the actor has since unliked.
update public.notifications n
set extra_count = greatest(
  (select count(*) from public.likes l
   where l.post_id = n.post_id and l.user_id <> n.actor_id), 0)
where n.type = 'like';

-- Follow/follow_request: keep only the newest row per (recipient_id, actor_id).
delete from public.notifications n
where n.type in ('follow', 'follow_request')
  and exists (
    select 1 from public.notifications k
    where k.type in ('follow', 'follow_request')
      and k.recipient_id = n.recipient_id
      and k.actor_id = n.actor_id
      and (k.created_at, k.id) > (n.created_at, n.id)
  );

-- ── A3. CHECK constraint gains 'followed_post_survived' ─────────────────────
do $$
begin
  alter table public.notifications drop constraint if exists notifications_type_check;
  alter table public.notifications
    add constraint notifications_type_check
    check (type in ('like', 'reaction', 'follow', 'follow_request',
                    'follow_accept', 'verdict_survived', 'verdict_archived',
                    'followed_post_survived'));
exception
  when duplicate_object then null; -- re-run
end $$;

-- ── A4. Dedupe indexes ───────────────────────────────────────────────────────
create unique index if not exists notifications_like_post_uniq
  on public.notifications (post_id) where type = 'like';

create unique index if not exists notifications_follow_pair_uniq
  on public.notifications (recipient_id, actor_id)
  where type in ('follow', 'follow_request');

create unique index if not exists notifications_followed_survived_uniq
  on public.notifications (recipient_id, post_id)
  where type = 'followed_post_survived';

-- ── A5. notify_on_like(): one row per post, resurfaces unread on new likes ──
create or replace function public.notify_on_like()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.user_id <> (select user_id from public.posts where id = new.post_id) then
    insert into public.notifications (recipient_id, actor_id, type, post_id, extra_count)
    select user_id, new.user_id, 'like', new.post_id, 0
    from public.posts where id = new.post_id
    on conflict (post_id) where type = 'like' do update
      set actor_id    = excluded.actor_id,   -- latest liker is displayed
          read        = false,               -- resurfaces as unread
          created_at  = now(),
          extra_count = greatest(
            (select count(*) from public.likes l
             where l.post_id = new.post_id and l.user_id <> new.user_id), 0);
  end if;
  return new;
end;
$$;

-- ── A6. notify_on_reaction(): direct parent + original author on re-reaction ─
create or replace function public.notify_on_reaction()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_author uuid;
  root_post_id  uuid;
  root_author   uuid;
begin
  if new.parent_post_id is null then
    return new;
  end if;

  select user_id, parent_post_id
  into parent_author, root_post_id
  from public.posts where id = new.parent_post_id;

  -- 1) Direct parent: original post → "reacted to your post";
  --    reaction → "reacted to your reaction". Self-guarded.
  if parent_author is not null and new.user_id <> parent_author then
    insert into public.notifications (recipient_id, actor_id, type, post_id)
    values (parent_author, new.user_id, 'reaction', new.parent_post_id);
  end if;

  -- 2) Reaction-on-reaction: also notify the ORIGINAL post's author.
  --    Skipped when the reaction owner IS the original author (they already
  --    received insert 1 — no double notification) or is the reactor themself.
  if root_post_id is not null then
    select user_id into root_author from public.posts where id = root_post_id;
    if root_author is not null
       and root_author <> parent_author
       and root_author <> new.user_id then
      insert into public.notifications (recipient_id, actor_id, type, post_id)
      values (root_author, new.user_id, 'reaction', root_post_id);
    end if;
  end if;

  return new;
end;
$$;

-- ── A7. notify_on_follow(): re-follow can never duplicate ────────────────────
create or replace function public.notify_on_follow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'accepted' then
    insert into public.notifications (recipient_id, actor_id, type)
    values (new.followee_id, new.follower_id, 'follow')
    on conflict (recipient_id, actor_id) where type in ('follow', 'follow_request')
    do nothing;
  elsif new.status = 'pending' then
    insert into public.notifications (recipient_id, actor_id, type)
    values (new.followee_id, new.follower_id, 'follow_request')
    on conflict (recipient_id, actor_id) where type in ('follow', 'follow_request')
    do nothing;
  end if;
  return new;
end;
$$;

-- ── B. run_survival_checkpoint(): early survival + follower fan-out ─────────
create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  processed integer;
  survived_ids uuid[];
  survived_users uuid[];
  archived_ids uuid[];
  archived_users uuid[];
  -- Exposure gate: computed fresh every run from the live profile count.
  required_views integer;
begin
  select least(100, greatest(5, ceil((select count(*) from public.profiles) * 0.25)))::int
  into required_views;

  with candidates as (
    select p.id, p.user_id, p.qualified_view_count,
           (p.checkpoint_at <= now()) as is_24h
    from public.posts p
    where p.status in ('trial', 'incomplete')
      and p.checkpoint_at is not null
  ),
  scored as (
    select
      c.id, c.user_id, c.qualified_view_count, c.is_24h,
      (select count(*) from public.posts   r where r.parent_post_id = c.id)                              as video_reactions,
      (select count(*) from public.likes   l where l.post_id = c.id)                                    as likes,
      (select count(*) from public.follows f where f.followee_id = c.user_id and f.status = 'accepted') as followers
    from candidates c
  ),
  updated as (
    update public.posts p
    set status = case
      -- EARLY SURVIVAL: gate AND engagement met — at ANY age.
      when s.qualified_view_count >= required_views
           and (s.video_reactions * 5) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
        then 'survived'
      -- Gate met, engagement missed: only a verdict at 24h+ (fail).
      when s.qualified_view_count >= required_views
        then 'archived'
      -- Gate unmet at 24h+: underexposed — park as incomplete (silent).
      else 'incomplete'
    end
    from scored s
    where p.id = s.id
      -- Only write rows where a decision is actually made. Young undecided
      -- posts (no gate yet, or gate-but-no-engagement before 24h) stay
      -- 'trial' and are left untouched.
      and (
        (s.qualified_view_count >= required_views
          and ((s.video_reactions * 5) + s.likes >= greatest(2, power(s.followers, 1.3) * 0.02)
               or s.is_24h))
        or (s.qualified_view_count < required_views and s.is_24h)
      )
    returning p.id, p.user_id, p.status as final_status
  )
  select
    count(*),
    coalesce(array_agg(u.id)      filter (where u.final_status = 'survived'), '{}'),
    coalesce(array_agg(u.user_id) filter (where u.final_status = 'survived'), '{}'),
    coalesce(array_agg(u.id)      filter (where u.final_status = 'archived'), '{}'),
    coalesce(array_agg(u.user_id) filter (where u.final_status = 'archived'), '{}')
  into processed, survived_ids, survived_users, archived_ids, archived_users
  from updated u;

  -- Verdict notifications: creator only; 'incomplete' stays silent. Each
  -- transition happens at most once (the UPDATE only touches trial/incomplete),
  -- so these can never duplicate.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_survived', u.pid
  from unnest(survived_ids, survived_users) as u(pid, uid);

  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select u.uid, u.uid, 'verdict_archived', u.pid
  from unnest(archived_ids, archived_users) as u(pid, uid);

  -- Follower fan-out: fire on the survive transition ONLY (archived posts
  -- never reach this). ONE INSERT...SELECT — no loop. Once per follower per
  -- post via the partial unique index + ON CONFLICT DO NOTHING.
  insert into public.notifications (recipient_id, actor_id, type, post_id)
  select f.follower_id, s.uid, 'followed_post_survived', s.pid
  from unnest(survived_ids, survived_users) as s(pid, uid)
  join public.follows f
    on f.followee_id = s.uid
   and f.status = 'accepted'
  where f.follower_id <> s.uid
  on conflict (recipient_id, post_id) where type = 'followed_post_survived'
  do nothing;

  return processed;
end;
$$;

-- ── B6. Cron: same job name, every 5 minutes ─────────────────────────────────
select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'survival-checkpoint';

select cron.schedule(
  'survival-checkpoint',
  '*/5 * * * *',
  $cron$
    select public.run_survival_checkpoint();
  $cron$
);
