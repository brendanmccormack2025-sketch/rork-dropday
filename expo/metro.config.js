const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Fix: @supabase/supabase-js@2.106.1 ships an ESM bundle (dist/index.mjs)
// containing `import(/* webpackIgnore: true */ OTEL_PKG)` where OTEL_PKG is a
// variable, not a string literal. Metro/Hermes cannot statically analyze a
// variable-named import() and throws "Invalid expression encountered" during
// production bundling. The CJS bundle (dist/index.cjs) uses require() instead,
// which Metro handles correctly. RN 0.81 enables package exports by default,
// so Metro resolves the "import" export condition → dist/index.mjs → crash.
// This override intercepts the resolution and forces Metro to load the CJS
// bundle for all platforms.
const supabaseCjsPath = path.resolve(
  __dirname,
  "node_modules/@supabase/supabase-js/dist/index.cjs"
);

const rorkConfig = withRorkMetro(config);

const originalResolveRequest = rorkConfig.resolver.resolveRequest;
rorkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@supabase/supabase-js") {
    return { type: "sourceFile", filePath: supabaseCjsPath };
  }
  return originalResolveRequest
    ? originalResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = rorkConfig;
