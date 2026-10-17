#!/usr/bin/env node
/**
 * The edit choice before the editor: Keep original / AI edit my video / Customize my edit.
 * Nothing is edited before the choice; each path runs only what it chose; the source stays untouched.
 *   node --experimental-strip-types --no-warnings scripts/test-edit-choice.mjs
 */
import { readFileSync } from "node:fs";
import {
  EDIT_FEATURES, EDIT_OPTIONS, LEGACY_CHOICE, appliesNothing, choiceFor, encodeEditChoice, needsTranscription, parseEditChoice, wantsEditChoice,
} from "../lib/editChoice.ts";

let failed = 0;
function eq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}
const ok = (name, c) => eq(name, !!c, true);
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const steps = (c) => ({ silence: c.silence, cleanup: c.cleanup, captions: c.captions, transcription: needsTranscription(c) });

// ── what each path runs ──
eq("Keep original: no pause removal, no cleanup, no captions, no speech analysis", steps(choiceFor("original")), { silence: false, cleanup: false, captions: false, transcription: false });
eq("AI edit: everything, like before", steps(choiceFor("auto")), { silence: true, cleanup: true, captions: true, transcription: true });
eq("AI edit follows the 'Auto-edit my videos' setting for pause removal", steps(choiceFor("auto", undefined, false)), { silence: false, cleanup: true, captions: true, transcription: true });
eq("Customize: only captions", steps(choiceFor("custom", { silence: false, cleanup: false, captions: true })), { silence: false, cleanup: false, captions: true, transcription: true });
eq("Customize: only pauses (speech analysed so no pause cut clips a word)", steps(choiceFor("custom", { silence: true, cleanup: false, captions: false })), { silence: true, cleanup: false, captions: false, transcription: true });
eq("Customize: cleanup without captions still transcribes (cuts come from the transcript)", steps(choiceFor("custom", { silence: false, cleanup: true, captions: false })), { silence: false, cleanup: true, captions: false, transcription: true });
ok("Customize with everything off applies nothing (treated as Keep original)", appliesNothing(choiceFor("custom", { silence: false, cleanup: false, captions: false })));

// ── the param the editor reads ──
for (const c of [
  choiceFor("original"),
  choiceFor("auto"),
  choiceFor("auto", undefined, false),
  choiceFor("custom", { silence: true, cleanup: false, captions: true }),
  choiceFor("custom", { silence: false, cleanup: true, captions: false }),
  choiceFor("custom", { silence: false, cleanup: false, captions: false }),
]) eq(`round trip ${encodeEditChoice(c)}`, parseEditChoice(encodeEditChoice(c)), c);
eq("no param (draft, reaction, older link): the old automatic behaviour", parseEditChoice(undefined), LEGACY_CHOICE);
eq("an unknown value: the old behaviour, never a crash", parseEditChoice("whatever"), LEGACY_CHOICE);
ok("an explicit choice is marked explicit, the fallback is not", parseEditChoice("original").explicit && !LEGACY_CHOICE.explicit);

// ── who sees the screen ──
ok("a new video post gets the choice", wantsEditChoice({ clips: [{ type: "video" }] }));
ok("a photo goes straight to the editor", !wantsEditChoice({ clips: [{ type: "image" }] }));
ok("a reaction goes straight to the editor", !wantsEditChoice({ clips: [{ type: "video" }], reactingTo: "p" }));
ok("a reply in a reaction tree goes straight to the editor", !wantsEditChoice({ clips: [{ type: "video" }], rootDropId: "p" }));
ok("a draft opens in the editor as saved", !wantsEditChoice({ clips: [{ type: "video" }], draftId: "d" }));

// ── the screen ──
const screen = read("../app/edit-choice.tsx");
eq("three options, explained", EDIT_OPTIONS.map((o) => [o.mode, o.title, o.body.length > 10]), [["original", "Keep original", true], ["auto", "AI edit my video", true], ["custom", "Customize my edit", true]]);
eq("Customize offers each edit separately", EDIT_FEATURES.map((f) => f.key), ["silence", "cleanup", "captions"]);
for (const mod of ["lib/ai/autoEdit", "lib/autoEdit/analysis", "lib/transcription", "lib/silenceDetection", "lib/renderEdit", "lib/mergeClips", "lib/exportEdit", "modules/"]) {
  ok(`the screen does no processing (does not import ${mod})`, !screen.includes(`@/${mod}`));
}
ok("nothing is chosen until the user picks (no preselected option)", /useState<EditMode \| null>\(null\)/.test(screen));
ok("Continue is disabled until an option is picked", /disabled=\{!mode \|\| busy\}/.test(screen));
ok("one request at a time (busy guard before navigating)", /if \(!mode \|\| busyRef\.current\) return;/.test(screen) && screen.indexOf("busyRef.current = true") < screen.indexOf("openEditor(choice)"));
ok("back from the editor makes the screen usable again (choose again)", /useFocusEffect[\s\S]{0,120}busyRef\.current = false/.test(screen));
ok("the editor is pushed (not replaced), so Back returns to the choice", /router\.push\(\{ pathname: "\/edit"/.test(screen) && !/router\.replace\(\{ pathname: "\/edit"/.test(screen));
ok("the clips are passed through untouched, only `edit` is added", /const \{ edit: _old, \.\.\.pass \} = params;/.test(screen) && /params: \{ \.\.\.pass, edit: encodeEditChoice\(effective\) \}/.test(screen));
ok("the speech prompt comes only when an edit that needs it was chosen", /needsTranscription\(choice\) && \(await needsSpeechPrimer\(\)\)/.test(screen));

// ── entry points ──
const camera = read("../app/camera.tsx");
const sheet = read("../components/PostChoiceSheet.tsx");
ok("camera: a new video goes to the choice first", /wantsEditChoice\(\{ clips: forEditor, reactingTo, rootDropId \}\) \? "\/edit-choice" : "\/edit"/.test(camera));
ok("camera roll: a video goes to the choice first", /pathname: wantsEditChoice\(\{ clips: \[clip\] \}\) \? "\/edit-choice" : "\/edit"/.test(sheet));
ok("the Create sheet no longer asks for speech before any choice", !sheet.includes("needsSpeechPrimer") && !sheet.includes("CaptionsExplainer"));
ok("the route is registered", /name="edit-choice"/.test(read("../app/_layout.tsx")));

// ── the editor runs only what was chosen ──
const edit = read("../app/edit.tsx");
const silenceStart = edit.indexOf("if (!AUTO_EDIT_ENABLED || autoEditStartedRef.current) return;");
ok("pause removal: the choice is checked before the silence step starts", silenceStart > 0 && edit.indexOf("if (!editChoice.silence) return;", silenceStart) > silenceStart && edit.indexOf("if (!editChoice.silence) return;", silenceStart) < edit.indexOf("const result = await autoEdit(", silenceStart));
ok("an explicit choice is not overridden by the setting; without one the setting still decides", /if \(!editChoice\.explicit && !\(await getAutoEditEnabled\(\)\)\) return;/.test(edit));
ok("the transcript waits for no silence step that was not chosen", /AUTO_EDIT_ENABLED &&\s*editChoice\.silence &&/.test(edit));
ok("cleanup: ums, filler words and a slow start are cut only when chosen", /const planned = editChoice\.cleanup \? \[\.\.\.planHookTrim\(words, durationMs\), \.\.\.planFillerCuts\(words\)\] : \[\];/.test(edit) && /const umDecisions = editChoice\.cleanup \? umPlan\.decisions : \[\];/.test(edit) && !/mergePlan\(protectedState\.state, umPlan\.decisions/.test(edit));
ok("pause cuts are kept clear of words once the transcript is known (and in undo history)", /const guarded = guardSilenceCutsAgainstWords\(model\.state, words\);/.test(edit) && /mergePlan\(guarded\.state, planned/.test(edit) && /guardSilenceCutsAgainstWords\(snap, words\)\.state/.test(edit));
ok("captions start on or off as chosen", /initialOn: editChoice\.captions,/.test(edit));
ok("Keep original: speech is analyzed only if the creator turns captions on later", /onlyWhenOn: !needsTranscription\(editChoice\),/.test(edit));
const captions = read("../lib/transcription/useCaptions.ts");
ok("useCaptions: transcription starts only when active (enabled, and captions on when it waits for them)", /const active = enabled && \(!options\?\.onlyWhenOn \|\| captionsOn\);/.test(captions) && /if \(!active \|\| !ready \|\| status !== "waiting"\) return;/.test(captions));
ok("the editor still has Keep original / undo for returning to the source after an AI edit", edit.includes("handleKeepOriginal") && edit.includes('accessibilityLabel="Keep original"'));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
