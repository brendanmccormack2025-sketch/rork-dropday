import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/providers/AuthProvider";
import { getDropWindowState } from "@/constants/theme";
import { supabase } from "@/lib/supabase";

const DAILY_NOTIFICATION_ID = "dropday-going-live";

/**
 * Schedules a daily local notification at 8:00 PM device-local time
 * framing DropDay as a live event starting, not a personal reminder.
 *
 * "DropDay is live — join tonight's drop before 10PM"
 *
 * Skips firing if the user has already posted a top-level Drop during
 * tonight's window (best-effort: cancels/removes the notification when
 * the user posts during the window).
 *
 * expo-notifications works in Expo Go — it is part of the Expo SDK,
 * not a custom native module. On iOS, permissions must be requested
 * before scheduling; the request is made here on first auth.
 */
export function useLiveNotifications() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const scheduledRef = useRef(false);

  // ── Request permissions + schedule daily notification ────────────────
  useEffect(() => {
    if (!user?.id || scheduledRef.current) return;
    scheduledRef.current = true;

    (async () => {
      try {
        // Request permissions (iOS shows the system prompt once).
        // Android doesn't require explicit permission for local notifications
        // on API < 33, but we set up the channel anyway.
        if (Platform.OS === "ios") {
          const { status: existing } = await Notifications.getPermissionsAsync();
          if (existing !== "granted") {
            const { status } = await Notifications.requestPermissionsAsync();
            if (status !== "granted") return;
          }
        }

        // Set up Android notification channel
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("dropday-live", {
            name: "DropDay Live",
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
            lightColor: "#E8291C",
          });
        }

        // Cancel any previously scheduled instance to avoid duplicates
        await Notifications.cancelScheduledNotificationAsync(
          DAILY_NOTIFICATION_ID,
        ).catch(() => {});

        // Schedule the daily 8PM notification
        await Notifications.scheduleNotificationAsync({
          identifier: DAILY_NOTIFICATION_ID,
          content: {
            title: "DropDay is live",
            body: "Join tonight's drop before 10PM",
            sound: true,
            ...(Platform.OS === "android" ? { channelId: "dropday-live" } : {}),
          },
          trigger: {
            type: Notifications.SchedulableTriggerInputTypes.DAILY,
            hour: 20,
            minute: 0,
          } as Notifications.NotificationTriggerInput,
        });
      } catch (e) {
        console.warn("[live-notifications] setup error", (e as Error)?.message);
      }
    })();
  }, [user?.id]);

  // ── Cancel today's notification when user posts during the window ────
  // On successful post creation, the "posts" query cache is invalidated.
  // We watch for that here and cancel the notification if the user has
  // posted a top-level Drop during tonight's window.
  useEffect(() => {
    if (!user?.id) return;

    const checkAndCancel = async () => {
      const win = getDropWindowState(new Date());
      if (!win.isOpen) return;

      try {
        const { data, error } = await supabase
          .from("posts")
          .select("id")
          .eq("user_id", user.id)
          .is("parent_post_id", null)
          .gte("created_at", win.windowStart.toISOString())
          .limit(1);

        if (error) return;

        if (data && data.length > 0) {
          // User already posted tonight — cancel the scheduled notification
          await Notifications.cancelScheduledNotificationAsync(
            DAILY_NOTIFICATION_ID,
          ).catch(() => {});

          // Also remove any already-delivered notifications from our channel
          if (Platform.OS === "android") {
            await Notifications.dismissNotificationAsync(
              DAILY_NOTIFICATION_ID,
            ).catch(() => {});
          }
        }
      } catch {
        // Non-fatal
      }
    };

    // Check on mount and whenever posts cache changes
    checkAndCancel();

    // Subscribe to query cache changes so we re-check after a post
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] === "posts" &&
        event.query.queryKey[1] === "mine"
      ) {
        checkAndCancel();
      }
    });

    return () => unsubscribe();
  }, [user?.id, qc]);
}
