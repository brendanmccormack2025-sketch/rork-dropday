// functions/index.ts — Trial backend
//
// Video processing utilities for Trial.
// Current approach: multi-segment recordings are stored as a JSON array
// of URLs in the posts.segments column. The client player handles
// sequential playback, making server-side merging unnecessary for the
// common case where all segments share identical encoding parameters.

// Friend invite links (https://<domain>/i/<token>): open the app when it is installed, else the App Store page.
// Environment: APP_SCHEME (the app's URL scheme, app.json "scheme"), APP_STORE_URL (the Tryal App Store page), and, for
// universal links in a later build, APPLE_APP_ID ("<TEAM ID>.<bundle identifier>"), served as the association file.
type Env = { APP_SCHEME?: string; APP_STORE_URL?: string; APPLE_APP_ID?: string };
const INVITE_TOKEN = /^[0-9a-f]{32}\.[0-9]{1,6}\.[0-9a-f]{32}$/;

function invitePage(token: string, env: Env): Response {
  const scheme = env.APP_SCHEME ?? "tryal";
  const store = env.APP_STORE_URL ?? "https://apps.apple.com/";
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Join me on Tryal</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;background:#F5F3EE;color:#0A0A0A;text-align:center;padding:64px 24px}a{display:inline-block;margin-top:20px;background:#E8291C;color:#fff;padding:14px 26px;border-radius:28px;text-decoration:none;font-weight:700}</style></head>
<body><h1>Join me on Tryal</h1><p>Opening the app…</p><a href="${store}">Get Tryal</a>
<script>var t=Date.now();location.href=${JSON.stringify(`${scheme}://invite/${token}`)};setTimeout(function(){if(Date.now()-t<2500&&!document.hidden)location.href=${JSON.stringify(store)}},1500);</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url);

    const invite = /^\/i\/([^/]+)$/.exec(url.pathname);
    if (invite) {
      const token = decodeURIComponent(invite[1]!);
      return INVITE_TOKEN.test(token) ? invitePage(token, env) : new Response("Not found", { status: 404 });
    }

    if (url.pathname === "/.well-known/apple-app-site-association" && env.APPLE_APP_ID) {
      return Response.json({ applinks: { apps: [], details: [{ appID: env.APPLE_APP_ID, paths: ["/i/*"] }] } });
    }

    if (url.pathname === "/ping") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "trial-backend" });
    }

    return Response.json({ ok: true, hello: "trial" });
  },
};
