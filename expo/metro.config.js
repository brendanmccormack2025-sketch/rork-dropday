const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");

const config = getDefaultConfig(__dirname);

// ── OTEL_PKG backup fix ───────────────────────────────────────────────
// The primary fix is scripts/patch-supabase-otel.js (runs via postinstall
// and eas-build-post-install). This Metro resolver override is a backup
// that forces @supabase/supabase-js to resolve to the CJS bundle, which
// uses require() instead of variable-named import(). If the postinstall
// patch doesn't run for some reason, this covers the Metro bundling path.
const supabaseCjsPath = path.join(
  __dirname,
  "node_modules",
  "@supabase",
  "supabase-js",
  "dist",
  "index.cjs"
);

const rorkConfig = withRorkMetro(config);
const originalResolveRequest = rorkConfig.resolver.resolveRequest;

rorkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    moduleName === "@supabase/supabase-js" ||
    moduleName === "@supabase/supabase-js/dist/index.cjs"
  ) {
    return {
      filePath: supabaseCjsPath,
      type: "sourceFile",
    };
  }
  return originalResolveRequest(context, moduleName, platform);
};

module.exports = rorkConfig;
