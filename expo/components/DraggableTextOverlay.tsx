import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
} from "react-native-reanimated";
import type { TextOverlay, TextBackgroundStyle } from "@/providers/PostsProvider";
import { clampScale, effectiveFontSize, resolveBgMeta as resolveBgMetaShared } from "@/lib/textOverlayStyle";
import {
  TEXT_MAX_WIDTH,
  overlayFont,
  textLayout,
  fracToFrame,
  frameToFrac,
  type CoverCrop,
} from "@/lib/feedLayout";


const FULL_CROP: CoverCrop = { visibleW: 1, visibleH: 1, cropLeft: 0, cropTop: 0 };

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

const resolveBgMeta = resolveBgMetaShared;

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
  /** The feed cover crop of this frame; overlay x/y are fractions of the whole video. */
  crop?: CoverCrop;
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
  crop = FULL_CROP,
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
  const start = fracToFrame(overlay.x, overlay.y, frameWidth, frameHeight, crop);
  const translateX = useSharedValue(start.x);
  const translateY = useSharedValue(start.y);
  const fontSizeSv = useSharedValue(overlay.fontSize ?? 26);
  const scaleSv = useSharedValue(clampScale(overlay.scale));
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
    crop,
    onSelect,
    onUpdate,
    onEditStart,
    onDragState,
  });
  propsRef.current = {
    overlay,
    frameWidth,
    frameHeight,
    crop,
    onSelect,
    onUpdate,
    onEditStart,
    onDragState,
  };

  // Undo, redo or a new frame size change the overlay under us: follow it (never while a finger is down).
  useEffect(() => {
    if (isDraggingSv.value === 1) return;
    const at = fracToFrame(overlay.x, overlay.y, frameWidth, frameHeight, crop);
    translateX.value = at.x;
    translateY.value = at.y;
    scaleSv.value = clampScale(overlay.scale);
    rotationSv.value = overlay.rotation;
    fontSizeSv.value = overlay.fontSize ?? 26;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlay.x, overlay.y, overlay.scale, overlay.rotation, overlay.fontSize, frameWidth, frameHeight, crop.cropLeft, crop.cropTop, crop.visibleW, crop.visibleH]);

  // ── Gestures: pan, pinch and rotate together (react-native-gesture-handler), tap to select ─────────
  const gesture = useMemo(() => {
    let active = 0;
    let changed = false;
    let baseScale = 1;
    let baseRotation = 0;

    const begin = () => {
      const p = propsRef.current;
      if (active === 0) {
        changed = false;
        p.onEditStart?.(p.overlay.id);
      }
      active += 1;
    };

    const snapTo = (cx: number, cy: number) => {
      const p = propsRef.current;
      const frameCx = p.frameWidth / 2;
      const frameCy = p.frameHeight / 2;
      const nearX = Math.abs(cx - frameCx) < SNAP_THRESHOLD;
      const nearY = Math.abs(cy - frameCy) < SNAP_THRESHOLD;
      translateX.value = nearX ? frameCx : cx;
      translateY.value = nearY ? frameCy : cy;
      snapGuideV.value = withTiming(nearX ? 1 : 0, { duration: nearX ? 120 : 150 });
      snapGuideH.value = withTiming(nearY ? 1 : 0, { duration: nearY ? 120 : 150 });
      if (nearX || nearY) {
        scalePulse.value = withSpring(1.08, { stiffness: 400, damping: 12 }, () => {
          scalePulse.value = withSpring(1, { stiffness: 300, damping: 15 });
        });
      }
    };

    const commit = () => {
      const p = propsRef.current;
      const fw = p.frameWidth;
      const fh = p.frameHeight;
      const fx = clamp(translateX.value / fw, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN);
      const fy = clamp(translateY.value / fh, DRAG_EDGE_MARGIN, 1 - DRAG_EDGE_MARGIN);
      const full = frameToFrac(fx * fw, fy * fh, fw, fh, p.crop);
      p.onUpdate(p.overlay.id, {
        x: full.x,
        y: full.y,
        scale: clampScale(scaleSv.value),
        rotation: rotationSv.value,
      });
      p.onDragState?.(p.overlay.id, false, fx, fy);
      isDraggingSv.value = 0;
      snapGuideH.value = withTiming(0, { duration: 200 });
      snapGuideV.value = withTiming(0, { duration: 200 });
    };

    const end = () => {
      active = Math.max(0, active - 1);
      if (active === 0 && changed) {
        changed = false;
        commit();
      }
    };

    const pan = Gesture.Pan()
      .runOnJS(true)
      .minDistance(3)
      .maxPointers(2)
      .onStart(() => {
        begin();
        dragStartX.value = translateX.value;
        dragStartY.value = translateY.value;
        isDraggingSv.value = 1;
      })
      .onUpdate((e) => {
        changed = true;
        const p = propsRef.current;
        snapTo(dragStartX.value + e.translationX, dragStartY.value + e.translationY);
        p.onDragState?.(p.overlay.id, true, translateX.value / p.frameWidth, translateY.value / p.frameHeight);
      })
      .onFinalize((_e, success) => {
        if (success) end();
      });

    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => {
        begin();
        baseScale = scaleSv.value;
      })
      .onUpdate((e) => {
        changed = true;
        scaleSv.value = clampScale(baseScale * e.scale);
      })
      .onFinalize((_e, success) => {
        if (success) end();
      });

    const rotate = Gesture.Rotation()
      .runOnJS(true)
      .onStart(() => {
        begin();
        baseRotation = rotationSv.value;
      })
      .onUpdate((e) => {
        changed = true;
        rotationSv.value = baseRotation + (e.rotation * 180) / Math.PI;
      })
      .onFinalize((_e, success) => {
        if (success) end();
      });

    const doubleTap = Gesture.Tap()
      .runOnJS(true)
      .numberOfTaps(2)
      .maxDuration(300)
      .onEnd((_e, success) => {
        if (success) propsRef.current.onSelect(propsRef.current.overlay.id);
      });
    const singleTap = Gesture.Tap()
      .runOnJS(true)
      .maxDuration(300)
      .onEnd((_e, success) => {
        if (success) propsRef.current.onSelect(propsRef.current.overlay.id);
      });

    return Gesture.Simultaneous(Gesture.Exclusive(doubleTap, singleTap), pan, pinch, rotate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Animated styles ─────────────────────────────────────────────────────
  const videoW = frameWidth / crop.visibleW;
  const slotW = videoW * TEXT_MAX_WIDTH;
  // The slot is fixed: only the text box inside it changes size, so wrapping never depends on position.
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [
      { translateX: translateX.value - slotW / 2 },
      { translateY: translateY.value - textHeight.value / 2 },
      { rotate: `${rotationSv.value}deg` },
      { scale: scalePulse.value },
    ],
  }));

  // The same function the feed and Preview use, so sizes, padding and line height cannot drift apart.
  const animatedTextStyle = useAnimatedStyle(() => {
    const l = textLayout(effectiveFontSize({ fontSize: fontSizeSv.value, scale: scaleSv.value }), videoW);
    return { fontSize: l.fontSize, lineHeight: l.lineHeight };
  });
  const animatedBoxStyle = useAnimatedStyle(() => ({
    borderRadius: textLayout(effectiveFontSize({ fontSize: fontSizeSv.value, scale: scaleSv.value }), videoW).cornerRadius,
  }));
  const animatedPadStyle = useAnimatedStyle(() => {
    const l = textLayout(effectiveFontSize({ fontSize: fontSizeSv.value, scale: scaleSv.value }), videoW);
    return { paddingHorizontal: l.padX, paddingVertical: l.padY, borderRadius: l.cornerRadius };
  });

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
      style={[styles.overlayWrap, { width: slotW }, animatedStyle]}
      pointerEvents="box-none"
    >
      <GestureDetector gesture={gesture}>
      <Animated.View
        style={[styles.box, animatedPadStyle]}
        onLayout={handleLayout}
      >
      {/* Background box */}
      {hasBackground && (
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: bgMeta.bgColor,
              opacity: bgMeta.bgOpacity,
            },
            animatedBoxStyle,
          ]}
          pointerEvents="none"
        />
      )}

      {/* Selection outline: the same dashed white outline the caption uses */}
      {isSelected && (
        <Animated.View
          style={[styles.selectionOutline, animatedBoxStyle]}
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
        allowFontScaling={false}
        style={[
          styles.text,
          overlayFont(overlay.fontId),
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
      </GestureDetector>
    </Animated.View>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlayWrap: {
    position: "absolute",
    left: 0,
    top: 0,
    alignItems: "center",
  },
  box: {
    alignItems: "center",
    justifyContent: "center",
  },
  selectionOutline: {
    ...StyleSheet.absoluteFill,
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "#FFFFFF",
    margin: -3,
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
    backgroundColor: "rgba(255,255,255,0.45)",
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
