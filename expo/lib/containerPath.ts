/**
 * iOS gives the app's data folder a NEW name on every app update (TestFlight or App Store install):
 *   /var/mobile/Containers/Data/Application/<A>/Documents/drafts/x.mov  ->  .../Application/<B>/Documents/drafts/x.mov
 * The files move with it, but absolute paths saved before the update (drafts, pending uploads) point at the old name,
 * so a saved draft looked "deleted" after an update. Stored JSON is rebased onto the current folder when it is read.
 *
 * Pure; erasable TypeScript only so the Node tests can run it.
 */

const CONTAINER = /\/Data\/Application\/[0-9A-Fa-f-]{8,}\//g;

/** The current container folder name, from documentDirectory ("file:///var/mobile/Containers/Data/Application/<id>/Documents/"). */
export function containerIdOf(documentDirectory: string | null | undefined): string | null {
  const m = documentDirectory?.match(/\/Data\/Application\/([0-9A-Fa-f-]{8,})\//);
  return m ? m[1]! : null;
}

/** Every path in `text` (a single uri or stored JSON) pointed at the current container. Unchanged when unknown (web, Android). */
export function rebaseToContainer(text: string, documentDirectory: string | null | undefined): string {
  const id = containerIdOf(documentDirectory);
  if (!id || !text) return text;
  return text.replace(CONTAINER, `/Data/Application/${id}/`);
}

type DraftLike = {
  id: string;
  clips: Array<{ uri: string }>;
  coverThumbnailUri?: string;
  editState?: { state: { sourceUri?: string } } | undefined;
};

/** Where a saved local file can be now: its place under the current Documents folder, then the draft's own folder. */
export function draftFileCandidates(uri: string, draftId: string, documentDirectory: string): string[] {
  const out: string[] = [];
  const inDocs = uri.match(/\/Documents\/(.+)$/)?.[1];
  if (inDocs) out.push(`${documentDirectory}${inDocs}`);
  const name = uri.split(/[/?#]/).filter(Boolean).pop();
  if (name) out.push(`${documentDirectory}drafts/${draftId}/${name}`, `${documentDirectory}thumbnails/${name}`);
  return [...new Set(out)].filter((c) => c !== uri);
}

/**
 * Drafts whose files are not where the saved path says get pointed at the file wherever it is now (a path from before
 * an app update in any form, a moved folder). A file that cannot be found anywhere is left as it was. Returns the
 * drafts and whether anything changed. `exists` is the file check (getInfoAsync on device).
 */
export async function healDraftFiles<T extends DraftLike>(
  drafts: T[],
  documentDirectory: string | null | undefined,
  exists: (uri: string) => Promise<boolean>,
): Promise<{ drafts: T[]; changed: boolean }> {
  if (!documentDirectory) return { drafts, changed: false };
  let changed = false;
  const known = new Map<string, string>();
  const fix = async (uri: string | undefined, draftId: string): Promise<string | undefined> => {
    if (!uri || /^(https?|data|blob):/.test(uri)) return uri;
    const hit = known.get(uri);
    if (hit) return hit;
    let found = uri;
    if (!(await exists(uri))) {
      for (const c of draftFileCandidates(uri, draftId, documentDirectory)) {
        if (await exists(c)) {
          found = c;
          break;
        }
      }
    }
    known.set(uri, found);
    if (found !== uri) changed = true;
    return found;
  };
  const out: T[] = [];
  for (const d of drafts) {
    const clips = [];
    for (const c of d.clips) clips.push({ ...c, uri: (await fix(c.uri, d.id)) ?? c.uri });
    const cover = await fix(d.coverThumbnailUri, d.id);
    const src = d.editState?.state?.sourceUri;
    const fixedSrc = await fix(src, d.id);
    out.push({
      ...d,
      clips,
      ...(d.coverThumbnailUri !== undefined ? { coverThumbnailUri: cover } : {}),
      ...(d.editState && fixedSrc !== src ? { editState: { ...d.editState, state: { ...d.editState.state, sourceUri: fixedSrc } } } : {}),
    });
  }
  return { drafts: changed ? out : drafts, changed };
}
