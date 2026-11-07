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

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
