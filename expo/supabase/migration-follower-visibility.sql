-- ============================================================================
-- Follower visibility mechanic
-- ----------------------------------------------------------------------------
-- Core rule: a post is NOT visible to its creator's own followers until it
-- survives Trial. Followers only ever see status = 'survived' posts, and only
-- when the creator allowed it. Everyone else (the "outside audience") can see
-- trial/incomplete/survived posts as before. Archived stays excluded.
--
-- 1. posts.follower_visibility       — per-post opt-out (default: allow)
-- 2. profiles.default_follower_visibility — creator's global default, applied
--    at post-creation time unless overridden per-post.
-- ============================================================================

-- 1. Per-post follower visibility -------------------------------------------
alter table public.posts
  add column if not exists follower_visibility boolean not null default true;

comment on column public.posts.follower_visibility is
  'When false, this post is never shown to the creator''s followers (even after surviving Trial). Non-followers are unaffected.';

-- 2. Creator-level default (used when creating a post) -----------------------
alter table public.profiles
  add column if not exists default_follower_visibility boolean not null default true;

comment on column public.profiles.default_follower_visibility is
  'Default value of posts.follower_visibility for new posts created by this user. Toggled in Settings → Privacy.';

-- No backfill needed: both columns default to true, which preserves all
-- existing behavior (every existing post remains follower-visible).
