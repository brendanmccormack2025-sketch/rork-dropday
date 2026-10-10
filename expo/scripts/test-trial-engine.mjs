#!/usr/bin/env node
/**
 * Client side of the progressive-testing engine: watch reporting, feed rows, the creator's messages, and that the
 * app is wired to the new RPCs. node --experimental-strip-types --no-warnings scripts/test-trial-engine.mjs
 */
import { readFileSync } from "node:fs";
import { queuePositions, queuedLabel, FEED_CAUGHT_UP_BODY, FEED_CAUGHT_UP_TITLE, creatorTrialNote, readFeedRows, viewProgress, worthReporting } from "../lib/trialEngine.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

eq("watch report: whole ms, completed at 90% of a known duration", [viewProgress(11000, 12000), viewProgress(5000, 12000), viewProgress(5000, 0), viewProgress(-5, NaN)], [
  { watch_ms: 11000, duration_ms: 12000, completed: true }, { watch_ms: 5000, duration_ms: 12000, completed: false },
  { watch_ms: 5000, duration_ms: 0, completed: false }, { watch_ms: 0, duration_ms: 0, completed: false }]);
eq("a glance under 250 ms is not reported", [worthReporting(100), worthReporting(300)], [false, true]);
eq("engine feed rows: ids in order, end detection uses page_rows (filtering must not look like the end)",
  readFeedRows([{ post_id: "a", position: 1, page_rows: 20 }, { post_id: "b", position: 2, page_rows: 20 }]), { ids: [{ post_id: "a", position: 1 }, { post_id: "b", position: 2 }], rowCount: 20 });
eq("the empty-page sentinel row has no post and keeps the source row count", readFeedRows([{ post_id: null, position: -1, page_rows: 7 }]), { ids: [], rowCount: 7 });
eq("old get_feed rows (no page_rows) count as they are", readFeedRows([{ post_id: "a", position: 1 }]), { ids: [{ post_id: "a", position: 1 }], rowCount: 1 });
eq("creator sees ON TRIAL for a testing post and nothing for finished, ended or incomplete ones", [creatorTrialNote("trial"), creatorTrialNote("incomplete"), creatorTrialNote("survived"), creatorTrialNote("archived")], [{ title: "YOUR VIDEO IS ON TRIAL", body: null }, null, null, null]);

const feed = read("../components/FeedItem.tsx"), prov = read("../providers/PostsProvider.tsx"), notif = read("../components/NotificationItem.tsx"), badge = read("../components/TrialStatusBadge.tsx");
eq("feed uses get_feed_engine and falls back to get_feed", [/rpc\("get_feed_engine"/.test(prov), /rpc\("get_feed", \{ p_limit/.test(prov), /readFeedRows/.test(prov)], [true, true, true]);
eq("FeedItem reports watch time and shares, and shows the progress indicator with no numbers", [/sendViewProgress/.test(feed) && /record_view_progress/.test(read("../lib/viewProgress.ts")), /record_post_share/.test(feed), /trial_post_progress/.test(feed), /trialNote\.title/.test(feed)], [true, true, true, true]);
eq("the owner's own views are not reported", /isOwner\s*\?\s*null/.test(feed), true);
eq("no ended / incomplete notifications or wording in the app (survived keeps its celebration)", [/verdict_incomplete/.test(notif), /verdict_archived/.test(notif), /verdict_survived/.test(notif), /Trial ended|Trial incomplete|didn't earn/.test(notif)], [false, false, true, false]);
eq("no TRIAL ENDED / TRIAL INCOMPLETE badge exists", [/TRIAL ENDED|TRIAL INCOMPLETE/.test(badge), /label: "SURVIVED"/.test(badge)], [false, true]);
const home = read("../app/(tabs)/index.tsx");
eq("empty feed: 'You're all caught up' + 'Be the first to put something on Trial' + a button to the camera", [FEED_CAUGHT_UP_TITLE, FEED_CAUGHT_UP_BODY, /onCreate=\{\(\) => router\.push\("\/camera"\)\}/.test(home), /FEED_CAUGHT_UP_BUTTON/.test(home)], ["You're all caught up", "Be the first to put something on Trial", true, true]);
eq("later feed pages send the ids already delivered (p_seen); the first page and pull-to-refresh do not", [/p_seen: offset > 0 \? loadedFeedIds/.test(prov), /function loadedFeedIds/.test(prov)], [true, true]);
eq("queue wording: up next, then #n in line", [queuedLabel(1), queuedLabel(2), queuedLabel(null), creatorTrialNote("queued", 3)], ["Queued: up next", "Queued: #2 in line", "Queued: up next", { title: "Queued: #3 in line", body: null }]);
eq("queue positions: oldest queued first, other statuses ignored", [...queuePositions([
  { id: "c", status: "queued", created_at: "2026-01-03T00:00:00Z" }, { id: "a", status: "queued", created_at: "2026-01-01T00:00:00Z" },
  { id: "t", status: "trial", created_at: "2026-01-00T00:00:00Z" }, { id: "b", status: "queued", created_at: "2026-01-02T00:00:00Z" }]).entries()], [["a", 1], ["b", 2], ["c", 3]]);
const profile = read("../app/(tabs)/profile.tsx"), badge2 = read("../components/TrialStatusBadge.tsx");
eq("own profile lists queued posts with their place in line; other users' profiles do not", [/isOnOwnProfile/.test(profile), /status === "queued"/.test(read("../components/profile/ProfileParts.tsx")) || /queued=\{item\.post\.status === "queued"\}/.test(profile), /isOnOtherProfile/.test(read("../app/user/[id].tsx"))], [true, true, true]);
eq("badge has a queued pill", /queued: \{ label: "QUEUED"/.test(badge2), true);
eq("app.json version untouched", JSON.parse(read("../app.json")).expo.version, "1.0.4");
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
