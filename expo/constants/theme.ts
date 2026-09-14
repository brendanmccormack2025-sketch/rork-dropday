/** Warm cream editorial aesthetic — signal red accent. */
export const theme = {
  bg: "#F5F3EE",
  bgElevated: "#FFFFFF",
  card: "#FFFFFF",
  border: "#D8D3C4",
  text: "#0A0A0A",
  textMuted: "#6E6862",
  textDim: "#A29B92",
  primary: "#E8291C",
  primaryDeep: "#B71C12",
  accent: "#E8291C",
  accentGlow: "#FF6B5E",
  violet: "#B71C12",
  danger: "#E8291C",
  success: "#1FA84D",
  /** Secondary accent — near-threshold / trending states ONLY. */
  trending: "#FFD400",
} as const;

export const DROP_WINDOW = {
  startHour: 20, // 8 PM
  endHour: 22,   // 10 PM
} as const;

export interface DropWindowState {
  isOpen: boolean;
  msUntilOpen: number;
  msUntilClose: number;
  windowStart: Date;
  windowEnd: Date;
}

export function getDropWindowState(now: Date = new Date()): DropWindowState {
  const start = new Date(now);
  start.setHours(DROP_WINDOW.startHour, 0, 0, 0);
  const end = new Date(now);
  end.setHours(DROP_WINDOW.endHour, 0, 0, 0);

  // If end would be before start (shouldn't happen with 20→22, but guard anyway),
  // push end to the next day.
  if (end <= start) {
    end.setDate(end.getDate() + 1);
  }

  const isOpen = now >= start && now < end;
  let msUntilOpen = start.getTime() - now.getTime();
  if (msUntilOpen < 0) {
    const tomorrowStart = new Date(start);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    msUntilOpen = tomorrowStart.getTime() - now.getTime();
  }
  const msUntilClose = end.getTime() - now.getTime();

  return { isOpen, msUntilOpen, msUntilClose, windowStart: start, windowEnd: end };
}

export function formatCountdown(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
