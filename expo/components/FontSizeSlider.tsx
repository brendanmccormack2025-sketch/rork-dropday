import React, { useCallback, useMemo } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  runOnJS,
} from "react-native-reanimated";
import { MIN_FONT_SIZE, MAX_FONT_SIZE } from "@/components/DraggableTextOverlay";

interface FontSizeSliderProps {
  value: number;
  onChange: (size: number) => void;
}

/** Wraps a View, stripping `collapsable` only on web so it
 *  never reaches the DOM. On native, `collapsable={false}` is
 *  required by react-native-gesture-handler to prevent the
 *  underlying native view from being collapsed/optimized away
 *  — stripping it on native breaks gesture recognizer attachment. */
const GestureView = React.forwardRef<
  View,
  React.ComponentProps<typeof View> & { collapsable?: boolean }
>((props, ref) => {
  if (Platform.OS === "web") {
    const { collapsable: _, ...rest } = props;
    return <View ref={ref} {...rest} />;
  }
  return <View ref={ref} {...props} />;
});

const TRACK_H = 4;
const THUMB_SIZE = 26;
const TRACK_PAD = THUMB_SIZE / 2; // half thumb so it sits flush at edges

export default function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  const trackWidth = useSharedValue(0);
  const thumbX = useSharedValue(0);

  // Initialize thumb position from value once track is measured
  const initFromValue = useCallback(
    (tw: number) => {
      "worklet";
      const ratio = (value - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE);
      thumbX.value = ratio * tw;
    },
    [value, thumbX],
  );

  // Return size in points
  const sizeFromX = useCallback(
    (x: number) => {
      "worklet";
      const tw = trackWidth.value;
      if (tw <= 0) return value;
      const ratio = clampWorklet(x / tw, 0, 1);
      return Math.round(MIN_FONT_SIZE + ratio * (MAX_FONT_SIZE - MIN_FONT_SIZE));
    },
    [value, trackWidth],
  );

  const panGesture = Gesture.Pan()
    .onStart(() => {
      // Re-sync on gesture start so value prop changes during drag are reflected
      const ratio = (value - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE);
      thumbX.value = ratio * trackWidth.value;
    })
    .onUpdate((e) => {
      const tw = trackWidth.value;
      if (tw <= 0) return;
      const newX = clampWorklet(thumbX.value + e.translationX, 0, tw);
      // Use changeX instead of absolute translation to allow re-syncing
      // Actually just clamp absolute: start position + translation
      const ratio = (value - MIN_FONT_SIZE) / (MAX_FONT_SIZE - MIN_FONT_SIZE);
      const startX = ratio * tw;
      const absX = clampWorklet(startX + e.translationX, 0, tw);
      thumbX.value = absX;
      const newSize = Math.round(MIN_FONT_SIZE + (absX / tw) * (MAX_FONT_SIZE - MIN_FONT_SIZE));
      runOnJS(onChange)(newSize);
    });

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value - THUMB_SIZE / 2 }],
  }));

  const trackFillStyle = useAnimatedStyle(() => ({
    width: thumbX.value,
  }));

  // Display value
  const displayValue = value;

  return (
    <View style={styles.wrapper}>
      <Text style={styles.label}>Font size</Text>
      <View style={styles.trackArea}>
        <GestureDetector gesture={panGesture}>
          <GestureView
            style={styles.trackContainer}
            onLayout={(e) => {
              const tw = e.nativeEvent.layout.width;
              trackWidth.value = tw;
              initFromValue(tw);
            }}
          >
            {/* Track background */}
            <View style={styles.trackBg} />
            {/* Track fill */}
            <Animated.View style={[styles.trackFill, trackFillStyle]} />
            {/* Thumb */}
            <Animated.View style={[styles.thumb, thumbStyle]} />
          </GestureView>
        </GestureDetector>
      </View>
      <Text style={styles.valueLabel}>{displayValue}</Text>
    </View>
  );
}

function clampWorklet(v: number, min: number, max: number): number {
  "worklet";
  return Math.max(min, Math.min(max, v));
}

const styles = StyleSheet.create({
  wrapper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 4,
  },
  label: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 11,
    fontWeight: "600" as const,
    minWidth: 50,
  },
  trackArea: {
    flex: 1,
    justifyContent: "center",
  },
  trackContainer: {
    height: 40,
    justifyContent: "center",
    position: "relative",
  },
  trackBg: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  trackFill: {
    position: "absolute",
    left: 0,
    top: 18,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.35)",
  },
  thumb: {
    position: "absolute",
    top: 7,
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 4,
  },
  valueLabel: {
    color: "rgba(255,255,255,0.75)",
    fontSize: 12,
    fontWeight: "700" as const,
    minWidth: 28,
    textAlign: "right",
  },
});
