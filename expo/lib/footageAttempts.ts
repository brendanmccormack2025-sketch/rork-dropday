/**
 * The last footage attempts, kept on the phone for the owner's debug screen (app/footage-debug.tsx): which step each one reached, the plain and the
 * raw error, the length and the file sizes. Pure list handling (the saving is in lib/footageRuntime.ts). Nothing here is sent anywhere.
 */
import type { UploadItem } from "./footageUpload.ts";

export const MAX_ATTEMPTS = 20;

export type Attempt = {
  id: string;
  at: number;
  name: string;
  stage: string;
  state: string;
  error?: string;
  rawError?: string;
  note?: string;
  durationSeconds?: number;
  sourceSize?: number;
  sizeBytes?: number;
  width?: number;
  height?: number;
  scheme?: string;
};

export function attemptFromItem(i: UploadItem): Attempt {
  return {
    id: i.localId, at: i.createdAt ?? Date.now(), name: i.name, stage: i.stage ?? i.state, state: i.state, error: i.error, rawError: i.rawError, note: i.note,
    durationSeconds: i.durationSeconds, sourceSize: i.sourceSize, sizeBytes: i.sizeBytes, width: i.width, height: i.height, scheme: i.sourceScheme,
  };
}

/** Insert or replace one attempt; newest first; at most 20. */
export function upsertAttempt(list: Attempt[], a: Attempt): Attempt[] {
  const rest = list.filter((x) => x.id !== a.id);
  return [a, ...rest].sort((x, y) => y.at - x.at).slice(0, MAX_ATTEMPTS);
}

const mb = (b?: number): string => (b && b > 0 ? `${(b / 1048576).toFixed(1)} MB` : "unknown");
const len = (s?: number): string => (s && s > 0 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : "unknown");

/** The lines shown for one attempt. */
export function describeAttempt(a: Attempt): string[] {
  const out = [
    `step: ${a.stage} (${a.state})`,
    `length: ${len(a.durationSeconds)} · picked file: ${mb(a.sourceSize)} · uploaded file: ${mb(a.sizeBytes)}${a.width && a.height ? ` · ${a.width}×${a.height}` : ""}`,
  ];
  if (a.scheme) out.push(`picked as: ${a.scheme}://`);
  if (a.error) out.push(`message: ${a.error}`);
  if (a.rawError) out.push(`reason: ${a.rawError}`);
  if (a.note) out.push(`note: ${a.note}`);
  return out;
}
