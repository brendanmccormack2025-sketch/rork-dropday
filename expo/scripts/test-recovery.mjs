#!/usr/bin/env node
/**
 * Recovery Boost, client side: wording that names nobody, every call goes to a database function, the offer screen and
 * notification are wired, and the migration is last in the order and the apply script (the rules are tested in test-recovery-sql.mjs).
 *   node --experimental-strip-types --no-warnings scripts/test-recovery.mjs
 */
import { readFileSync } from "node:fs";
import { RECOVERY_ANSWERED, RECOVERY_OFFER_BODY, RECOVERY_NOTIFICATION_TEXT, recoveryStatusText } from "../lib/recoveryText.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const sql = read("../supabase/migration-recovery.sql");
const code = (t) => t.replace(/--.*$/gm, "");

eq("the offer says it is optional, applies to the next post only, never boosts to anyone who knows them, and names nobody", [/optional/.test(RECOVERY_OFFER_BODY), /next post/.test(RECOVERY_OFFER_BODY), /never anyone who knows you/.test(RECOVERY_OFFER_BODY), /nobody is told who reported/.test(RECOVERY_OFFER_BODY)], [true, true, true, true]);
eq("answers and status texts", [RECOVERY_ANSWERED.accepted, RECOVERY_ANSWERED.declined, recoveryStatusText("accepted"), recoveryStatusText("used"), recoveryStatusText("offered")], ["Done. Your next post gets the boost.", "No problem. Nothing changes.", "Your next post will be boosted.", "Your boosted post is out. One boost per month.", null]);
const lib = read("../lib/recovery.ts");
eq("every call is a database function; the app never reads the offer tables", [["my_recovery_offer", "respond_recovery_offer", "admin_recovery_list"].every((f) => lib.includes(`"${f}"`) && sql.includes(`function public.${f}(`)), /\.from\("/.test(lib)], [true, false]);
eq("the client does not learn who is involved: my_recovery_offer returns no offender or reporter", !/returns table \([^)]*(offender|reporter)[^)]*\)\s*language plpgsql\s*security definer\s*set search_path = public\s*as \$\$\s*declare cfg public\.recovery_config;\s*begin\s*if auth\.uid\(\) is null then return; end if;\s*select \* into cfg from public\.recovery_config where id;\s*perform public\.recovery_expire\(\);\s*return query\s*select o\.id, o\.status/.test(sql), true);
eq("the notification and the offer screen are wired", [/"recovery_offer"/.test(read("../providers/NotificationsProvider.tsx")), /RECOVERY_NOTIFICATION_TEXT/.test(read("../components/NotificationItem.tsx")), /router\.push\("\/recovery-offer"/.test(read("../app/notifications.tsx")), /respondRecovery\(/.test(read("../app/recovery-offer.tsx")), /myRecoveryOffer/.test(read("../app/recovery-offer.tsx"))], [true, true, true, true, true]);
eq("the owner's screen lists the offers", [/adminRecovery/.test(read("../app/moderation-admin.tsx")), /Recovery/.test(read("../app/moderation-admin.tsx"))], [true, true]);
eq("the rules named in the brief are in the migration: reporter age, known connections both ways, distinct reporters, one boost per window, never an incident post, fresh strangers, owner confirmation", [/min_account_days/.test(code(sql)) && /pr\.created_at <= now\(\)/.test(code(sql)), /known_connections k[\s\S]{0,200}k\.user_id = p_reporter and k\.other_id = p_creator/.test(code(sql)), /count\(distinct r\.reporter_id\)/.test(code(sql)), /window_days/.test(code(sql)) && /o\.status = 'used'/.test(code(sql)), /new\.id = any \(o\.incident_post_ids\)/.test(code(sql)) && /not \(o\.boost_post_id = any \(o\.incident_post_ids\)\)/.test(code(sql)), /post_raw_views v join public\.posts q/.test(code(sql)) && /trial_is_silenced\(o\.creator, p_viewer\)/.test(code(sql)), /recovery_offer\(a\.creator, a\.offender, 'owner'/.test(code(sql))], [true, true, true, true, true, true, true]);
eq("the migration is in the order (after harassment, before sanctions) and in the apply script", [(() => { const o = read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#")); return o.indexOf("migration-recovery.sql") > o.indexOf("migration-harassment.sql") && o.indexOf("migration-recovery.sql") < o.indexOf("migration-sanctions.sql"); })(), /"migration-recovery\.sql"/.test(read("../scripts/apply-migrations.mjs"))], [true, true]);
eq("no payments", /payment|purchase|price|stripe|\biap\b/i.test(code(sql) + lib), false);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
