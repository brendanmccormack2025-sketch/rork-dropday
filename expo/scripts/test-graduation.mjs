#!/usr/bin/env node
/**
 * Graduation in the app: who sees what. (The database side is scripts/test-graduation-sql.mjs.)
 *   node --experimental-strip-types --no-warnings scripts/test-graduation.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import {
  BADGE_LABEL, GRADUATED_BODY, GRADUATED_TITLE, RESTRICTED_TITLE, blockFromBackendError, canPostRoot, canReact, graduationColumns,
  linkSourceFor, noteMissingGraduationColumns, parseCreatorStatus, postingBlock, postingBlockedError, postingBlockedKind,
  resetGraduationColumnsForTest, showsVerifiedBadge,
} from "../lib/creatorStatus.ts";

// creatorLinks imports react-native (Linking): give it a stub so the real link logic can run here.
register("data:text/javascript," + encodeURIComponent(`
  export async function resolve(spec, ctx, next) { if (spec === 'react-native') return { url: 'data:text/javascript,export const Linking={openURL:async()=>{}}', shortCircuit: true }; return next(spec, ctx); }
`));
const { getCreatorLinks } = await import("../lib/creatorLinks.ts");

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── status → what is allowed ──
{
  eq("unknown / missing status (before the migration) is active", [parseCreatorStatus(undefined), parseCreatorStatus(null), parseCreatorStatus("weird"), parseCreatorStatus("graduated"), parseCreatorStatus("restricted")], ["active", "active", "active", "graduated", "restricted"]);
  eq("active can post", [canPostRoot("active"), postingBlock("active")], [true, null]);
  eq("graduated cannot post a new post; restricted cannot", [canPostRoot("graduated"), canPostRoot("restricted")], [false, false]);
  eq("everyone can react (graduated and restricted too)", ["active", "graduated", "restricted"].map(canReact), [true, true, true]);
  const g = postingBlock("graduated");
  eq("graduated sees the positive screen", [g.title, g.kind], ["You made it 🎓", "graduated"]);
  ok("(it says they can still watch, react, message and support emerging creators)", /graduated from Trial/.test(GRADUATED_BODY) && /watch, react, message and support emerging creators/.test(GRADUATED_BODY));
  eq("restricted sees a neutral message", [postingBlock("restricted").title, postingBlock("restricted").kind], ["Posting is currently restricted", "restricted"]);
  ok("(and not the celebration)", !/🎓|made it/.test(postingBlock("restricted").title + postingBlock("restricted").body));
}

// ── the backend's refusal maps to the same messages, never a crash ──
{
  eq("POSTING_GRADUATED / POSTING_RESTRICTED from the database", [blockFromBackendError({ message: "POSTING_GRADUATED: graduated creators can no longer post to Trial" }), blockFromBackendError(new Error("POSTING_RESTRICTED: posting is currently restricted for this account"))], ["graduated", "restricted"]);
  eq("other errors are not status blocks", [blockFromBackendError({ message: "network down" }), blockFromBackendError(null), blockFromBackendError(undefined), blockFromBackendError("x")], [null, null, null, null]);
  const e = postingBlockedError("graduated");
  eq("createPost throws a typed error the editor and the provider recognise", [e instanceof Error, e.name, postingBlockedKind(e), postingBlockedKind(new Error("x")), postingBlockedKind(null)], [true, "PostingBlockedError", "graduated", null, null]);
}

// ── badge + links render ──
{
  const grad = { creator_status: "graduated", instagram_handle: "own_ig", tiktok_handle: null, youtube_url: "https://www.youtube.com/@big", website: "https://big.example", instagram_url: "https://www.instagram.com/big_official", tiktok_url: "https://www.tiktok.com/@big_official" };
  ok("a graduated profile shows the badge; active and restricted do not", showsVerifiedBadge(grad) && !showsVerifiedBadge({ creator_status: "active" }) && !showsVerifiedBadge({ creator_status: "restricted" }) && !showsVerifiedBadge(null) && !showsVerifiedBadge({}));
  eq("the badge text", BADGE_LABEL, "Verified Big Creator");
  const links = getCreatorLinks(linkSourceFor(grad));
  eq("a graduated profile shows Instagram, TikTok and YouTube (and the website), the admin URLs first, all https", links.map((l) => [l.kind, l.url]), [["instagram", "https://www.instagram.com/big_official"], ["tiktok", "https://www.tiktok.com/@big_official"], ["youtube", "https://www.youtube.com/@big"], ["website", "https://big.example"]]);
  eq("without the admin URLs it falls back to the creator's own handles", getCreatorLinks(linkSourceFor({ ...grad, instagram_url: null, tiktok_url: null, tiktok_handle: "mine" })).map((l) => l.url), ["https://www.instagram.com/own_ig", "https://www.tiktok.com/@mine", "https://www.youtube.com/@big", "https://big.example"]);
  eq("an unsafe admin link is never shown (only https on the right host)", getCreatorLinks(linkSourceFor({ ...grad, instagram_url: "javascript:alert(1)", instagram_handle: null, tiktok_url: "http://tiktok.com/@x" })).map((l) => l.kind), ["youtube", "website"]);
  eq("an active profile keeps its own links exactly as before", linkSourceFor({ creator_status: "active", instagram_handle: "a", instagram_url: "https://www.instagram.com/ignored" }).instagram_handle, "a");
  const pills = read("../components/CreatorLinkPills.tsx");
  ok("the pills open links externally through the shared helper", /openCreatorLink\(l\.url\)/.test(pills));
  const badge = read("../components/VerifiedCreatorBadge.tsx");
  ok("the badge component is distinct (gold cap + 'Verified Big Creator'), not a survival pill", /BADGE_LABEL/.test(badge) && /GraduationCap/.test(badge) && /#F6C945/.test(badge) && !/import[^;]*TrialStatusBadge/.test(badge));
  const profile = read("../app/(tabs)/profile.tsx");
  const other = read("../app/user/[id].tsx");
  ok("own profile: badge + links through the graduated link source", /showsVerifiedBadge\(myProfile\) \? <VerifiedCreatorBadge/.test(profile) && /CreatorLinkPills profile=\{linkSourceFor\(myProfile\)\}/.test(profile));
  ok("someone else's profile: the same", /showsVerifiedBadge\(profile\) \? <VerifiedCreatorBadge/.test(other) && /CreatorLinkPills profile=\{linkSourceFor\(profile\)\}/.test(other));
}

// ── the + / camera entry, and every client path ──
{
  const sheet = read("../components/PostChoiceSheet.tsx");
  ok("the + entry shows the matching screen instead of the options", /postingBlock\(parseCreatorStatus\(myProfile\?\.creator_status\)\)/.test(sheet) && /<PostingBlockedView block=\{block\}/.test(sheet));
  const cam = read("../app/camera.tsx");
  ok("the camera route shows it too (a new post only: a reaction still opens the camera)", /reactingTo \|\| rootDropId \? null : postingBlock\(/.test(cam) && /<PostingBlockedView block=\{block\}/.test(cam));
  const posts = read("../providers/PostsProvider.tsx");
  ok("createPost checks the status before uploading anything (root posts only) and throws the typed error", /if \(!rawInput\.parentPostId\) \{\s*const blocked = await fetchPostingBlockKind\(user\.id\);\s*if \(blocked\) throw postingBlockedError\(blocked\)/.test(posts));
  ok("and the database's refusal is mapped, not shown as a generic failure", /const refusedFor = blockFromBackendError\(insErr\);\s*if \(refusedFor\) throw postingBlockedError\(refusedFor\)/.test(posts));
  ok("the mutation's error handler shows the matching message and drops the placeholder (no crash, no generic alert)", /const blockedKind = postingBlockedKind\(err\);\s*if \(blockedKind\) \{[\s\S]{0,300}showAlert\(block\.title, block\.body\)[\s\S]{0,200}return;/.test(posts));
  const edit = read("../app/edit.tsx");
  ok("the editor shows the message and offers no useless Retry", /const blockedKind = postingBlockedKind\(postErr\);\s*if \(blockedKind\) \{[\s\S]{0,300}setError\(`\$\{block\.title\}\. \$\{block\.body\}`\)[\s\S]{0,120}return;/.test(edit));
  ok("likes, reactions, follows and messages never consult the status", !/creator_status|postingBlock|fetchPostingBlockKind/.test(posts.slice(posts.indexOf("followMutation") > 0 ? posts.indexOf("followMutation") : 0, posts.indexOf("followMutation") + 400)));
  ok("the only posts insert in the client is the checked one", (posts.match(/from\("posts"\)\.insert\(/g) ?? []).length === 1);
}

// ── before the migration is run ──
{
  resetGraduationColumnsForTest();
  ok("the new columns are asked for", /creator_status/.test(graduationColumns()));
  ok("an error naming them turns them off once, and the query is run again without them", noteMissingGraduationColumns({ message: 'column profiles.creator_status does not exist' }) && graduationColumns() === "" && !noteMissingGraduationColumns({ message: 'column profiles.creator_status does not exist' }));
  ok("an unrelated error does not", (resetGraduationColumnsForTest(), !noteMissingGraduationColumns({ message: "network" })));
  resetGraduationColumnsForTest();
}

// ── admin snippets ──
{
  const admin = read("../supabase/admin-graduation.sql");
  ok("ready-to-run snippets: graduate, restrict, restore, links, with a reason", /admin_set_creator_status\('USERNAME', 'graduated'/.test(admin) && /admin_set_creator_status\('USERNAME', 'restricted'/.test(admin) && /admin_set_creator_status\('USERNAME', 'active'/.test(admin) && /admin_set_creator_links\(/.test(admin));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
