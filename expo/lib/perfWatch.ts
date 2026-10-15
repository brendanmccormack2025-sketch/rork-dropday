/**
 * A small flight recorder for crashes that leave no report (iOS ending the app for memory or a stuck JS thread):
 * every 2 s the current screen, JavaScript heap size and how late the timer fired are saved on the phone, overwriting
 * the last sample. At the next launch the previous run's last sample (with its peaks) goes up as one metric,
 * "perfLastRun", so the moment before the app died can be read in client_errors. Never throws; a few bytes per tick.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

import { recordMetric } from "@/lib/clientErrors";

const KEY = "tryal:perf:v1";
const EVERY_MS = 2000;

let screen = "";
export function setPerfScreen(s: string): void {
  screen = s;
}

function heapMB(): number | null {
  try {
    const stats = (globalThis as { HermesInternal?: { getInstrumentedStats?: () => Record<string, number> } }).HermesInternal?.getInstrumentedStats?.();
    const bytes = stats?.js_heapSize ?? stats?.js_allocatedBytes;
    return typeof bytes === "number" ? Math.round(bytes / 1048576) : null;
  } catch {
    return null;
  }
}

let started = false;
export function startPerfWatch(): void {
  if (started) return;
  started = true;
  AsyncStorage.getItem(KEY)
    .then((raw) => {
      if (!raw) return;
      void recordMetric("perfLastRun", JSON.parse(raw) as Record<string, unknown>);
      return AsyncStorage.removeItem(KEY);
    })
    .catch(() => {});
  const startedAt = Date.now();
  let expected = startedAt + EVERY_MS;
  let maxLagMs = 0;
  let maxHeapMB = 0;
  let maxLagScreen = "";
  const tick = () => {
    try {
      const now = Date.now();
      const lagMs = Math.max(0, now - expected);
      expected = now + EVERY_MS;
      const heap = heapMB();
      if (lagMs > maxLagMs) {
        maxLagMs = lagMs;
        maxLagScreen = screen;
      }
      if (heap !== null && heap > maxHeapMB) maxHeapMB = heap;
      void AsyncStorage.setItem(
        KEY,
        JSON.stringify({ screen, heapMB: heap, lagMs, maxLagMs, maxLagScreen, maxHeapMB, upSec: Math.round((now - startedAt) / 1000), at: new Date(now).toISOString() }),
      ).catch(() => {});
    } catch {
      // diagnostics only
    }
    setTimeout(tick, EVERY_MS);
  };
  setTimeout(tick, EVERY_MS);
}
