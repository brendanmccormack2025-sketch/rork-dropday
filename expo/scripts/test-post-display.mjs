#!/usr/bin/env node
/**
 * Post status and counters on screen: "Expired" is never shown, a survived post is never dimmed, the SURVIVED banner
 * lasts 24 hours after survived_at, and the view counter uses the recorded views.
 *   node --experimental-strip-types --no-warnings scripts/test-post-display.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { SURVIVED_BANNER_MS, formatCount, shouldDimPost, showSurvivedBanner, viewsShown } from "../lib/postDisplay.ts";

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
eq("FeedItem's eye counter uses viewsShown", [/label=\{formatCount\(viewsShown\(post\)\)\}/.test(feedItem), /post\.view_count \?\? 0/.test(feedItem)], [true, false]);
// the bug: the post mappers dropped view_count, so a post opened from the profile always showed 0
const mappers = ["providers/PostsProvider.tsx", "app/profile-drops.tsx", "app/user/[id].tsx"].map((f) => readFileSync(join(root, f), "utf8"));
for (const [i, src] of mappers.entries()) {
  const mapped = (src.match(/like_count: \(row\.likes/g) || []).length;
  const withViews = (src.match(/view_count: \(row\.view_count as number \| undefined\) \?\? 0,\s*qualified_view_count: \(row\.qualified_view_count as number \| undefined\) \?\? 0,\s*like_count: \(row\.likes/g) || []).length;
  eq(`every post mapper in ${["PostsProvider", "profile-drops", "user/[id]"][i]} carries view_count and qualified_view_count`, [mapped > 0, withViews], [true, mapped]);
  const selects = src.match(/"id, user_id, media_url, media_type, caption[^"]*"/g) || [];
  eq(`every post select in ${["PostsProvider", "profile-drops", "user/[id]"][i]} reads qualified_view_count`, selects.filter((s) => !/qualified_view_count/.test(s)).length, 0);
}

// 4. compact format and the profile grid tile
eq("compact counts: 842, 1.2K, 3.4M", [formatCount(842), formatCount(1200), formatCount(3_400_000)], ["842", "1.2K", "3.4M"]);
eq("edges: 0, 999, 1000, 1049, 9999, 10 000, 999 999, 1 000 000, 2.5 billion", [0, 999, 1000, 1049, 9999, 10_000, 999_999, 1_000_000, 2_500_000_000].map(formatCount), ["0", "999", "1K", "1K", "9.9K", "10K", "999.9K", "1M", "2.5B"]);
eq("bad input shows 0", [formatCount(null), formatCount(undefined), formatCount(-5), formatCount(NaN)], ["0", "0", "0", "0"]);
eq("fractions are dropped", formatCount(12.9), "12");
const parts = readFileSync(join(root, "components/profile/ProfileParts.tsx"), "utf8");
const tile = parts.slice(parts.indexOf("export function PostTile"), parts.indexOf("export function DraftTileView"));
eq("the grid tile shows a play icon and formatCount(viewsShown(post)), bottom-left, on the same gradient; no like count", [/<Play /.test(tile), /formatCount\(viewsShown\(post\)\)/.test(tile), /tileStats/.test(tile), /rgba\(0,0,0,0\.55\)/.test(tile), /like_count|Heart/.test(tile)], [true, true, true, true, false]);
eq("the tile and the viewer use the same count source (viewsShown on the same post fields)", [/viewsShown\(post\)/.test(tile), /formatCount\(viewsShown\(post\)\)/.test(feedItem)], [true, true]);
// the creator's own views are excluded: client, trigger, RPC and backfill
const mig = readFileSync(join(root, "supabase/migration-views-exclude-author.sql"), "utf8");
eq("the creator's own views are not recorded (app) ...", /if \(!active \|\| isOwner\) return;[^\n]*\n\s*if \(rawViewRecorded/.test(feedItem), true);
eq("... nor counted (trigger and RPC), and old author rows are removed and the counter recounted", [/user_id <> new\.viewer_id/.test(mig), /function public\.record_raw_view[\s\S]*user_id = auth\.uid\(\)\) then return/.test(mig), /delete from public\.post_raw_views/.test(mig), /set view_count = c\.n/.test(mig)], [true, true, true, true]);
const order = readFileSync(join(root, "supabase/MIGRATIONS_ORDER.txt"), "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
eq("the migration is in MIGRATIONS_ORDER.txt, before known-connections (which stays last)", [order.includes("migration-views-exclude-author.sql"), order[order.length - 1]], [true, "migration-known-connections.sql"]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
