#!/usr/bin/env node
/**
 * A saved draft plays in the editor. Opening a draft with cuts arms the second (gapless) player at once, which re-ran
 * the player effects while the first load was still checking the file: the load was cancelled but remembered as done,
 * so the editor stayed black (posting still worked: it reads the file, not the player).
 *   node scripts/test-draft-playback.mjs
 */
import { readFileSync } from "node:fs";

let failed = 0;
const ok = (n, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${n}`); };
const edit = readFileSync(new URL("../app/edit.tsx", import.meta.url), "utf8");

// a tiny model of the effect: run, re-run before the async part finishes, then let it finish
function simulate(withFix) {
  const ref = { current: null };
  let loaded = null;
  const effect = (uri) => {
    if (ref.current === uri) return () => {};
    ref.current = uri;
    let cancelled = false, applied = false;
    const finish = () => { if (cancelled) return; applied = true; loaded = uri; };
    effect.pending.push(finish);
    return () => { cancelled = true; if (withFix && !applied && ref.current === uri) ref.current = "\u0000pending"; };
  };
  effect.pending = [];
  const cleanup1 = effect("draft.mov");
  cleanup1();                       // deps changed (preload armed) before the file check finished
  effect("draft.mov");              // re-run with the same video
  for (const f of effect.pending) f();
  return loaded;
}
ok("model: without the fix the player never gets the video (the bug)", simulate(false) === null);
ok("model: with the fix the re-run loads it", simulate(true) === "draft.mov");

for (const slot of ["A", "B"]) {
  ok(`player ${slot}: a dropped load is forgotten so the re-run loads it`,
    new RegExp(`if \\(!applied && loaded${slot}UriRef\\.current === targetUri\\) loaded${slot}UriRef\\.current = PLAYER_LOAD_PENDING;`).test(edit));
  ok(`player ${slot}: marked applied only when replace() really runs`,
    new RegExp(`if \\(cancelled\\) return;\\s*applied = true;\\s*player${slot}\\.replace\\(`).test(edit));
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
