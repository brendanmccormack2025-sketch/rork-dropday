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
