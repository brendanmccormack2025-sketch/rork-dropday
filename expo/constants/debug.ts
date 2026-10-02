/**
 * Hidden developer tools are only reachable by this one signed-in user.
 *
 * PASTE YOUR SUPABASE USER ID BELOW (the UUID, not your email):
 *   Supabase dashboard -> Authentication -> Users -> copy the "UID" column
 * for your own account. Until you replace the placeholder, nobody can open
 * the debug screens.
 */
export const OWNER_USER_ID = "PASTE-YOUR-SUPABASE-USER-ID-HERE";

/** True only when the signed-in user is the owner and the id was filled in. */
export function isDebugOwner(userId: string | null | undefined): boolean {
  return !!userId && userId === OWNER_USER_ID;
}
