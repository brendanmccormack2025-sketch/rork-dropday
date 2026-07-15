import { requireAuth, createAdminClient, AuthError } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const BUCKET = "drops";

/**
 * Extracts the storage object path from a public or signed URL.
 * Returns null if the URL doesn't match the expected Supabase Storage format.
 */
function extractStoragePath(url: string): string | null {
  if (!url) return null;
  const publicPrefix = `/storage/v1/object/public/${BUCKET}/`;
  const pubIdx = url.indexOf(publicPrefix);
  if (pubIdx !== -1) {
    return url.slice(pubIdx + publicPrefix.length).split("?")[0]!;
  }
  const signPrefix = `/storage/v1/object/sign/${BUCKET}/`;
  const signIdx = url.indexOf(signPrefix);
  if (signIdx !== -1) {
    return url.slice(signIdx + signPrefix.length).split("?")[0]!;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const user = await requireAuth(req);
    const admin = createAdminClient();
    const userId = user.userId;

    // ── 1. Collect all storage paths for the user's media files ──────────
    const pathsToDelete: string[] = [];

    // Fetch all posts by this user (Drops + reactions)
    const { data: posts, error: postsErr } = await admin
      .from("posts")
      .select("media_url, segments, thumbnail_url")
      .eq("user_id", userId);

    if (postsErr) {
      console.error("[delete-user] failed to fetch user posts", postsErr.message);
      // Continue anyway — DB cascade will remove rows, we just miss storage cleanup
    }

    if (posts) {
      for (const post of posts) {
        const row = post as Record<string, unknown>;
        const mediaUrl = row.media_url as string | null;
        if (mediaUrl) {
          const p = extractStoragePath(mediaUrl);
          if (p) pathsToDelete.push(p);
        }
        const segments = row.segments as string[] | null;
        if (segments) {
          for (const segUrl of segments) {
            const p = extractStoragePath(segUrl);
            if (p) pathsToDelete.push(p);
          }
        }
        const thumbUrl = row.thumbnail_url as string | null;
        if (thumbUrl) {
          const p = extractStoragePath(thumbUrl);
          if (p) pathsToDelete.push(p);
        }
      }
    }

    // Also list and delete any remaining files under the user's prefix
    // (catches avatars or files not referenced in posts)
    try {
      const { data: listedFiles, error: listErr } = await admin
        .storage
        .from(BUCKET)
        .list(userId, { limit: 1000 });

      if (!listErr && listedFiles) {
        for (const file of listedFiles) {
          if (file.name) {
            pathsToDelete.push(`${userId}/${file.name}`);
          }
        }
      }
    } catch (listErr) {
      console.warn("[delete-user] storage list error (non-fatal)", (listErr as Error)?.message);
    }

    // ── 2. Delete media files from storage (best-effort) ─────────────────
    if (pathsToDelete.length > 0) {
      // Deduplicate
      const uniquePaths = [...new Set(pathsToDelete)];
      const { error: storageErr } = await admin
        .storage
        .from(BUCKET)
        .remove(uniquePaths);

      if (storageErr) {
        console.warn("[delete-user] storage cleanup error (non-fatal)", storageErr.message);
      } else {
        console.log(`[delete-user] deleted ${uniquePaths.length} files from storage`);
      }
    }

    // ── 3. Delete the auth user (FK cascade removes all DB rows) ─────────
    const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);

    if (deleteErr) {
      console.error("[delete-user] admin.deleteUser failed", deleteErr.message);
      return new Response(
        JSON.stringify({ error: "Failed to delete account" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    if (err instanceof AuthError) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    console.error("[delete-user] internal error", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
