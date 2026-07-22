const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");

const config = getDefaultConfig(__dirname);

// @supabase/supabase-js@2.106.x ships an ESM bundle (dist/index.mjs) that
// contains a dynamic `import('@opentelemetry/api')` expression guarded by
// webpackIgnore/turbopackIgnore/@vite-ignore magic comments. Metro (Expo SDK
// 55+) enables `unstable_enablePackageExports` by default, so it resolves the
// `import` export condition and picks that ESM bundle. Hermes rejects `import()`
// at parse time, breaking every release build with "Invalid expression encountered"
// (supabase/supabase-js#2380, #2393).
//
// The CJS bundle (dist/index.cjs) hides the dynamic import behind a Function
// constructor, so it is Hermes-safe. Force Metro onto the CJS bundle by
// preferring the `require` export condition for this package.
// See https://github.com/supabase/supabase-js/pull/2393
config.resolver.conditionNames = Array.from(
  new Set(["require", ...(config.resolver.conditionNames ?? [])])
);
// `unstable_conditionNames` is the active field on some Metro versions; set
// both to be safe across SDK revisions.
if (config.resolver.unstable_conditionNames) {
  config.resolver.unstable_conditionNames = Array.from(
    new Set(["require", ...config.resolver.unstable_conditionNames])
  );
}

module.exports = withRorkMetro(config);
