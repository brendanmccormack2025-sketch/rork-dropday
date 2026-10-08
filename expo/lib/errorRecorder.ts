/**
 * Records fatal and unhandled JavaScript errors so a crash that leaves no JS message in the native log can
 * be read afterwards.
 *
 * On an error the report is written to storage at once (a promise the global handler waits for, briefly,
 * before RN aborts the app); at the next launch the pending reports are uploaded (client_errors, see
 * supabase/migration-client-errors.sql) and cleared. Caught failures (a failed Post) are recorded the same way.
 *
 * Pure: storage, the clock, the context and the upload are injected. Erasable TypeScript only so the Node
 * tests can run it.
 */

export type ErrorContext = {
  screen: string;
  appVersion: string;
  buildNumber: string;
  updateId: string | null;
  userId: string | null;
};

export type ErrorReport = {
  message: string;
  stack: string;
  context: ErrorContext & { timestamp: number; kind: string } & Record<string, unknown>;
};

export type Storage = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

export type UploadRow = { user_id: string; message: string; stack: string; context: ErrorReport["context"] };

export const ERROR_STORAGE_KEY = "trial:clientErrors:v1";
const MAX_PENDING = 20;
const MAX_MESSAGE = 500;
const MAX_STACK = 4000;

export function createErrorRecorder(deps: {
  storage: Storage;
  now: () => number;
  context: () => ErrorContext;
  /** Insert rows into client_errors as the signed-in user; rejects on failure. */
  upload: (rows: UploadRow[]) => Promise<void>;
  /** Run `fn` after `ms` (a timer); used to retry an upload that failed. Absent: no retries until the next flush. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Delays (ms) of the retries after a failed upload. */
  retryDelaysMs?: number[];
}) {
  let pending: ErrorReport[] | null = null;
  let chain: Promise<unknown> = Promise.resolve();

  async function load(): Promise<ErrorReport[]> {
    if (pending) return pending;
    try {
      const raw = await deps.storage.getItem(ERROR_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as ErrorReport[]) : [];
      pending = Array.isArray(parsed) ? parsed : [];
    } catch {
      pending = [];
    }
    return pending;
  }

  /** Serialise the storage work: a recording never races an upload. */
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = chain.then(job, job);
    chain = next.catch(() => {});
    return next;
  }

  /** Save a report; the returned promise resolves once it is written (never rejects). */
  function record(error: unknown, extra: { kind?: string } & Record<string, unknown> = {}): Promise<void> {
    let report: ErrorReport;
    try {
      const e = error as { message?: unknown; stack?: unknown } | null;
      const { kind, ...rest } = extra;
      report = {
        message: String((e && e.message) ?? error ?? "unknown error").slice(0, MAX_MESSAGE),
        stack: String((e && e.stack) ?? "").slice(0, MAX_STACK),
        context: { ...deps.context(), ...rest, timestamp: deps.now(), kind: kind ?? "error" },
      };
    } catch {
      return Promise.resolve();
    }
    return enqueue(async () => {
      const list = await load();
      list.push(report);
      while (list.length > MAX_PENDING) list.shift();
      try {
        await deps.storage.setItem(ERROR_STORAGE_KEY, JSON.stringify(list));
      } catch {
        // Storage failed: the report stays in memory for this run.
      }
    }).catch(() => {});
  }

  /**
   * Upload the pending reports of this user (reports without a user, or of another account, stay for later:
   * the table only accepts a user's own rows), then clear what went up. Never throws.
   */
  function flush(userId: string | null): Promise<{ uploaded: number }> {
    if (!userId) return Promise.resolve({ uploaded: 0 });
    return enqueue(async () => {
      const list = await load();
      const mine = list.filter((r) => r.context.userId === userId || r.context.userId === null);
      if (mine.length === 0) return { uploaded: 0 };
      try {
        await deps.upload(mine.map((r) => ({ user_id: userId, message: r.message, stack: r.stack, context: r.context })));
      } catch {
        return { uploaded: 0 }; // try again at the next launch
      }
      const rest = list.filter((r) => !mine.includes(r));
      pending = rest;
      try {
        if (rest.length === 0) await deps.storage.removeItem(ERROR_STORAGE_KEY);
        else await deps.storage.setItem(ERROR_STORAGE_KEY, JSON.stringify(rest));
      } catch {
        // They were uploaded; a stale copy may upload twice at worst.
      }
      return { uploaded: mine.length };
    }).catch(() => ({ uploaded: 0 }));
  }

  /**
   * A caught failure (a failed save, a failed Post): saved at once, then uploaded at once for the signed-in user,
   * not at the next launch. If the upload fails the report stays saved and the upload is retried after the
   * delays (and at the next launch). Never throws.
   */
  async function reportNow(error: unknown, extra: { kind?: string } & Record<string, unknown> = {}): Promise<void> {
    await record(error, extra);
    const delays = deps.retryDelaysMs ?? [5_000, 30_000, 120_000];
    const attempt = async (n: number): Promise<void> => {
      const userId = deps.context().userId;
      const before = await pendingCount();
      const { uploaded } = await flush(userId);
      const failed = !userId || (before > 0 && uploaded === 0);
      if (failed && n < delays.length && deps.schedule) {
        deps.schedule(() => void attempt(n + 1), delays[n]!);
      }
    };
    try {
      await attempt(0);
    } catch {
      // reporting must never throw
    }
  }

  async function pendingCount(): Promise<number> {
    return (await load()).length;
  }

  return { record, reportNow, flush, pendingCount };
}

/**
 * An error thrown by a timer or a native event callback that touches a native object (a video player) which was
 * already released, typically right after the screen closed. Nothing is wrong with the app: it is recorded and
 * NOT passed to React Native's fatal handler (which would abort the app).
 */
export function isReleasedNativeObjectError(error: unknown): boolean {
  const e = error as { message?: unknown; name?: unknown; code?: unknown } | null;
  const text = `${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    text.includes("nativesharedobjectnotfound") ||
    text.includes("native shared object") ||
    text.includes("shared object that was already released") ||
    text.includes("already released")
  );
}

/** How long the fatal handler waits for the report to be written before letting RN abort (ms). */
export const FATAL_WRITE_WAIT_MS = 800;

/**
 * Wrap a global error handler: a fatal error is recorded first (waiting briefly for the write), then the
 * previous handler runs exactly as before. A non-fatal one is recorded and passed on at once.
 */
export function wrapGlobalHandler(args: {
  previous: (error: unknown, isFatal?: boolean) => void;
  record: (error: unknown, extra: { kind: string; isFatal: boolean }) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}): (error: unknown, isFatal?: boolean) => void {
  return (error, isFatal) => {
    let written: Promise<void> = Promise.resolve();
    const benign = isReleasedNativeObjectError(error);
    try {
      written = args.record(error, { kind: benign ? "swallowed" : isFatal ? "fatal" : "error", isFatal: !!isFatal });
    } catch {
      // never let the recorder replace the real error
    }
    // A released video player touched after its screen closed: recorded, and the app carries on.
    if (benign) return;
    if (!isFatal) {
      args.previous(error, isFatal);
      return;
    }
    Promise.race([written, args.sleep(FATAL_WRITE_WAIT_MS)]).then(
      () => args.previous(error, isFatal),
      () => args.previous(error, isFatal),
    );
  };
}
