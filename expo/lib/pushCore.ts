/** Push notifications, the parts that need no phone: the settings model and what a tap opens. Pure; erasable TypeScript. */

export type PushPrefs = {
  enabled: boolean;
  survived: boolean;
  reactions: boolean;
  likes: boolean;
  friends: boolean;
  messages: boolean;
  message_preview: boolean;
};

export const DEFAULT_PUSH_PREFS: PushPrefs = { enabled: true, survived: true, reactions: true, likes: true, friends: true, messages: true, message_preview: false };

export const PUSH_PREF_ROWS: Array<{ key: Exclude<keyof PushPrefs, "enabled">; label: string; hint?: string }> = [
  { key: "survived", label: "My post survived" },
  { key: "reactions", label: "Reactions to my posts" },
  { key: "likes", label: "Likes", hint: "Only at 1, 5, 10 and 25 likes on a post." },
  { key: "friends", label: "Friend requests" },
  { key: "messages", label: "Messages" },
  { key: "message_preview", label: "Show message text", hint: "Off by default. Never shown on accounts under 18." },
];

/** What the server returned, with every missing value at its default. */
export function normalizePrefs(row: Partial<PushPrefs> | null | undefined): PushPrefs {
  const out = { ...DEFAULT_PUSH_PREFS };
  for (const k of Object.keys(out) as Array<keyof PushPrefs>) if (typeof row?.[k] === "boolean") out[k] = row[k] as boolean;
  return out;
}

export const EXPO_TOKEN_RE = /^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$/;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROUTES = [new RegExp(`^/messages/${UUID}$`), /^\/messages$/, /^\/people$/, /^\/notifications$/, new RegExp(`^/post/${UUID}/reaction-tree$`)];

/** The screen a tapped push opens: only routes the app knows (a push can never open an arbitrary path). */
export function routeFromPushData(data: unknown): string | null {
  const route = (data as { route?: unknown } | null | undefined)?.route;
  if (typeof route !== "string" || route.length > 120) return null;
  return ROUTES.some((re) => re.test(route)) ? route : null;
}
