/**
 * Handles deep links coming back from the native DropDay Camera app.
 *
 * The native camera uploads the recorded video to Supabase storage,
 * then opens a URL like:
 *   rork-fgum9ff0goqjv4vh7u4xf://edit?videoUrl=<public_url>&caption=<text>
 *
 * This handler parses the params and routes to the Expo edit screen.
 */

export function redirectSystemPath({
  path,
  initial,
}: { path: string; initial: boolean }) {
  if (path.startsWith("/edit")) {
    try {
      // path looks like "/edit?videoUrl=...&caption=..."
      const queryStart = path.indexOf("?");
      if (queryStart === -1) return "/edit";

      const params = new URLSearchParams(path.slice(queryStart));
      const videoUrl = params.get("videoUrl");
      const caption = params.get("caption");

      if (videoUrl) {
        const editParams = new URLSearchParams();
        editParams.set("videoUrl", videoUrl);
        if (caption) editParams.set("caption", caption);
        return `/edit?${editParams.toString()}`;
      }
    } catch {
      // If parsing fails, just go to edit without params
    }
    return "/edit";
  }

  if (path.startsWith("/feed") || path === "/") {
    return "/";
  }

  return "/";
}
