/**
 * Uploading campaign footage as SEGMENTS: the database plans a video into ~1-minute parts, the phone cuts part N+1 while part N uploads, and the video is
 * usable for a campaign (status 'partial') as soon as its first part is there. One video at a time:
 *   read length -> check limits and free space -> register (the plan) -> thumbnail -> for each segment: cut -> upload (resumable) -> complete.
 * The list is saved on the phone, so closing Tryal and coming back continues where it stopped (each segment resumes from the byte the server has; a
 * segment that was not finished is cut again from the source). Foreground only ("keep Tryal open"): a background-upload module is a later native
 * build; everything goes through `FootageDeps`, so it slots in without touching the screens.
 */
import { MAX_BYTES, MAX_EACH_SECONDS, canAdd, type FootageItem } from "./footageLimits.ts";
import { WORKING_SPACE_BYTES, estimateRemainingSeconds, spaceCheck } from "./footageSegments.ts";
import { TusError, tusUpload, type TusIO } from "./tus.ts";

export type UploadState = "queued" | "compressing" | "uploading" | "done" | "error";
export type SegState = {
  idx: number; startS: number; endS: number; path: string;
  state: "pending" | "cutting" | "uploading" | "ready";
  sizeBytes?: number; tusUrl?: string | null; uri?: string; cutSeconds?: number; uploadSeconds?: number;
};
export type UploadItem = FootageItem & {
  localId: string;
  sourceUri: string;
  name: string;
  width: number;
  height: number;
  state: UploadState;
  progress: number;          // 0..1 of the whole video (segments done + the one in progress)
  footageId?: string;
  thumbPath?: string;
  sizeBytes?: number;        // total uploaded so far
  thumbUri?: string;
  tusThumbUrl?: string | null;
  /** the plan and where each segment is */
  segments?: SegState[];
  segmentSeconds?: number;
  segmentsReady?: number;
  segmentCount?: number;
  /** seconds left for this video, estimated from the segments already done */
  etaSeconds?: number;
  /** set once the campaign is posted: the rest of the upload carries on behind the campaign screen */
  campaignId?: string;
  /** what it is doing (or was doing when it failed), in words: shown on the screen and in the debug list */
  stage?: string;
  error?: string;       // the plain message, naming the stage
  rawError?: string;    // the underlying reason, for the debug list
  sourceSize?: number;  // bytes of the picked file, when the picker said
  previewUri?: string;  // a small picture of the first frame, so the row has a thumbnail at once
  createdAt?: number;
  note?: string;
  sourceScheme?: string; // file / ph / content: what kind of address the picker gave
  sourceKey?: string;    // the video's identity (the photo library's asset id, else name + size + length), so the same video is not added twice
};
export type PlannedSegment = { idx: number; start_s: number | string; end_s: number | string; path: string };
export type Registered = { id: string; thumb_path: string; segment_seconds: number; segments: PlannedSegment[] };

export type FootageDeps = {
  /** the database's plan for a video of this length */
  registerSegmented(durationSeconds: number, width: number, height: number): Promise<Registered>;
  completeSegment(footageId: string, idx: number, sizeBytes: number): Promise<string>;
  remove(id: string): Promise<void>;
  /** cut [startS, endS) of the source into its own small MP4 on the phone */
  cutSegment(sourceUri: string, startS: number, endS: number, onProgress: (p: number) => void): Promise<{ uri: string; sizeBytes: number }>;
  /** a small jpeg of the first frame, or null */
  thumbnail(uri: string): Promise<{ uri: string; sizeBytes: number } | null>;
  /** a picture of the first frame for the list (not uploaded) */
  preview?(uri: string): Promise<string | null>;
  /** the video's length when the picker did not say (null = unknown) */
  readDuration?(uri: string): Promise<number | null>;
  /** the video's size in pixels when the picker did not say */
  dimensions?(uri: string): Promise<{ width: number; height: number } | null>;
  /** free space in bytes (null = unknown) */
  freeBytes?(): Promise<number | null>;
  fileExists(uri: string): Promise<boolean>;
  deleteFile(uri: string): Promise<void>;
  makeIO(fileUri: string, size: number): TusIO;
  endpoint: string;
  bucket: string;
  load(): Promise<UploadItem[]>;
  save(items: UploadItem[]): Promise<void>;
  newId(): string;
  now?(): number;
};

export type FootageInput = { uri: string; name: string; durationSeconds: number; width: number; height: number; sizeBytes?: number; assetId?: string | null };

/** Same video = same photo-library asset id; when the picker gives none, the same name, file size and length. */
export function footageKey(f: FootageInput): string {
  return f.assetId ? `asset:${f.assetId}` : `file:${f.name}|${f.sizeBytes ?? 0}|${Math.round(f.durationSeconds * 10)}`;
}
export type Listener = (items: UploadItem[]) => void;

/** A video can go into a campaign once its first segment is uploaded. */
export const isPostable = (i: UploadItem): boolean => !!i.footageId && (i.segmentsReady ?? 0) >= 1 && i.state !== "error";

export class FootageUploader {
  private items: UploadItem[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private cancelled = new Set<string>();
  private deps: FootageDeps;
  constructor(deps: FootageDeps) { this.deps = deps; }

  list(): UploadItem[] { return this.items; }
  subscribe(l: Listener): () => void { this.listeners.add(l); l(this.items); return () => { this.listeners.delete(l); }; }
  private emit(): void { for (const l of this.listeners) l(this.items); void this.deps.save(this.items).catch(() => {}); }
  private patch(localId: string, p: Partial<UploadItem>): void { this.items = this.items.map((i) => (i.localId === localId ? { ...i, ...p } : i)); this.emit(); }
  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /** Read the saved list (after the app was closed) and carry on. */
  async restore(): Promise<void> {
    if (this.items.length) return;
    const saved = await this.deps.load().catch(() => [] as UploadItem[]);
    this.items = (Array.isArray(saved) ? saved : []).map((i) => (i.state === "compressing" || i.state === "uploading" ? { ...i, state: "queued" as const } : i));
    this.emit();
    void this.run();
  }

  /** Add videos. Each is checked against the 30 / 60 minute limits first; the refusals are returned (by name), the rest are queued. */
  add(inputs: FootageInput[]): { added: UploadItem[]; refused: Array<{ name: string; reason: string }> } {
    const added: UploadItem[] = [], refused: Array<{ name: string; reason: string }> = [];
    for (const f of inputs) {
      const key = footageKey(f);
      if ([...this.items, ...added].some((i) => i.sourceKey === key)) { refused.push({ name: f.name, reason: "Already added." }); continue; }
      // a length the picker did not give (0) is read later; it is checked against the limits as soon as it is known
      const mine = [...this.items.filter((i) => !i.campaignId && i.state !== "error"), ...added];
      const check = f.durationSeconds > 0 ? canAdd(mine, f.durationSeconds) : { ok: true as const };
      if (!check.ok) { refused.push({ name: f.name, reason: check.reason }); continue; }
      added.push({ localId: this.deps.newId(), sourceUri: f.uri, name: f.name, durationSeconds: f.durationSeconds, width: f.width, height: f.height, state: "queued", progress: 0, stage: "waiting", sourceSize: f.sizeBytes, createdAt: this.now(), sourceScheme: f.uri.split(":")[0], sourceKey: key });
    }
    if (added.length) { this.items = [...this.items, ...added]; this.emit(); for (const a of added) void this.makePreview(a.localId); void this.run(); }
    return { added, refused };
  }

  /** a picture of the first frame, so the row has a thumbnail the moment the video is picked (never fails the video) */
  private async makePreview(localId: string): Promise<void> {
    const it = this.items.find((i) => i.localId === localId);
    if (!it || !this.deps.preview) return;
    try { const u = await this.deps.preview(it.sourceUri); if (u && this.items.some((i) => i.localId === localId)) this.patch(localId, { previewUri: u }); } catch { /* no picture: the row still shows */ }
  }

  /** Remove a video from the list (and from the server if it was registered and the campaign has not frozen it). */
  async remove(localId: string): Promise<void> {
    const it = this.items.find((i) => i.localId === localId);
    if (!it) return;
    this.cancelled.add(localId);
    this.items = this.items.filter((i) => i.localId !== localId);
    this.emit();
    if (it.footageId) await this.deps.remove(it.footageId).catch(() => {});
    await this.cleanFiles(it);
  }

  retry(localId: string): void { this.patch(localId, { state: "queued", error: undefined }); void this.run(); }

  /** Ids of the videos that can go into a campaign now (their first segment is uploaded), in order. */
  postableIds(): string[] { return this.items.filter((i) => !i.campaignId && isPostable(i)).map((i) => i.footageId!); }
  /** Every video in the wizard is either postable or failed (failed ones are left out): nothing is still waiting for its first segment. */
  readyToPost(): boolean { const mine = this.items.filter((i) => !i.campaignId); return mine.some(isPostable) && mine.every((i) => isPostable(i) || i.state === "error"); }
  /** The campaign was posted with these videos: the finished ones leave the list, the rest keep uploading behind the campaign. */
  async attach(footageIds: string[], campaignId: string): Promise<void> {
    const ids = new Set(footageIds);
    const finished = this.items.filter((i) => i.footageId && ids.has(i.footageId) && i.state === "done");
    this.items = this.items.filter((i) => !finished.includes(i)).map((i) => (i.footageId && ids.has(i.footageId) ? { ...i, campaignId } : i));
    this.emit();
    for (const f of finished) await this.cleanFiles(f);
    void this.run();
  }
  /** Seconds left for everything not finished (all videos, in the queue's order). */
  totalEtaSeconds(): number { return this.items.filter((i) => i.state !== "done" && i.state !== "error").reduce((a, i) => a + (i.etaSeconds ?? this.estimate(i)), 0); }
  private estimate(i: UploadItem): number {
    const segs = i.segments ?? [];
    const segSeconds = i.segmentSeconds ?? 60;
    const remaining = segs.length ? segs.filter((s) => s.state !== "ready").length : Math.max(1, Math.ceil(i.durationSeconds / segSeconds));
    return estimateRemainingSeconds({ remaining, segmentSeconds: segSeconds, cutSeconds: segs.map((s) => s.cutSeconds).filter((x): x is number => x !== undefined), uploadSeconds: segs.map((s) => s.uploadSeconds).filter((x): x is number => x !== undefined) });
  }

  /** After the wizard is left without posting: forget the list. */
  async clear(): Promise<void> { for (const i of this.items.filter((x) => !x.campaignId)) await this.cleanFiles(i); this.items = this.items.filter((i) => i.campaignId); this.emit(); }

  private async cleanFiles(it: UploadItem): Promise<void> {
    const files = [it.thumbUri, it.previewUri, ...(it.segments ?? []).map((s) => s.uri)];
    for (const u of files) if (u && u !== it.sourceUri) await this.deps.deleteFile(u).catch(() => {});
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const next = this.items.find((i) => i.state === "queued");
        if (!next) break;
        await this.one(next.localId);
      }
    } finally { this.running = false; }
  }

  private async one(localId: string): Promise<void> {
    const get = () => this.items.find((i) => i.localId === localId);
    const dead = () => this.cancelled.has(localId) || !get();
    let stage = "starting";
    const at = (st: string, p: Partial<UploadItem> = {}) => { stage = st; this.patch(localId, { stage: st, ...p }); };
    const segPatch = (idx: number, p: Partial<SegState>) => {
      const it = get(); if (!it?.segments) return;
      this.patch(localId, { segments: it.segments.map((s) => (s.idx === idx ? { ...s, ...p } : s)) });
    };
    try {
      let it = get()!;
      // 1. the length: what the picker said, else what the file says; then the limits
      at("checking the length", { state: "compressing", error: undefined, rawError: undefined });
      let dur = it.durationSeconds;
      if (!(dur > 0) && this.deps.readDuration) dur = (await this.deps.readDuration(it.sourceUri).catch(() => null)) ?? 0;
      if (!(dur > 0)) throw new Error("could not read the length of this video");
      if (dur > MAX_EACH_SECONDS) throw new Error("each video can be at most 30 minutes");
      if (!it.footageId) {
        const others = this.items.filter((i) => i.localId !== localId && !i.campaignId && i.state !== "error").map((i) => ({ durationSeconds: i.durationSeconds }));
        const fit = canAdd(others, dur);
        if (!fit.ok) throw new Error(fit.reason.toLowerCase().includes("60") ? "a campaign can have at most 60 minutes of footage" : fit.reason);
      }
      this.patch(localId, { durationSeconds: dur });
      // 2. free space for the cutting
      if (this.deps.freeBytes) {
        at("checking free space");
        const sp = spaceCheck(await this.deps.freeBytes().catch(() => null), WORKING_SPACE_BYTES);
        if (!sp.ok) throw new Error(`not enough free space: ${sp.message}`);
      }
      // 3. register: the database plans the segments
      it = get()!;
      if (!it.footageId) {
        at("registering the video");
        let { width, height } = it;
        if (!(width > 0 && height > 0) && this.deps.dimensions) { const d = await this.deps.dimensions(it.sourceUri).catch(() => null); if (d) { width = d.width; height = d.height; } }
        if (!(width > 0 && height > 0)) { width = 1280; height = 720; }
        const r = await this.deps.registerSegmented(dur, width, height);
        if (dead()) { await this.deps.remove(r.id).catch(() => {}); return; }
        this.patch(localId, {
          footageId: r.id, thumbPath: r.thumb_path, width, height, segmentSeconds: r.segment_seconds, segmentCount: r.segments.length, segmentsReady: 0, sizeBytes: undefined,
          segments: r.segments.map((s) => ({ idx: s.idx, startS: Number(s.start_s), endS: Number(s.end_s), path: s.path, state: "pending" as const })),
        });
        it = get()!;
      }
      this.patch(localId, { state: "uploading" });
      // 4. thumbnail (a bonus: a failure here never fails the video)
      it = get()!;
      if (!it.thumbUri && it.thumbPath) {
        at("making the thumbnail");
        const t = await this.deps.thumbnail(it.sourceUri).catch(() => null);
        if (t) this.patch(localId, { thumbUri: t.uri });
        it = get()!;
        if (t) {
          try {
            await tusUpload(this.deps.makeIO(t.uri, t.sizeBytes), { endpoint: this.deps.endpoint, size: t.sizeBytes, bucket: this.deps.bucket, objectName: it.thumbPath!, contentType: "image/jpeg", resumeUrl: it.tusThumbUrl, onUrl: (u) => this.patch(localId, { tusThumbUrl: u }), isCancelled: dead, maxAttempts: 4 });
          } catch (e) { if (e instanceof TusError && e.message === "cancelled") return; /* the video can do without it */ }
        }
      }
      // 5. the segments: cut N+1 while N uploads
      const todo = (get()!.segments ?? []).filter((s) => s.state !== "ready");
      const cutOne = async (s: SegState): Promise<{ uri: string; sizeBytes: number }> => {
        const cur = get()?.segments?.find((x) => x.idx === s.idx);
        if (cur?.uri && (await this.deps.fileExists(cur.uri).catch(() => false)) && cur.sizeBytes) return { uri: cur.uri, sizeBytes: cur.sizeBytes };
        segPatch(s.idx, { state: "cutting" });
        const t0 = this.now();
        const c = await this.deps.cutSegment(get()!.sourceUri, s.startS, s.endS, () => {});
        if (dead()) { await this.deps.deleteFile(c.uri).catch(() => {}); throw new TusError("cancelled", true); }
        if (!(c.sizeBytes > 0)) throw new Error("the cut segment is empty");
        if (c.sizeBytes > MAX_BYTES) throw new Error("that segment is too large");
        segPatch(s.idx, { uri: c.uri, sizeBytes: c.sizeBytes, cutSeconds: (this.now() - t0) / 1000 });
        return c;
      };
      let nextCut: Promise<{ uri: string; sizeBytes: number }> | null = todo.length ? cutOne(todo[0]) : null;
      nextCut?.catch(() => {});
      for (let k = 0; k < todo.length; k++) {
        const s = todo[k];
        at(`preparing part ${s.idx + 1} of ${get()!.segmentCount}`);
        const cut = await nextCut!;
        if (dead()) return;
        if (k + 1 < todo.length) { nextCut = cutOne(todo[k + 1]); nextCut.catch(() => {}); }
        it = get()!;
        at(`uploading part ${s.idx + 1} of ${it.segmentCount}`);
        segPatch(s.idx, { state: "uploading" });
        const t1 = this.now();
        const saved = get()!.segments!.find((x) => x.idx === s.idx)!;
        await tusUpload(this.deps.makeIO(cut.uri, cut.sizeBytes), {
          endpoint: this.deps.endpoint, size: cut.sizeBytes, bucket: this.deps.bucket, objectName: s.path, contentType: "video/mp4",
          resumeUrl: saved.tusUrl, onUrl: (u) => segPatch(s.idx, { tusUrl: u }),
          onProgress: (sent, total) => { if (!dead()) { const cur = get()!; this.patch(localId, { progress: ((cur.segmentsReady ?? 0) + sent / total) / (cur.segmentCount ?? 1) }); } }, isCancelled: dead,
        });
        if (dead()) return;
        at(`finishing part ${s.idx + 1}`);
        await this.deps.completeSegment(it.footageId!, s.idx, cut.sizeBytes);
        segPatch(s.idx, { state: "ready", uploadSeconds: (this.now() - t1) / 1000, tusUrl: null });
        await this.deps.deleteFile(cut.uri).catch(() => {});
        segPatch(s.idx, { uri: undefined });
        const cur = get()!;
        const ready = (cur.segments ?? []).filter((x) => x.state === "ready").length;
        this.patch(localId, { segmentsReady: ready, sizeBytes: (cur.segments ?? []).reduce((a, x) => a + (x.state === "ready" || x.idx === s.idx ? x.sizeBytes ?? 0 : 0), 0), progress: ready / (cur.segmentCount ?? 1) });
        this.patch(localId, { etaSeconds: this.estimate(get()!) });
      }
      at("ready", { state: "done", progress: 1, error: undefined, rawError: undefined, etaSeconds: 0 });
      const done = get();
      if (done?.thumbUri) await this.deps.deleteFile(done.thumbUri).catch(() => {});
      this.patch(localId, { thumbUri: undefined });
      // a finished video that is already inside a posted campaign has nothing more to show here
      if (get()?.campaignId) { this.items = this.items.filter((i) => i.localId !== localId); this.emit(); }
    } catch (e) {
      const it = get();
      if (!it || (e instanceof TusError && e.message === "cancelled")) return;
      const fatal = e instanceof TusError ? e.fatal : false;
      const raw = String((e as Error)?.message ?? e).slice(0, 300);
      // never silent: the message names the step that failed and why. A video that already has segments keeps them (Retry continues).
      this.patch(localId, { state: "error", stage, rawError: raw, error: `Stopped while ${stage}. ${friendlyUploadError(raw)}`, ...(fatal && !it.segmentsReady ? { footageId: undefined, segments: undefined } : {}) });
    }
  }
}

export function friendlyUploadError(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("not enough free space")) return String(message).replace(/^not enough free space: /i, "");
  if (m.includes("at most") && m.includes("minutes of footage")) return "A campaign can have at most 60 minutes of footage.";
  if (m.includes("each video can be at most")) return "Each video can be at most 30 minutes.";
  if (m.includes("too large")) return "That video is too large. Try a shorter one.";
  if (m.includes("too many videos")) return "Too many videos at once. Finish or remove some first.";
  if (m.includes("not available for this account") || m.includes("creator role")) return "Money isn't available for this account.";
  if (m.includes("not allowed to upload")) return "You're not allowed to upload this. Sign in again and retry.";
  if (m.includes("could not read the length")) return "Tryal couldn't read how long this video is. Try a different video.";
  if (m.includes("could not be read")) return "Tryal couldn't open this video file.";
  if (m.includes("413") || m.includes("maximum allowed size") || m.includes("too large for the server")) return "The server's upload size limit is smaller than this video. (The owner may need to raise the project's Storage upload limit.)";
  if (m.includes("upload failed") || m.includes("network") || m.includes("not complete")) return "The upload stopped. Check your connection and tap Retry.";
  return "Something went wrong with this video. Tap Retry.";
}
