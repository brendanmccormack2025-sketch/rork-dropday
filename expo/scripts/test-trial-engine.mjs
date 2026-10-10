#!/usr/bin/env node
/**
 * Client side of the progressive-testing engine: watch reporting, feed rows, the creator's messages, and that the
 * app is wired to the new RPCs. node --experimental-strip-types --no-warnings scripts/test-trial-engine.mjs
 */
import { readFileSync } from "node:fs";
import { FEED_CAUGHT_UP_BODY, FEED_CAUGHT_UP_TITLE, creatorTrialNote, readFeedRows, viewProgress, worthReporting, TRIAL_INCOMPLETE_MESSAGE } from "../lib/trialEngine.ts";

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
eq("creator sees ON TRIAL, the incomplete message, and nothing for finished posts", [creatorTrialNote("trial"), creatorTrialNote("incomplete"), creatorTrialNote("survived"), creatorTrialNote("archived")],
  [{ title: "YOUR VIDEO IS ON TRIAL", body: null }, { title: "TRIAL INCOMPLETE", body: TRIAL_INCOMPLETE_MESSAGE }, null, null]);
eq("the exact incomplete wording", TRIAL_INCOMPLETE_MESSAGE, "Trial incomplete: not enough testing activity was available. Try posting again!");
eq("never says failed to the creator", /fail/i.test(TRIAL_INCOMPLETE_MESSAGE) || /fail/i.test(JSON.stringify(creatorTrialNote("incomplete"))), false);

const feed = read("../components/FeedItem.tsx"), prov = read("../providers/PostsProvider.tsx"), notif = read("../components/NotificationItem.tsx"), badge = read("../components/TrialStatusBadge.tsx");
eq("feed uses get_feed_engine and falls back to get_feed", [/rpc\("get_feed_engine"/.test(prov), /rpc\("get_feed", \{ p_limit/.test(prov), /readFeedRows/.test(prov)], [true, true, true]);
eq("FeedItem reports watch time and shares, and shows the progress indicator with no numbers", [/sendViewProgress/.test(feed) && /record_view_progress/.test(read("../lib/viewProgress.ts")), /record_post_share/.test(feed), /trial_post_progress/.test(feed), /trialNote\.title/.test(feed)], [true, true, true, true]);
eq("the owner's own views are not reported", /isOwner\s*\?\s*null/.test(feed), true);
eq("notifications show the incomplete verdict", [/verdict_incomplete/.test(notif), /TRIAL_INCOMPLETE_NOTIFICATION/.test(notif)], [true, true]);
eq("the badge has its own incomplete pill (not 'failed')", /incomplete: \{ label: "TRIAL INCOMPLETE"/.test(badge), true);
const home = read("../app/(tabs)/index.tsx");
eq("empty feed: 'You're all caught up' + 'Be the first to put something on Trial' + a button to the camera", [FEED_CAUGHT_UP_TITLE, FEED_CAUGHT_UP_BODY, /onCreate=\{\(\) => router\.push\("\/camera"\)\}/.test(home), /FEED_CAUGHT_UP_BUTTON/.test(home)], ["You're all caught up", "Be the first to put something on Trial", true, true]);
eq("app.json version untouched", JSON.parse(read("../app.json")).expo.version, "1.0.4");
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
