/** Deep indigo-night aesthetic — electric blue accent. */
export const theme = {
  bg: "#0A0A14",
  bgElevated: "#13131F",
  card: "#1C1C2E",
  border: "#1C1C1E",
  text: "#F5F5F5",
  textMuted: "#999999",
  textDim: "#555555",
  primary: "#0A84FF",
  primaryDeep: "#0055CC",
  accent: "#0A84FF",
  accentGlow: "#3B82F6",
  violet: "#8B5CF6",
  danger: "#FF453A",
  success: "#30D158",
} as const;

export const DROP_WINDOW = {
  startHour: 20,
  endHour: 24,
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
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);

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
