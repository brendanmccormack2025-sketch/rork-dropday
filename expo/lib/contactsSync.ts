/**
 * Contacts matching, the pure parts (no native import): is the native module there, what to send, when to re-sync.
 * Only phone numbers are ever read from contacts: no names, no emails. Erasable TypeScript only (Node tests).
 */
import { normalizeE164 } from "./phone.ts";

/** Contacts are re-synced on app open at most this often. */
export const CONTACTS_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;
/** The server keeps at most this many numbers per user. */
export const MAX_CONTACT_NUMBERS = 10000;

/** Current builds (before 1.0.5) have no ExpoContacts native module: the contacts option is then hidden. */
export function contactsAvailable(getNativeModule: () => unknown): boolean {
  try {
    return !!getNativeModule();
  } catch {
    return false;
  }
}

export function shouldResync(lastSyncedMs: number | null | undefined, nowMs: number): boolean {
  if (lastSyncedMs == null || !Number.isFinite(lastSyncedMs)) return true;
  return nowMs - lastSyncedMs >= CONTACTS_RESYNC_MS;
}

export type ContactLike = { phoneNumbers?: Array<{ number?: string | null; digits?: string | null }> | null };

/** Unique E.164 numbers from contacts. Reads phoneNumbers only; everything else on a contact is ignored. */
export function collectNumbers(contacts: ContactLike[], region: string | null): string[] {
  const out = new Set<string>();
  for (const c of contacts) {
    for (const p of c.phoneNumbers ?? []) {
      const n = normalizeE164(p.number ?? p.digits ?? null, region);
      if (n) out.add(n);
      if (out.size >= MAX_CONTACT_NUMBERS) return [...out];
    }
  }
  return [...out];
}
