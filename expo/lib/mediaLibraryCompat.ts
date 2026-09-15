/**
 * Web-compatible wrapper around expo-media-library.
 *
 * SDK 57 removed expo-media-library's web implementation — requiring the
 * module in a web bundle throws "Cannot find native module
 * 'ExpoMediaLibraryNext'" at module-eval time. This wrapper never evaluates
 * the native module on web: it lazy-requires it on native platforms only and
 * returns safe fallbacks for web callers.
 */

import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";

type MediaLibraryModule = typeof import("expo-media-library");

/** Local structural copy of expo-media-library's PermissionResponse — the
 *  real type isn't re-exported from the package index and the subpath is
 *  blocked by the package's exports map. Members match the upstream shape,
 *  so real responses assign to this type cleanly. */
type PermissionResponse = {
  granted: boolean;
  canAskAgain: boolean;
  status: "granted" | "denied" | "undetermined" | "restricted";
  expires: "never" | number;
  accessPrivileges?: "all" | "limited" | "none";
};

let cached: MediaLibraryModule | null = null;

/** Load expo-media-library on native platforms only. Returns null on web. */
export function getMediaLibrary(): MediaLibraryModule | null {
  if (Platform.OS === "web") return null;
  if (!cached) {
    // Lazy require keeps the native module out of module-eval on web.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require("expo-media-library") as MediaLibraryModule;
  }
  return cached;
}

/** Stub returned to web callers — the gallery doesn't exist in the browser. */
const WEB_DENIED: PermissionResponse = {
  granted: false,
  canAskAgain: false,
  status: "denied",
  expires: "never",
};

// ── saveToLibraryAsync ───────────────────────────────────────────────────────

export async function saveToLibraryAsync(uri: string): Promise<void> {
  const ml = getMediaLibrary();
  if (!ml) return; // Web: nothing to save to, treat as a no-op.
  return ml.saveToLibraryAsync(uri);
}

// ── useMediaLibraryPermissions ───────────────────────────────────────────────

/** Drop-in replacement for MediaLibrary.usePermissions() that is safe on web.
 *  On web it returns [null, denied-stub request] so callers' guard clauses
 *  behave the same as an un-granted native permission. */
export function useMediaLibraryPermissions(
  options?: { get?: boolean },
): [
  PermissionResponse | null,
  (options?: { writeOnly?: boolean }) => Promise<PermissionResponse>,
] {
  const [permission, setPermission] = useState<PermissionResponse | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") return;
    if (options?.get === false) return;
    let cancelled = false;
    getMediaLibrary()
      ?.getPermissionsAsync()
      .then((p: PermissionResponse) => {
        if (!cancelled) setPermission(p);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [options?.get]);

  const request = useCallback(async (): Promise<PermissionResponse> => {
    const ml = getMediaLibrary();
    if (!ml) return WEB_DENIED;
    const result = await ml.requestPermissionsAsync();
    setPermission(result);
    return result;
  }, []);

  return [permission, request];
}
