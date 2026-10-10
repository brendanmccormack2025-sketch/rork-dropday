import { supabase } from "@/lib/supabase";
import type { SendProgress } from "@/lib/watchReport";

/** One write of the viewer's cumulative watch time. Resolves false on any error (RPCs return { error }, they don't reject). */
export const sendViewProgress: SendProgress = async (p) => {
  const { error } = await supabase.rpc("record_view_progress", {
    p_post_id: p.post_id,
    p_watch_ms: p.watch_ms,
    p_duration_ms: p.duration_ms,
    p_completed: p.completed,
  });
  return !error;
};
