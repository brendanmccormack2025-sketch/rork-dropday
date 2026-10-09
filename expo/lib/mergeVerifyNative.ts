/** The plain player for lib/mergeVerify.ts: a detached expo-video player, not shown anywhere. */
import { createVideoPlayer } from "expo-video";

import type { VerifyPlayer } from "@/lib/mergeVerify";

const READY_TIMEOUT_MS = 8000;

export function createVerifyPlayer(uri: string): VerifyPlayer {
  const player = createVideoPlayer({ uri });
  player.muted = true;
  return {
    ready: () =>
      new Promise<boolean>((resolve) => {
        if (player.status === "readyToPlay") return resolve(true);
        const timer = setTimeout(() => {
          sub.remove();
          resolve(false);
        }, READY_TIMEOUT_MS);
        const sub = player.addListener("statusChange", ({ status }) => {
          if (status === "readyToPlay" || status === "error") {
            clearTimeout(timer);
            sub.remove();
            resolve(status === "readyToPlay");
          }
        });
      }),
    seekMs: (ms) => {
      player.currentTime = ms / 1000;
    },
    play: () => player.play(),
    pause: () => player.pause(),
    positionMs: () => (player.currentTime || 0) * 1000,
    durationMs: () => (player.duration || 0) * 1000,
    release: () => player.release(),
  };
}
