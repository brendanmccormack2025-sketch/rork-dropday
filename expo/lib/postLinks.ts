/**
 * Links on posts (supabase/migration-post-links.sql): the "Watch on <platform>" button, the tracked short link it opens, the owner's tap count.
 * Validation of the address lives in lib/creatorLinks.ts (the one place that parses links); this file only talks to the database and builds the
 * short link. The raw address is never opened from here: the app opens https://<project>/functions/v1/go/<code>, which counts the tap and redirects.
 */
import { supabase, supabaseUrl } from "@/lib/supabase";
import { openCreatorLink, VIDEO_PLATFORM_LABELS, type VideoPlatform } from "@/lib/creatorLinks";

export type PostLink = { code: string; platform: VideoPlatform };

export const CODE_RE = /^[0-9a-f]{10}$/;

/** The tracked short link for a code (null if it is not a code). */
export function trackedUrl(code: string, base: string = supabaseUrl): string | null {
  if (!CODE_RE.test(code)) return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/go/${code}`;
}

export const watchLabel = (platform: VideoPlatform): string => `Watch on ${VIDEO_PLATFORM_LABELS[platform]}`;

export function tapsLine(n: number): string | null {
  if (!Number.isFinite(n) || n <= 0) return null;
  return `This post sent ${n.toLocaleString("en-US")} ${n === 1 ? "person" : "people"} to your video.`;
}

/** Open a post's video through its tracked link. Never throws; returns whether the OS accepted it. */
export async function openPostLink(link: PostLink): Promise<boolean> {
  const url = trackedUrl(link.code);
  return url ? openCreatorLink(url) : false;
}

/** The server message for a refused link, in plain words. */
export function postLinkErrorMessage(message: string | null | undefined): string {
  return /not allowed/i.test(message ?? "") ? "Links can go to YouTube, TikTok, Instagram, X, Twitch or Spotify." : "Couldn't add the link to your post.";
}

export async function setPostVideoLink(postId: string, url: string): Promise<string> {
  const { data, error } = await supabase.rpc("set_post_video_link", { p_post: postId, p_url: url });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function clearPostVideoLink(postId: string): Promise<void> {
  const { error } = await supabase.rpc("clear_post_video_link", { p_post: postId });
  if (error) throw new Error(error.message);
}

export async function myPostLinkTaps(postId: string): Promise<number> {
  const { data, error } = await supabase.rpc("my_post_link_taps", { p_post: postId });
  if (error) return 0;
  return Number(data ?? 0);
}

// ── reading the link of posts as they appear (one small batched query, kept apart from the feed query) ──
// The feed's own query is not touched: if the migration is not applied yet the batch just finds nothing and the post shows the creator's socials.
const cache = new Map<string, PostLink | null>();
const waiting = new Map<string, Array<(l: PostLink | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let unavailableUntil = 0;

async function flush(): Promise<void> {
  timer = null;
  const ids = [...waiting.keys()];
  const callbacks = new Map(waiting);
  waiting.clear();
  const done = (id: string, l: PostLink | null) => { cache.set(id, l); for (const cb of callbacks.get(id) ?? []) cb(l); };
  if (Date.now() < unavailableUntil) { ids.forEach((id) => done(id, null)); return; }
  try {
    const { data, error } = await supabase.from("posts").select("id, link_code, link_platform").in("id", ids);
    if (error) {
      if (/link_code|link_platform|column/i.test(error.message)) unavailableUntil = Date.now() + 10 * 60_000;   // not migrated yet: do not ask again for a while
      ids.forEach((id) => done(id, null));
      return;
    }
    const found = new Map<string, PostLink>();
    for (const r of (data ?? []) as Array<{ id: string; link_code: string | null; link_platform: string | null }>) {
      if (r.link_code && CODE_RE.test(r.link_code) && r.link_platform && r.link_platform in VIDEO_PLATFORM_LABELS) found.set(r.id, { code: r.link_code, platform: r.link_platform as VideoPlatform });
    }
    ids.forEach((id) => done(id, found.get(id) ?? null));
  } catch {
    ids.forEach((id) => done(id, null));
  }
}

/** The video link of a post (null if none, or if it cannot be read). Batches the ids asked for within 40 ms into one query. */
export function getPostLink(postId: string): Promise<PostLink | null> {
  if (cache.has(postId)) return Promise.resolve(cache.get(postId) ?? null);
  return new Promise((resolve) => {
    const list = waiting.get(postId) ?? [];
    list.push(resolve);
    waiting.set(postId, list);
    if (!timer) timer = setTimeout(() => { void flush(); }, 40);
  });
}

/** After this device sets or clears a link, forget what was cached for the post. */
export function forgetPostLink(postId: string): void { cache.delete(postId); }
