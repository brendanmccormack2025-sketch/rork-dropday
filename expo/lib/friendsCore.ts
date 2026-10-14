/**
 * Friends and direct messages, the parts that need no network: invite links, texts, message lists. Pure; erasable
 * TypeScript only so the Node tests can run it. The rules themselves (who may message whom, what may be sent) live in the
 * database (supabase/migration-friends-messages.sql); nothing here decides them.
 */

export type Relation = "friend" | "requested" | "incoming" | "none";

export type Person = { id: string; username: string; display_name: string | null; avatar_url: string | null };
export type PersonResult = Person & { relation: Relation };
export type FriendRequest = Person & { direction: "incoming" | "outgoing"; created_at: string };

export type Conversation = {
  other_id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  last_text: string | null;
  last_was_post: boolean;
  last_at: string;
  unread: number;
};

export type ChatMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string | null;
  post_id: string | null;
  was_post: boolean;
  created_at: string;
  deleted_at: string | null;
};

/** What a shared post says when it can no longer be shown (ended, hidden, deleted, or no longer allowed). */
export const POST_UNAVAILABLE_TEXT = "This post isn't available";
export const INVITE_TEXT = "Join me on Tryal";

// ── invite links ──
/** user id (32 hex) . version . signature (32 hex): the token the server signs (my_invite_token). */
export const INVITE_TOKEN_RE = /^[0-9a-f]{32}\.[0-9]{1,6}\.[0-9a-f]{32}$/;

/** The page that opens the app (or the App Store). Set EXPO_PUBLIC_INVITE_BASE_URL once the domain exists. */
export const DEFAULT_INVITE_BASE = "https://tryal.app";

export function inviteWebLink(token: string, base: string = DEFAULT_INVITE_BASE): string {
  return `${base.replace(/\/+$/, "")}/i/${token}`;
}

export function inviteAppLink(token: string, scheme: string): string {
  return `${scheme}://invite/${token}`;
}

/** The token from a raw token, a web link (…/i/<token>), an app link (…://invite/<token>) or a path; null if there is none. */
export function parseInviteToken(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = String(input).trim();
  if (INVITE_TOKEN_RE.test(text)) return text;
  const m = /(?:^|[/:])(?:i|invite)\/([0-9a-f]{32}\.[0-9]{1,6}\.[0-9a-f]{32})(?:[/?#]|$)/.exec(text);
  return m ? m[1]! : null;
}

/** The text of an invite: "Join me on Tryal" and the link. */
export function inviteMessage(link: string): string {
  return `${INVITE_TEXT}\n${link}`;
}

/** Opens Messages with the invite already typed for one phone number (no SMS service: the person's own phone sends it). */
export function smsHref(number: string, body: string, os: string): string {
  const digits = number.replace(/[^\d+]/g, "");
  return `sms:${digits}${os === "ios" ? "&" : "?"}body=${encodeURIComponent(body)}`;
}

// ── the lists ──
export function relationLabel(relation: Relation): string {
  switch (relation) {
    case "friend":
      return "Friends";
    case "requested":
      return "Requested";
    case "incoming":
      return "Accept";
    default:
      return "Add";
  }
}

/** One line for the conversation list. */
export function messagePreview(c: Pick<Conversation, "last_text" | "last_was_post">): string {
  if (c.last_was_post) return c.last_text ? `Sent a post: ${c.last_text}` : "Sent a post";
  return c.last_text ?? "";
}

/** "3", "9+", or null when there is nothing to show. */
export function unreadLabel(n: number): string | null {
  if (!(n > 0)) return null;
  return n > 9 ? "9+" : String(Math.floor(n));
}

/** Messages oldest first, each id once (a realtime event can repeat what a fetch already returned). */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1));
}

/** What a deleted message shows. */
export const DELETED_MESSAGE_TEXT = "Message deleted";

/** The server's reasons, in words a person can read. */
export function friendlyError(e: unknown): string {
  const m = String((e as { message?: unknown } | null)?.message ?? e ?? "").toLowerCase();
  if (m.includes("only message friends")) return "You can only message friends.";
  if (m.includes("cannot message this person") || m.includes("cannot send a request")) return "You can't do that with this person.";
  if (m.includes("cannot be sent")) return "This post can't be sent to that person.";
  if (m.includes("invalid invite")) return "This invite link isn't valid any more.";
  if (m.includes("your own invite")) return "That's your own invite link.";
  if (m.includes("1 to 2000")) return "A message can be 1 to 2000 characters.";
  return "Something went wrong. Please try again.";
}
