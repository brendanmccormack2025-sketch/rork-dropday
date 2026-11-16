/** Footage limits and the minutes display. The database checks the same numbers (money_config, money_footage_guard); these give the message first. */
export const MAX_TOTAL_SECONDS = 3600;   // 60 minutes per campaign
export const MAX_EACH_SECONDS = 1800;    // 30 minutes per video
export const MAX_BYTES = 2 * 1024 ** 3;  // 2 GB per video (after compression)

export type FootageItem = { durationSeconds: number };

export const usedSeconds = (items: FootageItem[]): number => items.reduce((a, i) => a + Math.max(0, i.durationSeconds), 0);
export const minutesLabel = (seconds: number): string => {
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, "0")}`;
};
/** "12 of 60 minutes used" */
export const usedLabel = (items: FootageItem[]): string => `${Math.floor(usedSeconds(items) / 60)} of ${MAX_TOTAL_SECONDS / 60} minutes used`;

export type AddCheck = { ok: true } | { ok: false; reason: string };
/** May a video of this length be added to what is already there? */
export function canAdd(items: FootageItem[], durationSeconds: number): AddCheck {
  if (!(durationSeconds > 0)) return { ok: false, reason: "That video has no length." };
  if (durationSeconds > MAX_EACH_SECONDS) return { ok: false, reason: `Each video can be at most ${MAX_EACH_SECONDS / 60} minutes.` };
  if (usedSeconds(items) + durationSeconds > MAX_TOTAL_SECONDS) return { ok: false, reason: `A campaign can have at most ${MAX_TOTAL_SECONDS / 60} minutes of footage.` };
  return { ok: true };
}
export const bytesLabel = (b: number): string => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1024 ** 2))} MB`);
