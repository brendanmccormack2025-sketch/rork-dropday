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
export const FileSystemUploadType = NativeFS.FileSystemUploadType;
export type FileSystemUploadResult = NativeFS.FileSystemUploadResult;
export type FileSystemUploadOptions = NativeFS.FileSystemUploadOptions;

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
    // base64 payload length (each char ≈ 6 bits).
    if (uri.startsWith("data:")) {
      const base64Idx = uri.indexOf(";base64,");
      if (base64Idx !== -1) {
        const base64Data = uri.slice(base64Idx + 8);
        const estimatedSize = Math.round(base64Data.length * 0.75);
        return { exists: true, size: estimatedSize };
      }
      // Plain data URI (no base64) — still valid, just can't estimate size
      return { exists: true, size: 0 };
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

// ── uploadAsync ─────────────────────────────────────────────────────────────

/**
 * Upload a file from a local URI to a remote server.
 *
 * On native (iOS/Android), this delegates to expo-file-system's uploadAsync
 * which streams the file directly from disk — much more reliable for large
 * video files than loading the entire file into memory first.
 *
 * On web, throws a clear error since the web preview doesn't have a real
 * file system and uses data: URIs instead.
 */
export async function uploadAsync(
  url: string,
  fileUri: string,
  options?: NativeFS.FileSystemUploadOptions,
): Promise<NativeFS.FileSystemUploadResult> {
  if (Platform.OS === "web") {
    throw new Error(
      "File upload is not available in the web preview. " +
        "Use the iOS or Android app to post drops.",
    );
  }
  return NativeFS.uploadAsync(url, fileUri, options);
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
