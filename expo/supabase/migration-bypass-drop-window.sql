-- DropDay: honor profiles.bypass_drop_window in the Drop posting window trigger
--
-- Replaces enforce_drop_window() with a version that skips the 8-10 PM gate
-- for demo/reviewer accounts whose profiles.bypass_drop_window is true.
-- Requires the bypass_drop_window boolean column on profiles (already added).
--
-- NOTE: The existing trg_enforce_drop_window trigger calls this function by
-- name, so replacing the function alone is sufficient — the trigger is
-- re-created below anyway for safety.

create or replace function enforce_drop_window()
returns trigger as $$
declare
  tz text;
  local_hour integer;
  bypass boolean;
begin
  -- Only restrict top-level Drops (parent_post_id IS NULL).
  -- Reactions (parent_post_id IS NOT NULL) are allowed at any time.
  if new.parent_post_id is not null then
    return new;
  end if;

  -- Demo/reviewer accounts with bypass_drop_window skip the gate entirely.
  select coalesce(p.bypass_drop_window, false)
    into bypass
    from public.profiles p
   where p.id = new.user_id;

  if bypass then
    return new;
  end if;

  -- Use the poster's timezone if provided, otherwise fall back to UTC.
  tz := coalesce(new.poster_timezone, 'UTC');

  -- Get the current hour in the poster's local timezone.
  local_hour := extract(hour from now() at time zone tz);

  -- Drop window: 8 PM (20:00) to 10 PM (22:00) local time, [20, 22).
  if local_hour < 20 or local_hour >= 22 then
    raise exception 'Drops can only be posted between 8 PM and 10 PM your time. Save as draft and try again during tonight''s drop window!';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_enforce_drop_window on public.posts;
create trigger trg_enforce_drop_window
  before insert on public.posts
  for each row
  execute function enforce_drop_window();

-- ── Apply the flag to the designated demo/reviewer account ────────────────
-- Run this separately (or edit here) with the actual account's user id:
--
--   update public.profiles
--      set bypass_drop_window = true
--    where id = '00000000-0000-0000-0000-000000000000';  -- replace with user id
