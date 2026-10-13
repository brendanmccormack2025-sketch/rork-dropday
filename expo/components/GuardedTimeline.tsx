import React, { useCallback, useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";

import PrecisionTimeline, { type PrecisionTimelineProps } from "@/components/PrecisionTimeline";
import { recordBreadcrumb, recordClientError } from "@/lib/clientErrors";
import { armGuard, disableGuard, disarmGuard, readGuard, type GuardStorage } from "@/lib/autoEdit/precisionGuard";

const storage: GuardStorage = {
  get: (k) => AsyncStorage.getItem(k),
  set: (k, v) => AsyncStorage.setItem(k, v),
};

/** The running build: native version + build + the over-the-air update id. A fix shipped as an update gets a new try. */
function buildKey(): string {
  let update = "embedded";
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Updates = require("expo-updates") as { updateId?: string | null };
    update = Updates.updateId ?? "embedded";
  } catch {
    update = "embedded";
  }
  let native = "";
  try {
    native = `${Constants.nativeAppVersion ?? Constants.expoConfig?.version ?? ""}+${Constants.nativeBuildVersion ?? ""}`;
  } catch {
    native = "";
  }
  return `${native}:${update}`;
}

/** The last decision this session, so reopening the Cuts screen does not flash the other timeline. */
let decided: "on" | "off" | null = null;

class Boundary extends React.Component<{ onError: (error: unknown, where: string) => void; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onError(error, "render");
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The precision timeline with a way out: if it throws (while rendering, in a handler, in a worklet), or the app died
 * with it showing last time, the previous timeline (`fallback`) is shown instead. Until the stored marker has been read
 * the fallback is shown too, so a build that crashes on this screen never gets as far as mounting the new timeline.
 */
export default function GuardedTimeline({ fallback, onActive, ...props }: PrecisionTimelineProps & { fallback: React.ReactNode; /** Whether the precision timeline (and its own Split / Delete toolbar) is the one on screen. */ onActive?: (active: boolean) => void }) {
  const [status, setStatus] = useState<"checking" | "on" | "off">(decided ?? "checking");
  const key = useRef(buildKey()).current;
  const failedOnce = useRef(false);

  useEffect(() => {
    let cancelled = false;
    readGuard(storage, key)
      .then((r) => {
        if (decided !== "off") decided = r.enabled ? "on" : "off";
        if (!cancelled) setStatus(decided ?? "on");
      })
      .catch(() => {
        if (!cancelled) setStatus(decided ?? "on");
      });
    return () => {
      cancelled = true;
    };
  }, [key]);

  useEffect(() => {
    onActive?.(status === "on");
    return () => onActive?.(false);
  }, [status, onActive]);

  // armed while the timeline is on screen and the app is in the foreground
  useEffect(() => {
    if (status !== "on") return;
    recordBreadcrumb("precision timeline: guard on, mounting");
    void armGuard(storage, key, Date.now());
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void armGuard(storage, key, Date.now());
      else void disarmGuard(storage, key);
    });
    return () => {
      sub.remove();
      void disarmGuard(storage, key);
    };
  }, [status, key]);

  const fail = useCallback(
    (error: unknown, where: string) => {
      if (failedOnce.current) return;
      failedOnce.current = true;
      decided = "off";
      const message = (error as Error)?.message ?? String(error);
      void disableGuard(storage, key, `${where}: ${message}`);
      void recordClientError(error instanceof Error ? error : new Error(String(error)), { kind: "precisionTimeline", where });
      setStatus("off");
    },
    [key],
  );

  if (status !== "on") return <>{fallback}</>;
  return (
    <Boundary onError={fail}>
      <PrecisionTimeline {...props} onFatal={fail} onBreadcrumb={recordBreadcrumb} />
    </Boundary>
  );
}
