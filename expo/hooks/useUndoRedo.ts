import { useCallback, useRef, useState } from "react";
import type { DraftClip, TextOverlay } from "@/providers/PostsProvider";

const MAX_STEPS = 50;

export interface EditorSnapshot {
  clips: DraftClip[];
  textOverlays: TextOverlay[];
}

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

/**
 * Undo/Redo hook for the video editor.
 *
 * Stores snapshots of `clips` and `textOverlays` in a ref-based stack
 * so that push/undo/redo operations are synchronous and race-free.
 * `canUndo`/`canRedo` are reactive state for UI bindings.
 */
export function useUndoRedo() {
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  /** Push a snapshot onto the undo stack. Clears the redo stack. */
  const pushSnapshot = useCallback(
    (clips: DraftClip[], textOverlays: TextOverlay[]) => {
      const snapshot: EditorSnapshot = {
        clips: deepClone(clips),
        textOverlays: deepClone(textOverlays),
      };
      const next = [
        ...undoStackRef.current.slice(-(MAX_STEPS - 1)),
        snapshot,
      ];
      undoStackRef.current = next;
      redoStackRef.current = [];
      syncFlags();
    },
    [syncFlags],
  );

  /** Pop the latest undo snapshot and return it, or null if empty. */
  const undo = useCallback((): EditorSnapshot | null => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return null;
    const snapshot = stack[stack.length - 1]!;
    undoStackRef.current = stack.slice(0, -1);
    syncFlags();
    return snapshot;
  }, [syncFlags]);

  /** Push current state onto the redo stack (called after undo restores). */
  const pushRedo = useCallback(
    (clips: DraftClip[], textOverlays: TextOverlay[]) => {
      redoStackRef.current = [
        ...redoStackRef.current,
        {
          clips: deepClone(clips),
          textOverlays: deepClone(textOverlays),
        },
      ];
      syncFlags();
    },
    [syncFlags],
  );

  /** Pop the latest redo snapshot and return it, or null if empty. */
  const redo = useCallback((): EditorSnapshot | null => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return null;
    const snapshot = stack[stack.length - 1]!;
    redoStackRef.current = stack.slice(0, -1);
    syncFlags();
    return snapshot;
  }, [syncFlags]);

  return { canUndo, canRedo, undo, redo, pushSnapshot, pushRedo };
}
