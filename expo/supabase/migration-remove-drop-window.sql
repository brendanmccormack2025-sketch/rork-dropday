-- Trial: remove the 8-10 PM Drop posting window entirely.
--
-- The client-side gate has been removed from the app. This drops the
-- server-side BEFORE INSERT trigger that rejected top-level Drops
-- (parent_post_id IS NULL) created outside 8-10 PM poster-local time.
-- Reactions were never restricted.
--
-- NOTE: This must be applied manually in the Supabase SQL editor.
-- Until it runs, the database will still reject posts outside the window
-- even though the app no longer checks.
--
-- The poster_timezone column on posts is kept (harmless, nullable).

drop trigger if exists trg_enforce_drop_window on public.posts;
drop function if exists enforce_drop_window();
