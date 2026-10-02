-- Profile external links: YouTube (idempotent)
--
-- profiles already has website, instagram_handle and tiktok_handle. This adds
-- youtube_url: either a channel handle starting with @ (for example '@name') or
-- a full https URL on youtube.com / youtu.be. The app validates and normalizes
-- it (lib/creatorLinks.ts); the database stores text as given.
--
-- No RLS or policy changes: profiles stay readable by everyone and users can only
-- update their own row, as before. The app treats a missing youtube_url column as
-- empty until this is run, so it is safe to ship the app first.
--
-- Run manually in the Supabase SQL editor. Safe to re-run.

alter table public.profiles add column if not exists youtube_url text;

-- Rollback (comment): alter table public.profiles drop column if exists youtube_url;
