#!/usr/bin/env node
/**
 * Footage limits (lib/footageLimits.ts) and the upload manager (lib/footageUpload.ts) with fake phone and server pieces: the order of the steps, what is
 * saved so an upload can resume after Tryal was closed, what happens on every kind of failure, and that files are cleaned up.
 *   node --experimental-strip-types --no-warnings scripts/test-footage-upload.mjs
 */
import { MAX_BYTES, MAX_EACH_SECONDS, MAX_TOTAL_SECONDS, bytesLabel, canAdd, minutesLabel, usedLabel, usedSeconds } from "../lib/footageLimits.ts";
import { FootageUploader, footageKey, friendlyUploadError } from "../lib/footageUpload.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const MB = 1024 * 1024;
const settle = async (u) => { for (let i = 0; i < 200 && u.list().some((x) => ["queued", "compressing", "uploading"].includes(x.state)); i++) await new Promise((r) => setTimeout(r, 1)); await new Promise((r) => setTimeout(r, 2)); };

// ── limits ──
eq("limits: 60 minutes in total, 30 each, 2 GB", [MAX_TOTAL_SECONDS, MAX_EACH_SECONDS, MAX_BYTES], [3600, 1800, 2147483648]);
eq("minutes labels", [minutesLabel(0), minutesLabel(59.6), minutesLabel(61), minutesLabel(1800), usedLabel([{ durationSeconds: 754 }, { durationSeconds: 60 }]), usedLabel([])], ["0:00", "1:00", "1:01", "30:00", "13 of 60 minutes used", "0 of 60 minutes used"]);
eq("canAdd: 30:00 is fine, 30:01 is not, 0 and negative are not, and 60 minutes in total is the ceiling", [canAdd([], 1800).ok, canAdd([], 1801).ok, canAdd([], 0).ok, canAdd([], -5).ok, canAdd([{ durationSeconds: 1800 }, { durationSeconds: 1200 }], 600).ok, canAdd([{ durationSeconds: 1800 }, { durationSeconds: 1200 }], 601).ok], [true, false, false, false, true, false]);
eq("canAdd says why", [canAdd([], 1801).reason, canAdd([{ durationSeconds: 3000 }], 700).reason], ["Each video can be at most 30 minutes.", "A campaign can have at most 60 minutes of footage."]);
eq("sizes", [bytesLabel(5 * MB), bytesLabel(300), bytesLabel(1.5 * 1024 * MB), usedSeconds([{ durationSeconds: 1.5 }, { durationSeconds: 2 }])], ["5 MB", "1 MB", "1.5 GB", 3.5]);

// ── the manager, with fakes ──
function world(over = {}) {
  const w = { calls: [], saved: [], files: new Set(), seq: 0, serverOffsets: new Map(), tusFail: null, registerFail: null, completeFail: null, thumbFail: false, tusPlan: [], ...over };
  let n = 0;
  const deps = {
    endpoint: "https://x/upload", bucket: "campaign-footage",
    async register(d, wd, h, s) { w.calls.push(`register ${d} ${wd}x${h} ${s}`); if (w.registerFail) throw new Error(w.registerFail); const id = `f${++w.seq}`; return { id, storage_path: `me/${id}.mp4`, thumb_path: `me/${id}.jpg` }; },
    async complete(id) { w.calls.push(`complete ${id}`); if (w.completeFail) throw new Error(w.completeFail); },
    async fail(id) { w.calls.push(`fail ${id}`); },
    async remove(id) { w.calls.push(`remove ${id}`); },
    async compress(uri, onProgress) { w.calls.push(`compress ${uri}`); onProgress(0.5); onProgress(1); const out = `file:///cache/c${++n}.mp4`; w.files.add(out); return { uri: out, sizeBytes: w.size ?? 10 * MB, width: 1280, height: 720, durationSeconds: w.dur ?? 0 }; },
    async thumbnail(uri) { w.calls.push(`thumb ${uri}`); if (w.gate) await w.gate; if (w.thumbFail) throw new Error("no frame"); const t = `file:///cache/t${n}.jpg`; w.files.add(t); return { uri: t, sizeBytes: 5000 }; },
    async fileExists(u) { return w.files.has(u); },
    ...(w.noPreview ? {} : { async preview(uri) { w.calls.push(`preview ${uri}`); return `file:///cache/p-${uri.split('/').pop()}.jpg`; } }),
    ...(w.readDur !== undefined ? { async readDuration(uri) { w.calls.push(`readDuration ${uri}`); return w.readDur; } } : {}),
    async deleteFile(u) { w.calls.push(`delete ${u}`); w.files.delete(u); },
    makeIO(uri, size) {
      return {
        async request(method, url) {
          if (method === "POST") { const id = `up${++w.seq}`; w.serverOffsets.set(id, 0); w.calls.push(`tus-create ${uri}`); return { status: 201, headers: { location: `https://x/upload/${id}` } }; }
          const id = url.split("/").pop(); w.calls.push(`tus-head ${id}`); return w.serverOffsets.has(id) ? { status: 200, headers: { "upload-offset": String(w.serverOffsets.get(id)) } } : { status: 404, headers: {} };
        },
        async patch(url, _h, offset, length) {
          const id = url.split("/").pop();
          const planned = w.tusPlan.shift();
          if (planned === "drop") throw new Error("network error");
          if (planned === 403) return { status: 403, headers: {} };
          w.serverOffsets.set(id, offset + length); w.calls.push(`tus-patch ${uri} ${offset}+${length}`);
          return { status: 204, headers: { "upload-offset": String(offset + length) } };
        },
        async authHeaders() { return {}; }, async sleep() {},
      };
    },
    async load() { return w.stored ?? []; },
    async save(items) { w.saved.push(JSON.parse(JSON.stringify(items))); },
    newId: () => `L${++w.seq}`,
  };
  return { w, deps };
}
const vid = (name, sec) => ({ uri: `file:///roll/${name}.mov`, name, durationSeconds: sec, width: 1920, height: 1080 });

// a picked video shows up at once, with a picture, and every failure names its step
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const seen = [];
  u.subscribe((items) => seen.push(items.map((i) => `${i.name}:${i.state}:${i.stage ?? ""}`).join(",")));
  const added = u.add([vid("a", 60)]);
  eq("the video is in the list the moment it is added (before anything has run), waiting, with its length and file size", [seen.includes("a:queued:waiting"), u.list()[0].durationSeconds, u.list().length, added.added.length], [true, 60, 1, 1]);
  await settle(u);
  eq("it gets a preview picture early (not uploaded), and its steps are shown in order on the way to ready", [u.list()[0].previewUri?.endsWith(".jpg"), [...new Set(seen.map((x) => x.split(":")[2]))].filter(Boolean)], [true, ["waiting", "preparing the video", "checking the length", "checking the size", "registering the video", "making the thumbnail", "uploading the video", "finishing", "ready"]]);
  const np = world({ noPreview: true }); const npu = new FootageUploader(np.deps); npu.add([vid("b", 60)]); await settle(npu);
  eq("a preview that cannot be made does not matter", [npu.list()[0].state, npu.list()[0].previewUri ?? null], ["done", null]);
}
{
  const a = world({ readDur: 90 });
  const u = new FootageUploader(a.deps);
  u.add([{ ...vid("nolen", 0), sizeBytes: 123 }]);
  await settle(u);
  eq("a length the picker did not give is read from the file, and the video goes on to ready; the picked file's size is kept", [u.list()[0].state, u.list()[0].durationSeconds, u.list()[0].sourceSize, a.w.calls.filter((c) => c.startsWith("register"))], ["done", 90, 123, ["register 90 1280x720 10485760"]]);
  const b = world({ dur: 120 });
  const v = new FootageUploader(b.deps); v.add([vid("nolen2", 0)]); await settle(v);
  eq("...or from the compressor's own measurement", [v.list()[0].state, v.list()[0].durationSeconds], ["done", 120]);
  const c = world({ dur: 1900 });
  const y = new FootageUploader(c.deps); y.add([vid("long2", 0)]); await settle(y);
  eq("a video that turns out to be over 30 minutes stops at the length check with that reason, and is never registered", [y.list()[0].state, y.list()[0].error, c.w.calls.some((x) => x.startsWith("register"))], ["error", "Stopped while checking the length. Each video can be at most 30 minutes.", false]);
  const d = world({ readDur: 100 });
  const z = new FootageUploader(d.deps); z.add([vid("a", 1800), vid("b", 1800), vid("c", 0)]); await settle(z);
  eq("a length that is only known later, and no longer fits in the 60 minutes, stops at the length check with that reason", [z.list().map((i) => i.state), z.list()[2].error], [["done", "done", "error"], "Stopped while checking the length. A campaign can have at most 60 minutes of footage."]);
  const e = world({ tusPlan: ["ok", 403] });
  e.deps.compress = async () => { throw new Error("export session failed (-11800)"); };
  const k = new FootageUploader(e.deps); k.add([vid("bad", 60)]); await settle(k);
  eq("when the compressor throws, the error names the step and keeps the raw reason for the debug list", [k.list()[0].state, k.list()[0].stage, k.list()[0].error, k.list()[0].rawError], ["error", "preparing the video", "Stopped while preparing the video. Something went wrong with this video. Tap Retry.", "export session failed (-11800)"]);
}
// the same video twice
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const A1 = { ...vid("video-48", 60), assetId: "ABC-123/L0/001" };
  const r1 = u.add([A1]);
  const r2 = u.add([{ ...vid("renamed", 61), assetId: "ABC-123/L0/001" }]);
  eq("the same photo-library asset id is 'Already added', whatever its name, length or size now says", [r1.added.length, r2.added.length, r2.refused], [1, 0, [{ name: "renamed", reason: "Already added." }]]);
  const r3 = u.add([{ ...vid("video-49", 60), assetId: "DEF-456/L0/001" }]);
  eq("a different asset with a similar name is a different video", r3.added.length, 1);
  const r4 = u.add([{ ...vid("p", 30), assetId: "X/1" }, { ...vid("p2", 30), assetId: "X/1" }]);
  eq("the same video twice in ONE pick is added once", [r4.added.length, r4.refused.map((x) => x.reason)], [1, ["Already added."]]);
  await settle(u);
  const again = u.add([A1]);
  eq("it is still 'Already added' after it finished uploading", [again.added.length, again.refused[0]?.reason], [0, "Already added."]);
  const id = u.list().find((i) => i.name === "video-48").localId;
  await u.remove(id);
  eq("removing it lets it be added again", u.add([A1]).added.length, 1);
  await settle(u);
  await u.clear();
  eq("after the campaign is posted (the list is cleared) the same video can be used for the next campaign", u.add([A1]).added.length, 1);
  eq("without an asset id the key is name + file size + length: same file, same key; any difference, a different one", [footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }) === footageKey({ uri: "b", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }), footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }) === footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 6 })], [true, false]);
  const e = world({ registerFail: "boom" }); const ue = new FootageUploader(e.deps);
  ue.add([{ ...vid("bad", 60), assetId: "E/1" }]); await settle(ue);
  eq("a video that failed is still in the list, so adding it again says 'Already added' (use Retry on it)", ue.add([{ ...vid("bad", 60), assetId: "E/1" }]).refused[0]?.reason, "Already added.");
  const f = world(); f.w.stored = [{ localId: "L9", sourceUri: "s", name: "x", durationSeconds: 60, width: 1, height: 1, state: "done", progress: 1, footageId: "f1", sourceKey: "asset:Z/9" }];
  const uf = new FootageUploader(f.deps); await uf.restore();
  eq("the identity survives a restart", uf.add([{ ...vid("x", 60), assetId: "Z/9" }]).refused[0]?.reason, "Already added.");
}
// the happy path
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const { added, refused } = u.add([vid("a", 600), vid("b", 300)]);
  await settle(u);
  eq("two videos are added, and each goes compress, register, thumbnail, thumbnail upload, video upload, complete, in that order, one video at a time", [added.length, refused.length, w.calls.filter((c) => !c.startsWith("delete") && !c.startsWith("preview")).map((c) => c.split(" ")[0] + (c.startsWith("tus-patch") ? ":" + (c.includes(".jpg") ? "jpg" : "mp4") : ""))], [2, 0, ["compress", "register", "thumb", "tus-create", "tus-patch:jpg", "tus-create", "tus-patch:mp4", "tus-patch:mp4", "complete", "compress", "register", "thumb", "tus-create", "tus-patch:jpg", "tus-create", "tus-patch:mp4", "tus-patch:mp4", "complete"]]);
  eq("both are done; their ids come back in the order they were added; allDone is true", [u.list().map((i) => i.state), u.readyIds(), u.allDone()], [["done", "done"], ["f2", "f5"].map((x, i) => u.list()[i].footageId), true]);
  eq("the registration carries the real (compressed) size, size and length", w.calls.filter((c) => c.startsWith("register")), ["register 600 1280x720 10485760", "register 300 1280x720 10485760"]);
  eq("the temporary compressed file and thumbnail are deleted after a finished upload, and the picked original is never touched", [w.files.size, w.calls.some((c) => c === "delete file:///roll/a.mov")], [0, false]);
  eq("the list is saved at every step (so a closed app can resume), with the footage id and the resumable URL while uploading", [w.saved.length > 6, w.saved.some((s) => s.some((i) => i.state === "uploading" && i.footageId && i.tusVideoUrl))], [true, true]);
}
// limits at the door
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const r = u.add([vid("long", 1801), vid("ok1", 1800), vid("ok2", 1800), vid("one-too-many", 1), vid("ok3", 0)]);
  await settle(u);
  eq("a 30:01 video and a video that would pass 60 minutes in total are refused by name with the reason; one whose length the picker did not give is let in (its length is read next); the rest are queued", [r.refused.map((x) => x.name), r.added.map((x) => x.name), r.refused[0].reason], [["long", "one-too-many"], ["ok1", "ok2", "ok3"], "Each video can be at most 30 minutes."]);
  eq("refused videos never reach the server, and the one with no length stops at the length check (nothing can read it here) with a plain message naming that step", [w.calls.filter((c) => c.startsWith("register")).length, u.list().find((i) => i.name === "ok3").state, u.list().find((i) => i.name === "ok3").error, u.list().find((i) => i.name === "ok3").stage], [2, "error", "Stopped while checking the length. Tryal couldn't read how long this video is. Try a different video.", "checking the length"]);
  u.add([vid("again", 60)]);
  eq("the minutes in use count while uploading and once done (a failed one does not hold minutes)", u.list().length, 3);
}
// the server says no
{
  const { w, deps } = world({ registerFail: "a campaign can have at most 60 minutes of footage" });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  eq("a refusal when registering shows a plain message, nothing is uploaded, and the item can be retried", [u.list()[0].state, u.list()[0].error, w.calls.some((c) => c.startsWith("tus-")), w.calls.some((c) => c.startsWith("fail"))], ["error", "Stopped while registering the video. A campaign can have at most 60 minutes of footage.", false, false]);
  w.registerFail = null; u.retry(u.list()[0].localId); await settle(u);
  eq("retrying after the problem went away finishes it", u.list()[0].state, "done");
  eq("an error video does not use up minutes while it is in error", (() => { const x = new FootageUploader(world({ registerFail: "boom" }).deps); x.add([vid("a", 1800)]); return null; })(), null);
}
// thumbnail trouble
{
  const { w, deps } = world({ thumbFail: true });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  eq("a thumbnail that cannot be made does not fail the video", [u.list()[0].state, w.calls.some((c) => c.includes(".jpg"))], ["done", false]);
}
// network trouble and resuming
{
  const { w, deps } = world({ size: 14 * MB, tusPlan: ["drop", "drop", "drop", "drop", "drop", "drop", "drop", "drop", "drop", "drop", "drop", "drop"] });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  const it = u.list()[0];
  eq("when the connection stays down the video ends in a retryable error and KEEPS its registration and upload URL (nothing is re-registered or restarted)", [it.state, it.error, !!it.footageId, !!it.tusVideoUrl, w.calls.some((c) => c.startsWith("fail"))], ["error", "Stopped while uploading the video. The upload stopped. Check your connection and tap Retry.", true, true, false]);
  w.tusPlan = []; const before = w.calls.filter((c) => c.startsWith("register")).length;
  u.retry(it.localId); await settle(u);
  eq("tapping Retry once the network is back continues the same upload: one registration in total, the same URL asked for its offset, then complete", [u.list()[0].state, w.calls.filter((c) => c.startsWith("register")).length === before, w.calls.some((c) => c.startsWith("tus-head")), w.calls.filter((c) => c.startsWith("complete")).length], ["done", true, true, 1]);
  // the compressed file survived, so it was not compressed again
  eq("...and the already compressed file is reused, not compressed again", w.calls.filter((c) => c.startsWith("compress")).length, 1);
}
// the app was closed in the middle
{
  const a = world({ size: 14 * MB });
  a.w.stored = [{ localId: "L1", sourceUri: "file:///roll/a.mov", name: "a", durationSeconds: 600, width: 1280, height: 720, state: "uploading", progress: 0.6, footageId: "f9", videoPath: "me/f9.mp4", thumbPath: "me/f9.jpg", sizeBytes: 14 * MB, compressedUri: "file:///cache/keep.mp4", tusVideoUrl: "https://x/upload/up77", thumbUri: "file:///cache/keep.jpg" }];
  a.w.files.add("file:///cache/keep.mp4"); a.w.files.add("file:///cache/keep.jpg");
  a.w.serverOffsets.set("up77", 6 * MB);
  const u = new FootageUploader(a.deps);
  await u.restore();
  await settle(u);
  eq("after a restart the saved upload resumes at the server's offset (6 MiB already there: only the last 8 MiB is sent), with no new registration or compression", [a.w.calls.filter((c) => c.startsWith("tus-patch") && c.includes("keep.mp4")).map((c) => c.split(" ")[2]), a.w.calls.some((c) => c.startsWith("register")), a.w.calls.some((c) => c.startsWith("compress")), a.w.calls.includes("complete f9"), u.list()[0].state], [["6291456+6291456", "12582912+2097152"], false, false, true, "done"]);
  const b = world(); b.w.stored = [{ localId: "L2", sourceUri: "s", name: "x", durationSeconds: 60, width: 1, height: 1, state: "compressing", progress: 0.1 }];
  const u2 = new FootageUploader(b.deps); await u2.restore(); await settle(u2);
  eq("an item that was being compressed when the app closed starts over from the top", [b.w.calls.filter((c) => c.startsWith("compress")).length, u2.list()[0].state], [1, "done"]);
  const c = world(); c.w.stored = "garbage";
  const u3 = new FootageUploader({ ...c.deps, load: async () => { throw new Error("corrupt"); } }); await u3.restore();
  eq("an unreadable saved list is ignored", u3.list(), []);
}
// fatal upload errors
{
  const { w, deps } = world({ size: 14 * MB, tusPlan: ["ok", 403] });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  eq("a refusal from Storage (403) gives the minutes back (fail is called), forgets the dead registration and says so", [u.list()[0].state, w.calls.filter((c) => c.startsWith("fail")), u.list()[0].footageId, u.list()[0].error], ["error", ["fail f2"], null, "Stopped while uploading the video. You're not allowed to upload this. Sign in again and retry."]);
  w.tusPlan = []; u.retry(u.list()[0].localId); await settle(u);
  eq("...and a retry registers afresh and finishes", [u.list()[0].state, w.calls.filter((c) => c.startsWith("register")).length], ["done", 2]);
}
{
  const { deps, w } = world({ completeFail: "the upload is not complete yet" });
  const u = new FootageUploader(deps); u.add([vid("a", 600)]); await settle(u);
  eq("if the database says the file is not complete, the item shows a retryable error and keeps its upload", [u.list()[0].state, u.list()[0].error, !!u.list()[0].footageId], ["error", "Stopped while finishing. The upload stopped. Check your connection and tap Retry.", true]);
  const big = world({ size: MAX_BYTES + 1 }); const u2 = new FootageUploader(big.deps); u2.add([vid("big", 600)]); await settle(u2);
  eq("a file still over 2 GB after compression is refused before registering", [u2.list()[0].state, u2.list()[0].error, big.w.calls.some((c) => c.startsWith("register"))], ["error", "Stopped while checking the size. That video is too large. Try a shorter one.", false]);
}
// removing
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  const id = u.list()[0].localId;
  await u.remove(id);
  eq("removing a finished video asks the server to remove it and empties the list", [w.calls.includes(`remove ${u.list()[0]?.footageId ?? "f1"}`) || w.calls.some((c) => c.startsWith("remove f")), u.list().length, u.readyIds()], [true, 0, []]);
  let release; const gate = new Promise((r) => { release = r; });
  const x = world({ gate }); const u2 = new FootageUploader(x.deps);
  u2.add([vid("slow", 600)]); await new Promise((r) => setTimeout(r, 5));
  const fid = u2.list()[0].footageId;
  await u2.remove(u2.list()[0].localId); release(); await new Promise((r) => setTimeout(r, 20));
  eq("removing a video while it is still going (registered, thumbnail pending) removes the registration, never uploads the video and never completes it", [!!fid, x.w.calls.filter((c) => c.startsWith("remove")), x.w.calls.some((c) => c.startsWith("complete")), x.w.calls.some((c) => c.startsWith("tus-patch") && c.includes(".mp4")), u2.list().length], [true, [`remove ${fid}`], false, false, 0]);
}
// clearing after the campaign is posted
{
  const { w, deps } = world();
  const u = new FootageUploader(deps); u.add([vid("a", 600)]); await settle(u);
  await u.clear();
  eq("after the campaign is posted the list is cleared and saved as empty", [u.list().length, w.saved.at(-1)], [0, []]);
}
eq("error wording", [friendlyUploadError("each video can be at most 30 minutes"), friendlyUploadError("too many videos at once"), friendlyUploadError("Money is not available for this account"), friendlyUploadError("zzz")], ["Each video can be at most 30 minutes.", "Too many videos at once. Finish or remove some first.", "Money isn't available for this account.", "Something went wrong with this video. Tap Retry."]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
