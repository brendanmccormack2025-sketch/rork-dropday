#!/usr/bin/env node
/**
 * Stranger-only distribution, client wiring: nothing in the app can reach content around the database checks,
 * discovery goes through the RPCs, contacts matching reads phones + emails (never names), the friend opt-in is gone.
 *   node --experimental-strip-types --no-warnings scripts/test-stranger-only.mjs
 */
import { readFileSync } from "node:fs";
import { collectEmails } from "../lib/contactsSync.ts";
import { CONTACTS_EXPLAINER_BODY, CONTACTS_ONBOARDING_BODY } from "../lib/privacyTexts.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const prov = read("../providers/PostsProvider.tsx"), explore = read("../app/(tabs)/explore.tsx"), friends = read("../lib/friends.ts"), chat = read("../app/messages/[userId].tsx"), contacts = read("../lib/contacts.ts");
eq("feed: only get_feed_engine; no direct posts query, no get_feed fallback, no following feed, no USE_SERVER_FEED", [/rpc\("get_feed_engine"/.test(prov), /rpc\("get_feed"/.test(prov), /USE_SERVER_FEED|followingFeedQuery|rankFollowingFeed/.test(prov)], [true, false, false]);
eq("suggested and Explore creators come from RPCs", [/rpc\("suggested_creators"/.test(prov), /rpc\("get_explore_creators"/.test(prov)], [true, true]);
eq("creator search goes through search_creators", /rpc\("search_creators"/.test(explore), true);
eq("no friend opt-in in the app (lib and chat menu)", [/friendCanTest|setFriendCanTest|friend_can_test/.test(friends), /friendCanTest|let them test|friend_can_test/i.test(chat)], [false, false]);
eq("contacts sync uploads phones and emails and sets the account email hash", [/sync_my_contacts"/.test(contacts), /sync_my_contact_emails/.test(contacts), /set_my_email_hash/.test(contacts)], [true, true, true]);
eq("collectEmails: lower-cased, de-duplicated, junk dropped", collectEmails([{ emails: [{ email: " Ann@Example.com " }, { email: "ann@example.com" }, { email: "junk" }] }, {}, { emails: null }]), ["ann@example.com"]);
eq("privacy texts say emails are read and never promise friends/contacts see posts later", [/email/.test(CONTACTS_EXPLAINER_BODY), /email/.test(CONTACTS_ONBOARDING_BODY), /only see your posts after they survive/.test(CONTACTS_EXPLAINER_BODY)], [true, true, false]);
const order = read("../supabase/MIGRATIONS_ORDER.txt").split("\n").filter((l) => l.trim() && !l.startsWith("#"));
eq("migration order ends: snapshot, known-connections, stranger-only", order.slice(-3), ["migration-live-snapshot.sql", "migration-known-connections.sql", "migration-stranger-only.sql"]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
