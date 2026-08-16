const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");

const config = getDefaultConfig(__dirname);

// ── OTEL_PKG fix ───────────────────────────────────────────────────────
// @supabase/supabase-js@2.106.1 ESM bundle (dist/index.mjs) contains
// `import(/* webpackIgnore */ OTEL_PKG)` where OTEL_PKG is a variable.
// Hermes rejects variable-named dynamic import() as "Invalid expression",
// breaking the Supabase client internally. The CJS bundle (dist/index.cjs)
// uses `Promise.resolve().then(require(s))` instead — safe for Hermes.
//
// We intercept the resolution of @supabase/supabase-js and return the
// CJS file path directly, same approach Rork uses for its polyfills.
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
