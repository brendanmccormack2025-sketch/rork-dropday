/** Recovery Boost wording (pure; erasable TypeScript so the Node tests can run it). The rules are in supabase/migration-recovery.sql. */
export const RECOVERY_NOTIFICATION_TEXT = "We saw what happened. You can have a Recovery Boost for your next post.";
export const RECOVERY_OFFER_TITLE = "A fresh start for your next post";
export const RECOVERY_OFFER_BODY = "Some people were unkind to you, and we've confirmed it. If you want, your next post gets an early push to fresh people who've never seen your posts, never anyone who knows you. It's optional, it only applies to your next post, and nobody is told who reported what.";
export const RECOVERY_ACCEPT = "Boost my next post";
export const RECOVERY_DECLINE = "Not now";
export const RECOVERY_NO_OFFER_TEXT = "No Recovery Boost right now.";
export const RECOVERY_ANSWERED: Record<"accepted" | "declined", string> = {
  accepted: "Done. Your next post gets the boost.",
  declined: "No problem. Nothing changes.",
};

/** What the offer screen says for an offer in this state. */
export function recoveryStatusText(status: string | null | undefined): string | null {
  if (status === "accepted") return "Your next post will be boosted.";
  if (status === "used") return "Your boosted post is out. One boost per month.";
  return null;
}
