#!/usr/bin/env node
/**
 * Post status and counters on screen: "Expired" is never shown, a survived post is never dimmed, the SURVIVED banner
 * lasts 24 hours after survived_at, and the view counter uses the recorded views.
 *   node --experimental-strip-types --no-warnings scripts/test-post-display.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SURVIVED_BANNER_MS, shouldDimPost, showSurvivedBanner, viewsShown } from "../lib/postDisplay.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("..", import.meta.url).pathname;
const H = 3600_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const at = (h) => new Date(T0 - h * H).toISOString();

// 1. never "Expired" in the UI; a survived post is never dimmed
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    statSync(p).isDirectory() ? walk(p, out) : /\.tsx$/.test(n) && out.push(p);
  }
  return out;
}
const uiFiles = ["app", "components"].flatMap((d) => walk(join(root, d)));
const shownExpired = [];
for (const f of uiFiles) {
  const src = readFileSync(f, "utf8");
  // quoted text / JSX text that says Expired (statuses compared in code are lower-case string literals handled below)
  for (const m of src.matchAll(/>\s*([^<>{}\n]*\bexpired\b[^<>{}\n]*)</gi)) shownExpired.push(f.replace(root, "") + ": " + m[1].trim());
  for (const m of src.matchAll(/(label|title|body|text)\s*[:=]\s*["'`]([^"'`\n]*\bexpired\b[^"'`\n]*)["'`]/gi)) shownExpired.push(f.replace(root, "") + ": " + m[2]);
}
eq("no UI text says Expired / EXPIRED", shownExpired, []);
const badge = readFileSync(join(root, "components/TrialStatusBadge.tsx"), "utf8");
eq("the status badge has no expired entry", /expired\s*:\s*\{/.test(badge), false);
eq("a survived post (status expired internally) is never dimmed", [
  shouldDimPost({ status: "expired", survived_at: at(100) }),
  shouldDimPost({ status: "survived", survived_at: at(1) }),
], [false, false]);
eq("only an archived post that never survived is dimmed", [
  shouldDimPost({ status: "archived", survived_at: null }),
  shouldDimPost({ status: "trial" }),
], [true, false]);
const feedItem = readFileSync(join(root, "components/FeedItem.tsx"), "utf8");
eq("FeedItem dims through shouldDimPost, not by the expired status", [/shouldDimPost\(post\)/.test(feedItem), /status === "expired"/.test(feedItem)], [true, false]);

// 2. the SURVIVED banner: 24 hours after survived_at, then nothing
eq("banner shows right after survival and just before 24 h", [
  showSurvivedBanner({ status: "survived", survived_at: at(0) }, T0),
  showSurvivedBanner({ status: "survived", survived_at: at(23.9) }, T0),
], [true, true]);
eq("banner is gone at 24 h and after, for 'survived' and 'expired' alike", [
  showSurvivedBanner({ status: "survived", survived_at: at(24) }, T0),
  showSurvivedBanner({ status: "expired", survived_at: at(30) }, T0),
  showSurvivedBanner({ status: "expired", survived_at: at(24 * 90) }, T0),
], [false, false, false]);
eq("no banner for posts that did not survive or without survived_at", [
  showSurvivedBanner({ status: "trial", survived_at: at(1) }, T0),
  showSurvivedBanner({ status: "survived", survived_at: null }, T0),
  showSurvivedBanner({ status: "survived", survived_at: "garbage" }, T0),
], [false, false, false]);
eq("the window is exactly 24 hours", SURVIVED_BANNER_MS, 24 * H);
eq("the badge asks showSurvivedBanner with survived_at and FeedItem passes survivedAt", [/showSurvivedBanner/.test(badge), /survivedAt=\{post\.survived_at\}/.test(feedItem)], [true, true]);

// 3. the view counter uses the recorded views
eq("views shown: raw views, or the qualified views when higher", [
  viewsShown({ view_count: 5, qualified_view_count: 2 }),
  viewsShown({ view_count: 0, qualified_view_count: 3 }),
  viewsShown({ view_count: 7 }),
  viewsShown({}),
  viewsShown({ view_count: -4, qualified_view_count: null }),
], [5, 3, 7, 0, 0]);
eq("FeedItem's eye counter uses viewsShown", [/label=\{String\(viewsShown\(post\)\)\}/.test(feedItem), /post\.view_count \?\? 0/.test(feedItem)], [true, false]);
// the bug: the post mappers dropped view_count, so a post opened from the profile always showed 0
const mappers = ["providers/PostsProvider.tsx", "app/profile-drops.tsx", "app/user/[id].tsx"].map((f) => readFileSync(join(root, f), "utf8"));
for (const [i, src] of mappers.entries()) {
  const mapped = (src.match(/like_count: \(row\.likes/g) || []).length;
  const withViews = (src.match(/view_count: \(row\.view_count as number \| undefined\) \?\? 0,\s*qualified_view_count: \(row\.qualified_view_count as number \| undefined\) \?\? 0,\s*like_count: \(row\.likes/g) || []).length;
  eq(`every post mapper in ${["PostsProvider", "profile-drops", "user/[id]"][i]} carries view_count and qualified_view_count`, [mapped > 0, withViews], [true, mapped]);
  const selects = src.match(/"id, user_id, media_url, media_type, caption[^"]*"/g) || [];
  eq(`every post select in ${["PostsProvider", "profile-drops", "user/[id]"][i]} reads qualified_view_count`, selects.filter((s) => !/qualified_view_count/.test(s)).length, 0);
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
