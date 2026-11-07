/** What a suspended or banned person is told at sign-in (pure; erasable TypeScript so the Node tests can run it). */
export type Sanction = { kind: "suspend" | "ban"; until: string | null };

export function sanctionTitle(s: Sanction): string {
  return s.kind === "ban" ? "Your account is banned" : "Your account is suspended";
}

/** "Your account is suspended until Nov 20, 2026, 3:00 PM." / "Your account has been banned." */
export function sanctionMessage(s: Sanction, format: (d: Date) => string = (d) => d.toLocaleString()): string {
  if (s.kind === "ban") return "Your account has been banned for breaking the Tryal Terms of Use. We have zero tolerance for objectionable content and abusive users.";
  const when = s.until ? format(new Date(s.until)) : "further notice";
  return `Your account is suspended until ${when}. You can't post, react, like or message until then, and your posts are hidden. We have zero tolerance for objectionable content and abusive users.`;
}

export const SANCTION_CONTACT = "If you think this is a mistake, contact brendanmccormack2025@gmail.com.";
export const SANCTION_SIGN_OUT = "Sign out";

/** The database says "Your account is suspended until ..." / "banned" when a write is refused. */
export function sanctionError(e: unknown): string | null {
  const m = String((e as { message?: unknown } | null)?.message ?? e ?? "");
  if (/account is banned/i.test(m)) return "Your account is banned.";
  if (/account is suspended/i.test(m)) return m.match(/Your account is suspended[^.]*(?:\.\d+)?[^.]*\./)?.[0] ?? "Your account is suspended.";
  return null;
}
