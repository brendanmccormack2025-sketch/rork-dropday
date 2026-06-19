/**
 * Web-compatible wrapper around expo-file-system/legacy.
 *
 * expo-file-system requires native modules that don't exist in the web
 * (iframe-based React Native Web) preview. This module provides the same
 * API surface but with safe no-op / early-error fallbacks for web, so the
 * app doesn't crash with "not available on web" errors.
 */

import { Platform } from "react-native";
import * as NativeFS from "expo-file-system/legacy";

// ── Re-export constants ──────────────────────────────────────────────────────

export const EncodingType = NativeFS.EncodingType;

// ── Types ────────────────────────────────────────────────────────────────────

type FileInfo = {
  exists: boolean;
  isDirectory?: boolean;
  uri?: string;
  size?: number;
  modificationTime?: number;
  md5?: string;
};

// ── documentDirectory ────────────────────────────────────────────────────────

/** On web, returns a dummy path. Native calls that consume this path will be
 *  no-ops (see the individual function wrappers below). */
export const documentDirectory: string =
  Platform.OS === "web"
    ? "file:///web-fs-not-available/"
    : NativeFS.documentDirectory ?? "";

export const cacheDirectory: string =
  Platform.OS === "web"
    ? "file:///web-fs-not-available/"
    : NativeFS.cacheDirectory ?? "";

// ── getInfoAsync ─────────────────────────────────────────────────────────────

export async function getInfoAsync(
  uri: string,
  options?: { size?: boolean; md5?: boolean },
): Promise<FileInfo> {
  if (Platform.OS === "web") {
    // On the web preview, media pickers return inline data: URIs
    // (e.g. data:image/png;base64,...). These contain the actual
    // image/video data and are valid — estimate the size from the
    // base64 payload length (each char ≈ 6 bits) or the URI length.
    if (uri.startsWith("data:")) {
      const commaIdx = uri.indexOf(",");
      if (commaIdx === -1) return { exists: true, size: 0 };
      const payload = uri.slice(commaIdx + 1);
      const base64Idx = uri.indexOf(";base64,");
      if (base64Idx !== -1) {
        // Base64: each char encodes 6 bits → 0.75 bytes per char
        const estimatedSize = Math.round(payload.length * 0.75);
        return { exists: true, size: Math.max(estimatedSize, 1) };
      }
      // URL-encoded data URI (no base64 marker) — estimate from URI length.
      // URL decoding expands percent-encoded bytes, so payload length is a
      // reasonable lower bound. Never return 0 to avoid the "empty file" guard.
      const estimatedSize = Math.max(Math.round(payload.length * 0.5), 1);
      return { exists: true, size: estimatedSize };
    }
    return { exists: false, size: 0 };
  }
  return NativeFS.getInfoAsync(uri, options);
}

// ── makeDirectoryAsync ───────────────────────────────────────────────────────

export async function makeDirectoryAsync(
  _path: string,
  _options?: { intermediates?: boolean },
): Promise<void> {
  if (Platform.OS === "web") {
    // Web has no real file system — silently succeed so the caller
    // can continue its code path and hit a clear error later if it
    // actually depends on the directory existing.
    return;
  }
  return NativeFS.makeDirectoryAsync(_path, _options);
}

// ── copyAsync ────────────────────────────────────────────────────────────────

export async function copyAsync(_options: {
  from: string;
  to: string;
}): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error(
      "File copy is not available in the web preview. " +
        "Use the iOS or Android app to post drops.",
    );
  }
  return NativeFS.copyAsync(_options);
}

// ── readAsStringAsync ────────────────────────────────────────────────────────

export async function readAsStringAsync(
  uri: string,
  options?: NativeFS.ReadingOptions,
): Promise<string> {
  if (Platform.OS === "web") {
    throw new Error(
      "File read is not available in the web preview. " +
        "Use the iOS or Android app.",
    );
  }
  return NativeFS.readAsStringAsync(uri, options);
}

// ── writeAsStringAsync ───────────────────────────────────────────────────────

export async function writeAsStringAsync(
  uri: string,
  contents: string,
  options?: NativeFS.WritingOptions,
): Promise<void> {
  if (Platform.OS === "web") {
    throw new Error(
      "File write is not available in the web preview. " +
        "Use the iOS or Android app.",
    );
  }
  return NativeFS.writeAsStringAsync(uri, contents, options);
}

// ── deleteAsync ──────────────────────────────────────────────────────────────

export async function deleteAsync(
  _path: string,
  _options?: { idempotent?: boolean },
): Promise<void> {
  if (Platform.OS === "web") {
    // No-op on web — there's nothing to clean up.
    return;
  }
  return NativeFS.deleteAsync(_path, _options);
}
