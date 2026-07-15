-- DropDay: Manual media deletion script for removed content
--
-- Run this in the Supabase SQL Editor when you want to permanently delete
-- the actual media files from Supabase Storage for posts marked as 'removed'.
--
-- This script does NOT auto-run on status change. It's a deliberate, manual
-- step you take after reviewing reports in the Table Editor and confirming
-- a violation.
--
-- Usage:
--   1. Review reports in Table Editor → reports table
--   2. Set moderation_status to 'removed' on the offending post(s)
--   3. Run this script to generate a list of storage paths to delete
--   4. Copy each path and delete via Supabase Dashboard → Storage, or
--      use the Supabase JS client / CLI to remove them programmatically.
--
-- Alternatively, run the helper function below to get all paths for
-- removed posts, then delete them via the Storage API.

-- ============================================================================
-- Helper: List all media paths for posts with moderation_status = 'removed'
-- ============================================================================
-- Returns one row per file to delete (media_url, segments, thumbnail_url)
-- with the storage path extracted from the public URL.

create or replace function get_removed_media_paths()
returns table (
  post_id uuid,
  storage_path text,
  file_type text
) as $$
declare
  bucket_url_prefix text;
begin
  -- Adjust this prefix to match your Supabase project URL
  bucket_url_prefix := 'https://tfdjymogbtfavdzgfqas.supabase.co/storage/v1/object/public/drops/';

  -- Primary media_url
  return query
  select
    p.id,
    replace(p.media_url, bucket_url_prefix, '') as storage_path,
    'media'::text as file_type
  from public.posts p
  where p.moderation_status = 'removed'
    and p.media_url like bucket_url_prefix || '%';

  -- Segments (multi-segment posts)
  return query
  select
    p.id,
    replace(seg.seg_url, bucket_url_prefix, '') as storage_path,
    'segment'::text as file_type
  from public.posts p,
       jsonb_array_elements_text(p.segments) as seg(seg_url)
  where p.moderation_status = 'removed'
    and p.segments is not null
    and seg.seg_url like bucket_url_prefix || '%';

  -- Thumbnails
  return query
  select
    p.id,
    replace(p.thumbnail_url, bucket_url_prefix, '') as storage_path,
    'thumbnail'::text as file_type
  from public.posts p
  where p.moderation_status = 'removed'
    and p.thumbnail_url is not null
    and p.thumbnail_url like bucket_url_prefix || '%';
end;
$$ language plpgsql stable;

grant execute on function get_removed_media_paths() to authenticated;

-- ============================================================================
-- Quick view: See all removed content with their media paths
-- ============================================================================
-- Run this to see what needs deletion:
--   select * from get_removed_media_paths();
--
-- Then delete each file via the Supabase Storage API or Dashboard.
-- After deleting files, you can optionally delete the DB rows too:
--   delete from public.posts where moderation_status = 'removed';
-- (Only do this after confirming the media files are gone from storage.)
