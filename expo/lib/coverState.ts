/**
 * Module-level bridge for passing cover thumbnail selection
 * from CoverPicker back to the edit screen without re-mounting.
 */
export const coverState: {
  pendingAction: "save-draft" | "publish" | null;
  resultThumbnailUri: string | null;
  resultThumbnailMs: number;
} = {
  pendingAction: null,
  resultThumbnailUri: null,
  resultThumbnailMs: 0,
};
