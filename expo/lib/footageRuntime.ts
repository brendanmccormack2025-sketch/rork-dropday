/** The phone's side of footage upload: the real file, network, compression and storage behind `FootageDeps` (lib/footageUpload.ts), and the camera-roll picker. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { getThumbnailAsync } from "expo-video-thumbnails";

import { cacheDirectory, deleteAsync, getInfoAsync, readAsStringAsync, writeAsStringAsync, EncodingType } from "@/lib/fileSystemCompat";
import { FootageUploader, type FootageDeps, type FootageInput, type Registered, type UploadItem } from "@/lib/footageUpload";
import { supabaseMediaStore } from "@/lib/mediaStore";
import { launchLibraryWithRetry } from "@/lib/pickerRetry";
import { libraryPickerOptions } from "@/lib/pickerOptions";
import { VIDEO_PICKER_ERROR_MESSAGES, classifyPickerError } from "@/lib/pickerErrors";
import { renderMerge } from "@/lib/mergeNative";
import { supabase } from "@/lib/supabase";
import { MAX_ATTEMPTS, attemptFromItem, upsertAttempt, type Attempt } from "@/lib/footageAttempts";
import type { TusIO, TusResponse } from "@/lib/tus";

const KEY = "money.footage.queue.v1";
const ATTEMPTS_KEY = "money.footage.attempts.v1";
const CHUNK_FILE = `${cacheDirectory}tus_chunk.bin`;

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

const parseHeaders = (raw: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of raw.trim().split(/\r?\n/)) { const i = line.indexOf(":"); if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim(); }
  return out;
};

/** One XHR (RN's fetch cannot send a file range): `bodyUri` is a file the XHR streams; no body for POST / HEAD. */
function xhr(method: string, url: string, headers: Record<string, string>, bodyUri?: string): Promise<TusResponse> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open(method, url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    x.onload = () => resolve({ status: x.status, headers: parseHeaders(x.getAllResponseHeaders() || "") });
    x.onerror = () => reject(new Error("network error"));
    x.ontimeout = () => reject(new Error("network timeout"));
    x.timeout = 120_000;
    if (bodyUri) (x as unknown as { send(b: unknown): void }).send({ uri: bodyUri }); else x.send();
  });
}

export function makeIO(fileUri: string, _size: number): TusIO {
  return {
    request: (method, url, headers) => xhr(method, url, headers),
    async patch(url, headers, offset, length) {
      // the chunk goes to a small file first, which the XHR then streams: no base64 in the request, never the whole video in memory
      const b64 = await readAsStringAsync(fileUri, { encoding: EncodingType.Base64, position: offset, length });
      await writeAsStringAsync(CHUNK_FILE, b64, { encoding: EncodingType.Base64 });
      try { return await xhr("PATCH", url, headers, CHUNK_FILE); } finally { await deleteAsync(CHUNK_FILE, { idempotent: true }).catch(() => {}); }
    },
    authHeaders: () => supabaseMediaStore.authHeaders(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

const deps: FootageDeps = {
  register: async (d, w, h, s) => {
    const rows = await rpc<Registered[]>("money_footage_register", { p_duration_seconds: d, p_width: w, p_height: h, p_size_bytes: s });
    return Array.isArray(rows) ? rows[0]! : (rows as unknown as Registered);
  },
  complete: (id) => rpc<void>("money_footage_complete", { p_id: id }),
  fail: (id) => rpc<void>("money_footage_fail", { p_id: id }),
  remove: (id) => rpc<void>("money_footage_remove", { p_id: id }),
  async compress(uri, onProgress) {
    // Compression goes through the existing renderer (a plain re-encode). If it cannot, the original is uploaded when it fits the size limit.
    const info = async (u: string) => { const i = await getInfoAsync(u, { size: true }); return i.exists ? Number((i as { size?: number }).size ?? 0) : 0; };
    try {
      const r = await renderMerge([uri], onProgress);
      const thumb = await getThumbnailAsync(r.uri, { time: 0 }).catch(() => null);
      return { uri: r.uri, sizeBytes: (await info(r.uri)) || 1, width: thumb?.width ?? 0, height: thumb?.height ?? 0, durationSeconds: r.durationMs / 1000 };
    } catch (e) {
      const size = await info(uri);
      if (!(size > 0)) throw new Error(`that video could not be read (${String((e as Error)?.message ?? e).slice(0, 120)})`);
      return { uri, sizeBytes: size, width: 0, height: 0, durationSeconds: 0, note: `the compressor failed (${String((e as Error)?.message ?? e).slice(0, 120)}); the original file is uploaded` };
    }
  },
  async preview(uri) {
    const t = await getThumbnailAsync(uri, { time: 0, quality: 0.4 });
    return t.uri;
  },
  async readDuration(uri) {
    try {
      const m = await import("@/modules/video-render");
      if (m.supportsTimingProbe) { const t = await m.probeTimingAsync(uri); if (t && t.durationMs > 0) return t.durationMs / 1000; }
    } catch { /* fall through */ }
    return null;
  },
  async thumbnail(uri) {
    const t = await getThumbnailAsync(uri, { time: 0, quality: 0.6 });
    const i = await getInfoAsync(t.uri, { size: true });
    return i.exists ? { uri: t.uri, sizeBytes: Number((i as { size?: number }).size ?? 0) } : null;
  },
  fileExists: async (u) => (await getInfoAsync(u)).exists,
  deleteFile: (u) => deleteAsync(u, { idempotent: true }),
  makeIO,
  endpoint: supabaseMediaStore.uploadEndpoint,
  bucket: supabaseMediaStore.bucket,
  async load() { try { return JSON.parse((await AsyncStorage.getItem(KEY)) ?? "[]") as UploadItem[]; } catch { return []; } },
  async save(items) { try { await AsyncStorage.setItem(KEY, JSON.stringify(items)); } catch { /* the list is also in memory */ } },
  newId: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
};

export const footageUploader = new FootageUploader(deps);

// ── the last attempts, for the owner's debug screen ──
export async function loadAttempts(): Promise<Attempt[]> {
  try { return JSON.parse((await AsyncStorage.getItem(ATTEMPTS_KEY)) ?? "[]") as Attempt[]; } catch { return []; }
}
export async function clearAttempts(): Promise<void> { try { await AsyncStorage.removeItem(ATTEMPTS_KEY); } catch { /* nothing to clear */ } }
let attempts: Promise<Attempt[]> | null = null;
let writing: Promise<unknown> = Promise.resolve();
async function record(a: Attempt): Promise<void> {
  attempts = (attempts ?? loadAttempts()).then((l) => upsertAttempt(l, a).slice(0, MAX_ATTEMPTS));
  const next = await attempts;
  writing = writing.then(() => AsyncStorage.setItem(ATTEMPTS_KEY, JSON.stringify(next))).catch(() => {});
}
let lastSig = new Map<string, string>();
footageUploader.subscribe((items) => {
  for (const i of items) {
    const sig = `${i.state}|${i.stage}|${i.error ?? ""}|${i.durationSeconds}|${i.sizeBytes ?? ""}`;   // not on every progress tick
    if (lastSig.get(i.localId) !== sig) { lastSig.set(i.localId, sig); void record(attemptFromItem(i)); }
  }
});
/** A problem before a video even reaches the list (the picker): it goes in the debug list too. */
export function recordPickerProblem(message: string, detail?: string): void {
  void record({ id: `pick-${Date.now()}`, at: Date.now(), name: "(picking videos)", stage: "picking videos", state: "error", error: message, rawError: detail });
}

export type PickResult = { inputs: FootageInput[]; message: string | null };

/**
 * Pick videos from the camera roll (several at once), the same way the post picker does: the shared options (lib/pickerOptions.ts: iCloud download on,
 * the file as it is in Photos, no HEVC conversion), one automatic retry for iCloud download errors (lib/pickerRetry.ts) and plain wording for every
 * failure (lib/pickerErrors.ts). iOS needs no permission for its own picker, so none is asked for first (a refused or "limited" permission used to end
 * the pick silently). Every way this can fail returns a message instead of nothing. `isCancelled` lets the screen's Cancel drop a result that arrives late.
 */
export async function pickFootage(opts: { onRetry?: (attempt: number) => void; isCancelled?: () => boolean } = {}): Promise<PickResult> {
  let res: ImagePicker.ImagePickerResult;
  try {
    res = await launchLibraryWithRetry(libraryPickerOptions({ videosOnly: true, multiple: { limit: 20 } }), opts.onRetry);
  } catch (e) {
    const why = String((e as Error)?.message ?? e).slice(0, 300);
    const kind = classifyPickerError(e);
    if (kind === "cancelled" || opts.isCancelled?.()) return { inputs: [], message: null };
    const message = kind === "unknown" ? `Couldn't open your photos: ${why.slice(0, 160)}` : VIDEO_PICKER_ERROR_MESSAGES[kind];
    recordPickerProblem(message, `${kind}: ${why}`);
    return { inputs: [], message };
  }
  if (opts.isCancelled?.() || res.canceled) return { inputs: [], message: null };
  if (!res.assets?.length) { const message = "Your photo library didn't return a video. Try picking it again."; recordPickerProblem(message, "no assets"); return { inputs: [], message }; }
  const inputs: FootageInput[] = [];
  let skipped = 0;
  res.assets.forEach((a, i) => {
    if (a.type && a.type !== "video") { skipped++; return; }
    inputs.push({ uri: a.uri, name: a.fileName ?? `Video ${i + 1}`, durationSeconds: a.duration && a.duration > 0 ? a.duration / 1000 : 0, width: a.width ?? 0, height: a.height ?? 0, sizeBytes: a.fileSize });
  });
  if (!inputs.length) { const message = "That wasn't a video. Pick a video from your camera roll."; recordPickerProblem(message, `${skipped} non-video asset(s)`); return { inputs, message }; }
  return { inputs, message: null };
}
