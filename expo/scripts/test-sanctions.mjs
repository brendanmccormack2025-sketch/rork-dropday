#!/usr/bin/env node
/**
 * Account sanctions and owner alerts, client side: what a suspended or banned person is told, the sign-in gate, the owner's controls
 * in the moderation screen, the report alert (notification, push route and text), and the migration in the order and the apply
 * script (the rules themselves are tested in test-sanctions-sql.mjs).
 *   node --experimental-strip-types --no-warnings scripts/test-sanctions.mjs
 */
import { readFileSync } from "node:fs";
import { sanctionError, sanctionMessage, sanctionTitle } from "../lib/sanctionText.ts";
import { safetyError } from "../lib/safetyText.ts";
import { friendlyError } from "../lib/friendsCore.ts";
import { routeFromPushData } from "../lib/pushCore.ts";
import { PRIVACY_POLICY, TERMS_OF_USE } from "../constants/legal.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../supabase/migration-sanctions.sql");
const code = (t) => t.replace(/--.*$/gm, "");

const fmt = () => "Nov 20, 2026";
eq("suspended: 'Your account is suspended until <date>', what it means, zero tolerance", [sanctionTitle({ kind: "suspend", until: "2026-11-20T15:00:00Z" }), sanctionMessage({ kind: "suspend", until: "2026-11-20T15:00:00Z" }, fmt).startsWith("Your account is suspended until Nov 20, 2026."), /can't post, react, like or message/.test(sanctionMessage({ kind: "suspend", until: "2026-11-20T15:00:00Z" }, fmt)), /zero tolerance/.test(sanctionMessage({ kind: "suspend", until: "2026-11-20T15:00:00Z" }, fmt))], ["Your account is suspended", true, true, true]);
eq("banned: says banned, no date", [sanctionTitle({ kind: "ban", until: null }), /banned/.test(sanctionMessage({ kind: "ban", until: null })), /until/.test(sanctionMessage({ kind: "ban", until: null }))], ["Your account is banned", true, false]);
eq("the database's refusal reads well in the chat, caption and like paths", [sanctionError(new Error("Your account is banned.")), sanctionError(new Error("Your account is suspended until 2026-11-20 15:00 UTC.")), safetyError(new Error("Your account is banned.")), friendlyError(new Error("Your account is suspended until 2026-11-20 15:00 UTC.")), sanctionError(new Error("boom"))], ["Your account is banned.", "Your account is suspended until 2026-11-20 15:00 UTC.", "Your account is banned.", "Your account is suspended until 2026-11-20 15:00 UTC.", null]);

const layout = read("../app/_layout.tsx");
eq("sign-in: the app shows the sanction screen instead of the app, from the database's my_sanction, re-checked while it is in force", [/mySanction/.test(layout), /<SanctionScreen sanction=\{sanctionQuery\.data\}/.test(layout), /refetchInterval/.test(layout), /rpc\("my_sanction"\)/.test(read("../lib/sanction.ts")), /signOut/.test(read("../components/SanctionScreen.tsx")) || /onSignOut/.test(read("../components/SanctionScreen.tsx"))], [true, true, true, true, true]);
eq("a network error never locks anyone out (no sanction on failure)", /catch \{\s*return null;/.test(read("../lib/sanction.ts")), true);

const ma = read("../app/moderation-admin.tsx");
eq("the owner's screen: suspend 7 / 30 days, ban, unsuspend / unban, the log; on report and flag cards", [/Suspend 7 days/.test(ma), /Suspend 30 days/.test(ma), /text: "Ban"/.test(ma), /Unban/.test(ma) && /Unsuspend/.test(ma), /adminModerationLog/.test(ma), (ma.match(/Suspend \/ ban account/g) ?? []).length === 2], [true, true, true, true, true, true]);
const lib = read("../lib/safety.ts");
eq("every call is a database function", [["admin_sanction_user", "admin_lift_sanction", "admin_sanctions_list", "admin_moderation_log"].every((f) => lib.includes(`"${f}"`) && sql.includes(`function public.${f}(`))], [true]);

eq("the report alert is wired: notification type, text, tap, push route (allowed), push text", [/"report_alert"/.test(read("../providers/NotificationsProvider.tsx")), /New report to review/.test(read("../components/NotificationItem.tsx")), /router\.push\("\/moderation-admin"/.test(read("../app/notifications.tsx")), routeFromPushData({ route: "/moderation-admin" }), /case "report_alert":\s*return \{ title: "Tryal moderation"/.test(read("../supabase/functions/send-push/map.ts"))], [true, true, true, "/moderation-admin", true]);

eq("enforced on every write path by triggers: posts (and reactions), likes, messages", [/before insert on public\.posts for each row execute function public\.sanction_guard/.test(sql), /before insert on public\.likes for each row execute function public\.sanction_guard/.test(sql), /before insert on public\.chat_messages for each row execute function public\.sanction_guard/.test(sql)], [true, true, true]);
eq("the migration is last in the order and in the apply script; no payments", [read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")).pop(), /"migration-sanctions\.sql"\]/.test(read("../scripts/apply-migrations.mjs")), /payment|purchase|stripe/i.test(code(sql))], ["migration-sanctions.sql", true, false]);

const allText = (d) => d.sections.flatMap((x) => [x.heading, ...x.paragraphs]).join("\n");
const terms = allText(TERMS_OF_USE), privacy = allText(PRIVACY_POLICY);
eq("Terms: zero tolerance for objectionable content AND abusive users, removal and suspension / ban, reports reviewed within 24 hours, the added bullet", [/zero tolerance for objectionable content and abusive users/.test(terms), /suspended or permanently banned/.test(terms), /review every report within 24 hours/.test(terms), /Is otherwise objectionable or abusive/.test(terms), /contacting someone who has blocked you/.test(terms), /suspend \(temporarily\) or ban \(permanently\)/.test(terms)], [true, true, true, true, true, true]);
eq("Terms: the rest is as it was (14 sections, section 4 renamed)", [TERMS_OF_USE.sections.length, TERMS_OF_USE.sections[3].heading, TERMS_OF_USE.sections[13].heading], [14, "4. Acceptable Use and Zero Tolerance", "14. Contact Us"]);
eq("Privacy: contacts phone numbers AND emails (hashed, never names), people who know you never get your posts, messages, moderation records, Spotlight, failed vs unjudged posts", [/phone numbers and email addresses in your contacts \(not names\)/.test(privacy), /never get your posts in their feed/.test(privacy), /messages you send to friends/.test(privacy), /suspensions and bans/.test(privacy), /Spotlight, only if you say yes/.test(privacy), /too few people saw to be judged/.test(privacy), /not names or emails/.test(privacy)], [true, true, true, true, true, true, false]);
const signup = read("../app/(auth)/sign-up.tsx");
eq("sign-up: the acceptance text carries the zero-tolerance sentence next to the Terms and Privacy links, and the box is still required", [/Tryal has zero tolerance for objectionable content and abusive users\./.test(signup), /Terms of Use/.test(signup) && /Privacy Policy/.test(signup), /disabled=\{!agreedToTerms/.test(signup)], [true, true, true]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
