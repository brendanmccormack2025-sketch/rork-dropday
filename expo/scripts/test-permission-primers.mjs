#!/usr/bin/env node
/**
 * Apple guideline 5.1.1(iv): a custom message shown before a system permission prompt must ALWAYS lead to the prompt.
 * No "Not now" / skip button and no way to close it first (rejection, Sept 2026). The user says no in the prompt itself.
 *   node scripts/test-permission-primers.mjs
 */
import { readFileSync } from "node:fs";

let failed = 0;
const ok = (name, c) => { if (!c) failed++; console.log(`${c ? "PASS" : "FAIL"}  ${name}`); };
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
/** The code without comments: only what the user can see counts. */
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const camera = read("../app/camera.tsx");
const permBlock = camera.slice(camera.indexOf("if (!permission.granted)"), camera.indexOf("const zoomToLabel"));
ok("camera: the access screen has no 'Not now'", !/Not now/i.test(permBlock));
ok("camera: Continue asks the system for camera and microphone", /label="Continue"[\s\S]{0,120}await requestPermission\(\)/.test(permBlock));
ok("camera: after a no, the screen links to Settings", permBlock.includes("Open Settings"));

const explainer = code(read("../components/CaptionsExplainer.tsx"));
ok("speech explainer: no 'Not now'", !/Not now/i.test(explainer));
ok("speech explainer: closing it (Android back) continues to the prompt", explainer.includes("onRequestClose={onContinue}"));

const contacts = code(read("../app/onboarding-contacts.tsx"));
ok("contacts onboarding: no 'Not now' or skip", !/Not now|Skip|Maybe later/i.test(contacts));
ok("contacts onboarding: no back button before the prompt", /<SettingsScaffold[^>]*hideBack/.test(contacts));
ok("contacts onboarding: the only button is Continue and it shows the system prompt", (contacts.match(/<Pressable/g) ?? []).length === 1 && contacts.includes(">Continue<") && contacts.includes("enableContacts(user.id)"));

const texts = read("../lib/privacyTexts.ts");
ok("contacts onboarding says the user can say no in the system prompt", /CONTACTS_ONBOARDING_BODY = "[^"]*you can say no/.test(texts));

const scaffold = read("../components/SettingsScaffold.tsx");
ok("the scaffold can hide its back button", /hideBack \? <View/.test(scaffold));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
