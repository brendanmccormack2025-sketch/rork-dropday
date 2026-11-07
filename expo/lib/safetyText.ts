/**
 * Wording for the harassment-protection controls (pure; erasable TypeScript so the Node tests can run it). The rules are in the
 * database (supabase/migration-harassment.sql); this file only says them to people.
 */
export type DmPolicy = "friends" | "friends_7d" | "nobody";
export type InteractionMode = "open" | "established" | "closed";

export const DM_POLICIES: ReadonlyArray<{ key: DmPolicy; title: string; body: string }> = [
  { key: "friends", title: "My friends", body: "Anyone you're friends with can message you." },
  { key: "friends_7d", title: "Friends of a week or more", body: "New friends have to wait 7 days before they can message you." },
  { key: "nobody", title: "Nobody", body: "No new messages. You can still message your friends, and block or report anyone." },
];

export const INTERACTION_MODES: ReadonlyArray<{ key: InteractionMode; title: string }> = [
  { key: "open", title: "Everyone" },
  { key: "established", title: "Accounts older than 7 days" },
  { key: "closed", title: "Nobody (no new likes or reactions)" },
];

export const WHO_CAN_MESSAGE_TITLE = "Who can message me";
export const LIMIT_INTERACTIONS_TITLE = "Limit interactions";
export const LIMIT_INTERACTIONS_BODY = "Choose who can like or react to this post from now on. What's already there stays.";
export const REMOVE_REACTION_TITLE = "Remove this reaction?";
export const REMOVE_REACTION_BODY = "It and the replies under it disappear from your post. They aren't told.";

/** What a database error from the harassment checks means to a person (the server never names a blocked word). */
export function safetyError(e: unknown): string | null {
  const m = String((e as { message?: unknown } | null)?.message ?? e ?? "").toLowerCase();
  if (m.includes("not allowed on tryal")) return "That contains words that aren't allowed on Tryal.";
  if (m.includes("not taking messages")) return "This person isn't taking messages right now.";
  if (m.includes("been friends for")) return "This person only takes messages from people who have been friends for a while.";
  if (m.includes("wait for a reply")) return "Wait for a reply before sending more.";
  if (m.includes("interactions are limited")) return "Interactions are limited on this post.";
  return null;
}
