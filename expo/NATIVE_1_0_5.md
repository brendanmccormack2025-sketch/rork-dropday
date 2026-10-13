# Native work for 1.0.5 (burned-in text styles)

Everything below needs a new EAS build and an `app.json` version bump. The JS side is already gated on the two
capabilities in step 2 and 3, so it switches on by itself once the native module reports them; on 1.0.4 nothing changes.

## What 1.0.4 can burn in (VideoRenderModule.swift, `makeTextOverlay`)
Text color, background color (#RRGGBB or #RRGGBBAA, absent = none), per-line background, padding, corner radius,
letter spacing, uppercase, a fixed soft shadow (black 60%, radius 4, 2 down), font by `UIFont(name:)`.
Only Montserrat is embedded.

## What it cannot do yet
1. **Fonts**: TikTok Sans, Anton, Archivo Black, Poppins, Permanent Marker, Caveat, DM Serif Display, Space Grotesk are not
   embedded, so a caption in one of them falls back to Montserrat ExtraBold (the caption sheet hides them on 1.0.4).
   Add the `.ttf` files to the `expo-font` plugin list in `app.json`
   (PostScript names: TikTokSans-Bold, Anton-Regular, ArchivoBlack-Regular, Poppins-SemiBold, PermanentMarker-Regular,
   Caveat-Bold, DMSerifDisplay-Regular, SpaceGrotesk-Bold).
2. **Report the embedded fonts**: expose `supportedFontNames: string[]` from the module (the names for which
   `UIFont(name:size:) != nil`). `lib/renderAtPost.ts` passes it to `toRenderJson({ fontNames })`; the caption sheet and
   the default caption font (TikTok Sans, "Trial style") use it.
3. **Outline**: add a `supportsTextOutline` capability and honor the style keys `outlineColor` (#RRGGBB) and
   `outlineWidth` (points) by adding `.strokeColor` and a negative `.strokeWidth` (stroke + fill) to the attributed
   string in `makeTextOverlay`. Until then outline keys are not sent and the caption sheet hides the outline control.
4. **Shadow placement (optional)**: the shadow sits on the container layer, so with a background it falls around the box
   (the preview matches). A shadow on the letters inside a box would need a second layer.
5. **Text-button overlays** are drawn live (editor, Preview, feed) and are not part of the burned-in video; if that ever
   changes, `overlayRenderStyle` in `lib/editStyles.ts` is the mapping, covered by `scripts/test-text-styles.mjs`.

Test matrix: `scripts/test-text-styles.mjs` checks every font x text color x background (none, 11 solids, 2 translucent)
x outline (off, 3 sizes) x shadow for overlays and captions, with and without the 1.0.5 capabilities.
