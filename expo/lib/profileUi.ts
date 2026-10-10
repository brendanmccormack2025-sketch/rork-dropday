/**
 * Pure helpers of the redesigned profile screens (grid metrics, avatar tint, tabs). Erasable TypeScript only (Node tests).
 */
import { AVATAR_TINTS, SIDE_MARGIN } from "../constants/design.ts";
import { hasSurvived } from "./profileVisibility.ts";

export const GRID_COLUMNS = 3;
export const GRID_GAP = 2;
/** Thumbnails are 9:16. */
export const TILE_ASPECT = 16 / 9;

/** Three equal 9:16 tiles across the screen between the side margins, 2 pt apart. */
export function gridTileSize(screenWidth: number): { width: number; height: number } {
  const width = Math.floor((screenWidth - 2 * SIDE_MARGIN - (GRID_COLUMNS - 1) * GRID_GAP) / GRID_COLUMNS);
  return { width, height: Math.round(width * TILE_ASPECT) };
}

/** The same tint for the same name. */
export function avatarTint(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_TINTS[h % AVATAR_TINTS.length]!;
}

export function avatarInitial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

export type OwnTab = "survived" | "trial" | "drafts";
export const OWN_TABS: Array<{ key: OwnTab; label: string }> = [
  { key: "survived", label: "Survived" },
  { key: "trial", label: "On Trial" },
  { key: "drafts", label: "Drafts" },
];

type TabPost = { status?: string | null; survived_at?: string | null; media_deleted_at?: string | null };

/** Own profile, per tab: Survived (forever), On Trial (testing + queued). Drafts are not posts. */
export function postsForTab<T extends TabPost>(posts: T[], tab: OwnTab): T[] {
  if (tab === "survived") return posts.filter((p) => hasSurvived(p) && !p.media_deleted_at);
  if (tab === "trial") return posts.filter((p) => p.status === "trial" || p.status === "queued");
  return [];
}

/** The tab to open first: Survived, unless there is nothing there yet but something is on trial. */
export function initialOwnTab(posts: TabPost[]): OwnTab {
  if (postsForTab(posts, "survived").length > 0) return "survived";
  return postsForTab(posts, "trial").length > 0 ? "trial" : "survived";
}

export const EMPTY_OWN_SURVIVED_TITLE = "Your wins live here.";
export const EMPTY_OWN_SURVIVED_BODY = "Put something on Trial.";
export const EMPTY_OTHER_SURVIVED = "No survived posts yet";
