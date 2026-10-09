/** The expo-video side of lib/playerReset.ts. */
import type { VideoPlayer } from "expo-video";

import type { ResettablePlayer } from "@/lib/playerReset";

export function adaptPlayer(p: VideoPlayer): ResettablePlayer {
  return {
    pause: () => p.pause(),
    replace: (uri) => p.replace({ uri }),
    nextReady: (timeoutMs) => {
      let sub: { remove(): void } | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let done: (v: boolean) => void = () => {};
      const promise = new Promise<boolean>((resolve) => {
        done = (v) => {
          if (timer) clearTimeout(timer);
          sub?.remove();
          resolve(v);
        };
        timer = setTimeout(() => done(false), timeoutMs);
        sub = p.addListener("statusChange", ({ status }) => {
          if (status === "readyToPlay") done(true);
          else if (status === "error") done(false);
        });
      });
      return { promise, cancel: () => done(false) };
    },
    seekMs: (ms) => {
      p.currentTime = ms / 1000;
    },
  };
}
