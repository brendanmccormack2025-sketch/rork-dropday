import { useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

const KEY = "dropday:playbackDiagnostics";

let value = false;
let loaded: Promise<void> | null = null;
const listeners = new Set<(on: boolean) => void>();

function load(): Promise<void> {
  if (!loaded) {
    loaded = AsyncStorage.getItem(KEY)
      .then((v) => {
        value = v === "1";
      })
      .catch(() => {});
  }
  return loaded;
}

/** "Playback diagnostics" switch (internal accounts only); off unless turned on. */
export async function getPlaybackDiagnostics(): Promise<boolean> {
  await load();
  return value;
}

export function setPlaybackDiagnostics(on: boolean): void {
  value = on;
  loaded = Promise.resolve();
  AsyncStorage.setItem(KEY, on ? "1" : "0").catch(() => {});
  listeners.forEach((l) => l(on));
}

export function usePlaybackDiagnostics(): boolean {
  const [on, setOn] = useState<boolean>(value);
  useEffect(() => {
    let cancelled = false;
    load().then(() => {
      if (!cancelled) setOn(value);
    });
    listeners.add(setOn);
    return () => {
      cancelled = true;
      listeners.delete(setOn);
    };
  }, []);
  return on;
}
