/**
 * Expo config plugin that applies the expo-av SDK 57 compat patch during
 * prebuild, so EAS cloud builds (and local `expo run:ios`) compile the EXAV
 * pod against the headers SDK 57 removed. See
 * scripts/patch-expo-av-compat.js for the patch details.
 */
const { withDangerousMod } = require("@expo/config-plugins");
const { patchExpoAv } = require("../scripts/patch-expo-av-compat");

const withExpoAvCompat = (config) =>
  withDangerousMod(config, [
    "ios",
    (config) => {
      patchExpoAv(config.modRequest.projectRoot);
      return config;
    },
  ]);

module.exports = withExpoAvCompat;
