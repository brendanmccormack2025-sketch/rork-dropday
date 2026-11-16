/**
 * Campaign form rules, the money math and the labels on a campaign card. Pure: the database checks every rule again (campaigns_validate,
 * money_create_campaign); this gives people the message before the round trip, and the same numbers on the card and in the worked example.
 */
export const PLATFORMS = ["tiktok", "instagram", "youtube", "x"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_LABELS: Record<Platform, string> = { tiktok: "TikTok", instagram: "Instagram", youtube: "YouTube", x: "X" };
export const PAYMENT_METHODS = ["paypal", "venmo", "cashapp"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_LABELS: Record<PaymentMethod, string> = { paypal: "PayPal", venmo: "Venmo", cashapp: "Cash App" };
export const DEADLINE_DAYS = [3, 7, 14, 30] as const;
export const WINDOW_DAYS = [3, 5, 7, 10, 14] as const;
/** The quick pay buttons on the Pay screen: dollars per 1,000 views. "Other" lets the creator type any rate. */
export const PAY_PRESETS = [1, 2, 3] as const;
/** What a new campaign starts with; creators change these under "More options". */
export const DEFAULT_PLATFORMS: Platform[] = ["tiktok", "instagram", "youtube"];

export type CampaignForm = {
  title: string;
  description: string;
  /** optional: the creator's full video (YouTube, TikTok, Instagram, X, Twitch or Spotify) */
  fullVideoUrl: string;
  ratePer1k: string;
  capPerClip: string;
  totalBudget: string;
  guaranteedPerClip: string;
  platforms: Platform[];
  viewWindowDays: number;
  minViews: string;
  paymentMethod: PaymentMethod | null;
  paymentHandle: string;
  deadlineDays: number;
  maxClips: string;
  agree: boolean;
};

export const EMPTY_FORM: CampaignForm = {
  title: "", description: "", fullVideoUrl: "", ratePer1k: "", capPerClip: "", totalBudget: "", guaranteedPerClip: "",
  platforms: [...DEFAULT_PLATFORMS], viewWindowDays: 7, minViews: "1000", paymentMethod: null, paymentHandle: "", deadlineDays: 14, maxClips: "5", agree: false,
};

/** "12", "12.5", "$12.50" -> 12.5; anything else -> null. At most two decimals. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/^\$/, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  return Number(t);
}
const parseInt0 = (text: string): number | null => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : null);

/** Host of an https URL, lower case; null for anything else (http, user@host tricks, ports, no host). Same rule as money_url_host(). */
export function urlHost(url: string): string | null {
  const m = /^https:\/\/([a-z0-9][a-z0-9.-]*)(?:[/?#]|$)/.exec(url.trim().toLowerCase());
  return m ? m[1] : null;
}
/** Which site a video link belongs to, by host: the same list as link_platform_of() in the database (shared cases: scripts/post-link-cases.mjs). */
export function videoLinkPlatform(url: string): "youtube" | "tiktok" | "instagram" | "x" | "twitch" | "spotify" | null {
  const t = url.trim();
  if (!t || t.length > 500 || /\s/.test(t)) return null;
  const h = urlHost(t);
  if (!h) return null;
  const sub = (d: string) => h === d || h.endsWith(`.${d}`);
  if (sub("youtube.com") || h === "youtu.be") return "youtube";
  if (sub("tiktok.com")) return "tiktok";
  if (sub("instagram.com")) return "instagram";
  if (sub("x.com") || h === "twitter.com" || h === "www.twitter.com" || h === "mobile.twitter.com") return "x";
  if (sub("twitch.tv")) return "twitch";
  if (h === "open.spotify.com") return "spotify";
  return null;
}
export const fullVideoLinkOk = (url: string): boolean => videoLinkPlatform(url) !== null;
/** A pasted address without https:// gets it (as the post composer does). */
export const withHttps = (url: string): string => { const t = url.trim(); return t && !/^[a-z][a-z0-9+.-]*:/i.test(t) ? `https://${t}` : t; };
/** Plain text only: an email, @name or $cashtag. Same rule as money_handle_ok(). */
export function handleOk(handle: string): boolean {
  const h = handle.trim();
  return /^[A-Za-z0-9@$._+-]{2,64}$/.test(h) && /[A-Za-z0-9]/.test(h) && !/(paypal\.me|paypal\.com|venmo\.com|cash\.app|cash\.me|https?|www\.)/i.test(h);
}

export type FormErrors = Partial<Record<keyof CampaignForm | "footage", string>>;
export type CampaignArgs = {
  p_title: string; p_description: string; p_full_video_url: string | null; p_rate_per_1k: number; p_cap_per_clip: number; p_total_budget: number;
  p_guaranteed_per_clip: number; p_platforms: Platform[]; p_view_window_days: number; p_min_views: number; p_payment_method: PaymentMethod;
  p_payment_handle: string; p_deadline: string; p_max_clips_per_clipper: number; p_agree: boolean; p_footage_ids: string[];
};

export function validateCampaign(f: CampaignForm, now: Date = new Date(), footageIds: string[] = []): { ok: true; args: CampaignArgs } | { ok: false; errors: FormErrors } {
  const e: FormErrors = {};
  const title = f.title.trim(), description = f.description.trim();
  if (!title) e.title = "Give your campaign a title."; else if (title.length > 60) e.title = "The title can be at most 60 characters.";
  if (!description) e.description = "Say what to clip."; else if (description.length > 1000) e.description = "The description can be at most 1000 characters.";
  if (footageIds.length < 1) e.footage = "Add at least one video.";
  const full = withHttps(f.fullVideoUrl);
  if (full && !fullVideoLinkOk(full)) e.fullVideoUrl = "Use a YouTube, TikTok, Instagram, X, Twitch or Spotify link, or leave it empty.";
  const rate = parseMoney(f.ratePer1k), cap = parseMoney(f.capPerClip), budget = parseMoney(f.totalBudget);
  const guar = f.guaranteedPerClip.trim() === "" ? 0 : parseMoney(f.guaranteedPerClip);
  if (rate === null || rate <= 0 || rate > 1000) e.ratePer1k = "Enter the rate per 1,000 views, like 1.50.";
  if (cap === null || cap <= 0) e.capPerClip = "Enter the most one clip can earn.";
  if (budget === null || budget <= 0) e.totalBudget = "Enter your total budget.";
  if (guar === null) e.guaranteedPerClip = "Enter an amount like 3, or leave it empty.";
  if (!e.capPerClip && !e.totalBudget && !e.guaranteedPerClip && cap! + guar! > budget!) e.totalBudget = "The budget must cover at least one clip (cap plus guarantee).";
  if (f.platforms.length < 1) e.platforms = "Pick at least one platform.";
  if (f.viewWindowDays < 3 || f.viewWindowDays > 14) e.viewWindowDays = "The view window is 3 to 14 days.";
  const minViews = parseInt0(f.minViews);
  if (minViews === null) e.minViews = "Enter a whole number of views.";
  if (!f.paymentMethod) e.paymentMethod = "Pick how you pay.";
  if (!f.paymentHandle.trim()) e.paymentHandle = "Enter your handle.";
  else if (!handleOk(f.paymentHandle)) e.paymentHandle = "Plain text only: an email, @name or $cashtag. No links.";
  const maxClips = parseInt0(f.maxClips);
  if (maxClips === null || maxClips < 1 || maxClips > 50) e.maxClips = "Between 1 and 50 clips each.";
  if (!f.agree) e.agree = "Accept the Campaign Agreement to post.";
  if (Object.keys(e).length) return { ok: false, errors: e };
  return {
    ok: true,
    args: {
      p_title: title, p_description: description, p_full_video_url: full || null, p_rate_per_1k: rate!, p_cap_per_clip: cap!, p_total_budget: budget!,
      p_guaranteed_per_clip: guar!, p_platforms: f.platforms, p_view_window_days: f.viewWindowDays, p_min_views: minViews!, p_payment_method: f.paymentMethod!,
      p_payment_handle: f.paymentHandle.trim(), p_deadline: new Date(now.getTime() + f.deadlineDays * 86_400_000).toISOString(),
      p_max_clips_per_clipper: maxClips!, p_agree: true, p_footage_ids: footageIds,
    },
  };
}

/** What a clip earns, exactly as the server computes it: guarantee + (views >= minViews ? min(views / 1000 x rate, cap) : 0), to the cent. */
export function owedFor(views: number, c: { ratePer1k: number; capPerClip: number; guaranteedPerClip: number; minViews: number }): number {
  const raw = c.guaranteedPerClip + (views >= c.minViews ? Math.min((views / 1000) * c.ratePer1k, c.capPerClip) : 0);
  return Math.round(raw * 100 + 1e-9) / 100;
}

export const dollars = (n: number): string => (Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`);

/** "10,000 views = $23 per clip": the guarantee plus the per-view pay (capped), exactly what the server would owe for a clip with 10,000 views. */
export function workedExample(f: CampaignForm): string | null {
  const rate = parseMoney(f.ratePer1k);
  if (rate === null || rate <= 0) return null;
  const guar = f.guaranteedPerClip.trim() === "" ? 0 : parseMoney(f.guaranteedPerClip);
  const cap = parseMoney(f.capPerClip);
  const min = parseInt0(f.minViews) ?? 0;
  if (guar === null) return null;
  const views = 10_000;
  const total = owedFor(views, { ratePer1k: rate, capPerClip: cap ?? Number.POSITIVE_INFINITY, guaranteedPerClip: guar, minViews: min });
  const capped = cap !== null && (views / 1000) * rate > cap;
  return `${views.toLocaleString("en-US")} views = ${dollars(total)} per clip${capped ? " (the most it can earn)" : ""}`;
}

// ── campaign cards ──
export type CampaignRow = {
  id: string; creator_id: string; title: string; description: string; full_video_url: string | null; rate_per_1k: number | string; cap_per_clip: number | string;
  total_budget: number | string; guaranteed_per_clip: number | string; platforms: Platform[]; view_window_days: number; min_views: number;
  payment_method: PaymentMethod; deadline: string; max_clips_per_clipper: number; status: "open" | "paused" | "closed"; terms_frozen_at: string | null;
  budget_committed: number | string; budget_left: number | string; created_at: string;
};
export type CreatorStats = { rating_avg: number | null; rating_count: number; approved_count: number; paid_count: number; avg_days_to_pay: number | null; late_count: number } | null;

const n = (v: number | string): number => Number(v);
export const payViaLabel = (m: PaymentMethod): string => `Pays via ${PAYMENT_LABELS[m]}`;
export const ratingLabel = (s: CreatorStats): string => (s && s.rating_count > 0 && s.rating_avg !== null ? `★ ${Number(s.rating_avg).toFixed(1)} (${s.rating_count})` : "No reviews yet");
export function recordLabel(s: CreatorStats): string {
  if (!s || !s.approved_count) return "No payments yet";
  const days = s.avg_days_to_pay !== null && s.avg_days_to_pay !== undefined ? ` · avg ${Number(s.avg_days_to_pay).toFixed(1)} days` : "";
  return `Paid ${s.paid_count} of ${s.approved_count}${days}`;
}
export function profileBadge(s: CreatorStats): string {
  const stars = s && s.rating_count > 0 && s.rating_avg !== null ? `★ ${Number(s.rating_avg).toFixed(1)} (${s.rating_count})` : "★ new";
  return `${stars} · Paid ${s?.paid_count ?? 0}/${s?.approved_count ?? 0}`;
}
export function deadlineLabel(deadlineIso: string, now: Date = new Date()): string {
  const ms = new Date(deadlineIso).getTime() - now.getTime();
  if (!(ms > 0)) return "Closed";
  const days = Math.floor(ms / 86_400_000), hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `Closes in ${days} d ${hours} h` : `Closes in ${hours} h`;
}
export function cardModel(c: CampaignRow, stats: CreatorStats, now: Date = new Date()) {
  const guar = n(c.guaranteed_per_clip);
  return {
    id: c.id,
    title: c.title,
    rate: `${dollars(n(c.rate_per_1k))} per 1,000 views`,
    cap: `up to ${dollars(n(c.cap_per_clip))} per clip`,
    guarantee: guar > 0 ? `${dollars(guar)} guaranteed per clip` : null,
    budgetLeft: `${dollars(n(c.budget_left))} left of ${dollars(n(c.total_budget))}`,
    platforms: c.platforms.map((p) => PLATFORM_LABELS[p]).join(" · "),
    payVia: payViaLabel(c.payment_method),
    rating: ratingLabel(stats),
    record: recordLabel(stats),
    deadline: deadlineLabel(c.deadline, now),
  };
}

export type SortKey = "newest" | "rate" | "rating";
export function sortCampaigns<T extends { row: CampaignRow; stats: CreatorStats }>(items: T[], key: SortKey): T[] {
  const out = items.slice();
  if (key === "newest") out.sort((a, b) => b.row.created_at.localeCompare(a.row.created_at));
  else if (key === "rate") out.sort((a, b) => n(b.row.rate_per_1k) - n(a.row.rate_per_1k) || b.row.created_at.localeCompare(a.row.created_at));
  else out.sort((a, b) => (b.stats?.rating_avg ?? -1) - (a.stats?.rating_avg ?? -1) || (b.stats?.rating_count ?? 0) - (a.stats?.rating_count ?? 0) || b.row.created_at.localeCompare(a.row.created_at));
  return out;
}

/** The server's refusals, in words a person can act on. */
export function moneyErrorMessage(message: string | undefined | null): string {
  const m = (message ?? "").toLowerCase();
  if (m.includes("not allowed on tryal")) return "This contains words that are not allowed on Tryal.";
  if (m.includes("overdue payment")) return "You have an overdue payment. Resolve it before posting a new campaign.";
  if (m.includes("not open")) return "This campaign is no longer open.";
  if (m.includes("cannot join") || m.includes("cannot join your own")) return "You can't join this campaign.";
  if (m.includes("not available for this account")) return "Money isn't available for this account.";
  if (m.includes("tick every rule")) return "Tick every box to continue.";
  if (m.includes("full video link")) return "Use a YouTube, TikTok, Instagram, X, Twitch or Spotify link for the full video.";
  if (m.includes("add at least one video")) return "Add at least one video.";
  if (m.includes("missing or still uploading")) return "Some videos are still uploading. Wait until they finish.";
  if (m.includes("minutes of footage")) return "A campaign can have at most 60 minutes of footage.";
  if (m.includes("payment handle")) return "Plain text only for the payment handle: an email, @name or $cashtag.";
  if (m.includes("deadline")) return "The deadline must be between 1 hour and a year from now.";
  return "Something went wrong. Check your connection and try again.";
}
