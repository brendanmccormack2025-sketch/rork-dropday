-- Trial: Live-event features — streak tracking + tonight's drop count
-- 1. Add current_streak and last_post_date to profiles
-- 2. Trigger to increment/reset streak on top-level Drop insert
-- 3. RPC to count distinct users who posted a top-level Drop since a given timestamp

-- ============================================================================
-- 1. Add streak columns to profiles
-- ============================================================================
alter table public.profiles
  add column if not exists current_streak integer not null default 0,
  add column if not exists last_post_date date;

-- ============================================================================
-- 2. Trigger: update streak on top-level Drop insert
--    - If last_post_date = yesterday → streak + 1
--    - If last_post_date = today   → no change (already counted)
--    - Otherwise (gap or first post) → streak = 1
--    Always set last_post_date = today (the date in the poster's timezone).
-- ============================================================================
create or replace function update_streak_on_drop()
returns trigger as $$
declare
  prev_date date;
  today_date date;
  tz text;
begin
  -- Only top-level Drops (not reactions) count toward streaks.
  if new.parent_post_id is not null then
    return new;
  end if;

  -- Determine "today" in the poster's local timezone.
  tz := coalesce(new.poster_timezone, 'UTC');
  today_date := (now() at time zone tz)::date;

  select p.last_post_date into prev_date
  from public.profiles p
  where p.id = new.user_id;

  if prev_date is null then
    -- First ever drop → streak = 1
    update public.profiles
    set current_streak = 1, last_post_date = today_date
    where id = new.user_id;
  elsif prev_date = today_date then
    -- Already posted today → no change (streak already incremented)
    return new;
  elsif prev_date = today_date - 1 then
    -- Posted yesterday → consecutive, increment
    update public.profiles
    set current_streak = current_streak + 1, last_post_date = today_date
    where id = new.user_id;
  else
    -- Gap > 1 day → reset to 1
    update public.profiles
    set current_streak = 1, last_post_date = today_date
    where id = new.user_id;
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists trg_update_streak on public.posts;
create trigger trg_update_streak
  after insert on public.posts
  for each row
  when (new.parent_post_id is null)
  execute function update_streak_on_drop();

-- ============================================================================
-- 3. RPC: count distinct users who posted a top-level Drop since a timestamp
--    Used by the live participant counter during the 8-10PM window.
--    Returns an approximate count of "people dropping tonight."
-- ============================================================================
create or replace function get_tonight_drop_count(since_ts timestamptz)
returns integer as $$
declare
  result integer;
begin
  select count(distinct user_id) into result
  from public.posts
  where parent_post_id is null
    and created_at >= since_ts
    and moderation_status = 'active';

  return coalesce(result, 0);
end;
$$ language plpgsql stable security definer set search_path = public;

grant execute on function get_tonight_drop_count(timestamptz) to anon, authenticated;
