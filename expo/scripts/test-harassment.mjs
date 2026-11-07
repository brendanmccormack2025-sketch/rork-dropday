#!/usr/bin/env node
/**
 * Harassment protection, client side: the lists and wording match what the database accepts, every control goes through a
 * database function, errors read well, and the owner-only moderation screen is wired (the rules themselves are tested in
 * test-harassment-sql.mjs).
 *   node --experimental-strip-types --no-warnings scripts/test-harassment.mjs
 */
import { readFileSync } from "node:fs";
import { DM_POLICIES, INTERACTION_MODES, safetyError } from "../lib/safetyText.ts";
import { friendlyError } from "../lib/friendsCore.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../supabase/migration-harassment.sql");
const code = (t) => t.replace(/--.*$/gm, "");

eq("DM policies in the app are exactly what the database accepts", [DM_POLICIES.map((p) => p.key), (sql.match(/dm_policy\s+text not null default 'friends' check \(dm_policy in \(([^)]*)\)/) ?? [])[1]?.match(/'([a-z_0-9]+)'/g)?.map((s) => s.slice(1, -1))], [["friends", "friends_7d", "nobody"], ["friends", "friends_7d", "nobody"]]);
eq("interaction modes: open (no row) / established / closed", [INTERACTION_MODES.map((m) => m.key), /mode in \('established', 'closed'\)/.test(sql), /p_mode not in \('open', 'established', 'closed'\)/.test(sql)], [["open", "established", "closed"], true, true]);

eq("errors from the database read well, and a blocked word is never named", [safetyError(new Error("This contains words that are not allowed on Tryal.")), safetyError(new Error("This person is not taking messages right now.")), safetyError(new Error("Wait for a reply before sending more.")), safetyError(new Error("Interactions are limited on this post.")), safetyError(new Error("boom"))], ["That contains words that aren't allowed on Tryal.", "This person isn't taking messages right now.", "Wait for a reply before sending more.", "Interactions are limited on this post.", null]);
eq("the chat screen's friendlyError uses them and keeps its old messages", [friendlyError(new Error("Wait for a reply before sending more.")), friendlyError(new Error("you can only message friends")), friendlyError(new Error("x"))], ["Wait for a reply before sending more.", "You can only message friends.", "Something went wrong. Please try again."]);

const lib = read("../lib/safety.ts");
eq("every call is a database function (no table reads or writes from the app)", [["my_controls", "set_dm_policy", "my_post_interaction_mode", "set_post_interactions", "remove_reaction_on_my_post", "admin_reports_queue", "admin_report_resolve", "admin_flags_list", "admin_flag_resolve", "admin_filter_terms", "admin_filter_add", "admin_filter_remove"].every((f) => lib.includes(`"${f}"`) && sql.includes(`function public.${f}(`)), /\.from\("/.test(lib)], [true, false]);
eq("the controls are reachable: settings row, post menu, reaction tree", [/who-can-message/.test(read("../app/settings.tsx")), /setPostInteractions\(/.test(read("../components/FeedItem.tsx")) && /LIMIT_INTERACTIONS_TITLE, onPress: handleLimit/.test(read("../components/FeedItem.tsx")), /isCreator && !isOwner && !isPending/.test(read("../app/post/[id]/reaction-tree.tsx")) && /removeReactionOnMyPost\(/.test(read("../app/post/[id]/reaction-tree.tsx"))], [true, true, true]);
const ma = read("../app/moderation-admin.tsx");
eq("the moderation screen is owner only, has Reports / Flags / Word list and resolves through the database", [/isDebugOwner\(user\?\.id\)/.test(ma) && /<Redirect/.test(ma), /Reports/.test(ma) && /Flags/.test(ma) && /Word list/.test(ma), /adminResolveReport\(/.test(ma), /adminResolveFlag\(/.test(ma), /adminAddTerm\(/.test(ma), /moderation-admin/.test(read("../app/settings.tsx")) && /isDebugOwner\(user\?\.id\) && \(/.test(read("../app/settings.tsx"))], [true, true, true, true, true, true]);
eq("existing report and block paths are untouched: the hook still inserts into reports; the migration neither drops nor redefines them", [/reports/.test(read("../hooks/useReportContent.ts")), /(drop|create or replace) (function|table|trigger)[^;]*(report_message|auto_hide_reported_content|user_blocks|trg_auto_hide_reported)/i.test(code(sql))], [true, false]);
eq("the database enforces on the tables every path writes to: messages, captions, likes, reactions", [/before insert on public\.chat_messages/.test(sql), /before insert or update of caption, text_overlays on public\.posts/.test(sql), /before insert on public\.likes/.test(sql), /before insert on public\.posts/.test(sql)], [true, true, true, true]);
eq("the migration is last in the order and in the apply script", [read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")).pop(), /"migration-harassment\.sql"\]/.test(read("../scripts/apply-migrations.mjs"))], ["migration-harassment.sql", true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
