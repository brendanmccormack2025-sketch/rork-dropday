/**
 * Hidden developer tools are only reachable by this one signed-in user.
 *
 * PASTE YOUR SUPABASE USER ID BELOW (the UUID, not your email):
 *   Supabase dashboard -> Authentication -> Users -> copy the "UID" column
 * for your own account. Until you replace the placeholder, nobody can open
 * the debug screens.
 */
export const OWNER_USER_ID = "aee21757-1ded-41a7-9392-bddbf0d657df";

/** True only when the signed-in user is the owner and the id was filled in. */
export function isDebugOwner(userId: string | null | undefined): boolean {
  return !!userId && userId === OWNER_USER_ID;
}

/** Accounts that get the render-at-post path and playback diagnostics, in addition to the owner. */
export const INTERNAL_TESTER_IDS = ["aee21757-1ded-41a7-9392-bddbf0d657df", "519562a1-96a3-48cf-a755-783e61c96457"];

/** True for the owner or any internal tester. */
export function isInternalTester(userId: string | null | undefined): boolean {
  return !!userId && (userId === OWNER_USER_ID || INTERNAL_TESTER_IDS.includes(userId));
}
