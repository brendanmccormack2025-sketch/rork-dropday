import { useState, useCallback } from "react";
import { Alert } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/providers/AuthProvider";

/** Valid report reasons — mirrors the DB check constraint. */
export type ReportReason = "spam" | "harassment" | "nudity" | "other";

export type ReportTargetType = "post" | "reaction";

type ReportRow = { target_id: string; target_type: string };

/**
 * Hook for reporting user-generated content.
 *
 * Provides a `reportContent` function that shows a native Alert with
 * reason options (spam, harassment, nudity, other) and inserts a row
 * into the `reports` table. On successful insert, optimistically adds
 * the reported target_id to the ["reports", "mine", userId] React Query
 * cache so the content disappears from feed/reaction views immediately
 * without waiting for a refetch.
 *
 * Usage:
 *   const { reportContent, isReporting } = useReportContent();
 *   <Pressable onPress={() => reportContent("post", post.id)} />
 */
export function useReportContent() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [isReporting, setIsReporting] = useState<boolean>(false);

  const reportContent = useCallback(
    async (targetType: ReportTargetType, targetId: string) => {
      if (!user?.id) {
        Alert.alert("Sign in required", "You need to be signed in to report content.");
        return;
      }

      const reasons: { label: string; value: ReportReason }[] = [
        { label: "Spam or misleading", value: "spam" },
        { label: "Harassment or bullying", value: "harassment" },
        { label: "Nudity or sexual content", value: "nudity" },
        { label: "Other", value: "other" },
      ];

      Alert.alert(
        "Report this content",
        "Why are you reporting this?",
        [
          ...reasons.map((r) => ({
            text: r.label,
            onPress: () => submitReport(r.value),
          })),
          { text: "Cancel", style: "cancel" as const },
        ],
      );

      async function submitReport(reason: ReportReason) {
        if (!user?.id) return;
        setIsReporting(true);
        try {
          const { error } = await supabase.from("reports").insert({
            reporter_id: user.id,
            target_type: targetType,
            target_id: targetId,
            reason,
          });

          if (error) {
            // Duplicate report (unique constraint violation)
            if (error.code === "23505") {
              Alert.alert("Already reported", "You've already reported this content.");
            } else {
              console.error("[report] insert error", error.message);
              Alert.alert("Report failed", "Could not submit your report. Please try again.");
            }
          } else {
            // ── Optimistic update: add the reported target to the "my reports"
            //    cache immediately so filterBlocked / filterBlockedReactions
            //    exclude it on the next render — no refetch needed.
            const cacheKey = ["reports", "mine", user.id] as const;
            qc.setQueryData<ReportRow[]>(cacheKey, (old) => {
              const next = old ?? [];
              // Guard against duplicates (shouldn't happen, but safe)
              if (next.some((r) => r.target_id === targetId && r.target_type === targetType)) {
                return next;
              }
              return [...next, { target_id: targetId, target_type: targetType }];
            });

            Alert.alert(
              "Report submitted",
              "Thank you. Our team will review this content. If multiple users report the same content, it will be hidden automatically while we review.",
            );
          }
        } catch (e) {
          console.error("[report] unexpected error", (e as Error)?.message ?? e);
          Alert.alert("Report failed", "Something went wrong. Please try again.");
        } finally {
          setIsReporting(false);
        }
      }
    },
    [user?.id, qc],
  );

  return { reportContent, isReporting };
}
