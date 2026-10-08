#!/usr/bin/env node
/**
 * Save to camera roll: the export render carries the captions AND the Text-button overlays with the feed's layout;
 * a failed save never fails the post; the switch off means no save; pinch scale and rotation are one layout in the
 * editor, Preview, feed and export.
 *
 *   node --experimental-strip-types scripts/test-save-roll.mjs
 */
import { readFileSync } from "node:fs";
import { toRenderJson } from "../lib/editStyles.ts";
import { textLayout, textOverlayRenderSpec, videoDisplayWidth, computeCoverCrop, VIDEO_ASPECT, overlayBox, TEXT_MAX_WIDTH } from "../lib/feedLayout.ts";
import {
  MAX_OVERLAY_SCALE, MIN_OVERLAY_SCALE, clampScale, effectiveFontSize, textOverlayExportSpec, textOverlaysToEditOverlays,
} from "../lib/textOverlayStyle.ts";
import { buildCaptionLines, captionLinesToEditOverlays } from "../lib/transcription/captionLines.ts";
import { createSaveStatus, runSaveWithStatus, saveToCameraRoll } from "../lib/saveToRoll.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

const NEW = { supportsFont: true, supportsTextBox: true };
const OLD = { supportsFont: false, supportsTextBox: false };
const ov = (patch = {}) => ({ id: "t1", text: "Bruhh \u{1F633}", x: 0.3, y: 0.25, fontSize: 26, rotation: 0, color: "#FFFFFF", backgroundStyle: "black-box", ...patch });
const captions = captionLinesToEditOverlays(buildCaptionLines([{ text: "hi", startMs: 100, endMs: 400 }, { text: "there", startMs: 450, endMs: 900 }], {}, [{ startMs: 0, endMs: 1000 }]));

// ── 1: the export render JSON ──
{
  const texts = textOverlaysToEditOverlays([ov(), ov({ id: "t2", text: "A long line of words that wraps", backgroundStyle: "none-white", y: 0.6 })], NEW);
  const json = JSON.parse(toRenderJson({ version: 1, clips: [], overlays: [...captions, ...texts] }, { supportsFont: true, supportsTextBox: true }));
  const caps = json.overlays.filter((o) => o.kind === "caption");
  const txt = json.overlays.filter((o) => o.kind === "text");
  ok("the export has the captions and both Text-button overlays", caps.length === captions.length && txt.length === 2);
  const s = txt[0].styleSpec;
  const feedW = videoDisplayWidth(390, computeCoverCrop(390, 844, VIDEO_ASPECT));
  const feed = textLayout(26, feedW);
  ok("font size is the feed's, scaled to 1080 (same fraction of the video width)", near(s.fontSize / 1080, feed.fontSize / feedW));
  ok("padding across / down and corner are the feed's", near(s.backgroundPaddingX / 1080, feed.padX / feedW) && near(s.backgroundPaddingY / 1080, feed.padY / feedW) && near(s.cornerRadius / 1080, feed.cornerRadius / feedW));
  ok("max width is the slot (0.86 of the video) and the line height is the feed's", s.maxWidth === TEXT_MAX_WIDTH && near(s.lineHeight, feed.lineHeight / feed.fontSize));
  eq("position: the overlay's own centre", [s.xCenter, s.yCenter], [0.3, 0.25]);
  eq("Montserrat Bold by PostScript name", s.fontName, "Montserrat-Bold");
  eq("black box: white text on black", [s.color, s.backgroundColor], ["#FFFFFF", "#000000"]);
  const plain = txt[1].styleSpec;
  eq("no box: no background, a shadow, no padding keys", [plain.backgroundColor, plain.shadow, plain.backgroundPaddingX], [undefined, true, undefined]);
  eq("captions in the same JSON are untouched by the text overlays", caps[0].styleSpec, JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captions }, { supportsFont: true, supportsTextBox: true })).overlays[0].styleSpec);
  eq("translucent box keeps its opacity", textOverlayExportSpec(ov({ backgroundStyle: "translucent-box" }), NEW).backgroundColor, "#0000008C");
  eq("a chosen font keeps its PostScript name", textOverlayExportSpec(ov({ fontId: "avenir" }), NEW).fontName, "AvenirNext-Heavy");
  eq("start and end times carry over", textOverlaysToEditOverlays([ov({ startMs: 500, endMs: 900 })], NEW).map((o) => [o.startMs, o.endMs]), [[500, 900]]);
  eq("old build (cannot place text by centre): no Text overlays burned in, captions unaffected", [textOverlaysToEditOverlays([ov()], OLD).length, JSON.parse(toRenderJson({ version: 1, clips: [], overlays: captions }, {})).overlays.length], [0, captions.length]);
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("Swift places a text overlay by xCenter and rotates it", /style\["xCenter"\]/.test(swift) && /style\["rotation"\]/.test(swift) && /CATransform3DMakeRotation/.test(swift));
}

// ── 2: a failed save never fails the post ──
{
  const calls = [];
  const base = (over = {}) => ({
    enabled: true,
    render: async () => (calls.push("render"), { uri: "file:///x.mp4" }),
    ensurePermission: async () => (calls.push("permission"), true),
    save: async () => void calls.push("save"),
    cleanup: async () => void calls.push("cleanup"),
    ...over,
  });
  const post = async (save) => {
    // The post, then the save: the save's outcome is never part of the post's.
    let posted = false;
    posted = true;
    let result;
    try { result = await save(); } catch { result = { status: "failed", reason: "threw" }; }
    return { posted, result };
  };
  let r = await post(() => saveToCameraRoll(base({ render: async () => { throw new Error("native"); } })));
  eq("a render failure: the post is fine, the save says failed", [r.posted, r.result], [true, { status: "failed", reason: "render" }]);
  r = await post(() => saveToCameraRoll(base({ save: async () => { throw new Error("photos"); } })));
  eq("a save failure: failed, the temp file is cleaned up", [r.posted, r.result.status, calls.at(-1)], [true, "failed", "cleanup"]);
  calls.length = 0;
  r = await post(() => saveToCameraRoll(base({ ensurePermission: async () => false })));
  eq("permission denied: failed, no render was started", [r.result, calls.filter((c) => c === "render").length], [{ status: "failed", reason: "permission" }, 0]);
  calls.length = 0;
  r = await post(() => saveToCameraRoll(base({ ensurePermission: async () => { throw new Error("x"); } })));
  eq("a permission error is a result, not a throw", [r.result.status, calls.length], ["failed", 0]);
  let reported = 0;
  r = await post(() => saveToCameraRoll(base({ render: async () => { throw new Error("n"); }, onError: () => { reported++; throw new Error("reporter broke"); } })));
  eq("errors are reported (the error recorder), and a broken reporter cannot throw", [reported, r.result.status], [1, "failed"]);
  calls.length = 0;
  r = await saveToCameraRoll(base());
  eq("the happy path: permission, render, save, cleanup", [r, calls], [{ status: "saved" }, ["permission", "render", "save", "cleanup"]]);

  // Retry
  const status = createSaveStatus();
  let attempt = 0;
  const run = () => saveToCameraRoll(base({ render: async () => { attempt++; if (attempt === 1) throw new Error("first"); return { uri: "f" }; } }));
  await runSaveWithStatus(status, run);
  eq("after a failure the status offers Retry", status.get().kind, "failed");
  status.get().retry();
  await new Promise((r2) => setTimeout(r2, 20));
  eq("Retry runs it again and it saves", [attempt, status.get().kind], [2, "saved"]);

  const edit = read("../app/edit.tsx");
  const i = edit.indexOf("createPost.mutate(");
  const j = edit.indexOf("startPostExport(");
  ok("the export starts after the upload has started, inside a try/catch with a recorder", i > 0 && j > i && /startPostExport[\s\S]{0,400}recordClientError/.test(edit));
  ok("the failure message and Retry exist", /Couldn't save to camera roll/.test(read("../lib/saveToRoll.ts")) && /Retry/.test(read("../components/SaveToRollToast.tsx")));
}

// ── 3: the switch ──
{
  const calls = [];
  const r = await saveToCameraRoll({ enabled: false, render: async () => (calls.push("render"), { uri: "x" }), ensurePermission: async () => (calls.push("perm"), true), save: async () => void calls.push("save"), cleanup: async () => {} });
  eq("switch off: nothing rendered, no permission asked, nothing saved", [r, calls], [{ status: "off" }, []]);
  const edit = read("../app/edit.tsx");
  ok("Post passes the switch to the export", /enabled: saveToRollRef\.current/.test(edit));
  ok("the switch is near Post, on by default, remembered per user", /useState\(true\)/.test(edit) && /setSaveEditedToRoll\(v, user\?\.id\)/.test(edit) && /getSaveEditedToRoll\(user\?\.id\)/.test(edit));
  ok("the setting is stored per user", /SAVE_EDITED_KEY\}:\$\{userId\}/.test(read("../lib/autoEditSettings.ts")));
  const exp = read("../lib/exportEdit.ts");
  ok("add-only permission, existing usage description, no watermark", /getPermissionsAsync\(true\)/.test(exp) && /requestPermissionsAsync\(true\)/.test(exp) && !/watermark/i.test(exp) && /NSPhotoLibraryAddUsageDescription/.test(read("../app.json")));
  const feed = read("../components/FeedItem.tsx");
  ok("the “…” menu of the user's own post offers Save to camera roll (owner branch only)", /if \(isOwner\) \{\s*Alert\.alert\("More options", undefined, \[\s*\.\.\.\(post\._optimistic[\s\S]{0,200}Save to camera roll/.test(feed));
}

// ── 4: pinch scale ──
{
  eq("scale is clamped", [clampScale(0.1), clampScale(9), clampScale(undefined), clampScale(1.7)], [MIN_OVERLAY_SCALE, MAX_OVERLAY_SCALE, 1, 1.7]);
  eq("a non-number scale is 1", clampScale(NaN), 1);
  const scaled = ov({ scale: 2.2 });
  eq("effective size = typed size x scale", effectiveFontSize(scaled), 26 * 2.2);
  eq("an overlay without a scale is unchanged", effectiveFontSize(ov()), 26);
  for (const videoW of [200, 390, 1080]) {
    const box = overlayBox(scaled.text, effectiveFontSize(scaled), videoW);
    const exp = textOverlayRenderSpec(effectiveFontSize(scaled));
    ok(`scale ${scaled.scale} @${videoW}: the editor/feed box is the export's, scaled`, near(box.height / videoW, (box.lines.length * exp.fontSize * exp.lineHeight + 2 * exp.backgroundPaddingY) / 1080));
  }
  eq("the export spec uses the scaled size", textOverlayExportSpec(scaled, NEW).fontSize, textOverlayRenderSpec(26 * 2.2).fontSize);
  const drag = read("../components/DraggableTextOverlay.tsx");
  const feed = read("../components/FeedItem.tsx");
  ok("the editor pinch uses react-native-gesture-handler (pan, pinch, rotate together) and stores scale", /Gesture\.Pinch\(\)/.test(drag) && /Gesture\.Pan\(\)/.test(drag) && /Gesture\.Rotation\(\)/.test(drag) && /Gesture\.Simultaneous\(/.test(drag) && /scale: clampScale\(scaleSv\.value\)/.test(drag));
  ok("editor and feed both size from effectiveFontSize", /effectiveFontSize\(\{ fontSize: fontSizeSv\.value, scale: scaleSv\.value \}\)/.test(drag) && /effectiveFontSize\(overlay\)/.test(feed));
  ok("a gesture takes the undo snapshot first, so undo/redo cover it", /p\.onEditStart\?\.\(p\.overlay\.id\)/.test(drag) && /handleTextOverlayEditStart/.test(read("../app/edit.tsx")));
  ok("undo/redo move the overlay: shared values follow the props", /scaleSv\.value = clampScale\(overlay\.scale\)/.test(drag));
}

// ── 5: rotation ──
{
  const r = textOverlayExportSpec(ov({ rotation: 25 }), NEW);
  eq("rotation reaches the export in degrees", r.rotation, 25);
  eq("no rotation: no key", textOverlayExportSpec(ov(), NEW).rotation, undefined);
  const feed = read("../components/FeedItem.tsx");
  ok("the feed rotates the overlay by the same degrees", /rotate: `\$\{overlay\.rotation\}deg`/.test(feed));
  ok("the editor stores two-finger rotation in the same field", /rotation: rotationSv\.value/.test(read("../components/DraggableTextOverlay.tsx")));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
