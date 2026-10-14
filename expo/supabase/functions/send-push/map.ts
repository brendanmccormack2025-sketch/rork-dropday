/**
 * Notification rows -> Expo push messages, and what to do with Expo's answers. Pure and erasable TypeScript: the Edge
 * Function (index.ts) uses it, and so do the Node tests (scripts/test-push.mjs). No Deno or network here.
 *
 * Rules:
 *   - survived: "Your post survived Tryal 🏆"; reaction: "<name> reacted to your post" (several on one post collapse:
 *     "<name> and N others reacted to your post"); like milestones (1, 5, 10, 25): "Your post reached N likes";
 *     friend request / accept; message: title = sender, body "sent you a message" or "sent you a post".
 *   - Message TEXT is never shown unless the row carries a preview, which the database only sends for an adult who turned
 *     previews on; and a minor never gets one, whatever the row says.
 *   - One push per (person, kind, post / sender) in a batch; every row of a group is marked together.
 */

export type ClaimedRow = {
  id: string;
  type: string;
  recipient_id: string;
  actor_id: string | null;
  post_id: string | null;
  created_at: string;
  attempts: number;
  actor_name: string | null;
  recipient_minor: boolean;
  tokens: string[];
  milestone: number | null;
  last_was_post: boolean | null;
  preview: string | null;
};

export type PushPayload = {
  /** The rows this push stands for (all are marked sent / failed together). */
  ids: string[];
  recipient_id: string;
  tokens: string[];
  title: string;
  body: string;
  /** What the app reads when the push is tapped (never message text). */
  data: { type: string; route: string; notificationId: string; postId?: string; actorId?: string };
  /** Collapses a newer push of the same thread on the lock screen. */
  threadId: string;
};

export type ExpoMessage = {
  to: string;
  title: string;
  body: string;
  data: PushPayload["data"];
  sound: "default";
  priority: "high";
  ttl: number;
  channelId: string;
  _contentAvailable?: boolean;
};

const nameOf = (row: ClaimedRow): string => (row.actor_name && row.actor_name.trim() ? row.actor_name.trim().slice(0, 40) : "Someone");

/** Where a tap on this notification goes. */
export function routeFor(row: Pick<ClaimedRow, "type" | "actor_id" | "post_id">): string {
  switch (row.type) {
    case "message":
      return row.actor_id ? `/messages/${row.actor_id}` : "/messages";
    case "friend_request":
      return "/people";
    case "friend_accept":
      return row.actor_id ? `/messages/${row.actor_id}` : "/people";
    case "reaction":
    case "like":
    case "verdict_survived":
      return row.post_id ? `/post/${row.post_id}/reaction-tree` : "/notifications";
    default:
      return "/notifications";
  }
}

/** The group a row belongs to: rows with the same key become one push. */
function groupKey(row: ClaimedRow): string {
  switch (row.type) {
    case "reaction":
      return `reaction:${row.recipient_id}:${row.post_id}`;
    case "message":
      return `message:${row.recipient_id}:${row.actor_id}`;
    case "like":
      return `like:${row.recipient_id}:${row.post_id}`;
    default:
      return `${row.type}:${row.recipient_id}:${row.id}`;   // one push each
  }
}

/** The text of one group (rows are oldest first). */
function textFor(rows: ClaimedRow[]): { title: string; body: string } {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  switch (first.type) {
    case "verdict_survived":
      return { title: "Tryal", body: "Your post survived Tryal 🏆" };
    case "reaction": {
      const names = [...new Set(rows.map(nameOf))];
      const others = names.length - 1;
      return { title: "Tryal", body: others > 0 ? `${names[0]} and ${others} ${others === 1 ? "other" : "others"} reacted to your post` : `${names[0]} reacted to your post` };
    }
    case "like": {
      const n = Math.max(...rows.map((r) => r.milestone ?? 0));
      return { title: "Tryal", body: n <= 1 ? "Your post got its first like" : `Your post reached ${n} likes` };
    }
    case "friend_request":
      return { title: nameOf(first), body: "sent you a friend request" };
    case "friend_accept":
      return { title: nameOf(first), body: "is now your friend" };
    case "message": {
      const wasPost = last.last_was_post === true;
      // text only when the database sent it (adult, previews on) and the recipient is not a minor
      const text = !last.recipient_minor && !wasPost && last.preview ? last.preview.trim().slice(0, 120) : "";
      return { title: nameOf(last), body: text || (wasPost ? "sent you a post" : "sent you a message") };
    }
    default:
      return { title: "Tryal", body: "You have a new notification" };
  }
}

/** Rows (any order) -> one push per group. Rows with no token are left out (the caller marks them skipped). */
export function buildPushes(rows: ClaimedRow[]): PushPayload[] {
  const groups = new Map<string, ClaimedRow[]>();
  for (const row of [...rows].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))) {
    if (!row.tokens || row.tokens.length === 0) continue;
    const key = groupKey(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: PushPayload[] = [];
  for (const [key, list] of groups) {
    const last = list[list.length - 1]!;
    const { title, body } = textFor(list);
    out.push({
      ids: list.map((r) => r.id),
      recipient_id: last.recipient_id,
      tokens: [...new Set(list.flatMap((r) => r.tokens))],
      title,
      body,
      data: {
        type: last.type,
        route: routeFor(last),
        notificationId: last.id,
        ...(last.post_id ? { postId: last.post_id } : {}),
        ...(last.actor_id ? { actorId: last.actor_id } : {}),
      },
      threadId: key.split(":").slice(0, 3).join(":"),
    });
  }
  return out;
}

/** One Expo message per token. */
export function toExpoMessages(pushes: PushPayload[]): Array<{ message: ExpoMessage; push: PushPayload }> {
  const out: Array<{ message: ExpoMessage; push: PushPayload }> = [];
  for (const push of pushes) {
    for (const to of push.tokens) {
      out.push({ push, message: { to, title: push.title, body: push.body, data: push.data, sound: "default", priority: "high", ttl: 86400, channelId: "default" } });
    }
  }
  return out;
}

/** Expo takes at most 100 messages per request. */
export function chunk<T>(items: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type Ticket = { status?: string; id?: string; message?: string; details?: { error?: string } };

export type SendOutcome = {
  /** notification ids with at least one accepted message */
  sent: string[];
  /** notification ids whose every message failed in a way worth retrying */
  retry: Array<{ ids: string[]; error: string }>;
  /** notification ids with no message left to send (all their tokens were invalid) */
  skipped: string[];
  /** tokens Expo says are dead */
  removeTokens: string[];
  /** tickets to look at again later */
  tickets: Array<{ id: string; token: string }>;
};

/**
 * Expo's tickets for one chunk of messages (same order) -> what to record. A ticket with DeviceNotRegistered removes that
 * token; any other error (rate limits, server trouble) is retried later; a push counts as sent if one of its tokens took it.
 * `tickets` null = the whole request failed (network, 5xx): everything in it is retried.
 */
export function interpretTickets(chunkMessages: Array<{ message: ExpoMessage; push: PushPayload }>, tickets: Ticket[] | null, requestError?: string): SendOutcome {
  const outcome: SendOutcome = { sent: [], retry: [], skipped: [], removeTokens: [], tickets: [] };
  const perPush = new Map<PushPayload, { ok: number; retryable: string | null; dead: number; total: number }>();
  chunkMessages.forEach(({ message, push }, i) => {
    const entry = perPush.get(push) ?? { ok: 0, retryable: null, dead: 0, total: 0 };
    entry.total++;
    const t = tickets ? tickets[i] : undefined;
    if (!t) {
      entry.retryable = requestError ?? "no ticket";
    } else if (t.status === "ok") {
      entry.ok++;
      if (t.id) outcome.tickets.push({ id: t.id, token: message.to });
    } else if (t.details?.error === "DeviceNotRegistered") {
      entry.dead++;
      outcome.removeTokens.push(message.to);
    } else {
      entry.retryable = t.details?.error ?? t.message ?? "error";
    }
    perPush.set(push, entry);
  });
  for (const [push, e] of perPush) {
    if (e.ok > 0) outcome.sent.push(...push.ids);
    else if (e.retryable) outcome.retry.push({ ids: push.ids, error: e.retryable });
    else outcome.skipped.push(...push.ids);   // every token was dead
  }
  return outcome;
}

export type Receipt = { status?: string; message?: string; details?: { error?: string } };

/** Receipts (id -> receipt) for tickets we kept: the tokens to remove, and the tickets that are finished. */
export function interpretReceipts(tickets: Array<{ ticket_id: string; token: string }>, receipts: Record<string, Receipt | undefined>): { removeTokens: string[]; finished: string[] } {
  const removeTokens: string[] = [];
  const finished: string[] = [];
  for (const t of tickets) {
    const r = receipts[t.ticket_id];
    if (!r) continue;                       // Expo has no receipt yet: ask again next minute
    finished.push(t.ticket_id);
    if (r.status === "error" && r.details?.error === "DeviceNotRegistered") removeTokens.push(t.token);
  }
  return { removeTokens: [...new Set(removeTokens)], finished };
}
