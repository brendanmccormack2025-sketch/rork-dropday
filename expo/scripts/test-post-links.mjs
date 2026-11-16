#!/usr/bin/env node
/**
 * Links on posts, the app's side (lib/creatorLinks.ts parseVideoLink, lib/postLinks.ts, the composer row, the Watch button): the same address
 * cases as the database test, the tracked short link, and that nothing opens a raw address or builds a second link system.
 *   node --experimental-strip-types --no-warnings scripts/test-post-links.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { BARE, BAD, GOOD } from "./post-link-cases.mjs";
import { register } from "node:module";

// creatorLinks imports react-native (Linking): give it a stub so the real link logic can run here (same trick as test-graduation.mjs).
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) { if (spec === 'react-native') return { url: 'data:text/javascript,export const Linking={openURL:async()=>{}}', shortCircuit: true }; return next(spec, ctx); }
`));
const { VIDEO_LINK_DOMAINS, VIDEO_PLATFORM_LABELS, parseVideoLink, videoPlatformOfHost } = await import("../lib/creatorLinks.ts");

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const root = new URL("../", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");

// ── the same addresses as the database ──
for (const [u, p] of GOOD) { const r = parseVideoLink(u); eq(`allowed: ${u.trim()} -> ${p}`, [r.ok, r.ok ? r.platform : null], [true, p]); }
for (const u of BAD) eq(`refused: ${u.slice(0, 40)}${u.length > 40 ? "…" : ""}`, parseVideoLink(u).ok, false);
for (const [u, p] of BARE) { const r = parseVideoLink(u); eq(`a bare address gets https:// (${u})`, [r.ok, r.ok ? r.platform : null, r.ok ? r.url.startsWith("https://") : null], [true, p, true]); }
eq("what is sent to the database is the normalized https address, with the platform and label the button will show", (() => { const r = parseVideoLink("  https://youtu.be/abc?t=5  "); return r.ok ? [r.url, r.platform, r.label] : null; })(), ["https://youtu.be/abc?t=5", "youtube", "YouTube"]);
eq("errors are plain: empty, not a link, not an allowed site, too long", [parseVideoLink("").ok ? null : parseVideoLink("").error, parseVideoLink("hello there").ok ? null : parseVideoLink("hello there").error, parseVideoLink("https://evil.com/x").ok ? null : parseVideoLink("https://evil.com/x").error, parseVideoLink("https://youtube.com/" + "a".repeat(500)).ok ? null : parseVideoLink("https://youtube.com/" + "a".repeat(500)).error],
  ["Paste the link to your video.", "That doesn't look like a link. Use one that starts with https://.", "Links can go to YouTube, TikTok, Instagram, X, Twitch or Spotify.", "That link is too long."]);
eq("platform labels", Object.values(VIDEO_PLATFORM_LABELS), ["YouTube", "TikTok", "Instagram", "X", "Twitch", "Spotify"]);

// ── the allowed sites are the same everywhere: client, database, spec ──
const sql = read("supabase/migration-post-links.sql");
const sqlHosts = [...sql.matchAll(/h = '([a-z.]+)'/g)].map((m) => m[1]);
eq("the client's site list is the owner's list (with twitter.com as X)", [...VIDEO_LINK_DOMAINS], ["youtube.com", "youtu.be", "tiktok.com", "instagram.com", "x.com", "twitter.com", "twitch.tv", "open.spotify.com"]);
eq("the database's link_platform_of names exactly those sites (twitter.com only as itself, www. and mobile.)", [...new Set(sqlHosts)].sort(), [...VIDEO_LINK_DOMAINS, "www.twitter.com", "mobile.twitter.com"].sort());
const spec = readFileSync(join(root, "../MONEY_TAB_SPEC.md"), "utf8");
eq("the spec (section 16) lists the same sites", VIDEO_LINK_DOMAINS.every((d) => spec.includes("`" + d + "`")), true);
eq("subdomains of the first five count, look-alikes and other subdomains do not; twitter.com / www. / mobile. are X, other twitter.com subdomains are not", [videoPlatformOfHost("vm.tiktok.com"), videoPlatformOfHost("www.youtu.be"), videoPlatformOfHost("evilx.com"), videoPlatformOfHost("spotify.com"), videoPlatformOfHost("api.open.spotify.com"), videoPlatformOfHost("twitter.com"), videoPlatformOfHost("www.twitter.com"), videoPlatformOfHost("mobile.twitter.com"), videoPlatformOfHost("m.twitter.com"), videoPlatformOfHost("api.twitter.com")], ["tiktok", null, null, null, null, "x", "x", "x", null, null]);

// ── the tracked link and the button (lib/postLinks.ts pieces that need no network) ──
const src = read("lib/postLinks.ts");
const trackedUrl = (code, base) => /^[0-9a-f]{10}$/.test(code) ? `${base.replace(/\/+$/, "")}/functions/v1/go/${code}` : null;
eq("the short link is <project>/functions/v1/go/<code>, only for a real code (same rule as the function)", [/functions\/v1\/go\/\$\{code\}/.test(src), /CODE_RE = \/\^\[0-9a-f\]\{10\}\$\//.test(src), trackedUrl("0123456789", "https://x.supabase.co/"), trackedUrl("short", "https://x.supabase.co")], [true, true, "https://x.supabase.co/functions/v1/go/0123456789", null]);
eq("the button says 'Watch on <platform>' and the owner's line is plural-aware", [/`Watch on \$\{VIDEO_PLATFORM_LABELS\[platform\]\}`/.test(src), /This post sent \$\{n\.toLocaleString\("en-US"\)\} \$\{n === 1 \? "person" : "people"\} to your video\./.test(src)], [true, true]);

// ── no second link system, and the raw address is never opened ──
const FILES = [];
(function walk(d) { for (const f of readdirSync(join(root, d))) { if (["node_modules", "scripts", "supabase", "ios", "android", ".git"].includes(f)) continue; const p = join(d, f); if (statSync(join(root, p)).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) FILES.push(p); } })(".");
const defsParse = FILES.filter((f) => /function parseVideoLink|const parseVideoLink/.test(read(f)));
eq("video links are parsed in exactly one place: lib/creatorLinks.ts (the profile-links code)", defsParse, ["lib/creatorLinks.ts"]);
eq("lib/postLinks.ts reuses it for opening and labels (imports from creatorLinks) and has no URL parser of its own", [/from "@\/lib\/creatorLinks"/.test(src), /new URL\(/.test(src)], [true, false]);
const button = read("components/PostLinkOrSocials.tsx");
eq("the Watch button opens the tracked link only (openPostLink), never the stored address, and falls back to the profile's social icons when there is no link", [/openPostLink\(link\)/.test(button), /openCreatorLink|Linking\./.test(button), /<CreatorLinkIcons profile=\{profile\}/.test(button), /link\.url|\.url\b/.test(button)], [true, false, true, false]);
const feed = read("components/FeedItem.tsx");
eq("the feed shows the button (or the socials) through that one component, in place of the old icon row", [/<PostLinkOrSocials postId=\{post\.id\}/.test(feed), /<CreatorLinkIcons/.test(feed)], [true, false]);
eq("the owner's tap line only shows to the owner, from the owner-only function", [/isOwner \? tapsLine\(taps\)/.test(button), /"my_post_link_taps"/.test(src)], [true, true]);
const edit = read("app/edit.tsx");
eq("the composer: the Links row is for root posts only, 'My socials' is the default, a bad link stops the post with the message before any upload work, and the link goes to createPost", [/\{isRootPost && \(\s*<PostLinksRow/.test(edit), /useState<LinksMode>\("socials"\)/.test(edit), /const parsedLink = parseVideoLink\(videoLinkText\);\s*if \(!parsedLink\.ok\) \{\s*setError\(parsedLink\.error\)/.test(edit), /videoLink: videoLinkRef\.current \?\? undefined/.test(edit)], [true, true, true, true]);
const prov = read("providers/PostsProvider.tsx");
eq("createPost adds the link after the post exists, for root posts, and a failure never fails the post", [/rawInput\.videoLink && !input\.parentPostId/.test(prov), /await setPostVideoLink\(insData\.id as string, rawInput\.videoLink\)/.test(prov), /video link not added \(non-fatal\)/.test(prov)], [true, true, true]);
eq("the feed's own query is not changed (the link is read separately, so an app update before the migration cannot break the feed)", [/link_code/.test(prov), /FEED_POST_SELECT =\s*\n?\s*"[^"]*link_/.test(prov)], [false, false]);
eq("the batched reader asks only for id, link_code, link_platform and gives up quietly (10 minutes) if the columns are not there yet", [/select\("id, link_code, link_platform"\)/.test(src), /unavailableUntil = Date\.now\(\) \+ 10 \* 60_000/.test(src)], [true, true]);
eq("no password, token or analytics id is added anywhere in the link code", /apikey|secret|token|analytics/i.test(src + button + read("components/PostLinksRow.tsx")), false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
