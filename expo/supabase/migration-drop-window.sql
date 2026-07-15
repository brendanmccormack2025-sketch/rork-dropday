-- DropDay: Server-side enforcement of the Drop posting window
-- Original Drops (parent_post_id IS NULL) may only be created between 8 PM and 10 PM
-- in the poster's local timezone. Reactions (parent_post_id IS NOT NULL) are unrestricted.

-- ============================================================================
-- 1. Add poster_timezone column to posts
--    Stores the IANA timezone string (e.g. 'America/New_York') sent by the client.
--    Nullable for backwards compatibility with existing rows.
-- ============================================================================
alter table public.posts
  add column if not exists poster_timezone text;

-- ============================================================================
-- 2. BEFORE INSERT trigger: reject top-level Drops outside the 8-10 PM window
--    Reactions are never restricted.
-- ============================================================================
create or replace function enforce_drop_window()
returns trigger as $$
declare
  tz text;
  local_hour integer;
begin
  -- Only restrict top-level Drops (parent_post_id IS NULL).
  -- Reactions (parent_post_id IS NOT NULL) are allowed at any time.
  if new.parent_post_id is not null then
    return new;
  end if;

  -- Use the poster's timezone if provided, otherwise fall back to UTC.
  tz := coalesce(new.poster_timezone, 'UTC');

  -- Get the current hour in the poster's local timezone.
  local_hour := extract(hour from now() at time zone tz);

  -- Drop window: 8 PM (20:00) to 10 PM (22:00) local time.
  -- Hour 20 = 8 PM, hour 21 = 9 PM — both allowed.
  -- Hour 22 = 10 PM — window is closed (8 PM to 10 PM means [20, 22)).
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
