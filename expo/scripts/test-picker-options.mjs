#!/usr/bin/env node
/**
 * One options helper for BOTH camera-roll pickers (lib/pickerOptions.ts): the post picker and the campaign footage picker. iCloud download on (without it an
 * iCloud video fails with PHPhotosErrorDomain 3164), the file as it is in Photos (no HEVC conversion), one automatic retry, plain error wording.
 *   node --experimental-strip-types --no-warnings scripts/test-picker-options.mjs
 */
import { readFileSync } from "node:fs";
import { libraryPickerOptions } from "../lib/pickerOptions.ts";
import { VIDEO_PICKER_ERROR_MESSAGES, PICKER_ERROR_MESSAGES, classifyPickerError } from "../lib/pickerErrors.ts";

let failed = 0;
function eq(name, actual, expected) { const ok = JSON.stringify(actual) === JSON.stringify(expected); if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`); }
const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");

const footage = libraryPickerOptions({ videosOnly: true, multiple: { limit: 20 } });
const post = libraryPickerOptions({ photoCompatible: false, videoMaxDuration: 300 });
const photoRetry = libraryPickerOptions({ photoCompatible: true, videoMaxDuration: 300 });
eq("footage picker: videos only, several at once (20), downloads from iCloud, the original representation (no conversion), full quality", [footage.mediaTypes, footage.allowsMultipleSelection, footage.selectionLimit, footage.shouldDownloadFromNetwork, footage.preferredAssetRepresentationMode, footage.quality], [["videos"], true, 20, true, "current", 1]);
eq("post picker: photos and videos, one item, downloads from iCloud, the original representation, the video length cap", [post.mediaTypes, post.allowsMultipleSelection, "selectionLimit" in post, post.shouldDownloadFromNetwork, post.preferredAssetRepresentationMode, post.videoMaxDuration], [["images", "videos"], false, false, true, "current", 300]);
eq("a photo that failed to read is retried as a compatible image, still downloading from iCloud", [photoRetry.mediaTypes, photoRetry.preferredAssetRepresentationMode, photoRetry.shouldDownloadFromNetwork], [["images"], "compatible", true]);
eq("every combination downloads from the network", [{}, { videosOnly: true }, { photoCompatible: true }, { multiple: { limit: 3 } }].map((o) => libraryPickerOptions(o).shouldDownloadFromNetwork), [true, true, true, true]);
eq("the enum strings are the ones expo-image-picker defines", (() => { const t = read("node_modules/expo-image-picker/build/ImagePicker.types.d.ts"); return [/Current = "current"/.test(t), /Compatible = "compatible"/.test(t)]; })(), [true, true]);

// neither picker builds its own options: both use the helper and both go through the retrying launcher
const sheet = read("components/PostChoiceSheet.tsx"), rt = read("lib/footageRuntime.ts");
eq("the post picker and the footage picker both build their options with libraryPickerOptions and open with launchLibraryWithRetry", [/libraryPickerOptions\(/.test(sheet), /libraryPickerOptions\(/.test(rt), /launchLibraryWithRetry\(/.test(sheet), /launchLibraryWithRetry\(/.test(rt)], [true, true, true, true]);
eq("neither calls launchImageLibraryAsync directly, and neither sets shouldDownloadFromNetwork or the representation mode itself (so they cannot drift)", [/launchImageLibraryAsync\(/.test(sheet), /launchImageLibraryAsync\(/.test(rt), /shouldDownloadFromNetwork|preferredAssetRepresentationMode/.test(sheet), /shouldDownloadFromNetwork|preferredAssetRepresentationMode/.test(rt)], [false, false, false, false]);

// the 3164 error
const e3164 = new Error("The operation couldn't be completed. (PHPhotosErrorDomain error 3164.)");
eq("PHPhotosErrorDomain 3164 is classified as iCloud, and the footage picker says it in plain words for a video", [classifyPickerError(e3164), VIDEO_PICKER_ERROR_MESSAGES.icloud], ["icloud", "This video is in iCloud and couldn't download. Check your connection and try again."]);
eq("the post picker's wording is unchanged", PICKER_ERROR_MESSAGES.icloud, "This is in iCloud and could not be downloaded. Open it in Photos until it finishes loading, use Wi-Fi, and try again.");
eq("the footage picker maps errors through the classifier (not a raw exception string for the known kinds), and keeps the reason for the debug list", [/classifyPickerError\(e\)/.test(rt), /VIDEO_PICKER_ERROR_MESSAGES\[kind\]/.test(rt), /recordPickerProblem\(message, `\$\{kind\}: \$\{why\}`\)/.test(rt)], [true, true, true]);

// the row
const step = read("components/money/FootageStep.tsx");
eq("while the video downloads the screen shows a 'Downloading from iCloud…' row with Cancel, the retry wording, and drops a result that arrives after Cancel", [/Downloading from iCloud…/.test(step), /Still downloading, trying again…/.test(step), /Almost there…/.test(step), /accessibilityLabel="Cancel"/.test(step), /run\.current !== my/.test(step), /isCancelled: \(\) => run\.current !== my/.test(step)], Array(6).fill(true));
console.log(failed ? `\n${failed} FAILED` : "\nall passed"); process.exit(failed ? 1 : 0);
