#!/usr/bin/env node
/**
 * Build in silence, client side: phone normalisation, contacts gating (the native module is absent in current builds),
 * what is read from contacts, the weekly re-sync, and that the app is wired to the right RPCs and strings.
 *   node --experimental-strip-types --no-warnings scripts/test-build-in-silence.mjs
 */
import { readFileSync } from "node:fs";
import { normalizeE164, regionFromLocale } from "../lib/phone.ts";
import { CONTACTS_RESYNC_MS, collectNumbers, contactsAvailable, shouldResync } from "../lib/contactsSync.ts";
import { PHONE_EXPLANATION } from "../lib/privacyTexts.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

eq("E.164: US formats", ["(415) 555-2671", "415-555-2671", "1 415 555 2671", "+1 (415) 555-2671", "415.555.2671 x22"].map((n) => normalizeE164(n, "US")), Array(5).fill("+14155552671"));
eq("E.164: UK national (trunk 0 dropped) and international", [normalizeE164("07911 123456", "GB"), normalizeE164("+44 7911 123456", "US"), normalizeE164("0044 7911 123456", "US")], Array(3).fill("+447911123456"));
eq("E.164: rejects short, empty, unknown region without +, junk", [normalizeE164("12345", "US"), normalizeE164("", "US"), normalizeE164("5551234567", "ZZ"), normalizeE164("abc", "US"), normalizeE164(null, "US"), normalizeE164("+0123456789", "US")], Array(6).fill(null));
eq("region from the phone's locale", [regionFromLocale("en-US"), regionFromLocale("pt_BR"), regionFromLocale("en")], ["US", "BR", null]);

eq("contacts option is hidden when the native module is absent (current builds)", [contactsAvailable(() => null), contactsAvailable(() => undefined), contactsAvailable(() => { throw new Error("no module"); }), contactsAvailable(() => ({}))], [false, false, false, true]);
eq("contacts: only phone numbers are collected, normalised and de-duplicated; names/emails are ignored", collectNumbers([
  { phoneNumbers: [{ number: "(415) 555-2671" }, { number: "415-555-2671" }], name: "Ann", emails: [{ email: "a@b.c" }] },
  { phoneNumbers: [{ digits: "+447911123456" }, { number: "junk" }] }, {}, { phoneNumbers: null }], "US"), ["+14155552671", "+447911123456"]);
eq("re-sync at most once a week", [shouldResync(null, 1e12), shouldResync(1e12, 1e12 + CONTACTS_RESYNC_MS - 1), shouldResync(1e12, 1e12 + CONTACTS_RESYNC_MS)], [true, false, true]);

const contacts = read("../lib/contacts.ts"), settings = read("../app/settings.tsx"), layout = read("../app/_layout.tsx"), auth = read("../providers/AuthProvider.tsx");
eq("native module detected at runtime and required lazily (no import of expo-contacts at the top)", [/requireOptionalNativeModule\("ExpoContacts"\)/.test(contacts), /require\("expo-contacts"\)/.test(contacts), /^import .*expo-contacts/m.test(contacts)], [true, true, false]);
eq("contacts read phone numbers only", [/Fields\.PhoneNumbers/.test(contacts), /Fields\.(Name|Emails|Image)/.test(contacts)], [true, false]);
eq("settings: Privacy section; the Contacts row only when the module exists", [/Your phone number/.test(settings), /Hide my trials from…/.test(settings), /show: isContactsAvailable\(\)/.test(settings)], [true, true, true]);
eq("weekly re-sync on app open, one-time phone step, account deletion clears the privacy data", [/syncContactsIfDue\(id\)/.test(layout), /onboarding-phone/.test(layout), /delete_my_privacy_data/.test(auth)], [true, true, true]);
eq("the explanation text", PHONE_EXPLANATION, "So people in your contacts don't see your posts while they're on trial");
const app = JSON.parse(read("../app.json")).expo, pkg = JSON.parse(read("../package.json"));
eq("app.json: version stays 1.0.4; contacts permission text and Android permission added", [app.version, app.ios.infoPlist.NSContactsUsageDescription, app.android.permissions.includes("android.permission.READ_CONTACTS")], ["1.0.4", "Trial checks your contacts so friends and family only see your posts after they survive Trial. Contacts are never shared.", true]);
eq("expo-contacts is a dependency (ships with 1.0.5)", /^~57\./.test(pkg.dependencies["expo-contacts"] ?? ""), true);
const sql = read("../supabase/migration-known-connections.sql");
eq("server: phones are hashed with a Vault pepper, hash is not unique, known_connections has a friends placeholder", [/hmac\(p_e164, pepper, 'sha256'\)/.test(sql), /vault\.decrypted_secrets/.test(sql), /create index if not exists user_phone_hash_hash_idx/.test(sql) && !/unique index[^;]*user_phone_hash/.test(sql), /'friend'::text from public\.friends/.test(sql)], [true, true, true, true]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
