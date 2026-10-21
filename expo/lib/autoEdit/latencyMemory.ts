/**
 * Remembers the standby player's learned start-up latency across editor sessions and app restarts, so the first
 * cut of a playback is on time too (gaplessPlan learns it; this keeps it). Not imported by the Node tests.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { GAPLESS_DEFAULTS } from "./gaplessPlan";

const KEY = "gapless_latency_ms_v1";
let current: number = GAPLESS_DEFAULTS.latencyMs;
let lastSaved = current;

AsyncStorage.getItem(KEY)
  .then((v) => {
    const n = Number(v);
    if (v !== null && Number.isFinite(n) && n >= 15 && n <= 250) current = lastSaved = n;
  })
  .catch(() => {});

/** The latency to start a playback with: the last one learned on this phone, or the default. */
export function rememberedLatency(): number {
  return current;
}

/** Keep a newly learned latency (stored only when it changed by 5 ms or more). */
export function saveLatency(ms: number): void {
  current = ms;
  if (Math.abs(ms - lastSaved) < 5) return;
  lastSaved = ms;
  AsyncStorage.setItem(KEY, String(ms)).catch(() => {});
}
