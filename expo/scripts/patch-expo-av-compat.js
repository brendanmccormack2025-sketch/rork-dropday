#!/usr/bin/env node
/**
 * Restores the three ExpoModulesCore headers that SDK 57 removed but
 * expo-av 16.0.8 (final release, unmaintained) still imports natively:
 *
 *   EXEventEmitter.h            — legacy module event protocol
 *   EXEventEmitterService.h     — event emitter service protocol
 *   EXLegacyExpoViewProtocol.h  — legacy view init protocol
 *
 * Without this, the EXAV pod fails to compile on SDK 57
 * ("'ExpoModulesCore/EXEventEmitter.h' file not found",
 *  "could not build Objective-C module 'EXAV'").
 *
 * The header contents below are copied verbatim from
 * expo-modules-core@3.0.30 (SDK 54), the last SDK where expo-av compiled.
 * They are plain @protocol declarations whose own dependencies
 * (EXDefines.h, EXExportedModule.h, EXModuleRegistry.h) still exist in
 * expo-modules-core 57, so they are written into the expo-av pod itself
 * and the expo-av imports are redirected to them. No JS or permission
 * behavior is changed.
 *
 * Used by:
 *  - CLI entry (local node_modules patching): `node scripts/patch-expo-av-compat.js`
 *  - The `plugins/expo-av-compat-plugin.js` config plugin, so EAS cloud
 *    builds apply it during prebuild.
 *
 * Idempotent (safe to run multiple times).
 */
const fs = require("fs");
const path = require("path");

// Verbatim from expo-modules-core@3.0.30 /ios/Legacy/Protocols + /ios
const HEADERS = {
  "EXEventEmitter.h": `// Copyright © 2018 650 Industries. All rights reserved.

#import <Foundation/Foundation.h>

#import <ExpoModulesCore/EXDefines.h>
#import <ExpoModulesCore/EXExportedModule.h>

// Implement this protocol in your exported module to be able
// to send events through platform event emitter.

@protocol EXEventEmitter

- (void)startObserving;
- (void)stopObserving;

- (NSArray<NSString *> *)supportedEvents;

@end
`,
  "EXEventEmitterService.h": `// Copyright © 2018 650 Industries. All rights reserved.

#import <Foundation/Foundation.h>

#import <ExpoModulesCore/EXDefines.h>
#import <ExpoModulesCore/EXExportedModule.h>

@protocol EXEventEmitterService

- (void)sendEventWithName:(NSString *)name body:(id)body;

@end
`,
  "EXLegacyExpoViewProtocol.h": `// Copyright 2022-present 650 Industries. All rights reserved.

#import <ExpoModulesCore/EXModuleRegistry.h>

/**
 The protocol required for the Objective-C views to be initialized with the legacy module registry.
 - ToDo: Remove once all views are migrated to the new API and Swift.
 */
@protocol EXLegacyExpoViewProtocol

- (instancetype)initWithModuleRegistry:(nullable EXModuleRegistry *)moduleRegistry;

@end
`,
};

// Headers are written into the EXAV pod (its podspec globs EXAV/**), so they
// compile into the EXAV target and resolve via the <EXAV/...> umbrella — the
// same pattern expo-av already uses for its own headers.
const REWRITES = [
  ["#import <ExpoModulesCore/EXEventEmitter.h>", "#import <EXAV/EXEventEmitter.h>"],
  ["#import <ExpoModulesCore/EXEventEmitterService.h>", "#import <EXAV/EXEventEmitterService.h>"],
  ["#import <ExpoModulesCore/EXLegacyExpoViewProtocol.h>", "#import <EXAV/EXLegacyExpoViewProtocol.h>"],
  // Old UNIMODULES promise typedefs were dropped before SDK 57; core 57 ships
  // byte-identical EXPromise* typedefs, so redirect the token.
  ["UMPromiseResolveBlock", "EXPromiseResolveBlock"],
  ["UMPromiseRejectBlock", "EXPromiseRejectBlock"],
];

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(h|m|mm)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Patches node_modules/expo-av inside the given Expo project root.
 * @param {string} expoProjectRoot Absolute path to the Expo app directory.
 * @returns {boolean} true if any change was made.
 */
function patchExpoAv(expoProjectRoot) {
  const avIosDir = path.join(expoProjectRoot, "node_modules", "expo-av", "ios");

  if (!fs.existsSync(avIosDir)) {
    console.log("[patch-expo-av-compat] expo-av ios dir not found, skipping");
    return false;
  }

  // 1. Write the compat headers into the EXAV pod source dir.
  const headerDir = path.join(avIosDir, "EXAV");
  for (const [name, content] of Object.entries(HEADERS)) {
    const target = path.join(headerDir, name);
    if (fs.existsSync(target)) {
      console.log(`[patch-expo-av-compat] ${name} already present, skipping write`);
    } else {
      fs.writeFileSync(target, content, "utf8");
      console.log(`[patch-expo-av-compat] wrote ${name}`);
    }
  }

  // 2. Redirect the removed-header imports to the local compat headers.
  const files = walk(avIosDir, []);
  let patchedCount = 0;
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let next = content;
    for (const [from, to] of REWRITES) {
      next = next.split(from).join(to);
    }
    if (next !== content) {
      fs.writeFileSync(file, next, "utf8");
      patchedCount += 1;
      console.log(`[patch-expo-av-compat] rewrote imports in ${path.relative(avIosDir, file)}`);
    }
  }

  // 3. Bridge the legacy resolver type: core 57 typed `Promise.resolver` as
  //    (JavaScriptValue) -> Void, but expo-av's legacy ObjC setFullscreen
  //    expects EXPromiseResolveBlock (Any?). Core 57 ships a matching
  //    `legacyResolver` property — use it.
  const swiftFile = path.join(avIosDir, "EXAV", "Video", "VideoViewModule.swift");
  if (fs.existsSync(swiftFile)) {
    const content = fs.readFileSync(swiftFile, "utf8");
    if (content.includes("promise.resolver")) {
      fs.writeFileSync(
        swiftFile,
        content.split("promise.resolver").join("promise.legacyResolver"),
        "utf8"
      );
      patchedCount += 1;
      console.log("[patch-expo-av-compat] bridged promise.resolver -> promise.legacyResolver in VideoViewModule.swift");
    }
  }

  // 4. Restore EXFatal / EXErrorWithMessage / EXLog* helpers that SDK 54
  //    declared in EXDefines.h and SDK 57 removed entirely (declarations and
  //    implementations). expo-av's legacy ObjC still calls them.
  const FATAL_H = `// Compat header for expo-av 16.0.8 on SDK 57.
// expo-modules-core SDK 54 declared these in EXDefines.h; SDK 57 removed them.
#import <Foundation/Foundation.h>

#ifdef __cplusplus
extern "C" {
#endif

void EXFatal(NSError *error);
NSError * EXErrorWithMessage(NSString *message);

void EXLogInfo(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
void EXLogWarn(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);
void EXLogError(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

#ifdef __cplusplus
}
#endif
`;
  const FATAL_M = `// Compat implementations for expo-av 16.0.8 on SDK 57 (see EXFatal.h).
#import <EXAV/EXFatal.h>

NSError * EXErrorWithMessage(NSString *message)
{
  // Verbatim behavior from expo-modules-core SDK 54 (Legacy/EXUtilities.m).
  NSDictionary<NSString *, id> *errorInfo = @{NSLocalizedDescriptionKey: message};
  return [[NSError alloc] initWithDomain:@"EXModulesErrorDomain" code:0 userInfo:errorInfo];
}

void EXFatal(NSError *error)
{
  // SDK 54 routed this to the legacy log manager's fatal handler, which no
  // longer exists in SDK 57. Log and raise — this path only triggers when
  // required Info.plist usage keys are missing.
  NSLog(@"[EXAV fatal] %@", error);
  [NSException raise:@"EXFatalException" format:@"%@", error.localizedDescription ?: @"Unknown error"];
}

void EXLogInfo(NSString *format, ...)
{
  va_list args;
  va_start(args, format);
  NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  NSLog(@"[EXAV info] %@", message);
}

void EXLogWarn(NSString *format, ...)
{
  va_list args;
  va_start(args, format);
  NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  NSLog(@"[EXAV warn] %@", message);
}

void EXLogError(NSString *format, ...)
{
  va_list args;
  va_start(args, format);
  NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
  va_end(args);
  NSLog(@"[EXAV error] %@", message);
}
`;
  for (const [name, content] of Object.entries({ "EXFatal.h": FATAL_H, "EXFatal.m": FATAL_M })) {
    const target = path.join(headerDir, name);
    if (fs.existsSync(target)) {
      console.log(`[patch-expo-av-compat] ${name} already present, skipping write`);
    } else {
      fs.writeFileSync(target, content, "utf8");
      console.log(`[patch-expo-av-compat] wrote ${name}`);
    }
  }

  // Inject the EXFatal.h import into every .m that calls the restored helpers.
  for (const file of walk(avIosDir, [])) {
    if (!file.endsWith(".m")) continue;
    const content = fs.readFileSync(file, "utf8");
    if (!/\bEXFatal\s*\(|\bEXErrorWithMessage\s*\(|\bEXLog(?:Info|Warn|Error)\s*\(/.test(content)) continue;
    if (content.includes("#import <EXAV/EXFatal.h>")) continue;
    const idx = content.indexOf("#import");
    if (idx === -1) continue;
    fs.writeFileSync(file, content.slice(0, idx) + "#import <EXAV/EXFatal.h>\n" + content.slice(idx), "utf8");
    patchedCount += 1;
    console.log(`[patch-expo-av-compat] injected EXFatal.h import into ${path.relative(avIosDir, file)}`);
  }

  if (patchedCount === 0) {
    console.log("[patch-expo-av-compat] no imports needed rewriting (already patched or not present)");
  } else {
    console.log(`[patch-expo-av-compat] patched ${patchedCount} file(s) successfully`);
  }
  return patchedCount > 0;
}

module.exports = { patchExpoAv };

if (require.main === module) {
  patchExpoAv(path.join(__dirname, ".."));
}
