// functions/index.ts — DropDay backend
//
// Video processing utilities for DropDay.
// Current approach: multi-segment recordings are stored as a JSON array
// of URLs in the posts.segments column. The client player handles
// sequential playback, making server-side merging unnecessary for the
// common case where all segments share identical encoding parameters.

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return Response.json({ ok: true, now: new Date().toISOString() });
    }

    if (url.pathname === "/health") {
      return Response.json({ status: "ok", service: "dropday-backend" });
    }

    return Response.json({ ok: true, hello: "dropday" });
  },
};
