/**
 * Trial design system: the shared tokens (radius, spacing, soft fills, type) every screen should use. Colors that already
 * live in constants/theme.ts stay there; this file adds what was missing. The profile screens are the first to adopt it.
 *
 * Rules of thumb
 *  - No outlined square boxes: soft fills instead of borders; Trial red (theme.accent) only for primary actions.
 *  - Radius: tiles 10, buttons / cards 14, pills / avatars 999.
 *  - Spacing on the 4 / 8 / 12 / 16 / 24 / 32 scale, 16 pt side margins.
 *  - Font: the app font (Plus Jakarta Sans via UiText); bold for names, grey for secondary text.
 *
 * Plain values only (no React, no native modules): the Node tests read it.
 */
import { theme } from "./theme.ts";

export const radius = { tile: 10, button: 14, pill: 999 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/** The side margin of every screen. */
export const SIDE_MARGIN = space.lg;

export const colors = {
  /** The page. */
  base: theme.bg,
  /** Soft fill for secondary buttons, chips, tiles' placeholders (a touch darker than the cream page). */
  fill: "#ECEAE4",
  fillPressed: "#E1DED6",
  /** Hairlines (tab bar top border, dividers). */
  hairline: "rgba(10,10,10,0.08)",
  text: theme.text,
  textSecondary: theme.textMuted,
  textTertiary: theme.textDim,
  /** Primary actions only. */
  primary: theme.accent,
  onPrimary: "#FFFFFF",
  /** Light tab bar: the cream page, slightly see-through, over a subtle blur. */
  tabBar: "rgba(245,243,238,0.86)",
} as const;

export const type = {
  name: { fontSize: 20, fontWeight: "800" as const },
  handle: { fontSize: 14, fontWeight: "500" as const },
  body: { fontSize: 14, lineHeight: 20, fontWeight: "400" as const },
  button: { fontSize: 14, fontWeight: "700" as const },
  tab: { fontSize: 15, fontWeight: "700" as const },
  caption: { fontSize: 12, fontWeight: "600" as const },
} as const;

/** Profile avatar diameter. */
export const AVATAR_SIZE = 88;

/** Soft tinted circles for avatars without a photo (picked by name, so a person always gets the same one). */
export const AVATAR_TINTS = ["#F3D5D0", "#F4E2C4", "#DCE8D2", "#D3E4EC", "#E3D8EE", "#EED7E3"] as const;
