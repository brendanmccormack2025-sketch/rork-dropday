const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js@2.106.1 ships an ESM bundle (dist/index.mjs) containing
// `import(OTEL_PKG)` — a dynamic import() with a *variable* specifier plus
// webpack/turbopack/vite magic comments. Metro doesn't understand those comments
// and cannot statically resolve a variable-named import(), so Hermes production
// bundling fails with "Invalid expression encountered". The CJS bundle
// (dist/index.cjs) uses require() instead and is safe. Expo SDK 54 enables
// unstable_enablePackageExports by default, which makes Metro pick the ESM
// bundle via the package's "exports" field. This resolver override forces
// supabase-js to the CJS entry for all platforms, leaving every other package
// untouched.
const rorkConfig = withRorkMetro(config);
const originalResolveRequest = rorkConfig.resolver.resolveRequest;

const SUPABASE_CJS_PATH = path.join(
  __dirname,
  "node_modules",
  "@supabase",
  "supabase-js",
  "dist",
  "index.cjs",
);

rorkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@supabase/supabase-js") {
    return {
      type: "sourceFile",
      filePath: SUPABASE_CJS_PATH,
    };
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = rorkConfig;
