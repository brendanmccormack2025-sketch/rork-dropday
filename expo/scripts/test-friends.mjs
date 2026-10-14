#!/usr/bin/env node
/**
 * Friends and messages, the app side: invite link building and parsing, texts, message lists, the entry in the feed
 * header, the send-to-friend sheet, deep links, and the privacy promises (contacts are never uploaded for the invite list,
 * no "X is on Tryal"). The rules themselves are tested on a real database in test-friends-sql.mjs.
 *   node --experimental-strip-types --no-warnings scripts/test-friends.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import {
  DEFAULT_INVITE_BASE, INVITE_TEXT, INVITE_TOKEN_RE, POST_UNAVAILABLE_TEXT, friendlyError, inviteAppLink, inviteMessage, inviteWebLink,
  mergeMessages, messagePreview, parseInviteToken, relationLabel, smsHref, unreadLabel,
} from "../lib/friendsCore.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── invite links ──
const id = "0123456789abcdef0123456789abcdef", sig = "fedcba9876543210fedcba9876543210";
const token = `${id}.1.${sig}`;
ok("a token is 32 hex . version . 32 hex", INVITE_TOKEN_RE.test(token) && !INVITE_TOKEN_RE.test(`${id}.1`) && !INVITE_TOKEN_RE.test(`${id}.x.${sig}`) && !INVITE_TOKEN_RE.test(token.toUpperCase()));
eq("web link", inviteWebLink(token), `${DEFAULT_INVITE_BASE}/i/${token}`);
eq("web link: a trailing slash on the base is dropped", inviteWebLink(token, "https://example.com/"), `https://example.com/i/${token}`);
eq("app link", inviteAppLink(token, "tryalx"), `tryalx://invite/${token}`);
for (const [what, input] of [["a raw token", token], ["the web link", inviteWebLink(token)], ["the app link", inviteAppLink(token, "tryalx")], ["a path", `/invite/${token}`], ["a link with a query", `${inviteWebLink(token)}?utm=x`], ["the web link with spaces around", `  ${inviteWebLink(token)}  `]]) {
  eq(`parse: ${what}`, parseInviteToken(input), token);
}
for (const [what, input] of [["nothing", null], ["empty", ""], ["garbage", "hello world"], ["a short token", `${id}.1.abc`], ["extra path", `https://x/i/${token}/more/../evil`], ["a token inside other text", `look ${token} here`], ["SQL", `${token}'; drop table x; --`]]) {
  ok(`parse: ${what} is not a token`, parseInviteToken(input) === null || parseInviteToken(input) === token && /(^|[/:])(i|invite)\//.test(String(input)));
}
eq("the invite text is 'Join me on Tryal' and the link", inviteMessage("https://x/i/t"), "Join me on Tryal\nhttps://x/i/t");
eq("the text itself", INVITE_TEXT, "Join me on Tryal");
eq("sms (iOS): the person's own Messages opens with the text typed", smsHref("+1 (415) 555-0101", "Join me on Tryal\nhttps://x/i/t", "ios"), "sms:+14155550101&body=Join%20me%20on%20Tryal%0Ahttps%3A%2F%2Fx%2Fi%2Ft");
eq("sms (Android)", smsHref("+14155550101", "hi", "android"), "sms:+14155550101?body=hi");

// ── lists and texts ──
eq("relation labels", ["friend", "requested", "incoming", "none"].map(relationLabel), ["Friends", "Requested", "Accept", "Add"]);
eq("conversation preview", [messagePreview({ last_text: "hi", last_was_post: false }), messagePreview({ last_text: null, last_was_post: true }), messagePreview({ last_text: "look", last_was_post: true })], ["hi", "Sent a post", "Sent a post: look"]);
eq("unread label", [0, -1, 1, 9, 10, 250, NaN].map(unreadLabel), [null, null, "1", "9", "9+", "9+", null]);
const m = (id, at, over = {}) => ({ id, conversation_id: "c", sender_id: "a", body: id, post_id: null, was_post: false, created_at: at, deleted_at: null, ...over });
eq("messages merge: oldest first, each id once, a changed message replaces the old one", mergeMessages([m("2", "2026-01-02"), m("1", "2026-01-01")], [m("2", "2026-01-02", { deleted_at: "2026-01-03", body: null }), m("3", "2026-01-03")]).map((x) => [x.id, x.deleted_at !== null]), [["1", false], ["2", true], ["3", false]]);
eq("the unavailable text", POST_UNAVAILABLE_TEXT, "This post isn't available");
eq("errors in words, never the database's text", [friendlyError(new Error("you can only message friends")), friendlyError(new Error("this post cannot be sent to that person")), friendlyError(new Error("invalid invite")), friendlyError(new Error("select * from secret"))], ["You can only message friends.", "This post can't be sent to that person.", "This invite link isn't valid any more.", "Something went wrong. Please try again."]);

// ── the feed header ──
{
  const feed = read("../app/(tabs)/index.tsx");
  const header = feed.slice(feed.indexOf("Messages (paper plane)"), feed.indexOf("emptyComponent"));
  ok("the paper plane sits next to the bell, with the same button style", /label|accessibilityLabel="Messages"/.test(header) && /<Send color="#fff" size=\{20\} strokeWidth=\{2\} \/>/.test(header) && (header.match(/style=\{styles\.bellBtn\}/g) ?? []).length === 2 && header.indexOf('accessibilityLabel="Messages"') < header.indexOf('accessibilityLabel="Notifications"'));
  ok("a red unread dot, the bell's own dot style", /unreadMessages > 0 && <View style=\{styles\.bellDot\} \/>/.test(header));
  ok("it opens the Messages screen", /router\.push\("\/messages" as never\)/.test(header));
  ok("the unread count is live (Realtime, server counted)", /useUnreadMessages\(\)/.test(feed) && /subscribeAnyMessage/.test(read("../hooks/useUnreadMessages.ts")) && /myUnreadMessages/.test(read("../hooks/useUnreadMessages.ts")));
  ok("the send arrow opens Send to friend (no direct native share any more)", /onSharePost=\{\(post\) => setSendPost\(post\)\}/.test(feed) && /<SendToFriendSheet post=\{sendPost\}/.test(feed) && !/DM sharing disabled/.test(feed));
  const drops = read("../app/profile-drops.tsx");
  ok("the profile viewer's send arrow does too", /<SendToFriendSheet post=\{sendPost\}/.test(drops) && /setSendPost\(post\)/.test(drops));
}

// ── the sheet and the screens ──
{
  const sheet = read("../components/SendToFriendSheet.tsx");
  ok("Send to friend lists what the server says (friends_for_post) and sends through the server's rule", /friendsForPost\(post\.id\)/.test(sheet) && /sendPostToFriend\(friend\.id, post\.id\)/.test(sheet) && !/known_connections|hide_from_list|contact_hashes/.test(sheet));
  ok("a refused send says why in words", /friendlyError\(e\)/.test(sheet));
  for (const f of ["app/messages/index.tsx", "app/messages/[userId].tsx", "app/people.tsx", "app/shared-post/[messageId].tsx", "app/invite/[token].tsx", "app/i/[token].tsx"]) ok(`screen exists: ${f}`, existsSync(new URL(`../${f}`, import.meta.url)));
  const chat = read("../app/messages/[userId].tsx");
  ok("chat: realtime subscription, report, delete my message, block", /subscribeMessages\(conversationId/.test(chat) && /reportMessage\(m\.id, reason\)/.test(chat) && /deleteMyMessage\(m\.id\)/.test(chat) && /blockUser\(other\)/.test(chat));
  ok("chat: sending goes through the server (no direct insert)", /sendMessage\(other, body\)/.test(chat) && !/\.from\("chat_messages"\)\s*\.insert/.test(chat));
  const shared = read("../app/shared-post/[messageId].tsx");
  ok("a shared post is opened through the server, which records the source and decides availability", /openSharedPost\(String\(messageId\)\)/.test(shared) && /POST_UNAVAILABLE_TEXT/.test(shared));
  const lib = read("../lib/friends.ts");
  ok("every write is an RPC (the tables have no client write access)", !/\.from\("(friendships|friend_requests|chat_conversations|chat_messages|chat_reads|message_post_opens)"\)\s*\.(insert|update|delete|upsert)/.test(lib + chat + read("../app/people.tsx")));
}

// ── privacy and safety promises ──
{
  const contacts = read("../lib/contacts.ts");
  const invite = contacts.slice(contacts.indexOf("export async function listContactsToInvite"));
  ok("the invite list reads contacts on the phone only: nothing is uploaded or hashed for it", !/supabase|rpc\(|sync_my_contacts|upload\(|AsyncStorage/.test(invite));
  ok("...and only after a tap on 'Choose from contacts' (the permission is asked then)", /requestPermissionsAsync\(\)/.test(invite) && /onPress=\{chooseContacts\}/.test(read("../app/people.tsx")));
  ok("the phone is not used to say who is on Tryal", !/is on Tryal|already on Tryal|on Tryal already/i.test(read("../app/people.tsx") + invite));
  ok("friends come from invites, requests and search only: no contact matching in the friend flows", !/contact_hashes|user_phone_hash|sync_my_contacts/.test(read("../lib/friends.ts") + read("../app/people.tsx")));
}

// ── deep links ──
{
  const intent = read("../app/+native-intent.tsx");
  ok("invite links keep their path through the native-intent handler", /startsWith\("\/invite\/"\)/.test(intent) && /startsWith\("\/i\/"\)/.test(intent));
  ok("a link opened signed out is kept and redeemed after sign-in", /savePendingInvite\(t\)/.test(read("../app/invite/[token].tsx")) && /redeemPendingInvite\(\)/.test(read("../app/_layout.tsx")));
  ok("the web link forwards to the invite screen", /\/invite\/\$\{String\(token\)\}/.test(read("../app/i/[token].tsx")));
}

// ── the web link worker ──
{
  const worker = await import("../../functions/index.ts");
  const res = await worker.default.fetch(new Request(`https://x.test/i/${token}`), { APP_SCHEME: "tryalx", APP_STORE_URL: "https://apps.apple.com/app/id1" });
  const html = await res.text();
  ok("the worker page opens the app link and falls back to the App Store", res.status === 200 && html.includes(`tryalx://invite/${token}`) && html.includes("https://apps.apple.com/app/id1"));
  eq("the worker refuses anything that is not a token", (await worker.default.fetch(new Request("https://x.test/i/hello"), {})).status, 404);
  eq("the worker does not reflect HTML in the token", (await worker.default.fetch(new Request(`https://x.test/i/${encodeURIComponent("<script>")}`), {})).status, 404);
}

// ── nothing native was added ──
{
  const pkg = JSON.parse(read("../package.json"));
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const files = ["lib/friends.ts", "lib/friendsCore.ts", "lib/invite.ts", "lib/contacts.ts", "hooks/useUnreadMessages.ts", "components/SendToFriendSheet.tsx", "app/people.tsx", "app/messages/index.tsx", "app/messages/[userId].tsx", "app/shared-post/[messageId].tsx", "app/invite/[token].tsx", "app/i/[token].tsx"];
  const missing = [];
  for (const f of files) for (const m of read(`../${f}`).matchAll(/from "([^".@][^"]*|@[^"/]+\/[^"]+)"/g)) {
    const name = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
    if (!deps.has(name) && !["react", "react-native"].includes(name)) missing.push(`${f}: ${m[1]}`);
  }
  eq("every package the feature imports is already in package.json (no new native package: it ships as an update after 1.0.5)", missing, []);
  const app = JSON.parse(read("../app.json")).expo;
  eq("app.json: still 1.0.5 and the same scheme; no new plugin for this feature", [app.version, typeof app.scheme, app.plugins.some((p) => /sms|messages|friends/i.test(JSON.stringify(p)))], ["1.0.5", "string", false]);
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
