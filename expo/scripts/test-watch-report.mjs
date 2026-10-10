#!/usr/bin/env node
/** Watch-time reporting: accumulates across background/foreground, reports on leave, retries failed writes. */
import { readFileSync } from "node:fs";
import { createWatchReporter, clearPending, pendingCount } from "../lib/watchReport.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
let t = 0;
const now = () => t;
const noSleep = async () => {};
const mk = (send, extra = {}) => createWatchReporter({ postId: "p1", send, now, sleep: noSleep, getDurationMs: () => 6367, ...extra });

{
  clearPending(); t = 0;
  const sent = [];
  const r = mk(async (p) => (sent.push(p), true));
  r.start(); t = 2787; r.pause(); await r.report();
  eq("swipe-away after 2.8 s is reported (watch time, duration, not completed)", sent, [{ post_id: "p1", watch_ms: 2787, duration_ms: 6367, completed: false }]);
}
{
  clearPending(); t = 0;
  const sent = [];
  const r = mk(async (p) => (sent.push(p), true));
  r.start(); t = 3000; r.pause(); await r.report();           // app goes to the background
  t = 60000; r.start(); t = 64000; r.pause(); await r.report();   // comes back, watches 4 s more
  eq("background time is not counted; the report is cumulative (3 s + 4 s)", sent.map((p) => p.watch_ms), [3000, 7000]);
  eq("completed at 90% of the duration", sent[1].completed, true);
}
{
  clearPending(); t = 0;
  const sent = [];
  const r = mk(async (p) => (sent.push(p), true));
  r.start(); t = 100; r.pause(); await r.report();
  eq("a glance under 250 ms is not reported", sent.length, 0);
  t = 5000; r.start(); t = 8000; await r.report(); await r.report();
  eq("the same watch time is not re-sent", sent.length, 1);
}
{
  clearPending(); t = 0;
  let calls = 0;
  const r = mk(async () => ++calls >= 3);   // fails twice, then succeeds
  r.start(); t = 4000; r.pause(); await r.report();
  eq("a failed write is retried (fails twice, third attempt lands)", [calls, pendingCount()], [3, 0]);
}
{
  clearPending(); t = 0;
  let online = false; const sent = [];
  const send = async (p) => (online ? (sent.push(p), true) : false);
  const r = mk(send);
  r.start(); t = 4000; r.pause(); await r.report();
  eq("when every retry fails the report is kept, not dropped", pendingCount(), 1);
  online = true;
  const r2 = createWatchReporter({ postId: "p2", send, now, sleep: noSleep });
  r2.start(); t = 9000; r2.pause(); await r2.report();
  eq("the next report (any post) flushes it", [pendingCount(), sent.map((p) => p.post_id).sort()], [0, ["p1", "p2"]]);
}
{
  clearPending(); t = 0;
  let calls = 0;
  const r = mk(async () => { calls++; throw new Error("network"); });
  r.start(); t = 4000; r.pause(); await r.report();
  eq("a throwing send is treated as a failure (kept for later)", pendingCount(), 1);
}
const feed = read("../components/FeedItem.tsx"), vp = read("../lib/viewProgress.ts");
eq("FeedItem reports on swipe/leave, app background and unmount; no reporter for the creator", [/AppState\.addEventListener\("change"/.test(feed), /sub\.remove\(\);\s*r\.pause\(\);\s*void r\.report\(\)/.test(feed), /isOwner\s*\?\s*null/.test(feed)], [true, true, true]);
eq("the send function detects { error } results (supabase RPCs do not reject)", /return !error/.test(vp), true);
eq("raw and qualified view calls clear their dedupe on an { error } result, not only on a rejection", [/res\.error\) qualifiedViewRecorded\.delete/.test(feed), /res\.error\) rawViewRecorded\.delete/.test(feed)], [true, true]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
