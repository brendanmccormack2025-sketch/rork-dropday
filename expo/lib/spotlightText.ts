/**
 * Spotlight wording and the fixed lists (pure; erasable TypeScript so the Node tests can run it). The rules themselves live in
 * the database (supabase/migration-spotlight.sql): this file only says them to people.
 */
export const SPOTLIGHT_CATEGORIES = [
  { key: "creator_of_the_day", label: "Creator of the Day" },
  { key: "rising_creators", label: "Rising Creators" },
  { key: "most_creative", label: "Most Creative" },
  { key: "best_storytelling", label: "Best Storytelling" },
  { key: "most_improved", label: "Most Improved" },
  { key: "community_favorite", label: "Community Favorite" },
] as const;

export type SpotlightCategory = (typeof SPOTLIGHT_CATEGORIES)[number]["key"];

export function categoryLabel(key: string | null | undefined): string {
  return SPOTLIGHT_CATEGORIES.find((c) => c.key === key)?.label ?? "Spotlight";
}

export type SpotlightChoice = "full" | "strangers" | "decline";

/** The three answers an offered creator can give. Nothing is shown to anyone before one of the first two. */
export const SPOTLIGHT_CHOICES: ReadonlyArray<{ key: SpotlightChoice; title: string; body: string }> = [
  { key: "full", title: "Spotlight me, for everyone", body: "Your post is featured for everyone on Tryal, including friends and people who have you in their contacts. Anyone on your hide list still never sees it." },
  { key: "strangers", title: "Spotlight me, strangers only", body: "Your post is featured only for people who don't already know you. Friends and contacts won't get it." },
  { key: "decline", title: "No thanks", body: "Nothing is featured and nobody is told. You won't be asked again for a while." },
];

export const SPOTLIGHT_OFFER_TITLE = "You've been picked for Spotlight";
export const SPOTLIGHT_NO_OFFER_TEXT = "No Spotlight offers right now.";
export const SPOTLIGHT_NOTIFICATION_TEXT = "You've been picked for Spotlight. Choose how it's shown.";
export const SPOTLIGHT_ANSWERED_TEXT: Record<SpotlightChoice, string> = {
  full: "Your Spotlight is live for everyone.",
  strangers: "Your Spotlight is live for strangers only.",
  decline: "Declined. Nothing was shown.",
};

/** The little text on a profile badge. */
export function badgeText(category: string | null | undefined, active: boolean): string {
  return active ? categoryLabel(category) : `${categoryLabel(category)} · featured`;
}

/** The small label on a Spotlight post in the feed, e.g. "Spotlight · Most Creative". */
export function spotlightLabel(category: string | null | undefined): string {
  return `Spotlight · ${categoryLabel(category)}`;
}
