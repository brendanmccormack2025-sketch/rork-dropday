/**
 * Resumable uploads (the TUS 1.0 protocol Supabase Storage speaks at /storage/v1/upload/resumable). Pure: all network and file access goes through
 * the injected `TusIO`, so the whole protocol (create, resume from a saved URL, ask the server where it is, send 6 MiB chunks, retry with backoff after
 * a dropped connection, start over when the server forgot the upload) is tested without a phone. The app's real IO is in lib/footageUpload.ts.
 */
export const TUS_CHUNK = 6 * 1024 * 1024; // Supabase requires exactly 6 MiB chunks (the last one may be smaller)

export type TusResponse = { status: number; headers: Record<string, string> };
export type TusIO = {
  /** POST (create) or HEAD (ask the offset): no body. Header names in the response are lower case. */
  request(method: "POST" | "HEAD", url: string, headers: Record<string, string>): Promise<TusResponse>;
  /** PATCH `length` bytes of the file starting at `offset`. */
  patch(url: string, headers: Record<string, string>, offset: number, length: number): Promise<TusResponse>;
  /** Fresh auth headers on every call (the access token can be refreshed between chunks). */
  authHeaders(): Promise<Record<string, string>>;
  sleep(ms: number): Promise<void>;
};

export type TusOptions = {
  endpoint: string;
  size: number;
  bucket: string;
  objectName: string;
  contentType: string;
  /** a URL saved by an earlier attempt: used to continue where the server says it is */
  resumeUrl?: string | null;
  onUrl?: (url: string) => void;
  onProgress?: (sent: number, total: number) => void;
  isCancelled?: () => boolean;
  maxAttempts?: number; // consecutive failures before giving up (default 8)
};

export class TusError extends Error {
  readonly fatal: boolean;
  constructor(message: string, fatal: boolean) { super(message); this.fatal = fatal; }
}

const b64 = (s: string): string => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
export const tusMetadata = (m: Record<string, string>): string => Object.entries(m).map(([k, v]) => `${k} ${b64(v)}`).join(",");
/** 1 s, 2 s, 4 s ... capped at 30 s */
export const backoffMs = (attempt: number): number => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1));
/** the byte ranges still to send from `offset` */
export function chunkPlan(size: number, offset: number): Array<{ offset: number; length: number }> {
  const out: Array<{ offset: number; length: number }> = [];
  for (let o = offset; o < size; o += TUS_CHUNK) out.push({ offset: o, length: Math.min(TUS_CHUNK, size - o) });
  return out;
}

const hdr = (r: TusResponse, k: string): string | undefined => r.headers[k.toLowerCase()];
const absolute = (endpoint: string, location: string): string => (/^https?:\/\//i.test(location) ? location : new URL(location, endpoint).toString());

export async function tusUpload(io: TusIO, o: TusOptions): Promise<void> {
  if (!(o.size > 0)) throw new TusError("empty file", true);
  const maxAttempts = o.maxAttempts ?? 8;
  const base = { "Tus-Resumable": "1.0.0" };
  let url = o.resumeUrl ?? null;
  let offset = 0;
  let failures = 0;
  const fail = async (why: string): Promise<void> => {
    failures++;
    if (failures >= maxAttempts) throw new TusError(`upload failed: ${why}`, false);
    await io.sleep(backoffMs(failures));
  };
  const create = async (): Promise<void> => {
    for (;;) {
      if (o.isCancelled?.()) throw new TusError("cancelled", true);
      try {
        const r = await io.request("POST", o.endpoint, {
          ...(await io.authHeaders()), ...base, "Upload-Length": String(o.size), "x-upsert": "false",
          "Upload-Metadata": tusMetadata({ bucketName: o.bucket, objectName: o.objectName, contentType: o.contentType, cacheControl: "3600" }),
        });
        const loc = hdr(r, "location");
        if (r.status === 201 && loc) { url = absolute(o.endpoint, loc); offset = 0; o.onUrl?.(url); return; }
        if (r.status === 401 || r.status === 403) throw new TusError("not allowed to upload", true);
        if (r.status === 400 || r.status === 413) throw new TusError(`the server refused the upload (${r.status})`, true);
        if (r.status === 409) { // the object already exists (an earlier attempt finished): nothing left to send
          offset = o.size; return;
        }
        await fail(`create ${r.status}`);
      } catch (e) {
        if (e instanceof TusError && e.fatal) throw e;
        await fail((e as Error).message);
      }
    }
  };
  const ask = async (): Promise<boolean> => { // true = asked; false = the server does not know this upload any more
    const r = await io.request("HEAD", url!, { ...(await io.authHeaders()), ...base });
    if (r.status === 404 || r.status === 410 || r.status === 403) return false;
    if (r.status >= 200 && r.status < 300) {
      const off = Number(hdr(r, "upload-offset"));
      if (Number.isFinite(off) && off >= 0) { offset = Math.min(off, o.size); return true; }
    }
    throw new Error(`HEAD ${r.status}`);
  };

  if (url) {
    try { if (!(await ask())) { url = null; } } catch { /* ask again below through the normal loop */ }
  }
  if (!url) await create();
  o.onProgress?.(offset, o.size);

  while (offset < o.size) {
    if (o.isCancelled?.()) throw new TusError("cancelled", true);
    const length = Math.min(TUS_CHUNK, o.size - offset);
    try {
      const r = await io.patch(url!, { ...(await io.authHeaders()), ...base, "Content-Type": "application/offset+octet-stream", "Upload-Offset": String(offset) }, offset, length);
      if (r.status === 204 || r.status === 200) {
        const next = Number(hdr(r, "upload-offset"));
        offset = Number.isFinite(next) && next > offset ? Math.min(next, o.size) : offset + length;
        failures = 0;
        o.onProgress?.(offset, o.size);
        continue;
      }
      if (r.status === 401 || r.status === 403) throw new TusError("not allowed to upload", true);
      if (r.status === 404 || r.status === 410) { await create(); continue; } // the server forgot it: start again
      if (r.status === 409) { // out of step with the server: ask where it is
        try { if (!(await ask())) await create(); } catch { await fail("offset"); }
        continue;
      }
      await fail(`patch ${r.status}`);
      try { if (!(await ask())) await create(); } catch { /* the loop tries again */ }
    } catch (e) {
      if (e instanceof TusError && e.fatal) throw e;
      await fail((e as Error).message);
      try { if (!(await ask())) await create(); } catch { /* the loop tries again */ }
    }
  }
}
