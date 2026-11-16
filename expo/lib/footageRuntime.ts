/** The phone's side of footage upload: the real file, network, compression and storage behind `FootageDeps` (lib/footageUpload.ts), and the camera-roll picker. */
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as ImagePicker from "expo-image-picker";
import { getThumbnailAsync } from "expo-video-thumbnails";

import { cacheDirectory, deleteAsync, getInfoAsync, readAsStringAsync, writeAsStringAsync, EncodingType } from "@/lib/fileSystemCompat";
import { FootageUploader, type FootageDeps, type FootageInput, type Registered, type UploadItem } from "@/lib/footageUpload";
import { supabaseMediaStore } from "@/lib/mediaStore";
import { renderMerge } from "@/lib/mergeNative";
import { supabase } from "@/lib/supabase";
import type { TusIO, TusResponse } from "@/lib/tus";

const KEY = "money.footage.queue.v1";
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
    } catch {
      const size = await info(uri);
      if (!(size > 0)) throw new Error("that video could not be read");
      return { uri, sizeBytes: size, width: 0, height: 0, durationSeconds: 0 };
    }
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

/** Pick videos from the camera roll (several at once). Videos over the limits are refused by the uploader with a message. */
export async function pickFootage(): Promise<FootageInput[]> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return [];
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["videos"], allowsMultipleSelection: true, selectionLimit: 20, videoExportPreset: ImagePicker.VideoExportPreset.Passthrough, quality: 1 });
  if (res.canceled) return [];
  return res.assets.map((a, i) => ({ uri: a.uri, name: a.fileName ?? `Video ${i + 1}`, durationSeconds: (a.duration ?? 0) / 1000, width: a.width ?? 0, height: a.height ?? 0 }));
}
