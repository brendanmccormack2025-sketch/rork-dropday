import React, { useCallback, useRef, useState, useEffect } from "react";
import {
  Animated,
  Pressable,
  StyleSheet,
  type GestureResponderEvent,
  type ViewStyle,
} from "react-native";
import { Heart } from "lucide-react-native";
import { theme } from "@/constants/theme";

const DOUBLE_TAP_DELAY_MS = 300;

// ── Floating Heart ──────────────────────────────────────────────────────────

function FloatingHeart({
  x,
  y,
  onDone,
}: {
  x: number;
  y: number;
  onDone: () => void;
}) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  const translateY = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(scale, {
        toValue: 1.4,
        friction: 4,
        tension: 180,
        useNativeDriver: true,
      }),
      Animated.spring(scale, {
        toValue: 1.0,
        friction: 3,
        tension: 140,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(translateY, {
          toValue: -60,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(scale, {
          toValue: 0.7,
          duration: 600,
          useNativeDriver: true,
        }),
      ]),
    ]).start(() => onDone());
  }, []);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: x - 45,
        top: y - 45,
        opacity,
        transform: [{ scale }, { translateY }],
      }}
    >
      <Heart
        color="rgba(255,255,255,0.95)"
        fill={theme.danger}
        size={90}
        strokeWidth={0}
      />
    </Animated.View>
  );
}

// ── Double-tap zone ─────────────────────────────────────────────────────────

interface HeartInstance {
  id: number;
  x: number;
  y: number;
}

interface DoubleTapLikeZoneProps {
  /** Called when a double-tap is detected — always likes, never unlikes. */
  onLike: () => void;
  /** Called on single-tap (after the double-tap delay window expires). */
  onSingleTap?: () => void;
  /** Optional children to render inside the zone (behind the hearts). */
  children?: React.ReactNode;
  /** Optional style to constrain the tap zone (e.g. exclude button areas). */
  style?: ViewStyle;
}

/**
 * Transparent tap zone that sits on top of video content.
 *
 * - Double-tap triggers like + a floating heart animation at the tap point.
 * - Single-tap fires after a 300 ms delay (the double-tap window).
 * - Does NOT block touches on siblings rendered later (action buttons, etc.)
 *   because it uses an onPress callback; React Native's responder system
 *   gives priority to Pressables that are higher in the visual tree.
 */
export default function DoubleTapLikeZone({
  onLike,
  onSingleTap,
  children,
  style,
}: DoubleTapLikeZoneProps) {
  const lastTapRef = useRef<number>(0);
  const singleTapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartIdRef = useRef<number>(0);
  const [hearts, setHearts] = useState<HeartInstance[]>([]);

  // On unmount, clear any pending single-tap timer.
  useEffect(() => {
    return () => {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
      }
    };
  }, []);

  const removeHeart = useCallback((id: number) => {
    setHearts((prev) => prev.filter((h) => h.id !== id));
  }, []);

  const handlePress = useCallback(
    (e: GestureResponderEvent) => {
      const now = Date.now();
      const elapsed = now - lastTapRef.current;

      if (elapsed < DOUBLE_TAP_DELAY_MS && lastTapRef.current !== 0) {
        // ── Double tap detected ──────────────────────────────────────
        if (singleTapTimerRef.current) {
          clearTimeout(singleTapTimerRef.current);
          singleTapTimerRef.current = null;
        }

        const id = heartIdRef.current++;
        setHearts((prev) => [
          ...prev,
          {
            id,
            x: e.nativeEvent.locationX,
            y: e.nativeEvent.locationY,
          },
        ]);

        onLike();
        lastTapRef.current = 0; // reset so triple-tap doesn't fire again
      } else {
        // ── First tap — arm the single-tap timer ─────────────────────
        lastTapRef.current = now;
        singleTapTimerRef.current = setTimeout(() => {
          onSingleTap?.();
          singleTapTimerRef.current = null;
        }, DOUBLE_TAP_DELAY_MS);
      }
    },
    [onLike, onSingleTap],
  );

  return (
    <Pressable onPress={handlePress} style={[styles.zone, style]}>
      {children}
      {hearts.map((h) => (
        <FloatingHeart
          key={h.id}
          x={h.x}
          y={h.y}
          onDone={() => removeHeart(h.id)}
        />
      ))}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  zone: {
    position: "absolute",
    top: 120,
    left: 0,
    right: 80,
    bottom: 0,
  },
});
