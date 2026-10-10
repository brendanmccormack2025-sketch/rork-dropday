#!/usr/bin/env node
/** Survived posts stay on the creator's profile for good: who sees what, the badge, and the wiring. */
import { readFileSync } from "node:fs";
import { hasSurvived, isOnOtherProfile, isOnOwnProfilePost } from "../lib/profileVisibility.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const now = Date.parse("2026-10-10T00:00:00Z");
const day = 86400000;
const post = (o) => ({ created_at: new Date(now - 2 * day).toISOString(), survived_at: null, media_deleted_at: null, ...o });

const survivedLive = post({ status: "survived", survived_at: "2026-10-09T00:00:00Z" });
const survivedAfterWindow = post({ status: "expired", survived_at: "2026-10-01T00:00:00Z", created_at: "2026-09-30T00:00:00Z" });
const ended = post({ status: "archived" }), incomplete = post({ status: "incomplete" }), queued = post({ status: "queued" }), testing = post({ status: "trial" });
const neverSurvivedExpired = post({ status: "expired" });

eq("a post that survived stays a survivor after its window (status 'expired', survived_at set)", [hasSurvived(survivedLive), hasSurvived(survivedAfterWindow), hasSurvived(neverSurvivedExpired)], [true, true, false]);
eq("others' profiles: survived posts only, also after their window", [survivedLive, survivedAfterWindow, ended, incomplete, queued, testing, neverSurvivedExpired].map(isOnOtherProfile), [true, true, false, false, false, false, false]);
eq("...and not when the media is missing (hidden, not faked)", isOnOtherProfile({ ...survivedAfterWindow, media_deleted_at: "2026-10-05T00:00:00Z" }), false);
eq("own profile: queued, testing and survived posts (forever); never ended or incomplete ones", [survivedLive, survivedAfterWindow, queued, testing, ended, incomplete, neverSurvivedExpired].map((p) => isOnOwnProfilePost(p)), [true, true, true, true, false, false, false]);

const badge = read("../components/TrialStatusBadge.tsx"), user = read("../app/user/[id].tsx"), drops = read("../app/profile-drops.tsx"), prov = read("../providers/PostsProvider.tsx"), prof = read("../app/(tabs)/profile.tsx");
eq("the SURVIVED badge component keeps a survived post survived after its window (the profile tiles no longer carry a badge: everything there survived)", [/survivedAt/.test(badge), /shown === "expired" && survivedAt/.test(badge), /TrialStatusBadge/.test(prof)], [true, true, false]);
eq("others' profiles ask the server (profile_posts) and fall back to survived-only filters", [/profilePostIds\(id\)/.test(user), /\.not\("survived_at", "is", null\)/.test(user), /profilePostIds\(userId\)/.test(drops), /isOnOtherProfile/.test(user) && /isOnOtherProfile/.test(drops)], [true, true, true, true]);
eq("others never get the old 'trial' status query", [/\.in\("status", \["trial", "survived"\]\)/.test(user), /\.in\("status", \["trial", "survived"\]\)/.test(drops)], [false, false]);
eq("own profile keeps room for a creator who posts a lot", /\.limit\(200\)/.test(prov), true);
eq("feed is unchanged: expired posts are not served (FEED_STATUSES)", /const FEED_STATUSES = \["trial", "incomplete", "survived"\]/.test(prov), true);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
