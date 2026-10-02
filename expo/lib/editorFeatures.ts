/**
 * Editor feature flags.
 *
 * Rule: no network or paid API calls in lib/ editing code. All analysis is
 * on-device and deterministic, kept in lib/ai/ behind small interfaces.
 */
export const FEATURES = {
  autoTrim: true,
  captions: false,
  soundEffects: false,
  imageOverlays: false,
  textToSpeech: false,
} as const;
