# Trial (formerly DropDay/Nexo)
Social video app. Users post videos; each post goes "on trial." If engagement meets the threshold it survives and reaches followers; if not, the trial ends and it is archived privately for the creator.

## Stack
React Native + Expo + TypeScript, Supabase (SQL migrations in expo/supabase/), EAS builds. Run all EAS/expo commands from expo/.

## Survival logic (run_survival_checkpoint, pg_cron every 5 min)
- Exposure gate: LEAST(100, GREATEST(5, CEIL(profiles * 0.25))) qualified views
- Engagement: video reactions x5 + likes x1 vs expected, floor 2
- Survive early once gate AND engagement met, at any age
- At 24h+: gate met + engagement missed -> archived; gate unmet -> incomplete (silent, stays on trial)
- Internal status "archived" is shown to users as "TRIAL ENDED". Never rename statuses or notification types.
- Archived posts must be hidden from everyone except the owner (feeds, other profiles, reaction trees).

## Notifications (server-side SQL triggers only)
like (one row per post, collapsed with extra_count), reaction, follow, follow_accept, verdict_survived, verdict_archived, followed_post_survived. Unique indexes dedupe. Push is not wired yet.

## Rules
- Prefer minimal edits; no rewrites. Reuse existing components.
- SQL changes: idempotent migration files in expo/supabase/, and I run them manually in the Supabase SQL editor.
- DMs are not part of the product yet; do not expose the dm screens.
- No text comments in the app; conversations happen through video reactions.
- Never commit .env or API keys.
