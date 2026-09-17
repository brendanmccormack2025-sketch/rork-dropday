-- ============================================================================
-- Survival Score / 24hr checkpoint
-- ============================================================================
-- Live-verified prerequisites (probed via PostgREST, 2026-09-17):
--   posts has NO like_count / status / checkpoint_at / view_count / video_reaction_count
--   posts.reaction_count already tracks video reactions via trg_reaction_count
--     (video reaction = any post row with parent_post_id not null)
--   likes is a bare table (user_id, post_id, created_at) - no denormalization
--   follows carries a status column ('accepted' = a real follow)
-- ============================================================================

-- 1. Columns -----------------------------------------------------------------
alter table public.posts add column if not exists status        text not null default 'trial';
alter table public.posts add column if not exists checkpoint_at timestamptz;
alter table public.posts add column if not exists like_count    integer not null default 0;
alter table public.posts add column if not exists view_count    integer not null default 0;
-- video_reaction_count intentionally NOT added: posts.reaction_count already
-- tracks exactly this, maintained by trg_reaction_count.

do $$
begin
  alter table public.posts
    add constraint posts_status_check check (status in ('trial', 'survived', 'archived'));
exception
  when duplicate_object then null; -- constraint already exists
end $$;

-- 2. checkpoint_at: set on insert only (new posts), created_at + 24h ----------
create or replace function public.set_checkpoint_at()
returns trigger
language plpgsql
as $$
begin
  if new.checkpoint_at is null then
    new.checkpoint_at := coalesce(new.created_at, now()) + interval '24 hours';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_checkpoint_at on public.posts;
create trigger trg_set_checkpoint_at
  before insert on public.posts
  for each row
  execute function public.set_checkpoint_at();

-- Existing rows are deliberately NOT backfilled (checkpoint_at stays null,
-- so pre-existing posts are never scored).

-- 3. like_count denormalization (likes -> posts) ------------------------------
create or replace function public.sync_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.posts set like_count = like_count + 1 where id = new.post_id;
    return new;
  elsif tg_op = 'DELETE' then
    update public.posts set like_count = greatest(like_count - 1, 0) where id = old.post_id;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_sync_like_count on public.likes;
create trigger trg_sync_like_count
  after insert or delete on public.likes
  for each row
  execute function public.sync_like_count();

-- One-time backfill so the column is truthful for existing posts
update public.posts p
set like_count = (select count(*) from public.likes l where l.post_id = p.id);

-- 4. Checkpoint scoring --------------------------------------------------------
-- weighted_engagement  = video_reactions * 5 + likes * 1
-- follower_count       = accepted follows of the post's author (live count)
-- expected_engagement  = greatest(3, power(follower_count, 1.3) * 0.02)
-- survived if weighted_engagement >= expected_engagement, else archived.
create or replace function public.run_survival_checkpoint()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  processed integer;
begin
  with candidates as (
    select p.id, p.user_id
    from public.posts p
    where p.status = 'trial'
      and p.checkpoint_at is not null
      and p.checkpoint_at <= now()
  ),
  scored as (
    select
      c.id,
      (select count(*) from public.posts   r where r.parent_post_id = c.id)                               as video_reactions,
      (select count(*) from public.likes   l where l.post_id = c.id)                                     as likes,
      (select count(*) from public.follows f where f.followee_id = c.user_id and f.status = 'accepted')  as followers
    from candidates c
  )
  update public.posts p
  set status = case
    when (s.video_reactions * 5) + s.likes >= greatest(3, power(s.followers, 1.3) * 0.02)
      then 'survived'
    else 'archived'
  end
  from scored s
  where p.id = s.id;

  get diagnostics processed = row_count;
  return processed;
end;
$$;

-- 5. Schedule: every 15 minutes -------------------------------------------------
create extension if not exists pg_cron;

select cron.unschedule(job.jobid) from cron.job job where job.jobname = 'survival-checkpoint';

select cron.schedule(
  'survival-checkpoint',
  '*/15 * * * *',
  $cron$
    select public.run_survival_checkpoint();
  $cron$
);
