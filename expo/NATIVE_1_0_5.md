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
5. **Text-button overlays** are drawn live (editor, Preview, feed) in the POSTED video. The camera-roll save can burn them
   in (below); `overlayRenderStyle` in `lib/editStyles.ts` is the older mapping for captions-style text, covered by
   `scripts/test-text-styles.mjs`.

## Done in VideoRenderModule.swift for 1.0.5 (capabilities in `Constants`)
- `supportsTextOverlays`: a `"text"` overlay with a complete `styleSpec` (lib/textOverlayStyle.ts `textOverlayExportSpec`)
  is placed by its own `xCenter` / `yCenter` (fractions of the frame), turned by `rotation` (degrees clockwise), wrapped at
  `maxWidth` x frame width with fixed `lineHeight`, and drawn with font (`fontName`), colour, a hugging per-line
  background (`backgroundColor`, `lineBackground`; absent = none), `outlineColor` / `outlineWidth` and `textShadow`.
- `supportsTextOutline`: the outline is drawn as an image (UIKit stroke under the fill, round joins), reaching
  `outlineWidth` beyond the letters.
- `supportedFontNames`: the bundled fonts `UIFont(name:)` opens. The files are in the `expo-font` list in `app.json`
  (UIAppFonts) and the module also registers every bundled `.ttf` / `.otf` with `CTFontManagerRegisterFontsForURL`.
- `textShadow {color, opacity, radius, offsetY}` sits on the letters (or the outline image), never on the box; sizes are for
  a 1080-wide frame. The older `shadow: true` (container, captions) is unchanged. Captions are drawn exactly as before.
- JS gates all of it behind `supportsTextOverlays` (`modules/video-render`) and the per-user setting "Include text in saved
  video" (`lib/autoEditSettings.ts`, on by default). On 1.0.4 the save has no text and no error.

Test matrix: `scripts/test-text-styles.mjs` checks every font x text color x background (none, 11 solids, 2 translucent)
x outline (off, 3 sizes) x shadow for overlays and captions, with and without the 1.0.5 capabilities.

## Rename to Tryal (1.0.5)
`app.json` `name` is "Tryal" (the name under the icon, CFBundleDisplayName) and every `NS*UsageDescription` says Tryal; the version is 1.0.5.
Slug, bundle identifier, package, scheme and EAS project are unchanged. Both need the new build: the display name and the permission texts are
native (Info.plist), as are the new icon and splash wordmark.
