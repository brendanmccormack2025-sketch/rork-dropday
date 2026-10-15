# Tryal
The product is called **Tryal** (renamed from "Trial"; user-facing text only). Code, DB values and identifiers keep the old name: the stored status is `'trial'`, tables/RPCs/migrations/notification types, the slug, bundle identifier, scheme and EAS project are unchanged and must not be renamed. All user-visible strings say "Tryal" (screens, notifications, permission texts, share text, errors); scripts/test-brand-name.mjs fails if "Trial" comes back into one. Wordmarks: expo/assets/images/tryal-wordmark.png on light screens, tryal-wordmark-white.png on dark ones (trial-wordmark.png is kept, unused).

There is no follower system. "Known people" are phone contacts (a match in either direction) plus the creator's hide list plus friends (friends only while trial_engine_config.known_source_friends is on, the default); they never get a testing post (feed or a direct read of the posts table: RLS policy posts_testing_not_for_known) and never count toward its verdict. Contacts and friends get it in their feed once it survives; the hide list never does (trial_feed_hidden), but anyone can still open the creator's profile and see survived posts. The hide list is private and does not block messaging.

Three systems: AI video editor, content testing, a fresh feed. Core loop: upload video -> AI edit -> Post ("Put it on Tryal") -> tested by strangers -> survives -> 24-hour distribution -> expires. No follower/following system; no groups and no comments. Friends (mutual: invite link, request, or username) can send each other 1:1 text messages and posts (supabase/migration-friends-messages.sql); friends are known people. Profile = username, picture, bio, external links (Instagram, TikTok, YouTube, website), not a grid of all videos. Navigation: Feed, Create/AI Editor, Profile.

## Stack
React Native + Expo + TypeScript, Supabase (SQL migrations in expo/supabase/), EAS builds. Run all EAS/expo commands from expo/.

## Lifecycle (times calculated server-side, never from the device clock)
testing -> survived (active for 24 hours) -> expired. Stored status for testing is 'trial'; a post is active while status = 'survived' and distribution_expires_at > now() (there is no active_24h status). A post that does not survive is archived (shown to the creator as "Tryal ended"). Stored: testing_started_at, survived_at, distribution_started_at, distribution_expires_at, expired_at. Expired and archived posts leave every feed. Post metadata and metrics are kept; the large video file is deleted later (about 7 days after expiry) by a scheduled job, only after a dry run. Reactions expire with their parent post and never get their own verdict. A reaction cannot be published to an expired post.

## Verdict rule
N = exposure gate, scaled by users active in the last 7 days: LEAST(100, GREATEST(3, CEIL(active*0.25)), GREATEST(1, active-1)). A post is judged when it reaches N qualified views; engagement = (distinct reactors x 2) + likes, author excluded. Survive immediately when the bar is met; if not met, archive once the Nth view is at least 10 minutes old (settling time). Posts that never reach N stay in testing. Thresholds live in the trial_config table (gate_min, gate_fraction, floor_points, reaction_weight, like_weight, settle_minutes, distribution_hours, retention_days, active_window_days) and must not depend on follower counts. (A migration for this exists on branch verdict-at-n-views and is not merged yet.)

## Feed
Rank survivors by engagement rate with recency decay; reserve about one in three slots for posts still in testing, fewest qualified views first. Precompute scores on a schedule into an indexed column; never compute ranking per feed request. After posting, the user lands in the feed.

## Notifications
In-app rows are created in SQL. Push (Expo): post survived, reaction on my post, likes only as milestones (1st, 5, 10, 25), optional "trial ended". No follower notifications.

## Cost rules
Process once, store the final asset, serve it, expire it. No paid AI API in the core product. The editor works on-device and deterministically: silence detection (native module expo/modules/audio-loudness, thresholds in expo/lib/silenceDetection.ts), cuts saved as segments/trim_data instructions, never re-rendering. Captions later via on-device speech recognition. Local files: temporary video files (post_uploads/, thumbnails/, Caches/Camera, ImagePicker, render_*.mp4, tmp/) are deleted after a successful post and by the launch cleanup (lib/storageCleanup.ts); drafts and files referenced by saved drafts or pending uploads are never deleted. Automatic only (no button).

## Working rules
Minimal edits, reuse existing code. One commit per numbered item. SQL changes are idempotent migration files in expo/supabase/ that I run manually in the Supabase SQL editor; the latest migration defining run_survival_checkpoint supersedes earlier ones and older ones must never be re-run. Never commit .env or keys. Native changes (new native modules, plugins, app.json permissions, icons, SDK upgrades) need a new EAS build and a version bump in app.json (runtime policy is appVersion, not fingerprint); JS-only changes can ship with eas update. Do not blindly delete DropDay code: audit dependencies first, hide or disable before deleting, and keep tables until a migration plan exists.
- Never rename existing statuses or notification types; add new values instead.
- No text comments in the app; conversations happen through video reactions.
