import React, { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";

import { GUIDE_FADE_MS, GUIDE_RADIUS, GUIDE_TINT, guideTarget } from "@/lib/guides";
import { safeZones, type Rect } from "@/lib/feedLayout";

/**
 * The feed's UI regions (logo, bell, right rail, bottom bar) as a soft tint over the editor's video, plus a thin
 * vertical line when the dragged item is centred. Visible only while an overlay or caption is dragged or pinched;
 * it fades out in 200 ms and takes no touches.
 */
export default function FeedSafeZones({
  frameW,
  frameH,
  screenW,
  topInset,
  visible,
  centered,
}: {
  frameW: number;
  frameH: number;
  screenW: number;
  topInset: number;
  visible: boolean;
  centered: boolean;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: guideTarget(visible), duration: GUIDE_FADE_MS, useNativeDriver: true }).start();
  }, [visible, opacity]);

  if (frameW <= 0 || frameH <= 0) return null;
  const zones = safeZones(frameW, frameH, screenW, topInset);
  const rects: Rect[] = [zones.logo, zones.bell, zones.rail, zones.bottom];
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity }]}>
      {rects.map((r, i) => (
        <View key={i} style={[styles.zone, { left: r.x, top: r.y, width: r.w, height: r.h }]} />
      ))}
      {centered && <View style={[styles.centerLine, { left: frameW / 2 - 0.5, height: frameH }]} />}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  zone: { position: "absolute", backgroundColor: GUIDE_TINT, borderRadius: GUIDE_RADIUS },
  centerLine: { position: "absolute", top: 0, width: 1, backgroundColor: "rgba(255,255,255,0.8)" },
});
