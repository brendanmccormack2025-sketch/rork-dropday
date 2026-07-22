const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");
const path = require("path");

const config = withRorkMetro(getDefaultConfig(__dirname));

// Fix: @supabase/supabase-js@2.106.1's ESM bundle (dist/index.mjs) contains
// a dynamic import(OTEL_PKG) expression that Hermes/hermesc rejects at parse
// time, breaking all React Native release builds. The CJS bundle (dist/index.cjs)
// is Hermes-safe — it uses require() instead of import().
//
// Metro with unstable_enablePackageExports (default in RN 0.81) picks the
// "import" export condition (ESM) because supabase-js@2.106.1 lacks a
// "react-native" condition. The official fix in v2.106.2 (supabase-js PR #2393)
// adds a "react-native" export condition pointing to the CJS bundle. Since the
// package version can't be upgraded here, we replicate that resolution behavior
// via a custom resolveRequest that forces supabase-js to the CJS bundle on native.
const supabasePkgDir = path.dirname(
  require.resolve("@supabase/supabase-js/package.json")
);
const previousResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform !== "web" &&
    (moduleName === "@supabase/supabase-js" ||
      moduleName === "@supabase/supabase-js/cors")
  ) {
    const fileName = moduleName.endsWith("/cors")
      ? "dist/cors.cjs"
      : "dist/index.cjs";
    return {
      type: "sourceFile",
      filePath: path.join(supabasePkgDir, fileName),
    };
  }
  if (previousResolveRequest) {
    return previousResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
