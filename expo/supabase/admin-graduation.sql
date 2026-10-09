-- Graduation: administrator snippets. Paste ONE block at a time into the Supabase SQL editor (never ship these in
-- the app). They only work for the service role / SQL editor; the app's users cannot run them or change a status.
-- Needs supabase/migration-graduation.sql to have been run. Every status change is recorded in creator_status_audit.

-- ── Graduate a user (a verified big creator: no new posts; watching, reacting, messaging stay) ─────────────────────
-- The reason is shown publicly on the profile row, so keep it fine to read.
select public.admin_set_creator_status('USERNAME', 'graduated', 'Reached 100k followers');
-- (optional) who did it, for the audit: add your admin user's uuid as a 4th argument
-- select public.admin_set_creator_status('USERNAME', 'graduated', 'Reached 100k followers', '00000000-0000-0000-0000-000000000000');

-- ── Restrict posting (neutral message in the app) ──────────────────────────────────────────────────────────────────
select public.admin_set_creator_status('USERNAME', 'restricted', 'Under review');

-- ── Restore a user (back to normal; can post again) ────────────────────────────────────────────────────────────────
select public.admin_set_creator_status('USERNAME', 'active', 'Restored after review');

-- ── External links shown on a graduated profile (https only; null = leave as is, '' = clear) ───────────────────────
select public.admin_set_creator_links(
  'USERNAME',
  'https://www.instagram.com/their_handle',
  'https://www.tiktok.com/@their_handle',
  'https://www.youtube.com/@their_handle'
);
-- clear only TikTok:
-- select public.admin_set_creator_links('USERNAME', null, '', null);

-- ── Look things up ─────────────────────────────────────────────────────────────────────────────────────────────────
-- Current status of everyone who is not active:
select username, creator_status, graduation_reason, graduated_at, instagram_url, tiktok_url, youtube_url
  from public.profiles where creator_status <> 'active' order by graduated_at desc nulls last;
-- The history of one user:
select a.changed_at, a.old_status, a.new_status, a.reason, a.changed_by
  from public.creator_status_audit a join public.profiles p on p.id = a.user_id
 where lower(p.username) = lower('USERNAME') order by a.changed_at desc;
