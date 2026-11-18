/**
 * Where campaign footage lives, behind one small interface, so the provider can change (Supabase Storage now; another store later) without touching the
 * screens. The bucket is private: nobody reads a file except through a short-lived signed URL, and the database only signs for the creator and the
 * clippers who joined the campaign (the Storage read policy in migration-money-footage.sql).
 */
import { supabase, supabaseUrl, supabaseAnonKey } from "@/lib/supabase";

export const FOOTAGE_BUCKET = "campaign-footage";

export interface MediaStore {
  /** The resumable-upload endpoint and the bucket (the upload itself is lib/tus.ts). */
  readonly uploadEndpoint: string;
  readonly bucket: string;
  /** Fresh auth headers for an upload request. */
  authHeaders(): Promise<Record<string, string>>;
  /** A short-lived read URL for one stored file, or null if this person may not read it. */
  signedUrl(path: string, seconds?: number): Promise<string | null>;
  /** several at once (the segments a clipper is about to play); a path that may not be read comes back null */
  signedUrls(paths: string[], seconds?: number): Promise<Array<string | null>>;
}

export const supabaseMediaStore: MediaStore = {
  uploadEndpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
  bucket: FOOTAGE_BUCKET,
  async authHeaders() {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) throw new Error("not signed in");
    return { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey };
  },
  async signedUrl(path, seconds = 3600) {
    const { data, error } = await supabase.storage.from(FOOTAGE_BUCKET).createSignedUrl(path, seconds);
    return error || !data ? null : data.signedUrl;
  },
  async signedUrls(paths, seconds = 3600) {
    if (!paths.length) return [];
    const { data, error } = await supabase.storage.from(FOOTAGE_BUCKET).createSignedUrls(paths, seconds);
    if (error || !data) return paths.map(() => null);
    const byPath = new Map(data.map((d) => [d.path, d.signedUrl ?? null]));
    return paths.map((p) => byPath.get(p) ?? null);
  },
};
