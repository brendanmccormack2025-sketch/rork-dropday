/**
 * ONE palette for text overlays and captions: text color, outline color and background color all come from here, in
 * this order, with these hex values. The two semi-transparent entries (black and white at 60%) are for backgrounds
 * only. Captions store the ids, text overlays store the hex; both resolve against this list.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

export type PaletteColor = {
  id: string;
  label: string;
  /** #RRGGBB, or #RRGGBBAA for the semi-transparent ones. */
  hex: string;
};

/** "Trial red" is the app's accent (constants/theme.ts). */
export const TRIAL_RED = "#E8291C";

/** The solid colors, in the order they are shown everywhere. */
export const PALETTE: PaletteColor[] = [
  { id: "white", label: "White", hex: "#FFFFFF" },
  { id: "black", label: "Black", hex: "#000000" },
  { id: "red", label: "Trial red", hex: TRIAL_RED },
  { id: "yellow", label: "Yellow", hex: "#FFD400" },
  { id: "orange", label: "Orange", hex: "#FF8A1F" },
  { id: "green", label: "Green", hex: "#1FC45A" },
  { id: "teal", label: "Teal", hex: "#14B8A6" },
  { id: "blue", label: "Blue", hex: "#1E5BFF" },
  { id: "purple", label: "Purple", hex: "#8B5CF6" },
  { id: "pink", label: "Pink", hex: "#FF5FA8" },
  { id: "grey", label: "Grey", hex: "#8E8E93" },
];

/** Backgrounds only: black and white at 60%, after the solid colors. */
export const TRANSLUCENT: PaletteColor[] = [
  { id: "black-60", label: "Black 60%", hex: "#00000099" },
  { id: "white-60", label: "White 60%", hex: "#FFFFFF99" },
];

export type PaletteRole = "text" | "outline" | "background";

/** The colors offered for a role: text and outline use the solids, a background adds the two semi-transparent ones. */
export function paletteFor(role: PaletteRole): PaletteColor[] {
  return role === "background" ? [...PALETTE, ...TRANSLUCENT] : PALETTE;
}

const ALL = [...PALETTE, ...TRANSLUCENT];

export function paletteById(id: string | undefined): PaletteColor | null {
  return ALL.find((c) => c.id === id) ?? null;
}

/** The palette entry with this hex (case-insensitive), or null for a color that is not in the palette. */
export function paletteByHex(hex: string | undefined): PaletteColor | null {
  const h = (hex ?? "").toUpperCase();
  return ALL.find((c) => c.hex === h) ?? null;
}

/** #RRGGBB / #RRGGBBAA -> the colour and its opacity (0..1). Anything else: null. */
export function splitHex(hex: string | undefined): { rgb: string; alpha: number } | null {
  const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex ?? "");
  if (!m) return null;
  return { rgb: `#${m[1]!.toUpperCase()}`, alpha: m[2] ? Math.round((parseInt(m[2], 16) / 255) * 100) / 100 : 1 };
}

/** "rgba(r,g,b,a)" for a palette hex (the preview side of a #RRGGBBAA background). */
export function hexToRgba(hex: string): string {
  const s = splitHex(hex);
  if (!s) return hex;
  const n = parseInt(s.rgb.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${s.alpha})`;
}
