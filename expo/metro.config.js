const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");
const path = require("path");

const config = getDefaultConfig(__dirname);

// Fix: @supabase/supabase-js@2.106.1's ESM bundle (dist/index.mjs) contains a
// dynamic import() with a variable argument and webpack/turbopack/vite magic
// comments that Metro cannot parse, causing "Invalid expression encountered"
// during production bundling. Force Metro to use the CJS bundle (dist/index.cjs)
// which uses Promise.resolve().then(require()) instead of import().
const originalResolveRequest = config.resolver?.resolveRequest;
config.resolver = {
  ...config.resolver,
  resolveRequest: (context, moduleName, platform) => {
    if (
      moduleName === "@supabase/supabase-js" ||
      moduleName === "@supabase/supabase-js/package.json"
    ) {
      const base = path.resolve(
        __dirname,
        "node_modules/@supabase/supabase-js"
      );
      if (moduleName === "@supabase/supabase-js/package.json") {
        return {
          filePath: path.resolve(base, "package.json"),
          type: "sourceFile",
        };
      }
      return {
        filePath: path.resolve(base, "dist/index.cjs"),
        type: "sourceFile",
      };
    }
    if (originalResolveRequest) {
      return originalResolveRequest(context, moduleName, platform);
    }
    return context.resolveRequest(context, moduleName, platform);
  },
};

module.exports = withRorkMetro(config);
