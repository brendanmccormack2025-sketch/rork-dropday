#!/usr/bin/env node
/**
 * Text box proportions in the render JSON (build 39 vs 1.0.4), the text editor's layers, and the feed
 * while a post uploads (nothing plays, "Finishing up…", the finished post replaces its optimistic copy in place).
 *
 *   node --experimental-strip-types scripts/test-posting-editor.mjs
 */
import { readFileSync } from "node:fs";
import { resolveOverlayStyle, toRenderJson, withTextBox } from "../lib/editStyles.ts";
import { TEXT_LINE_HEIGHT_EM, TEXT_PAD_X_EM, TEXT_PAD_Y_EM, textLayout, textOverlayRenderSpec } from "../lib/feedLayout.ts";
import { EDITOR_BAR_HEIGHT, EDITOR_LAYER_ORDER, editorLayout } from "../lib/textEditorLayout.ts";
import { adoptKey, insertFirst, isPosting, playingIndex, rowKey, scrollTarget, swapOptimistic, uploadLabel } from "../lib/postingFeed.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");

// ── A: the box in the render JSON ──
{
  const instr = { version: 1, clips: [], overlays: [
    { kind: "caption", text: "x", style: "trial", startMs: 0, endMs: 500 },
    { kind: "text", text: "Bruhh \u{1F633}", style: "callout", startMs: 0, endMs: 500 },
  ] };
  const oldBuild = JSON.parse(toRenderJson(instr));
  const none = JSON.parse(toRenderJson(instr, { supportsTextBox: false }));
  eq("build 39: no box keys, the JSON is what it was", oldBuild, none);
  ok("build 39: no backgroundPaddingX/Y or lineHeight anywhere", !/backgroundPaddingX|backgroundPaddingY|lineHeight/.test(JSON.stringify(oldBuild)));
  const modern = JSON.parse(toRenderJson(instr, { supportsTextBox: true }));
  const [cap, txt] = modern.overlays.map((o) => o.styleSpec);
  for (const [name, s] of [["caption", cap], ["text overlay", txt]]) {
    eq(`1.0.4 ${name}: 0.5 em across, 0.25 em down, line height 1.2 em`, [s.backgroundPaddingX / s.fontSize, s.backgroundPaddingY / s.fontSize, s.lineHeight], [TEXT_PAD_X_EM, TEXT_PAD_Y_EM, TEXT_LINE_HEIGHT_EM]);
  }
  eq("1.0.4: the legacy padding key stays, for the old renderer path", [cap.backgroundPadding, txt.backgroundPadding], [18, 20]);
  const { backgroundPaddingX, backgroundPaddingY, lineHeight, ...rest } = cap;
  eq("1.0.4: nothing else changes in a caption's spec", rest, JSON.parse(toRenderJson(instr)).overlays[0].styleSpec);
  const plain = withTextBox(resolveOverlayStyle("text"), true);
  eq("a text style with no background gets the line height only", [plain.lineHeight, plain.backgroundPaddingX], [TEXT_LINE_HEIGHT_EM, undefined]);
  const js = textLayout(26, 1080), r = textOverlayRenderSpec(26);
  eq("the JS overlay layout and the render numbers agree", [js.padX, js.padY, js.lineHeight / js.fontSize], [r.backgroundPaddingX, r.backgroundPaddingY, r.lineHeight]);
  const swift = read("../modules/video-render/ios/VideoRenderModule.swift");
  ok("Swift reads the box keys and keeps the old path without them", /backgroundPaddingX/.test(swift) && /backgroundPaddingY/.test(swift) && /style\["lineHeight"\]/.test(swift) && /supportsTextBox/.test(swift));
  ok("Swift: fixed line heights, box height = measured lines (no +2 only on the new path)", /minimumLineHeight/.test(swift) && /maximumLineHeight/.test(swift) && /baselineOffset/.test(swift));
}

// ── B: the text editor's layers ──
{
  for (const kb of [0, 291, 336]) {
    const L = editorLayout(844, kb);
    ok(`keyboard ${kb}: the bar is not inside the dimmed area`, L.bar.top + L.bar.height <= L.scrim.top || L.scrim.height === 0);
    ok(`keyboard ${kb}: the video preview region has no dimming`, L.preview.top + L.preview.height <= L.scrim.top && L.preview.height > 0);
    ok(`keyboard ${kb}: the bar sits right above the keyboard`, L.bar.top + L.bar.height === 844 - kb && L.bar.height === EDITOR_BAR_HEIGHT);
  }
  eq("layer order: dismiss area, scrim, then the bar on top", [...EDITOR_LAYER_ORDER], ["dismiss", "scrim", "bar"]);
  const src = read("../components/TextOverlayEditor.tsx");
  ok("the bar is rendered after the scrim in the component", src.indexOf("styles.scrim") < src.indexOf("styles.toolbarContainer"));
  ok("no full-screen dim any more", !/backdropFill/.test(src) && !/rgba\(0,0,0,0\.18\)/.test(src));
  ok("the confirm button is solid accent with a white check, no disabled-looking pink", /doneBtn: \{[^}]*backgroundColor: theme\.accent/.test(src) && !/rgba\(232,41,28,0\.18\)/.test(src));
  ok("the useless “…” button is gone", !/Ellipsis/.test(src) && !/More text options/.test(src));
  ok("the editor reports live text for the preview", /onLiveChange\?\.\(text, bgStyle\)/.test(src) && /onLiveChange=/.test(read("../app/edit.tsx")));
}

// ── C: posting ──
{
  const up = (id, progress = 0) => ({ id, _optimistic: { tempId: id, status: "uploading", progress } });
  const real = (id) => ({ id });
  const feed = [up("opt_1"), real("a"), real("b")];
  ok("posting is detected", isPosting(feed) && !isPosting([real("a")]));
  eq("while posting nothing plays (no video, no audio)", [0, 1, 2].map((i) => playingIndex(feed, i, true)), [-1, -1, -1]);
  eq("when not posting the visible item plays", playingIndex([real("a"), real("b")], 1, true), 1);
  eq("a blurred screen plays nothing", playingIndex([real("a")], 0, false), -1);
  eq("a failed upload does not freeze the feed", playingIndex([{ id: "f", _optimistic: { tempId: "f", status: "failed" } }, real("a")], 1, true), 1);
  eq("the feed scrolls to the uploading post", scrollTarget(feed), 0);
  eq("no scroll when nothing uploads", scrollTarget([real("a")]), null);
  eq("0% and 45%: the percentage", [uploadLabel(0).text, uploadLabel(45).text], ["Uploading… 0%", "Uploading… 45%"]);
  eq("99%: still a percentage", uploadLabel(99), { text: "Uploading… 99%", indeterminate: false });
  eq("100%: Finishing up…, indeterminate", uploadLabel(100), { text: "Finishing up…", indeterminate: true });
  eq("more than 100 or missing is clamped", [uploadLabel(140).indeterminate, uploadLabel(undefined).text], [true, "Uploading… 0%"]);

  // The finished post takes the optimistic one's place.
  const done = swapOptimistic(feed, "opt_1", real("srv_1"));
  eq("the real post replaces the optimistic one in place (same length, same position)", [done.length, done[0].id, done[1].id, done[2].id], [3, "srv_1", "a", "b"]);
  eq("the row keeps the optimistic key (no remount, no blank)", [rowKey(done[0]), rowKey(feed[0])], ["opt_1", "opt_1"]);
  ok("the optimistic marker is gone from the real post", done[0]._optimistic === undefined);
  const lens = [feed, swapOptimistic(feed, "opt_1", real("srv_1")), swapOptimistic(undefined, "opt_1", real("srv_1")), swapOptimistic([], "opt_1", real("srv_1"))].map((l) => l.length);
  ok("no state in between is empty or shorter than before", lens[1] === lens[0] && lens[2] === 1 && lens[3] === 1);
  eq("a swap when the optimistic row is already gone puts the post first, once", swapOptimistic([real("a")], "opt_1", real("srv_1")).map((p) => p.id), ["srv_1", "a"]);
  eq("a swap twice (late refetch) does not duplicate", swapOptimistic(done, "opt_1", real("srv_1")).map((p) => p.id), ["srv_1", "a", "b"]);
  eq("a refetch that already has the server row does not duplicate it", swapOptimistic([up("opt_1"), real("srv_1"), real("a")], "opt_1", real("srv_1")).map((p) => p.id), ["srv_1", "a"]);
  eq("insertFirst: the optimistic post goes first, once", insertFirst([real("a")], up("opt_2")).map((p) => p.id), ["opt_2", "a"]);
  eq("adoptKey without a temp id is the real post unchanged", adoptKey(real("x"), undefined), real("x"));

  const item = read("../components/FeedItem.tsx");
  const list = read("../components/FeedListView.tsx");
  ok("the list uses the stable row key and plays by playingIndex", /keyExtractor=\{rowKey\}/.test(list) && /playingIndex\(/.test(list));
  ok("video containers are black, not the app cream (#F5F3EE)", /item: \{[^}]*backgroundColor: "#000"/.test(item) && !/item: \{[^}]*F5F3EE/.test(item));
  ok("a poster frame sits under the video while it loads", /thumbnail_url \? \(\s*<Image source=\{\{ uri: post\.thumbnail_url \}\}/.test(item));
  ok("the progress label comes from uploadLabel (Finishing up…)", /uploadLabel\(post\._optimistic\?\.progress\)/.test(item) && /uploadStatus\.text/.test(item));
  const prov = read("../providers/PostsProvider.tsx");
  ok("createPost success swaps in place; no filter-then-prepend", (prov.match(/swapOptimistic\(/g) ?? []).length >= 3);
  ok("the feed scroll on upload is guarded (cannot crash Post)", /Scrolling is best-effort/.test(list));
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
