import { useCallback, useEffect, useState } from "react";

import { myUnreadMessages, subscribeAnyMessage } from "@/lib/friends";
import { useAuth } from "@/providers/AuthProvider";
import { DIAG_UNREAD_LIVE_ON } from "@/lib/diagFlags";

/** Unread chat messages for the red dot on the feed's message icon: fetched, then kept fresh by Realtime. */
export function useUnreadMessages(): { unread: number; refresh: () => void } {
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  const userId = user?.id ?? null;

  const refresh = useCallback(() => {
    if (!userId) {
      setUnread(0);
      return;
    }
    myUnreadMessages()
      .then((n) => setUnread(Number(n) || 0))
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (!DIAG_UNREAD_LIVE_ON) return;
    refresh();
    if (!userId) return;
    // a Realtime hiccup must never break the feed: subscribing is best effort, and a slow poll covers a missed event
    let off: (() => void) | null = null;
    try {
      off = subscribeAnyMessage(refresh);
    } catch {
      off = null;
    }
    const poll = setInterval(refresh, 90_000);
    return () => {
      clearInterval(poll);
      try {
        off?.();
      } catch {
        // ignore
      }
    };
  }, [userId, refresh]);

  return { unread, refresh };
}
