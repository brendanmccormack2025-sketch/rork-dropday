/**
 * The app's error recorder (see errorRecorder.ts): AsyncStorage, the Supabase client and the app/build/update
 * ids wired in. installGlobalErrorHandlers() runs at the very start of the app.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import { createErrorRecorder, wrapGlobalHandler, type ErrorContext } from "@/lib/errorRecorder";
import { supabase } from "@/lib/supabase";

const context: ErrorContext = {
  screen: "launch",
  appVersion: "",
  buildNumber: "",
  updateId: null,
  userId: null,
};

function readStaticContext(): void {
  try {
    context.appVersion = Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? "";
    context.buildNumber = Constants.nativeBuildVersion ?? "";
  } catch {
    // keep empty
  }
  try {
    // expo-updates: the id of the running update (null in development or the embedded bundle).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require("expo-updates") as { updateId?: string | null };
    context.updateId = Updates.updateId ?? null;
  } catch {
    context.updateId = null;
  }
}

/** Where the app is and who is signed in, for the next report. */
export function setErrorContext(patch: Partial<Pick<ErrorContext, "screen" | "userId">>): void {
  if (patch.screen !== undefined) context.screen = patch.screen;
  if (patch.userId !== undefined) context.userId = patch.userId;
}

const recorder = createErrorRecorder({
  storage: AsyncStorage,
  now: () => Date.now(),
  context: () => ({ ...context }),
  schedule: (fn, ms) => {
    setTimeout(fn, ms);
  },
  upload: async (rows) => {
    const { error } = await supabase.from("client_errors").insert(rows);
    if (error) {
      console.warn("[client_errors] upload failed:", error.message);
      throw error;
    }
  },
});

/** Record an error that was caught (a failed Post, a failed save, ...) and upload it at once. Never throws. */
export function recordClientError(error: unknown, extra: { kind: string } & Record<string, unknown>): Promise<void> {
  if (__DEV__) console.log("[client error]", extra.kind, (error as Error)?.message ?? error);
  return recorder.reportNow(error, extra);
}

/**
 * Record a measurement (not a failure): kind "metric", the name as the message, no stack. Uploaded at once; never
 * throws. Use it for numbers worth reading later (a flip gap), so they do not look like crashes.
 */
export function recordMetric(name: string, data: Record<string, unknown> = {}): Promise<void> {
  if (__DEV__) console.log("[metric]", name, JSON.stringify(data));
  return recorder.reportNow(`${name} ${Object.entries(data).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`.trim(), { kind: "metric", metric: name, ...data });
}

/** Upload the reports saved by earlier runs (call once the user is signed in). */
export function flushClientErrors(userId: string | null): Promise<{ uploaded: number }> {
  return recorder.flush(userId);
}

let installed = false;

/** Global JS error handler and unhandled-rejection handler. Idempotent; each part fails soft. */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;
  readStaticContext();
  try {
    const eu = (globalThis as unknown as { ErrorUtils?: { getGlobalHandler(): (e: unknown, f?: boolean) => void; setGlobalHandler(h: (e: unknown, f?: boolean) => void): void } }).ErrorUtils;
    if (eu) {
      eu.setGlobalHandler(
        wrapGlobalHandler({
          previous: eu.getGlobalHandler(),
          record: (e, extra) => recorder.record(e, extra),
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        }),
      );
    }
  } catch {
    // no global handler available
  }
  try {
    const hermes = (globalThis as unknown as { HermesInternal?: { enablePromiseRejectionTracker?: (o: unknown) => void } }).HermesInternal;
    const onUnhandled = (_id: unknown, error: unknown) => {
      void recorder.record(error, { kind: "unhandledRejection" });
    };
    if (hermes?.enablePromiseRejectionTracker) {
      hermes.enablePromiseRejectionTracker({ allRejections: true, onUnhandled });
    }
  } catch {
    // no tracker
  }
}
