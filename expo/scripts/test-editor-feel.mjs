#!/usr/bin/env node
/**
 * Editor feel: live frame preview while dragging a trim handle, a tapped clip plays at once (only it), and captions
 * use Apple's newer on-device transcriber when the phone has it.
 *   node scripts/test-editor-feel.mjs
 */
import { readFileSync } from "node:fs";
let failed = 0;
const ok = (name, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${name}`); };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const tl = read("../components/TimelineEditor.tsx");
const edit = read("../app/edit.tsx");
const swift = read("../modules/speech-captions/ios/SpeechCaptionsModule.swift");
const podspec = read("../modules/speech-captions/ios/SpeechCaptions.podspec");

ok("dragging a left trim handle previews the frame at the new start", /trimStartMs: newStart,\n\s+\}\);\n\s+if \(sl\.clip\.type === "video"\) scrub\(newStart, sl\.clip\.uri\);/.test(tl));
ok("dragging a right trim handle previews the frame at the new end", /if \(sl\.clip\.type === "video"\) scrub\(newEnd, sl\.clip\.uri\);/.test(tl));
ok("dragging a seam previews the frame there", /scrub\(drag\.clampedMs, cfg\.sourceUri\);/.test(tl));
ok("letting go ends the preview (all four release paths)", (tl.match(/scrub\(null\);\n\s+onTrimReleaseRef\.current\?\.\(\);/g) ?? []).length === 4);
ok("previews are throttled (~30 a second)", /now - lastScrubAtRef\.current < 33/.test(tl));
ok("both simple timelines are wired to the preview player", (edit.match(/onScrub=\{handleEdgePreview\}/g) ?? []).length === 2);
ok("the preview player can show any clip's file", /const uri = sourceUri \?\? editStateRef\.current\?\.state\.sourceUri;/.test(edit));
ok("tapping a clip jumps to its start and plays it", /for \(let i = 0; i < idx; i\+\+\) start \+= effectiveDurationMs\(clips\[i\]!\);\n\s+handleSeek\(start\);\n\s+setTimeout\(\(\) => setIsPlaying\(true\), 66\);/.test(edit));
ok("tapping a piece on the precision timeline always plays it", /\/\/ A tapped piece plays \(and loops\) at once, whether the video was playing or paused\.\n\s+setTimeout\(\(\) => setIsPlaying\(true\), 60\);/.test(edit));

ok("captions: iOS 26 transcriber first, guarded so older Xcode still builds", /#if compiler\(>=6\.2\)\n\s+if #available\(iOS 26\.0, \*\) \{/.test(swift) && /@available\(iOS 26\.0, \*\)\nprivate func transcribeWithAnalyzer/.test(swift));
ok("captions: word times from the transcript (audioTimeRange)", /attributeOptions: \[\.audioTimeRange\]/.test(swift) && /compactMap\(\\\.audioTimeRange\)/.test(swift));
ok("captions: the language model is installed when missing", /AssetInventory\.assetInstallationRequest\(supporting: modules\)/.test(swift));
ok("captions: any problem falls back to the older recognizer", /\} catch \{\n\s+\/\/ the older recognizer below gets a try\n\s+\}/.test(swift));
ok("captions: still on the phone only (old path keeps requiresOnDeviceRecognition)", /request\.requiresOnDeviceRecognition = true/.test(swift));
ok("NaturalLanguage is linked", /'NaturalLanguage'/.test(podspec) && /^import NaturalLanguage$/m.test(swift));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
