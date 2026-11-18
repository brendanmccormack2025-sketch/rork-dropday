#!/usr/bin/env node
/**
 * Footage limits (lib/footageLimits.ts) and the SEGMENTED upload manager (lib/footageUpload.ts) with fake phone and server pieces: the plan from the
 * database, cutting segment N+1 while N uploads, a video becoming usable after its first segment, what is saved so an upload resumes after Tryal was
 * closed, every kind of failure naming its step, duplicates, and cleanup.
 *   node --experimental-strip-types --no-warnings scripts/test-footage-upload.mjs
 */
import { MAX_BYTES, MAX_EACH_SECONDS, MAX_TOTAL_SECONDS, bytesLabel, canAdd, minutesLabel, usedLabel, usedSeconds } from "../lib/footageLimits.ts";
import { FootageUploader, footageKey, friendlyUploadError, isPostable } from "../lib/footageUpload.ts";
import { estimateRemainingSeconds } from "../lib/footageSegments.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const busy = (u) => u.list().some((x) => ["queued", "compressing", "uploading"].includes(x.state));
const settle = async (u) => { for (let i = 0; i < 400 && busy(u); i++) await sleep(1); await sleep(3); };
const until = async (cond) => { for (let i = 0; i < 400 && !cond(); i++) await sleep(1); };

// ── limits ──
eq("limits: 60 minutes in total, 30 each, 2 GB", [MAX_TOTAL_SECONDS, MAX_EACH_SECONDS, MAX_BYTES], [3600, 1800, 2147483648]);
eq("minutes labels", [minutesLabel(0), minutesLabel(59.6), minutesLabel(61), minutesLabel(1800), usedLabel([{ durationSeconds: 754 }, { durationSeconds: 60 }]), usedLabel([])], ["0:00", "1:00", "1:01", "30:00", "13 of 60 minutes used", "0 of 60 minutes used"]);
eq("canAdd: 30:00 is fine, 30:01 is not, 0 and negative are not, and 60 minutes in total is the ceiling", [canAdd([], 1800).ok, canAdd([], 1801).ok, canAdd([], 0).ok, canAdd([], -5).ok, canAdd([{ durationSeconds: 1800 }, { durationSeconds: 1200 }], 600).ok, canAdd([{ durationSeconds: 1800 }, { durationSeconds: 1200 }], 601).ok], [true, false, false, false, true, false]);
eq("canAdd says why", [canAdd([], 1801).reason, canAdd([{ durationSeconds: 3000 }], 700).reason], ["Each video can be at most 30 minutes.", "A campaign can have at most 60 minutes of footage."]);
eq("sizes", [bytesLabel(5 * MB), bytesLabel(300), bytesLabel(1.5 * 1024 * MB), usedSeconds([{ durationSeconds: 1.5 }, { durationSeconds: 2 }])], ["5 MB", "1 MB", "1.5 GB", 3.5]);

// ── the manager, with fakes ──
function world(over = {}) {
  const w = { calls: [], saved: [], files: new Set(), seq: 0, serverOffsets: new Map(), tusPlan: [], segSeconds: 60, t: 0, cutMs: 20_000, upMs: 10_000, segSize: 10 * MB, ...over };
  let n = 0;
  const deps = {
    endpoint: "https://x/upload", bucket: "campaign-footage",
    now: () => w.t,
    async registerSegmented(d, wd, h) {
      w.calls.push(`register ${d} ${wd}x${h}`);
      if (w.registerFail) throw new Error(w.registerFail);
      const id = `f${++w.seq}`; const count = Math.ceil(d / w.segSeconds);
      return { id, thumb_path: `me/${id}.jpg`, segment_seconds: w.segSeconds, segments: [...Array(count).keys()].map((i) => ({ idx: i, start_s: i * w.segSeconds, end_s: Math.min((i + 1) * w.segSeconds, d), path: `me/${id}/seg-${String(i).padStart(3, "0")}.mp4` })) };
    },
    async completeSegment(id, idx, size) { w.calls.push(`complete ${id}#${idx} ${size}`); if (w.completeFail) throw new Error(w.completeFail); return "partial"; },
    async remove(id) { w.calls.push(`remove ${id}`); },
    async cutSegment(uri, s, e) {
      w.calls.push(`cut ${s}-${e}`);
      if (w.cutFail) throw new Error(w.cutFail);
      await sleep(0);
      w.t += w.cutMs;
      const out = `file:///cache/seg-${++n}.mp4`; w.files.add(out);
      return { uri: out, sizeBytes: w.segSize };
    },
    async thumbnail(uri) { w.calls.push(`thumb ${uri}`); if (w.thumbFail) throw new Error("no frame"); const t = `file:///cache/t${n}.jpg`; w.files.add(t); return { uri: t, sizeBytes: 5000 }; },
    ...(w.noPreview ? {} : { async preview(uri) { w.calls.push(`preview ${uri}`); return `file:///cache/p-${uri.split("/").pop()}.jpg`; } }),
    ...(w.readDur !== undefined ? { async readDuration(uri) { w.calls.push(`readDuration ${uri}`); return w.readDur; } } : {}),
    ...(w.free !== undefined ? { async freeBytes() { return w.free; } } : {}),
    ...(w.dims ? { async dimensions() { return w.dims; } } : {}),
    async fileExists(u) { return w.files.has(u); },
    async deleteFile(u) { w.calls.push(`delete ${u}`); w.files.delete(u); },
    makeIO(uri, size) {
      return {
        async request(method, url) {
          if (method === "POST") { const id = `up${++w.seq}`; w.serverOffsets.set(id, 0); w.calls.push(`tus-create ${uri}`); return { status: 201, headers: { location: `https://x/upload/${id}` } }; }
          const id = url.split("/").pop(); w.calls.push(`tus-head ${id}`); return w.serverOffsets.has(id) ? { status: 200, headers: { "upload-offset": String(w.serverOffsets.get(id)) } } : { status: 404, headers: {} };
        },
        async patch(url, _h, offset, length) {
          const id = url.split("/").pop();
          if (w.gate && uri === w.gateUri) await w.gate;
          if (w.gateAll && uri.includes("seg-")) await w.gateAll;
          const planned = w.tusPlan.shift();
          if (planned === "drop") throw new Error("network error");
          if (planned === 403) return { status: 403, headers: {} };
          w.t += w.upMs;
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
const vid = (name, sec, o = {}) => ({ uri: `file:///roll/${name}.mov`, name, durationSeconds: sec, width: 1920, height: 1080, assetId: `A-${name}`, ...o });
const kinds = (calls) => calls.filter((c) => !c.startsWith("delete") && !c.startsWith("preview")).map((c) => c.split(" ")[0] + (c.startsWith("tus-patch") ? (c.includes(".jpg") ? ":jpg" : c.includes("seg-") ? ":seg" : ":x") : ""));

// the happy path: 150 s = 3 segments
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const { added, refused } = u.add([vid("a", 150)]);
  await settle(u);
  const it = u.list()[0];
  eq("a 150 s video is registered ONCE (with its length and size) and the database's plan (3 one-minute segments) is followed in order", [added.length, refused.length, w.calls.filter((c) => c.startsWith("register")), w.calls.filter((c) => c.startsWith("cut")), w.calls.filter((c) => c.startsWith("complete")).map((c) => c.split(" ")[1])], [1, 0, ["register 150 1920x1080"], ["cut 0-60", "cut 60-120", "cut 120-150"], ["f2#0", "f2#1", "f2#2"]]);
  eq("it ends done: 3 of 3 segments ready, progress 1, the total size, nothing left on the phone", [it.state, it.segmentsReady, it.segmentCount, it.progress, it.sizeBytes, [...w.files].filter((f) => f.includes("seg-")).length], ["done", 3, 3, 1, 30 * MB, 0]);
  eq("the thumbnail is cut from the SOURCE (not a segment) and uploaded before the segments", [w.calls.find((c) => c.startsWith("thumb")), kinds(w.calls).indexOf("tus-patch:jpg") < kinds(w.calls).indexOf("tus-patch:seg")], ["thumb file:///roll/a.mov", true]);
  eq("the length of a segment is a multiple of the plan: each segment is created on its own upload", w.calls.filter((c) => c.startsWith("tus-create")).length, 4);
}
// compression and upload overlap
{
  let release; const gateAll = new Promise((r) => { release = r; });
  const { w, deps } = world({ gateAll });
  const u = new FootageUploader(deps);
  u.add([vid("a", 150)]);
  await until(() => w.calls.includes("cut 60-120"));
  // every segment upload is held: the second segment must already be cutting, and nothing has completed
  const cutNextWhileUploading = w.calls.includes("cut 0-60") && w.calls.includes("cut 60-120") && !w.calls.some((c) => c.startsWith("complete")) && !w.calls.includes("cut 120-150");
  release();
  await settle(u);
  eq("segment N+1 is being cut while segment N is still uploading (nothing has completed yet), but never two cuts ahead (one at a time)", cutNextWhileUploading, true);
  eq("...and everything still finishes", [u.list()[0].state, u.list()[0].segmentsReady], ["done", 3]);
}
// usable after the first segment, early posting
{
  let release; const gate = new Promise((r) => { release = r; });
  const { w, deps } = world({ gate });
  const u = new FootageUploader(deps);
  u.add([vid("a", 180)]);
  await until(() => w.calls.some((c) => c.startsWith("cut 60-120")));
  // block the SECOND segment's upload (the second cut file)
  const segFiles = () => [...w.files].filter((f) => f.includes("seg-"));
  await until(() => u.list()[0].segmentsReady === 1);
  w.gateUri = segFiles().find((f) => f !== undefined && u.list()[0].segments.find((s) => s.uri === f && s.idx === 1));
  const early = u.list()[0];
  eq("after the FIRST segment the video is postable while it is still uploading; the wizard may post (readyToPost), and it says which id", [isPostable(early), early.state, u.readyToPost(), u.postableIds()], [true, "uploading", true, [early.footageId]]);
  release();
  await settle(u);
  eq("a video with no segment yet is not postable, and a failed video does not block posting the others", (() => { const x = new FootageUploader(world().deps); x.add([vid("n", 600)]); return [x.readyToPost(), x.postableIds()]; })(), [false, []]);
}
// attach to a campaign while it keeps uploading
{
  let release; const gate = new Promise((r) => { release = r; });
  const { w, deps } = world({ gate });
  const u = new FootageUploader(deps);
  u.add([vid("a", 180), vid("b", 60)]);
  await until(() => u.list()[0].segmentsReady === 1);
  w.gateUri = [...w.files].find((f) => f.includes("seg-") && u.list()[0].segments.some((s) => s.uri === f && s.idx === 1));
  const first = u.list()[0].footageId;
  await u.attach([first], "camp1");
  eq("posting the campaign with a video that is still uploading: it stays in the list tagged with the campaign (the rest keeps uploading), the wizard's own list no longer shows it", [u.list().find((i) => i.footageId === first)?.campaignId, u.list().filter((i) => !i.campaignId).map((i) => i.name)], ["camp1", ["b"]]);
  release();
  await settle(u);
  eq("when it finishes, a video that belongs to a posted campaign leaves the list (nothing more to show)", [u.list().some((i) => i.footageId === first), u.list().find((i) => i.name === "b")?.state], [false, "done"]);
  const { deps: d2 } = world(); const v2 = new FootageUploader(d2); v2.add([vid("c", 60)]); await settle(v2);
  await v2.attach([v2.list()[0].footageId], "camp2");
  eq("a video that had already finished leaves the list when its campaign is posted", v2.list().length, 0);
  const cl = world(); const v3 = new FootageUploader(cl.deps); v3.add([vid("d", 60)]); await settle(v3); await v3.clear();
  eq("clear() (the wizard was left) drops the videos not in a campaign", v3.list().length, 0);
}
// limits at the door and a length that is only known later
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const r = u.add([vid("long", 1801), vid("ok1", 1800), vid("ok2", 1800), vid("one-too-many", 1), vid("ok3", 0)]);
  await settle(u);
  eq("a 30:01 video and one that would pass 60 minutes in total are refused by name with the reason; one with no length is let in (its length is read next)", [r.refused.map((x) => x.name), r.added.map((x) => x.name), r.refused[0].reason], [["long", "one-too-many"], ["ok1", "ok2", "ok3"], "Each video can be at most 30 minutes."]);
  const ok3 = u.list().find((i) => i.name === "ok3");
  eq("the one with no length stops at the length check (nothing can read it here) with a plain message naming that step; the others register", [ok3.state, ok3.error, ok3.stage, w.calls.filter((c) => c.startsWith("register")).length], ["error", "Stopped while checking the length. Tryal couldn't read how long this video is. Try a different video.", "checking the length", 2]);
}
{
  const a = world({ readDur: 90 });
  const u = new FootageUploader(a.deps);
  u.add([{ ...vid("nolen", 0), sizeBytes: 123 }]);
  await settle(u);
  eq("a length the picker did not give is read from the file, the video goes on to done, and the picked file's size is kept", [u.list()[0].state, u.list()[0].durationSeconds, u.list()[0].sourceSize, a.w.calls.filter((c) => c.startsWith("register")), u.list()[0].segmentCount], ["done", 90, 123, ["register 90 1920x1080"], 2]);
  const c = world({ readDur: 1900 });
  const y = new FootageUploader(c.deps); y.add([vid("long2", 0)]); await settle(y);
  eq("a video that turns out to be over 30 minutes stops at the length check with that reason, and is never registered", [y.list()[0].state, y.list()[0].error, c.w.calls.some((x) => x.startsWith("register"))], ["error", "Stopped while checking the length. Each video can be at most 30 minutes.", false]);
  const d = world({ readDur: 100 });
  const z = new FootageUploader(d.deps); z.add([vid("a", 1800), vid("b", 1800), vid("c", 0)]); await settle(z);
  eq("a length that is only known later and no longer fits in the 60 minutes stops at the length check", [z.list().map((i) => i.state), z.list()[2].error], [["done", "done", "error"], "Stopped while checking the length. A campaign can have at most 60 minutes of footage."]);
  const e = world({ dims: { width: 720, height: 1280 } }); const ue = new FootageUploader(e.deps); ue.add([{ ...vid("nodim", 60), width: 0, height: 0 }]); await settle(ue);
  eq("a video whose size in pixels the picker did not give is measured from the file before registering", e.w.calls.find((c) => c.startsWith("register")), "register 60 720x1280");
}
// free space
{
  const { w, deps } = world({ free: 100 * MB });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  eq("with too little free space the video stops BEFORE registering, with a message that says how much is needed", [u.list()[0].state, u.list()[0].stage, /Not enough free space on this phone/.test(u.list()[0].error), w.calls.some((c) => c.startsWith("register"))], ["error", "checking free space", true, false]);
  const ok = world({ free: 5 * 1024 * MB }); const v = new FootageUploader(ok.deps); v.add([vid("a", 60)]); await settle(v);
  eq("with room it goes on", v.list()[0].state, "done");
}
// the server says no
{
  const { w, deps } = world({ registerFail: "a campaign can have at most 60 minutes of footage" });
  const u = new FootageUploader(deps);
  u.add([vid("a", 600)]);
  await settle(u);
  eq("a refusal when registering shows a plain message naming the step, nothing is cut or uploaded, and the item can be retried", [u.list()[0].state, u.list()[0].error, w.calls.some((c) => c.startsWith("cut") || c.startsWith("tus-"))], ["error", "Stopped while registering the video. A campaign can have at most 60 minutes of footage.", false]);
  w.registerFail = null; u.retry(u.list()[0].localId); await settle(u);
  eq("retrying after the problem went away finishes it", [u.list()[0].state, u.list()[0].segmentsReady], ["done", 10]);
}
// thumbnail trouble
{
  const { w, deps } = world({ thumbFail: true });
  const u = new FootageUploader(deps);
  u.add([vid("a", 60)]);
  await settle(u);
  eq("a thumbnail that cannot be made does not fail the video", [u.list()[0].state, w.calls.some((c) => c.includes(".jpg"))], ["done", false]);
}
// network trouble and resuming
{
  const drops = Array(12).fill("drop");
  const { w, deps } = world({ segSize: 14 * MB, tusPlan: ["ok", ...drops] });   // the thumbnail goes through, then the connection stays down
  const u = new FootageUploader(deps);
  u.add([vid("a", 120)]);
  await settle(u);
  const it = u.list()[0];
  eq("when the connection stays down the video ends in a retryable error naming the part, and KEEPS its registration, its plan and the segment's upload URL", [it.state, it.error, !!it.footageId, it.segments.length, !!it.segments[0].tusUrl], ["error", "Stopped while uploading part 1 of 2. The upload stopped. Check your connection and tap Retry.", true, 2, true]);
  w.tusPlan = []; const regs = w.calls.filter((c) => c.startsWith("register")).length;
  u.retry(it.localId); await settle(u);
  eq("Retry continues the same video: no new registration, the same upload URL is asked for its offset, then every segment completes", [u.list()[0].state, w.calls.filter((c) => c.startsWith("register")).length === regs, w.calls.some((c) => c.startsWith("tus-head")), w.calls.filter((c) => c.startsWith("complete")).length], ["done", true, true, 2]);
  eq("...and the segment that was already cut is not cut again", w.calls.filter((c) => c === "cut 0-60").length, 1);
}
// the app was closed in the middle
{
  const a = world({ segSize: 14 * MB });
  const seg = (i, state, o = {}) => ({ idx: i, startS: i * 60, endS: (i + 1) * 60, path: `me/f9/seg-00${i}.mp4`, state, ...o });
  a.w.stored = [{ localId: "L1", sourceUri: "file:///roll/a.mov", name: "a", durationSeconds: 180, width: 1280, height: 720, state: "uploading", progress: 0.4, footageId: "f9", thumbPath: "me/f9.jpg", segmentSeconds: 60, segmentCount: 3, segmentsReady: 1, thumbUri: "file:///cache/keep.jpg", tusThumbUrl: null,
    segments: [seg(0, "ready", { sizeBytes: 14 * MB }), seg(1, "uploading", { tusUrl: "https://x/upload/up77", uri: "file:///cache/keep-seg.mp4", sizeBytes: 14 * MB }), seg(2, "pending")] }];
  a.w.files.add("file:///cache/keep.jpg"); a.w.files.add("file:///cache/keep-seg.mp4");
  a.w.serverOffsets.set("up77", 6 * MB);
  const u = new FootageUploader(a.deps);
  await u.restore();
  await settle(u);
  eq("after a restart the saved upload resumes: the ready segment is not touched, the half-uploaded one continues at the server's offset (6 MiB already there), the pending one is cut", [a.w.calls.filter((c) => c.startsWith("tus-patch") && c.includes("keep-seg")).map((c) => c.split(" ")[2]), a.w.calls.filter((c) => c.startsWith("cut")), a.w.calls.some((c) => c.startsWith("register")), a.w.calls.filter((c) => c.startsWith("complete")).map((c) => c.split(" ")[1]), u.list()[0].state], [["6291456+6291456", "12582912+2097152"], ["cut 120-180"], false, ["f9#1", "f9#2"], "done"]);
  const b = world(); b.w.stored = [{ localId: "L2", sourceUri: "s", name: "x", durationSeconds: 60, width: 1, height: 1, state: "compressing", progress: 0.1 }];
  const u2 = new FootageUploader(b.deps); await u2.restore(); await settle(u2);
  eq("an item that was being prepared when the app closed starts over from the top", [b.w.calls.filter((c) => c.startsWith("register")).length, u2.list()[0].state], [1, "done"]);
  const c = world();
  const u3 = new FootageUploader({ ...c.deps, load: async () => { throw new Error("corrupt"); } }); await u3.restore();
  eq("an unreadable saved list is ignored", u3.list(), []);
  const d = world(); d.w.stored = "garbage"; const u4 = new FootageUploader(d.deps); await u4.restore();
  eq("so is a saved list that is not a list", u4.list(), []);
}
// fatal upload errors
{
  const { w, deps } = world({ segSize: 14 * MB, tusPlan: ["ok", 403] });
  const u = new FootageUploader(deps);
  u.add([vid("a", 60)]);
  await settle(u);
  eq("a refusal from Storage (403) on the FIRST segment forgets the dead registration and says so; Retry registers afresh", [u.list()[0].state, u.list()[0].footageId ?? null, u.list()[0].error], ["error", null, "Stopped while uploading part 1 of 1. You're not allowed to upload this. Sign in again and retry."]);
  w.tusPlan = []; u.retry(u.list()[0].localId); await settle(u);
  eq("...and then finishes", [u.list()[0].state, w.calls.filter((c) => c.startsWith("register")).length], ["done", 2]);
}
{
  const { deps } = world({ completeFail: "the upload is not complete yet" });
  const u = new FootageUploader(deps); u.add([vid("a", 60)]); await settle(u);
  eq("if the database says the segment is not complete, the item shows a retryable error naming the step and keeps its upload", [u.list()[0].state, u.list()[0].error, !!u.list()[0].footageId], ["error", "Stopped while finishing part 1. The upload stopped. Check your connection and tap Retry.", true]);
  const big = world({ segSize: MAX_BYTES + 1 }); const u2 = new FootageUploader(big.deps); u2.add([vid("big", 60)]); await settle(u2);
  eq("a cut segment over 2 GB is refused", [u2.list()[0].state, u2.list()[0].error], ["error", "Stopped while preparing part 1 of 1. That video is too large. Try a shorter one."]);
  const cf = world({ cutFail: "export session failed (-11800)" }); const u3 = new FootageUploader(cf.deps); u3.add([vid("bad", 60)]); await settle(u3);
  eq("when the cutter throws, the error names the part and keeps the raw reason for the debug list", [u3.list()[0].state, u3.list()[0].stage, u3.list()[0].error, u3.list()[0].rawError], ["error", "preparing part 1 of 1", "Stopped while preparing part 1 of 1. Something went wrong with this video. Tap Retry.", "export session failed (-11800)"]);
}
// the time left
{
  let release; const gate = new Promise((r) => { release = r; });
  const { w, deps } = world({ gate });
  const u = new FootageUploader(deps);
  u.add([vid("a", 300)]);   // 5 segments
  await until(() => u.list()[0].segmentsReady === 1);
  const it = u.list()[0];
  const segs = it.segments;
  const want = estimateRemainingSeconds({ remaining: segs.filter((x) => x.state !== "ready").length, segmentSeconds: 60, cutSeconds: segs.map((x) => x.cutSeconds).filter((x) => x !== undefined), uploadSeconds: segs.map((x) => x.uploadSeconds).filter((x) => x !== undefined) });
  eq("after the first segment the time left is estimated from the segments already measured, for the segments still to do", [it.etaSeconds > 0, it.etaSeconds, u.totalEtaSeconds()], [true, want, want]);
  w.gateUri = undefined; release();
  await settle(u);
  eq("a finished video has no time left", [u.list()[0].etaSeconds, u.totalEtaSeconds()], [0, 0]);
  const fresh = world(); const f = new FootageUploader(fresh.deps); f.add([vid("z", 600)]);
  eq("before anything is measured a video still gets a first estimate (never blank)", f.totalEtaSeconds() > 0, true);
  await settle(f);
}
// the same video twice
{
  const { deps } = world();
  const u = new FootageUploader(deps);
  const A1 = { ...vid("video-48", 60), assetId: "ABC-123/L0/001" };
  const r1 = u.add([A1]);
  const r2 = u.add([{ ...vid("renamed", 61), assetId: "ABC-123/L0/001" }]);
  eq("the same photo-library asset id is 'Already added', whatever its name, length or size now says", [r1.added.length, r2.added.length, r2.refused], [1, 0, [{ name: "renamed", reason: "Already added." }]]);
  eq("a different asset with a similar name is a different video", u.add([{ ...vid("video-49", 60), assetId: "DEF-456/L0/001" }]).added.length, 1);
  const r4 = u.add([{ ...vid("p", 30), assetId: "X/1" }, { ...vid("p2", 30), assetId: "X/1" }]);
  eq("the same video twice in ONE pick is added once", [r4.added.length, r4.refused.map((x) => x.reason)], [1, ["Already added."]]);
  await settle(u);
  eq("it is still 'Already added' after it finished uploading", [u.add([A1]).added.length], [0]);
  const id = u.list().find((i) => i.name === "video-48").localId;
  await u.remove(id);
  eq("removing it lets it be added again", u.add([A1]).added.length, 1);
  await settle(u);
  await u.clear();
  eq("after the campaign is posted (the list is cleared) the same video can be used for the next campaign", u.add([A1]).added.length, 1);
  await settle(u);
  eq("without an asset id the key is name + file size + length: same file, same key; any difference, a different one", [footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }) === footageKey({ uri: "b", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }), footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 5 }) === footageKey({ uri: "a", name: "v", durationSeconds: 60, width: 1, height: 1, sizeBytes: 6 })], [true, false]);
  const e = world({ registerFail: "boom" }); const ue = new FootageUploader(e.deps);
  ue.add([{ ...vid("bad", 60), assetId: "E/1" }]); await settle(ue);
  eq("a video that failed is still in the list, so adding it again says 'Already added' (use Retry on it)", ue.add([{ ...vid("bad", 60), assetId: "E/1" }]).refused[0]?.reason, "Already added.");
  const f = world(); f.w.stored = [{ localId: "L9", sourceUri: "s", name: "x", durationSeconds: 60, width: 1, height: 1, state: "done", progress: 1, footageId: "f1", sourceKey: "asset:Z/9" }];
  const uf = new FootageUploader(f.deps); await uf.restore();
  eq("the identity survives a restart", uf.add([{ ...vid("x", 60), assetId: "Z/9" }]).refused[0]?.reason, "Already added.");
}
// a picked video shows at once, with a picture and its steps
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  const seen = [];
  u.subscribe((items) => seen.push(items.map((i) => `${i.name}:${i.state}:${i.stage ?? ""}`).join(",")));
  const added = u.add([vid("a", 60)]);
  eq("the video is in the list the moment it is added, waiting, with its length", [seen.includes("a:queued:waiting"), u.list()[0].durationSeconds, added.added.length], [true, 60, 1]);
  await settle(u);
  eq("it gets a preview picture early (not uploaded), and its steps are shown in order on the way to ready", [u.list()[0].previewUri?.endsWith(".jpg"), [...new Set(seen.map((x) => x.split(":")[2]))].filter(Boolean)], [true, ["waiting", "checking the length", "registering the video", "making the thumbnail", "preparing part 1 of 1", "uploading part 1 of 1", "finishing part 1", "ready"]]);
  const np = world({ noPreview: true }); const npu = new FootageUploader(np.deps); npu.add([vid("b", 60)]); await settle(npu);
  eq("a preview that cannot be made does not matter", [npu.list()[0].state, npu.list()[0].previewUri ?? null], ["done", null]);
}
// removing
{
  const { w, deps } = world();
  const u = new FootageUploader(deps);
  u.add([vid("a", 60)]);
  await settle(u);
  const fid = u.list()[0].footageId;
  await u.remove(u.list()[0].localId);
  eq("removing a finished video asks the server to remove it and empties the list", [w.calls.includes(`remove ${fid}`), u.list().length], [true, 0]);
  let release; const gate = new Promise((r) => { release = r; });
  const x = world({ gate }); const u2 = new FootageUploader(x.deps);
  u2.add([vid("slow", 180)]);
  await until(() => u2.list()[0].segmentsReady === 1);
  x.w.gateUri = [...x.w.files].find((f) => f.includes("seg-") && u2.list()[0].segments.some((s) => s.uri === f && s.idx === 1));
  const fid2 = u2.list()[0].footageId;
  await u2.remove(u2.list()[0].localId); release(); await sleep(30);
  eq("removing a video while it is still going removes the registration and never completes another segment", [x.w.calls.filter((c) => c.startsWith("remove")), x.w.calls.filter((c) => c.startsWith("complete")).length, u2.list().length], [[`remove ${fid2}`], 1, 0]);
}
eq("error wording", [friendlyUploadError("each video can be at most 30 minutes"), friendlyUploadError("too many videos at once"), friendlyUploadError("Money is not available for this account"), friendlyUploadError("zzz")], ["Each video can be at most 30 minutes.", "Too many videos at once. Finish or remove some first.", "Money isn't available for this account.", "Something went wrong with this video. Tap Retry."]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
