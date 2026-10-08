import React from "react";
import { StyleSheet, View } from "react-native";

import { safeZones, type Rect } from "@/lib/feedLayout";

/**
 * Ghost guides for the feed's UI regions (logo, bell, right rail, bottom bar) over the
 * editor's feed-shaped preview. Faint at rest, stronger while something is dragged.
 */
export default function FeedSafeZones({
  frameW,
  frameH,
  screenW,
  topInset,
  active,
}: {
  frameW: number;
  frameH: number;
  screenW: number;
  topInset: number;
  active: boolean;
}) {
  if (frameW <= 0 || frameH <= 0) return null;
  const zones = safeZones(frameW, frameH, screenW, topInset);
  const rects: Rect[] = [zones.logo, zones.bell, zones.rail, zones.bottom];
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {rects.map((r, i) => (
        <View
          key={i}
          style={[
            styles.zone,
            { left: r.x, top: r.y, width: r.w, height: r.h, opacity: active ? 1 : 0.45 },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  zone: {
    position: "absolute",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.85)",
    borderStyle: "dashed",
    backgroundColor: "rgba(0,0,0,0.12)",
    borderRadius: 6,
  },
});
