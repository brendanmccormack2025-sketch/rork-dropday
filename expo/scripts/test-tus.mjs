#!/usr/bin/env node
/**
 * The resumable-upload protocol (lib/tus.ts) against a fake server that behaves like Supabase Storage's TUS endpoint: create, ask the offset, 6 MiB
 * PATCH chunks, and every way the network and the server can misbehave. No phone and no network needed.
 *   node --experimental-strip-types --no-warnings scripts/test-tus.mjs
 */
import { TUS_CHUNK, TusError, backoffMs, chunkPlan, tusMetadata, tusUpload } from "../lib/tus.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const MB = 1024 * 1024;
const ENDPOINT = "https://x.supabase.co/storage/v1/upload/resumable";

/** A fake server. `script` can turn the Nth call of a kind into a failure: { patch: { 2: "drop" | 500 | 409 | 404 | 403 } }. */
function fakeServer(script = {}) {
  const st = { uploads: new Map(), log: [], sleeps: [], calls: { post: 0, head: 0, patch: 0 }, next: 1, headers: [] };
  const fail = (kind) => script[kind]?.[st.calls[kind]];
  const io = {
    async request(method, url, headers) {
      st.headers.push({ method, url, headers });
      if (method === "POST") {
        st.calls.post++;
        const f = fail("post");
        if (f === "drop") throw new Error("network error");
        if (typeof f === "number") return { status: f, headers: {} };
        const id = `u${st.next++}`;
        st.uploads.set(id, { offset: 0, length: Number(headers["Upload-Length"]), meta: headers["Upload-Metadata"] });
        st.log.push(`POST ${id}`);
        return { status: 201, headers: { location: `/storage/v1/upload/resumable/${id}` } };
      }
      st.calls.head++;
      const f = fail("head");
      if (f === "drop") throw new Error("network error");
      if (typeof f === "number") return { status: f, headers: {} };
      const id = url.split("/").pop();
      const u = st.uploads.get(id);
      st.log.push(`HEAD ${id}`);
      return u ? { status: 200, headers: { "upload-offset": String(u.offset) } } : { status: 404, headers: {} };
    },
    async patch(url, headers, offset, length) {
      st.calls.patch++;
      st.headers.push({ method: "PATCH", url, headers });
      const f = fail("patch");
      const id = url.split("/").pop();
      const u = st.uploads.get(id);
      if (f === "drop") { if (u && st.dropKeepsData) u.offset = offset + length; throw new Error("network error"); }
      if (typeof f === "number") { if (f === 404) st.uploads.delete(id); return { status: f, headers: {} }; }
      if (!u) return { status: 404, headers: {} };
      if (Number(headers["Upload-Offset"]) !== u.offset) return { status: 409, headers: {} };
      u.offset = offset + length;
      st.log.push(`PATCH ${id} ${offset}+${length}`);
      return { status: 204, headers: { "upload-offset": String(u.offset) } };
    },
    async authHeaders() { return { Authorization: "Bearer t", apikey: "k" }; },
    async sleep(ms) { st.sleeps.push(ms); },
  };
  return { io, st };
}
const run = async (size, over = {}, script = {}, pre) => {
  const s = fakeServer(script);
  if (pre) pre(s.st);
  const progress = [], urls = [];
  let err = null;
  try {
    await tusUpload(s.io, { endpoint: ENDPOINT, size, bucket: "campaign-footage", objectName: "u/v.mp4", contentType: "video/mp4", onProgress: (a, b) => progress.push(`${a}/${b}`), onUrl: (u) => urls.push(u), ...over });
  } catch (e) { err = e; }
  return { ...s, progress, urls, err };
};

// ── helpers ──
eq("chunk plan: 14 MiB is 6 + 6 + 2; resuming at 6 MiB leaves 6 + 2; a whole number of chunks has no short one; done is empty", [chunkPlan(14 * MB, 0).map((c) => c.length / MB), chunkPlan(14 * MB, 6 * MB).map((c) => `${c.offset / MB}+${c.length / MB}`), chunkPlan(12 * MB, 0).length, chunkPlan(5, 5)], [[6, 6, 2], ["6+6", "12+2"], 2, []]);
eq("the chunk size is exactly 6 MiB (Supabase refuses any other)", TUS_CHUNK, 6291456);
eq("backoff doubles from 1 s and stops at 30 s", [1, 2, 3, 4, 5, 6, 7, 20].map(backoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
eq("metadata is key + base64 value, comma separated (and handles non-ASCII)", [tusMetadata({ a: "hi", b: "x/y.mp4" }), tusMetadata({ n: "é" })], ["a aGk=,b eC95Lm1wNA==", "n w6k="]);

// ── a clean upload ──
{
  const r = await run(14 * MB);
  eq("a 14 MiB upload: one create, three chunks in order, no waiting, no error", [r.err, r.st.calls.post, r.st.log.filter((l) => l.startsWith("PATCH")).map((l) => l.split(" ")[2]), r.st.sleeps], [null, 1, ["0+6291456", "6291456+6291456", "12582912+2097152"], []]);
  eq("progress rises to the end, and the upload URL is reported once (so it can be saved for resuming)", [r.progress.at(-1), r.progress.every((p, i) => i === 0 || Number(p.split("/")[0]) >= Number(r.progress[i - 1].split("/")[0])), r.urls], ["14680064/14680064", true, [`https://x.supabase.co/storage/v1/upload/resumable/u1`]]);
  const post = r.st.headers.find((h) => h.method === "POST").headers;
  eq("the create call sends the length, the bucket and the object name, the auth headers, and never overwrites", [post["Upload-Length"], post["Tus-Resumable"], post.Authorization, post.apikey, post["x-upsert"], post["Upload-Metadata"].includes("bucketName " + btoa("campaign-footage")), post["Upload-Metadata"].includes("objectName " + btoa("u/v.mp4")), post["Upload-Metadata"].includes("contentType " + btoa("video/mp4"))], ["14680064", "1.0.0", "Bearer t", "k", "false", true, true, true]);
  const patch = r.st.headers.find((h) => h.method === "PATCH").headers;
  eq("every chunk says where it starts", [patch["Content-Type"], patch["Upload-Offset"]], ["application/offset+octet-stream", "0"]);
  eq("a small file is one chunk", (await run(1000)).st.log.filter((l) => l.startsWith("PATCH")), ["PATCH u1 0+1000"]);
}
// ── resume ──
{
  const r = await run(14 * MB, { resumeUrl: `${ENDPOINT}/u9` }, {}, (st) => { st.uploads.set("u9", { offset: 6 * MB, length: 14 * MB }); });
  eq("resuming from a saved URL asks the server where it is, creates nothing, and sends only what is missing", [r.st.calls.post, r.st.log, r.err], [0, ["HEAD u9", "PATCH u9 6291456+6291456", "PATCH u9 12582912+2097152"], null]);
  eq("a resume that is already complete sends nothing", (await run(6 * MB, { resumeUrl: `${ENDPOINT}/u9` }, {}, (st) => { st.uploads.set("u9", { offset: 6 * MB, length: 6 * MB }); })).st.calls.patch, 0);
  const forgot = await run(8 * MB, { resumeUrl: `${ENDPOINT}/gone` });
  eq("a saved URL the server no longer knows (404) starts a fresh upload from zero", [forgot.err, forgot.st.calls.post, forgot.st.log.filter((l) => l.startsWith("PATCH")).length], [null, 1, 2]);
  const headFails = await run(6 * MB, { resumeUrl: `${ENDPOINT}/u9` }, { head: { 1: "drop" } }, (st) => { st.uploads.set("u9", { offset: 0, length: 6 * MB }); });
  eq("if asking for the offset fails at first, the upload still carries on (the patch learns the truth)", [headFails.err, headFails.st.uploads.get("u9").offset], [null, 6 * MB]);
}
// ── a dropped connection ──
{
  const r = await run(14 * MB, {}, { patch: { 2: "drop" } });
  eq("a connection dropped during chunk 2: waits 1 s, asks the server, resends chunk 2 from where the server is (the server lost it), finishes", [r.err, r.st.sleeps, r.st.log.filter((l) => l.startsWith("PATCH")).map((l) => l.split(" ")[2]), r.st.uploads.get("u1").offset], [null, [1000], ["0+6291456", "6291456+6291456", "12582912+2097152"], 14 * MB]);
  const kept = await run(14 * MB, {}, { patch: { 2: "drop" } }, (st) => { st.dropKeepsData = true; });
  eq("if the server DID keep the dropped chunk, it is not sent twice (the HEAD answer is believed)", [kept.err, kept.st.calls.patch, kept.st.uploads.get("u1").offset], [null, 3, 14 * MB]);
  const five = await run(14 * MB, {}, { patch: { 1: 503, 2: 500 } });
  eq("server errors (503, 500) are retried with growing waits", [five.err, five.st.sleeps], [null, [1000, 2000]]);
  const cr = await run(6 * MB, {}, { post: { 1: "drop", 2: 502 } });
  eq("create is retried too", [cr.err, cr.st.calls.post, cr.st.sleeps], [null, 3, [1000, 2000]]);
  const wait = await run(14 * MB, {}, { patch: { 2: "drop", 4: "drop" } });
  eq("the failure count resets after a good chunk (two separate drops do not add up)", [wait.err, wait.st.sleeps], [null, [1000, 1000]]);
}
// ── giving up, and not giving up ──
{
  const all = Object.fromEntries([...Array(30).keys()].map((i) => [i + 1, "drop"]));
  const r = await run(6 * MB, { maxAttempts: 4 }, { patch: all });
  eq("after maxAttempts failures in a row it stops with a retryable error (the progress is kept: the URL was reported)", [r.err instanceof TusError, r.err?.fatal, r.st.sleeps.length, r.urls.length], [true, false, 3, 1]);
  const denied = await run(6 * MB, {}, { patch: { 1: 403 } });
  eq("403 on a chunk is fatal at once, with no retries", [denied.err?.fatal, denied.st.sleeps], [true, []]);
  eq("403 or 401 on create is fatal; 400 and 413 too; they never loop", [(await run(MB, {}, { post: { 1: 403 } })).err?.fatal, (await run(MB, {}, { post: { 1: 401 } })).err?.fatal, (await run(MB, {}, { post: { 1: 413 } })).err?.fatal, (await run(MB, {}, { post: { 1: 400 } })).err?.fatal], [true, true, true, true]);
  eq("an empty file is refused before any request", [(await run(0)).err?.fatal, (await run(0)).st.calls.post], [true, 0]);
  const lost = await run(14 * MB, {}, { patch: { 2: 404 } });
  eq("the server forgetting the upload mid-way (404) starts again from zero and still finishes", [lost.err, lost.st.calls.post, lost.st.uploads.get("u2").offset], [null, 2, 14 * MB]);
  const mism = await run(14 * MB, {}, { patch: { 2: 409 } });
  eq("409 (out of step) is fixed by asking the offset, not by failing", [mism.err, mism.st.sleeps, mism.st.uploads.get("u1").offset], [null, [], 14 * MB]);
  const exists = await run(2 * MB, {}, { post: { 1: 409 } });
  eq("create answered 409 (the file is already there from an earlier finished attempt): nothing to send", [exists.err, exists.st.calls.patch], [null, 0]);
  let n = 0;
  const cancel = await run(14 * MB, { isCancelled: () => ++n > 3 });
  eq("cancelling stops between chunks with a 'cancelled' error", [cancel.err?.message, cancel.err?.fatal, cancel.st.calls.patch < 3], ["cancelled", true, true]);
  let tokens = 0;
  const s = fakeServer(); s.io.authHeaders = async () => ({ Authorization: `Bearer t${++tokens}`, apikey: "k" });
  await tusUpload(s.io, { endpoint: ENDPOINT, size: 14 * MB, bucket: "b", objectName: "o", contentType: "video/mp4" });
  eq("fresh auth headers are asked for on every request (a refreshed token is picked up between chunks)", [...new Set(s.st.headers.map((h) => h.headers.Authorization))].length, 4);
}
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
