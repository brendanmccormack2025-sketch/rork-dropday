const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");
const { withRorkMetro } = require("@rork-ai/toolkit-sdk/metro");

const config = getDefaultConfig(__dirname);

// OTEL_PKG backup — forces CJS bundle for @supabase/supabase-js
const supabaseCjsPath = path.join(
  __dirname, "node_modules", "@supabase", "supabase-js", "dist", "index.cjs"
);
const rorkConfig = withRorkMetro(config);
const originalResolveRequest = rorkConfig.resolver.resolveRequest;
rorkConfig.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "@supabase/supabase-js" || moduleName === "@supabase/supabase-js/dist/index.cjs") {
    return { filePath: supabaseCjsPath, type: "sourceFile" };
  }
  return originalResolveRequest(context, moduleName, platform);
};
module.exports = rorkConfig;
