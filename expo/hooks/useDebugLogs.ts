import { useRef, useState, useCallback } from "react";

export interface LogEntry {
  ts: string;
  level: "log" | "warn" | "error";
  message: string;
}

const MAX_ENTRIES = 30;

// Module-level store survives React re-renders
const logStore: LogEntry[] = [];
let listeners: Array<() => void> = [];
let patched = false;

function notifyListeners() {
  listeners.forEach((fn) => fn());
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a, null, 0);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

function addEntry(level: LogEntry["level"], args: unknown[]) {
  const now = new Date();
  const ts = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}.${now.getMilliseconds().toString().padStart(3, "0")}`;
  logStore.push({ ts, level, message: formatArgs(args) });
  if (logStore.length > MAX_ENTRIES) {
    logStore.splice(0, logStore.length - MAX_ENTRIES);
  }
  notifyListeners();
}

function patchConsole() {
  if (patched) return;
  patched = true;

  const orig = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  console.log = (...args: unknown[]) => {
    orig.log(...args);
    addEntry("log", args);
  };

  console.warn = (...args: unknown[]) => {
    orig.warn(...args);
    addEntry("warn", args);
  };

  console.error = (...args: unknown[]) => {
    orig.error(...args);
    addEntry("error", args);
  };
}

// Patch immediately at module load — before any component renders
patchConsole();

export function useDebugLogs() {
  const [, setTick] = useState(0);
  const listenerRef = useRef<(() => void) | null>(null);

  // Register a listener that bumps state to trigger re-render
  if (!listenerRef.current) {
    listenerRef.current = () => setTick((n) => n + 1);
    listeners.push(listenerRef.current);
  }

  const entries = logStore; // live reference — no stale closure

  const clear = useCallback(() => {
    logStore.length = 0;
    notifyListeners();
  }, []);

  return { entries, clear };
}
