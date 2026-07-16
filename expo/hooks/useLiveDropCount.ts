import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/lib/supabase";
import { getDropWindowState } from "@/constants/theme";

/**
 * Live participant counter — during the 8-10PM window only, fetches an
 * approximate count of how many distinct users have posted a top-level
 * Drop since tonight's window opened. Refreshes every 45 seconds.
 *
 * Outside the window, returns null (the UI should not render the counter).
 */
export function useLiveDropCount() {
  const [now, setNow] = useState(new Date());

  // Tick every 5 seconds so we detect window open/close promptly
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(id);
  }, []);

  const win = getDropWindowState(now);
  const windowOpen = win.isOpen;
  const sinceIso = win.windowStart.toISOString();

  const countQuery = useQuery<number>({
    queryKey: ["live-drop-count", sinceIso],
    enabled: windowOpen,
    staleTime: 30_000,
    refetchInterval: 45_000,
    queryFn: async (): Promise<number> => {
      try {
        const { data, error } = await supabase.rpc("get_tonight_drop_count", {
          since_ts: sinceIso,
        });
        if (error) {
          console.warn("[live-count] rpc error", error.message);
          return 0;
        }
        return (data as number) ?? 0;
      } catch (e) {
        console.warn("[live-count] fetch error", (e as Error)?.message);
        return 0;
      }
    },
  });

  if (!windowOpen) return null;
  return countQuery.data ?? null;
}

/**
 * Format a participant count for display: "1,200+ dropping tonight"
 */
export function formatDropCount(count: number): string {
  if (count >= 1000) {
    const k = (count / 1000).toFixed(1);
    return `${k}k+ dropping tonight`;
  }
  return `${count.toLocaleString()}+ dropping tonight`;
}
