import React, { useCallback, useMemo, useRef, useState } from "react";
import { PanResponder, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
} from "react-native-reanimated";
import type { TextOverlay, TextBackgroundStyle } from "@/providers/PostsProvider";

// ── Constants ────────────────────────────────────────────────────────────────

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 120;
const DRAG_EDGE_MARGIN = 0.01;
const SNAP_THRESHOLD = 16; // px — distance from center to trigger snap

// ── Helpers ──────────────────────────────────────────────────────────────────

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Background style resolver ────────────────────────────────────────────────

interface BgMeta {
  bgColor: string;
  textColor: string;
  bgOpacity: number;
  borderRadius: number;
}

function resolveBgMeta(
  style: TextBackgroundStyle,
  accentColor: string,
): BgMeta {
  switch (style) {
    case "none-white":
      return { bgColor: "transparent", textColor: "#FFFFFF", bgOpacity: 0, borderRadius: 0 };
    case "none-black":
      return { bgColor: "transparent", textColor: "#000000", bgOpacity: 0, borderRadius: 0 };
    case "white-box":
      return { bgColor: "#FFFFFF", textColor: "#000000", bgOpacity: 1, borderRadius: 0 };
    case "black-box":
      return { bgColor: "#000000", textColor: "#FFFFFF", bgOpacity: 1, borderRadius: 0 };
    case "accent-box":
      return { bgColor: accentColor, textColor: "#FFFFFF", bgOpacity: 1, borderRadius: 0 };
    case "translucent-box":
      return { bgColor: "#000000", textColor: "#FFFFFF", bgOpacity: 0.55, borderRadius: 0 };
  }
}

export const BG_STYLES: TextBackgroundStyle[] = [
  "none-white",
  "none-black",
  "white-box",
  "black-box",
];

export { resolveBgMeta };

// ── Props ────────────────────────────────────────────────────────────────────

interface DraggableTextOverlayProps {
  overlay: TextOverlay;
  frameWidth: number;
  frameHeight: number;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: Partial<TextOverlay>) => void;
  onDelete: () => void;
  onDuplicate?: () => void;
  onCycleBackgroundStyle?: (id: string) => void;
  /** Called at the start of any gesture (pan/pinch/rotate) so the
   *  parent can capture an undo snapshot before the edit begins. */
  onEditStart?: (id: string) => void;
  /** Called continuously during drag so the parent can show a trash zone.
   *  Passes the overlay's center in frame-relative coordinates. */
  onDragState?: (id: string, isDragging: boolean, centerX: number, centerY: number) => void;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function DraggableTextOverlay({
  overlay,
  frameWidth,
  frameHeight,
  isSelected,
  onSelect,
  onUpdate,
  onDelete: _onDelete,
  onDuplicate: _onDuplicate,
  onCycleBackgroundStyle: _onCycleBackgroundStyle,
  onEditStart,
  onDragState,
}: DraggableTextOverlayProps) {
  // ── Shared values (UI thread) ────────────────────────────────────────────
  const translateX = useSharedValue(overlay.x * frameWidth);
  const translateY = useSharedValue(overlay.y * frameHeight);
  const fontSizeSv = useSharedValue(overlay.fontSize ?? 26);
  const rotationSv = useSharedValue(overlay.rotation);
  const textWidth = useSharedValue(0);
  const textHeight = useSharedValue(0);
  const opacity = useSharedValue(0);

  // Snap guide visibility
  const snapGuideH = useSharedValue(0); // 0=hidden, 1=visible
  const snapGuideV = useSharedValue(0);
  const scalePulse = useSharedValue(1);

  // ── Temporary snapshots for gesture arithmetic ──────────────────────────
  const dragStartX = useSharedValue(0);
  const dragStartY = useSharedValue(0);

  // Track whether we're currently dragging (for trash zone)
  const isDraggingSv = useSharedValue(0); // 0=false, 1=true

  // ── Stable ref for latest props (PanResponder closure safety) ────────────
  const propsRef = useRef({
    overlay,
    frameWidth,
    frameHeight,
    onSelect,
    onUpdate,
    onEditStart,
    onDragState,
  });
  propsRef.current = {
    overlay,
    frameWidth,
    frameHeight,
    onSelect,
    onUpdate,
    onEditStart,
    onDragState,
  };

  // ── PanResponder — replaces all RNGH gestures ───────────────────────────
  const panResponder = useMemo(() => {
    // Mutable state inside the stable PanResponder closure
    let _isDragging = false;
    let _isPinching = false;
    let _lastTapTime = 0;
    let _tapTimer: ReturnType<typeof setTimeout> | null = null;
    let _pinchInitialDist = 0;
    let _pinchInitialAngle = 0;
    let _pinchStartFs = 26;
    let _rotationStartDeg = 0;

    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onShouldBlockNativeResponder: () => false,

      onPanResponderGrant: (evt) => {
        _isDragging = false;
        _isPinching = false;

        const touches = evt.nativeEvent.touches;
        const p = propsRef.current;

        if (touches && touches.length >= 2) {
          // Started with two fingers → pinch/rotate mode
          _isPinching = true;
          _isDragging = true;
          p.onEditStart?.(p.overlay.id);
          _pinchStartFs = fontSizeSv.value;
          _rotationStartDeg = rotationSv.value;

          const t0 = touches[0]!;
          const t1 = touches[1]!;
          const dx = t0.pageX - t1.pageX;
          const dy = t0.pageY - t1.pageY;
          _pinchInitialDist = Math.sqrt(dx * dx + dy * dy);
          _pinchInitialAngle = Math.atan2(dy, dx) * 180 / Math.PI;
        } else {
          // Single finger → prepare for pan or tap
          dragStartX.value = translateX.value;
          dragStartY.value = translateY.value;
        }
      },

      onPanResponderMove: (evt, gs) => {
        const touches = evt.nativeEvent.touches;
        if (!touches) return;

        const p = propsRef.current;
        const fw = p.frameWidth;
        const fh = p.frameHeight;

        // Transition from 1 → 2 fingers: switch to pinch/rotate
        if (touches.length >= 2 && !_isPinching) {
          _isPinching = true;
          _isDragging = true;
          p.onEditStart?.(p.overlay.id);
          _pinchStartFs = fontSizeSv.value;
          _rotationStartDeg = rotationSv.value;

          const t0 = touches[0]!;
          const t1 = touches[1]!;
          const dx = t0.pageX - t1.pageX;
          const dy = t0.pageY - t1.pageY;
          _pinchInitialDist = Math.sqrt(dx * dx + dy * dy);
          _pinchInitialAngle = Math.atan2(dy, dx) * 180 / Math.PI;
          return;
        }

        // Pinch / rotate mode (2 fingers)
        if (_isPinching && touches.length >= 2) {
          const t0 = touches[0]!;
          const t1 = touches[1]!;
          const dx = t0.pageX - t1.pageX;
          const dy = t0.pageY - t1.pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx) * 180 / Math.PI;

          if (_pinchInitialDist > 0) {
            fontSizeSv.value = clamp(
              _pinchStartFs * (dist / _pinchInitialDist),
              MIN_FONT_SIZE,
              MAX_FONT_SIZE,
            );
          }
          rotationSv.value = _rotationStartDeg + (angle - _pinchInitialAngle);
          return;
        }

        // Pan mode (1 finger, not pinching)
        if (touches.length === 1 && !_isPinching) {
          // Threshold-based drag start
          if (!_isDragging && (Math.abs(gs.dx) > 3 || Math.abs(gs.dy) > 3)) {
            _isDragging = true;
            p.onEditStart?.(p.overlay.id);
            isDraggingSv.value = 1;
            p.onDragState?.(
              p.overlay.id,
              true,
              translateX.value / fw,
              translateY.value / fh,
            );
          }

          if (_isDragging) {
            const cx = dragStartX.value + gs.dx;
            const cy = dragStartY.value + gs.dy;
            translateX.value = cx;
            translateY.value = cy;

            // Snap-to-center guides
            const frameCx = fw / 2;
            const frameCy = fh / 2;
            const distX = Math.abs(cx - frameCx);
            const distY = Math.abs(cy - frameCy);

            if (distX < SNAP_THRESHOLD) {
              translateX.value = frameCx;
              snapGuideV.value = withTiming(1, { duration: 120 });
            } else {
              snapGuideV.value = withTiming(0, { duration: 150 });
            }

            if (distY < SNAP_THRESHOLD) {
              translateY.value = frameCy;
              snapGuideH.value = withTiming(1, { duration: 120 });
            } else {
              snapGuideH.value = withTiming(0, { duration: 150 });
            }

            // Snap pulse when either guide triggers
            if (distX < SNAP_THRESHOLD || distY < SNAP_THRESHOLD) {
              scalePulse.value = withSpring(
                1.08,
                { stiffness: 400, damping: 12 },
                () => {
                  scalePulse.value = withSpring(1, { stiffness: 300, damping: 15 });
                },
              );
            }

            p.onDragState?.(
              p.overlay.id,
              true,
              translateX.value / fw,
              translateY.value / fh,
            );
          }
        }
      },

      onPanResponderRelease: () => {
        const p = propsRef.current;
        const fw = p.frameWidth;
        const fh = p.frameHeight;

        if (_isDragging || _isPinching) {
          // ── Sync shared values back to React state ─────────────────
          const tx = translateX.value;
          const ty = translateY.value;
          const centerX = fw / 2;
          const centerY = fh / 2;

          let snappedX = tx;
          let snappedY = ty;

          if (Math.abs(tx - centerX) < SNAP_THRESHOLD) {
            snappedX = centerX;
            translateX.value = withSpring(centerX, { stiffness: 300, damping: 25 });
          }
          if (Math.abs(ty - centerY) < SNAP_THRESHOLD) {
            snappedY = centerY;
            translateY.value = withSpring(centerY, { stiffness: 300, damping: 25 });
          }

          const newX = clamp(snappedX / fw, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN);
          const newY = clamp(snappedY / fh, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN);

          p.onUpdate(p.overlay.id, {
            x: newX,
            y: newY,
            fontSize: fontSizeSv.value,
            rotation: rotationSv.value,
          });

          p.onDragState?.(p.overlay.id, false, newX, newY);

          isDraggingSv.value = 0;
          snapGuideH.value = withTiming(0, { duration: 200 });
          snapGuideV.value = withTiming(0, { duration: 200 });
        } else {
          // ── Tap detection ─────────────────────────────────────────
          const now = Date.now();
          if (now - _lastTapTime < 300) {
            // Double tap
            if (_tapTimer) {
              clearTimeout(_tapTimer);
              _tapTimer = null;
            }
            // Fire onSelect — the parent's handleSelectOverlay will see
            // the overlay is already selected (from the double-tap) and
            // open the editor if appropriate.
            p.onSelect(p.overlay.id);
          } else {
            // Single tap — wait briefly to rule out double-tap
            _lastTapTime = now;
            if (_tapTimer) clearTimeout(_tapTimer);
            _tapTimer = setTimeout(() => {
              p.onSelect(p.overlay.id);
              _tapTimer = null;
            }, 300);
          }
        }

        _isDragging = false;
        _isPinching = false;
      },

      onPanResponderTerminate: () => {
        if (_isDragging || _isPinching) {
          isDraggingSv.value = 0;
          snapGuideH.value = withTiming(0, { duration: 200 });
          snapGuideV.value = withTiming(0, { duration: 200 });
        }
        if (_tapTimer) {
          clearTimeout(_tapTimer);
          _tapTimer = null;
        }
        _isDragging = false;
        _isPinching = false;
      },
    });
  }, []);

  // ── Animated styles ─────────────────────────────────────────────────────
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value - textWidth.value / 2 },
      { translateY: translateY.value - textHeight.value / 2 },
      { rotate: `${rotationSv.value}deg` },
      { scale: scalePulse.value },
    ],
  }));

  const animatedTextStyle = useAnimatedStyle(() => ({
    fontSize: fontSizeSv.value,
  }));

  // ── Snap guide line styles ──────────────────────────────────────────────
  const snapGuideHStyle = useAnimatedStyle(() => ({
    opacity: snapGuideH.value,
    width: frameWidth + 20,
  }));

  const snapGuideVStyle = useAnimatedStyle(() => ({
    opacity: snapGuideV.value,
    height: frameHeight + 20,
  }));

  // ── Measure text on JS thread, then fade in ────────────────────────────
  const [hasMeasured, setHasMeasured] = useState(false);

  const handleLayout = useCallback(
    (e: { nativeEvent: { layout: { width: number; height: number } } }) => {
      const w = e.nativeEvent.layout.width;
      const h = e.nativeEvent.layout.height;
      if (w > 0 && h > 0) {
        textWidth.value = w;
        textHeight.value = h;
        if (!hasMeasured) {
          setHasMeasured(true);
          opacity.value = withTiming(1, { duration: 180 });
        }
      }
    },
    [hasMeasured, textWidth, textHeight, opacity],
  );

  // ── Resolve background style ────────────────────────────────────────────
  const bgMeta = useMemo(
    () => resolveBgMeta(overlay.backgroundStyle ?? "none-white", overlay.color),
    [overlay.backgroundStyle, overlay.color],
  );

  const hasBackground = bgMeta.bgColor !== "transparent" && bgMeta.bgOpacity > 0;
  const effectiveTextColor = bgMeta.textColor;

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <Animated.View
      style={[styles.overlayWrap, animatedStyle]}
      onLayout={handleLayout}
      {...panResponder.panHandlers}
    >
      {/* Background box */}
      {hasBackground && (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: bgMeta.bgColor,
              opacity: bgMeta.bgOpacity,
              borderRadius: bgMeta.borderRadius,
            },
          ]}
          pointerEvents="none"
        />
      )}

      {/* Selection outline — solid border with slight glow */}
      {isSelected && (
        <Animated.View
          style={[
            styles.selectionOutline,
            { borderColor: "#E8291C" },
          ]}
          pointerEvents="none"
        />
      )}

      {/* Snap guides (rendered as absolute overlays) */}
      {isSelected && (
        <>
          {/* Horizontal center guide */}
          <Animated.View
            style={[
              styles.snapGuide,
              styles.snapGuideH,
              snapGuideHStyle,
            ]}
            pointerEvents="none"
          />
          {/* Vertical center guide */}
          <Animated.View
            style={[
              styles.snapGuide,
              styles.snapGuideV,
              snapGuideVStyle,
            ]}
            pointerEvents="none"
          />
        </>
      )}

      {/* Text content — fontSize driven by animated shared value */}
      <Animated.Text
        style={[
          styles.text,
          animatedTextStyle,
          {
            color: effectiveTextColor,
            textShadowColor: hasBackground
              ? "transparent"
              : effectiveTextColor === "#000000"
                ? "rgba(255,255,255,0.6)"
                : "rgba(0,0,0,0.6)",
          },
        ]}
      >
        {overlay.text}
      </Animated.Text>
    </Animated.View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlayWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    paddingHorizontal: 18,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  selectionOutline: {
    ...StyleSheet.absoluteFill,
    borderWidth: 2,
    borderRadius: 0,
    margin: -4,
    borderColor: "#E8291C",
  },
  text: {
    fontWeight: "900" as const,
    textAlign: "center",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    includeFontPadding: false,
  },
  // ── Snap guides ──
  snapGuide: {
    position: "absolute",
    backgroundColor: "rgba(232,41,28,0.25)",
  },
  snapGuideH: {
    height: 1,
    left: -10,
    top: "50%" as const,
    marginTop: -0.5,
  },
  snapGuideV: {
    width: 1,
    top: -10,
    left: "50%" as const,
    marginLeft: -0.5,
  },
});
