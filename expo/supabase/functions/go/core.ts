// The tracked short link behind "Watch on <platform>" (supabase/migration-post-links.sql). Pure logic, tested by scripts/test-link-redirect.mjs.
//   GET /functions/v1/go/<code>   -> 302 to the post's video link, after counting the tap (once per device per 24 hours)
// What it keeps: nothing. It sends the database a salted hash (HMAC of the platform-set address + a coarse device class, with the secret LINK_SALT)
// so the database can count one tap per device per 24 hours (and cap the counted taps per link per hour); the hash is deleted after 48 hours and the address / browser are never stored,
// logged or sent anywhere. Previews made by chat apps, search engines and other bots follow the link but are not counted.

export const CODE_RE = /^[0-9a-f]{10}$/;
export const BOT_RE = /bot|crawler|spider|preview|facebookexternalhit|slurp|whatsapp|telegram|discord|slack|twitter|linkedin|embedly|pinterest|skype|headless|curl|wget|python-requests|okhttp|go-http-client/i;

/** The code from /functions/v1/go/<code> (or ?c=<code>); null when it does not look like one. */
export function codeFromUrl(rawUrl: string): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  const fromQuery = u.searchParams.get("c");
  const fromPath = u.pathname.split("/").filter(Boolean).pop() ?? "";
  const code = (fromQuery ?? fromPath).toLowerCase();
  return CODE_RE.test(code) ? code : null;
}

/** A real person's browser GET. Not HEAD (link checkers), not a known bot or preview fetcher, and it must say what it is. */
export function isCountable(method: string, userAgent: string | null): boolean {
  if (method !== "GET") return false;
  const ua = (userAgent ?? "").trim();
  return ua.length > 0 && !BOT_RE.test(ua);
}

/**
 * The caller's address from what the PLATFORM sets, never from what the caller can write:
 *   1. cf-connecting-ip: set by Cloudflare in front of Supabase Edge Functions; Cloudflare overwrites any value the client sends.
 *   2. otherwise the LAST entry of x-forwarded-for: each proxy appends the address it saw to the END, so the last one comes from the nearest
 *      proxy, not from the caller. The FIRST entry is whatever the client chose to send and is never used.
 * Empty when neither exists (then the caller is counted by device class alone, which only ever undercounts).
 */
export function clientAddress(headers: Headers): string {
  const cf = (headers.get("cf-connecting-ip") ?? "").trim();
  if (cf) return cf;
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1]!;
  }
  return "";
}

/**
 * A coarse class of device + browser (ios-safari, android-chrome ...), not the free-form browser string: a caller can write any string it likes,
 * so using the whole string would let a script mint a fresh "device" per request. There are only a handful of classes.
 */
export function deviceClass(userAgent: string): string {
  const ua = userAgent.toLowerCase();
  const os = /iphone|ipad|ipod/.test(ua) ? "ios" : /android/.test(ua) ? "android" : /macintosh|mac os x/.test(ua) ? "mac" : /windows/.test(ua) ? "windows" : /linux|x11|cros/.test(ua) ? "linux" : "other";
  const browser = /edg\//.test(ua) ? "edge" : /samsungbrowser/.test(ua) ? "samsung" : /firefox|fxios/.test(ua) ? "firefox" : /chrome|crios/.test(ua) ? "chrome" : /safari/.test(ua) ? "safari" : "other";
  return `${os}-${browser}`;
}

/** HMAC-SHA256(secret, address | device class), hex, first 32 characters. Not reversible, and useless without the secret. */
export async function fingerprint(secret: string, address: string, userAgent: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${address}|${deviceClass(userAgent)}`)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Only an https address ever leaves this function (the database has already checked the site). */
export function safeTarget(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

const COMMON = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };

export type Deps = {
  lookup: (code: string) => Promise<{ url: string } | null>;
  record: (code: string, fp: string) => Promise<boolean>;
  salt: string | null;
};

export async function handle(req: Request, deps: Deps): Promise<Response> {
  const code = codeFromUrl(req.url);
  if (!code) return new Response("This link isn't available.", { status: 404, headers: { ...COMMON, "content-type": "text/plain; charset=utf-8" } });
  let target: string | null = null;
  try { target = safeTarget((await deps.lookup(code))?.url); } catch { target = null; }
  if (!target) return new Response("This link isn't available.", { status: 404, headers: { ...COMMON, "content-type": "text/plain; charset=utf-8" } });
  const ua = req.headers.get("user-agent");
  if (deps.salt && isCountable(req.method, ua)) {
    try { await deps.record(code, await fingerprint(deps.salt, clientAddress(req.headers), ua ?? "")); } catch { /* never block the redirect */ }
  }
  return new Response(null, { status: 302, headers: { ...COMMON, location: target } });
}
