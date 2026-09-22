-- Trial: Remove the streak system (deprecated — not part of Trial's design)
-- Reverses the streak parts of migration-live-event.sql:
--   1. trigger trg_update_streak + function update_streak_on_drop
--   2. profiles.current_streak and profiles.last_post_date columns
-- The get_tonight_drop_count RPC (live-event section 3) is unrelated and left in place.

-- 1. Drop the streak trigger and function
drop trigger if exists trg_update_streak on public.posts;
drop function if exists update_streak_on_drop();

-- 2. Drop the streak columns
alter table public.profiles
  drop column if exists current_streak,
  drop column if exists last_post_date;
