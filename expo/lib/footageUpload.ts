/**
 * Uploading campaign footage: one video at a time, compress -> register (the database reserves the minutes and the paths) -> thumbnail -> resumable
 * upload straight to the private bucket -> complete (the database checks the file is really there). The list is saved on the phone, so closing Tryal
 * and coming back continues where it stopped (the upload resumes from the byte the server has). Foreground only for now ("keep Tryal open"): the
 * background-upload module is a later native build; everything here goes through `FootageDeps`, so that module slots in without touching the screens.
 */
import { MAX_BYTES, MAX_EACH_SECONDS, canAdd, type FootageItem } from "./footageLimits.ts";
import { TusError, tusUpload, type TusIO } from "./tus.ts";

export type UploadState = "queued" | "compressing" | "uploading" | "done" | "error";
export type UploadItem = FootageItem & {
  localId: string;
  sourceUri: string;
  name: string;
  width: number;
  height: number;
  state: UploadState;
  progress: number;          // 0..1 of the whole job (compression counts a third, sending two thirds)
  footageId?: string;
  videoPath?: string;
  thumbPath?: string;
  sizeBytes?: number;
  compressedUri?: string;
  thumbUri?: string;
  tusVideoUrl?: string | null;
  tusThumbUrl?: string | null;
  /** what it is doing (or was doing when it failed), in words: shown on the screen and in the debug list */
  stage?: string;
  error?: string;       // the plain message, naming the stage
  rawError?: string;    // the underlying reason, for the debug list
  sourceSize?: number;  // bytes of the picked file, when the picker said
  previewUri?: string;  // a small picture of the first frame, so the row has a thumbnail at once
  createdAt?: number;
  note?: string;        // e.g. the compressor failed and the original was used
  sourceScheme?: string; // file / ph / content: what kind of address the picker gave
};
export type Registered = { id: string; storage_path: string; thumb_path: string };

export type FootageDeps = {
  register(durationSeconds: number, width: number, height: number, sizeBytes: number): Promise<Registered>;
  complete(id: string): Promise<void>;
  fail(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** compress on the phone; returns the file to upload (the original when compressing is not possible) */
  compress(uri: string, onProgress: (p: number) => void): Promise<{ uri: string; sizeBytes: number; width: number; height: number; durationSeconds: number; note?: string }>;
  /** a small jpeg of the first frame, or null */
  thumbnail(uri: string): Promise<{ uri: string; sizeBytes: number } | null>;
  /** a picture of the first frame for the list (not uploaded) */
  preview?(uri: string): Promise<string | null>;
  /** the video's length when the picker did not say (null = unknown) */
  readDuration?(uri: string): Promise<number | null>;
  fileExists(uri: string): Promise<boolean>;
  deleteFile(uri: string): Promise<void>;
  makeIO(fileUri: string, size: number): TusIO;
  endpoint: string;
  bucket: string;
  load(): Promise<UploadItem[]>;
  save(items: UploadItem[]): Promise<void>;
  newId(): string;
};

export type FootageInput = { uri: string; name: string; durationSeconds: number; width: number; height: number; sizeBytes?: number };
export type Listener = (items: UploadItem[]) => void;

export class FootageUploader {
  private items: UploadItem[] = [];
  private listeners = new Set<Listener>();
  private running = false;
  private cancelled = new Set<string>();
  private deps: FootageDeps;
  constructor(deps: FootageDeps) { this.deps = deps; }

  list(): UploadItem[] { return this.items; }
  subscribe(l: Listener): () => void { this.listeners.add(l); l(this.items); return () => { this.listeners.delete(l); }; }
  private emit(): void { for (const l of this.listeners) l(this.items); void this.deps.save(this.items.filter((i) => i.state !== "done" || !!i.footageId)).catch(() => {}); }
  private patch(localId: string, p: Partial<UploadItem>): void { this.items = this.items.map((i) => (i.localId === localId ? { ...i, ...p } : i)); this.emit(); }

  /** Read the saved list (after the app was closed) and carry on. Items that finished stay in the list until the campaign is posted. */
  async restore(): Promise<void> {
    if (this.items.length) return;
    const saved = await this.deps.load().catch(() => [] as UploadItem[]);
    this.items = saved.map((i) => (i.state === "compressing" || i.state === "uploading" ? { ...i, state: "queued" as const } : i));
    this.emit();
    void this.run();
  }

  /** Add videos. Each is checked against the 30 / 60 minute limits first; the refusals are returned (by name), the rest are queued. */
  add(inputs: FootageInput[]): { added: UploadItem[]; refused: Array<{ name: string; reason: string }> } {
    const added: UploadItem[] = [], refused: Array<{ name: string; reason: string }> = [];
    for (const f of inputs) {
      // a length the picker did not give (0) is read later; it is checked against the limits as soon as it is known
      const check = f.durationSeconds > 0 ? canAdd([...this.items.filter((i) => i.state !== "error"), ...added], f.durationSeconds) : { ok: true as const };
      if (!check.ok) { refused.push({ name: f.name, reason: check.reason }); continue; }
      added.push({ localId: this.deps.newId(), sourceUri: f.uri, name: f.name, durationSeconds: f.durationSeconds, width: f.width, height: f.height, state: "queued", progress: 0, stage: "waiting", sourceSize: f.sizeBytes, createdAt: Date.now(), sourceScheme: f.uri.split(":")[0] });
    }
    if (added.length) { this.items = [...this.items, ...added]; this.emit(); for (const a of added) void this.makePreview(a.localId); void this.run(); }
    return { added, refused };
  }

  /** Remove a video from the list (and from the server if it was registered). */
  async remove(localId: string): Promise<void> {
    const it = this.items.find((i) => i.localId === localId);
    if (!it) return;
    this.cancelled.add(localId);
    this.items = this.items.filter((i) => i.localId !== localId);
    this.emit();
    if (it.footageId) await this.deps.remove(it.footageId).catch(() => {});
    await this.cleanFiles(it);
  }

  /** a picture of the first frame, so the row has a thumbnail the moment the video is picked (never fails the video) */
  private async makePreview(localId: string): Promise<void> {
    const it = this.items.find((i) => i.localId === localId);
    if (!it || !this.deps.preview) return;
    try { const u = await this.deps.preview(it.sourceUri); if (u && this.items.some((i) => i.localId === localId)) this.patch(localId, { previewUri: u }); } catch { /* no picture: the row still shows */ }
  }

  retry(localId: string): void { this.patch(localId, { state: "queued", error: undefined }); void this.run(); }

  /** Ids of the finished videos, in order: what the campaign is created with. */
  readyIds(): string[] { return this.items.filter((i) => i.state === "done" && i.footageId).map((i) => i.footageId!); }
  allDone(): boolean { return this.items.length > 0 && this.items.every((i) => i.state === "done"); }
  /** After the campaign was posted: forget the list. */
  async clear(): Promise<void> { for (const i of this.items) await this.cleanFiles(i); this.items = []; this.emit(); }

  private async cleanFiles(it: UploadItem): Promise<void> {
    for (const u of [it.compressedUri, it.thumbUri, it.previewUri]) if (u && u !== it.sourceUri) await this.deps.deleteFile(u).catch(() => {});
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
    try {
      let it = get()!;
      // 1. compress (skipped when the compressed file from an earlier attempt is still there)
      if (!it.compressedUri || !(await this.deps.fileExists(it.compressedUri))) {
        at("preparing the video", { state: "compressing", progress: 0, error: undefined, rawError: undefined });
        const c = await this.deps.compress(it.sourceUri, (p) => { if (!dead()) this.patch(localId, { progress: Math.min(1, p) / 3 }); });
        if (dead()) { if (c.uri !== it.sourceUri) await this.deps.deleteFile(c.uri).catch(() => {}); return; }
        // the length: what the picker said, else what the file says, else what the compressor measured
        at("checking the length");
        let dur = c.durationSeconds || it.durationSeconds;
        if (!(dur > 0) && this.deps.readDuration) dur = (await this.deps.readDuration(c.uri).catch(() => null)) ?? 0;
        if (!(dur > 0)) throw new Error("could not read the length of this video");
        if (dur > MAX_EACH_SECONDS) throw new Error("each video can be at most 30 minutes");
        const others = this.items.filter((i) => i.localId !== localId && i.state !== "error").map((i) => ({ durationSeconds: i.durationSeconds }));
        const fit = canAdd(others, dur);
        if (!fit.ok) throw new Error(fit.reason.toLowerCase().includes("60") ? "a campaign can have at most 60 minutes of footage" : fit.reason);
        at("checking the size");
        if (c.sizeBytes > MAX_BYTES) throw new Error("that video is too large");
        this.patch(localId, { note: c.note, compressedUri: c.uri, sizeBytes: c.sizeBytes, width: c.width || it.width, height: c.height || it.height, durationSeconds: dur, footageId: undefined, tusVideoUrl: null, tusThumbUrl: null });
      }
      this.patch(localId, { state: "uploading" });
      it = get()!;
      // 2. register: the database reserves the minutes and gives the paths
      if (!it.footageId) {
        at("registering the video");
        const r = await this.deps.register(it.durationSeconds, it.width, it.height, it.sizeBytes!);
        if (dead()) { await this.deps.remove(r.id).catch(() => {}); return; }
        this.patch(localId, { footageId: r.id, videoPath: r.storage_path, thumbPath: r.thumb_path });
        it = get()!;
      }
      // 3. thumbnail (a bonus: a failure here never fails the video)
      if (!it.thumbUri && it.thumbPath) {
        at("making the thumbnail");
        const t = await this.deps.thumbnail(it.compressedUri!).catch(() => null);
        if (t) this.patch(localId, { thumbUri: t.uri });
        it = get()!;
        if (t) {
          try {
            await tusUpload(this.deps.makeIO(t.uri, t.sizeBytes), { endpoint: this.deps.endpoint, size: t.sizeBytes, bucket: this.deps.bucket, objectName: it.thumbPath!, contentType: "image/jpeg", resumeUrl: it.tusThumbUrl, onUrl: (u) => this.patch(localId, { tusThumbUrl: u }), isCancelled: dead, maxAttempts: 4 });
          } catch (e) { if (e instanceof TusError && e.message === "cancelled") return; /* the video can do without it */ }
        }
      }
      // 4. the video, in resumable chunks
      it = get()!;
      at("uploading the video");
      await tusUpload(this.deps.makeIO(it.compressedUri!, it.sizeBytes!), {
        endpoint: this.deps.endpoint, size: it.sizeBytes!, bucket: this.deps.bucket, objectName: it.videoPath!, contentType: "video/mp4",
        resumeUrl: it.tusVideoUrl, onUrl: (u) => this.patch(localId, { tusVideoUrl: u }),
        onProgress: (sent, total) => { if (!dead()) this.patch(localId, { progress: 1 / 3 + (2 / 3) * (sent / total) }); }, isCancelled: dead,
      });
      if (dead()) return;
      // 5. the database checks the file is really there
      at("finishing");
      await this.deps.complete(it.footageId!);
      this.patch(localId, { state: "done", progress: 1, stage: "ready", error: undefined, rawError: undefined });
      const done = get();
      if (done?.compressedUri && done.compressedUri !== done.sourceUri) await this.deps.deleteFile(done.compressedUri).catch(() => {});
      if (done?.thumbUri) await this.deps.deleteFile(done.thumbUri).catch(() => {});
      this.patch(localId, { compressedUri: undefined, thumbUri: undefined });
    } catch (e) {
      const it = get();
      if (!it || (e instanceof TusError && e.message === "cancelled")) return;
      const fatal = e instanceof TusError ? e.fatal : false;
      // a refusal from the database (limits, frozen, not ready) or a dead upload: give the minutes back and show the reason
      if (it.footageId && fatal) await this.deps.fail(it.footageId).catch(() => {});
      const raw = String((e as Error)?.message ?? e).slice(0, 300);
      // never silent: the message names the step that failed and why
      this.patch(localId, { state: "error", stage, rawError: raw, error: `Stopped while ${stage}. ${friendlyUploadError(raw)}`, ...(fatal ? { footageId: undefined } : {}) });
    }
  }
}

export function friendlyUploadError(message: string | undefined): string {
  const m = (message ?? "").toLowerCase();
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
