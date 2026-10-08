import AVFoundation
import QuartzCore
import ExpoModulesCore
import UIKit

// Length of the audio fade at every seam (seconds): 10 ms out of the clip that
// ends plus 10 ms into the clip that starts, so a seam never clicks.
private let seamFadeSeconds: Double = 0.010

// Extra zoom for "punch in" on every second segment.
private let punchInScale: CGFloat = 1.08

// Overlays never fade faster than this (seconds), so keyframe times stay distinct.
private let minOverlayFadeSeconds: Double = 0.016

private let renderFPS: Int32 = 30

struct RenderFailure {
  let code: String
  let reason: String
}

final class RenderException: GenericException<RenderFailure>, @unchecked Sendable {
  override var code: String { param.code }
  override var reason: String { param.reason }
}

private func fail(_ code: String, _ reason: String) -> RenderException {
  return RenderException(RenderFailure(code: code, reason: reason))
}

// One render at a time; also lets cancelRender reach the running export.
private final class RenderState {
  static let shared = RenderState()
  private let lock = NSLock()
  private var busy = false
  private var cancelled = false
  private var session: AVAssetExportSession?

  func begin() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if busy { return false }
    busy = true
    cancelled = false
    return true
  }

  func end() {
    lock.lock()
    busy = false
    session = nil
    lock.unlock()
  }

  var isCancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return cancelled
  }

  func setSession(_ s: AVAssetExportSession) {
    lock.lock()
    session = s
    let alreadyCancelled = cancelled
    lock.unlock()
    if alreadyCancelled { s.cancelExport() }
  }

  func cancel() {
    lock.lock()
    cancelled = true
    let s = session
    lock.unlock()
    s?.cancelExport()
  }
}

public class VideoRenderModule: Module {
  public func definition() -> ModuleDefinition {
    Name("VideoRender")

    // Build capabilities the JS checks: captions can use a font by PostScript name (style "fontName").
    // supportsTextBox: separate padding across/down and a fixed line height (style "backgroundPaddingX/Y", "lineHeight").
    Constants {
      ["supportsCaptionFont": true, "supportsTextBox": true]
    }

    Events("onProgress")

    Function("cancelRender") {
      RenderState.shared.cancel()
    }

    // Resolves { uri, durationMs, sizeBytes }; rejects with an ERR_RENDER_* code.
    AsyncFunction("renderAsync") { (json: String, options: [String: Any]?, promise: Promise) in
      guard RenderState.shared.begin() else {
        promise.reject(fail("ERR_RENDER_BUSY", "A render is already running"))
        return
      }
      Task.detached(priority: .userInitiated) { [weak self] in
        defer { RenderState.shared.end() }
        do {
          let result = try await render(json: json, options: options ?? [:]) { progress in
            self?.sendEvent("onProgress", ["progress": progress])
          }
          promise.resolve(result)
        } catch let e as Exception {
          promise.reject(e)
        } catch {
          promise.reject(fail("ERR_RENDER_FAILED", error.localizedDescription))
        }
      }
    }
  }
}

// MARK: - Input

private struct ClipSpec {
  let url: URL
  let startMs: Double
  let endMs: Double
}

private struct OverlaySpec {
  let kind: String
  let text: String
  let style: [String: Any]
  let startMs: Double?
  let endMs: Double?
  let url: URL?
  let volume: Float
  let x: Double?
  let y: Double?
  let width: Double?
}

private struct RenderSettings {
  var width: CGFloat = 1080
  var height: CGFloat = 1920
  var fill = true
  var bitrate: Double = 8_000_000
  var punchIn = false
}

private func number(_ v: Any?) -> Double? {
  if let n = v as? NSNumber { return n.doubleValue }
  return nil
}

private func fileURL(from uri: String) throws -> URL {
  let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "empty uri")
  }
  if trimmed.hasPrefix("/") {
    return URL(fileURLWithPath: trimmed)
  }
  guard let url = URL(string: trimmed), url.isFileURL else {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "uri must be a local file:// URL or absolute path: \(trimmed)")
  }
  return url
}

private func parseSettings(_ options: [String: Any]) -> RenderSettings {
  var s = RenderSettings()
  func even(_ v: Double) -> CGFloat { CGFloat(max(2, Int(v.rounded()) / 2 * 2)) }
  if let w = number(options["width"]), w >= 2 { s.width = even(w) }
  if let h = number(options["height"]), h >= 2 { s.height = even(h) }
  if let r = options["reframe"] as? String { s.fill = r != "fit" }
  if let b = number(options["bitrate"]), b >= 100_000 { s.bitrate = b }
  if let p = options["punchIn"] as? Bool { s.punchIn = p }
  return s
}

private func parseInstructions(_ json: String) throws -> (clips: [ClipSpec], overlays: [OverlaySpec]) {
  guard let data = json.data(using: .utf8),
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "instructions are not valid JSON")
  }
  guard number(root["version"]) == 1 else {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "unsupported instructions version")
  }
  guard let rawClips = root["clips"] as? [[String: Any]], !rawClips.isEmpty else {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "no clips")
  }

  var clips: [ClipSpec] = []
  for c in rawClips {
    guard let uri = c["uri"] as? String,
          let start = number(c["trimStartMs"]),
          let end = number(c["trimEndMs"]) else {
      throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "clip needs uri, trimStartMs and trimEndMs")
    }
    clips.append(ClipSpec(url: try fileURL(from: uri), startMs: start, endMs: end))
  }

  var overlays: [OverlaySpec] = []
  for o in (root["overlays"] as? [[String: Any]]) ?? [] {
    guard let kind = o["kind"] as? String else { continue }
    var url: URL? = nil
    if let uri = o["uri"] as? String { url = try fileURL(from: uri) }
    overlays.append(OverlaySpec(
      kind: kind,
      text: (o["text"] as? String) ?? "",
      style: (o["styleSpec"] as? [String: Any]) ?? [:],
      startMs: number(o["startMs"]),
      endMs: number(o["endMs"]),
      url: url,
      volume: Float(number(o["volume"]) ?? 1),
      x: number(o["x"]),
      y: number(o["y"]),
      width: number(o["width"])
    ))
  }
  return (clips, overlays)
}

// MARK: - Overlay drawing

private func color(_ hex: String?, fallback: UIColor) -> UIColor {
  guard var h = hex?.trimmingCharacters(in: .whitespaces), h.hasPrefix("#") else { return fallback }
  h.removeFirst()
  guard h.count == 6 || h.count == 8, let v = UInt64(h, radix: 16) else { return fallback }
  if h.count == 6 {
    return UIColor(
      red: CGFloat((v >> 16) & 0xFF) / 255,
      green: CGFloat((v >> 8) & 0xFF) / 255,
      blue: CGFloat(v & 0xFF) / 255,
      alpha: 1
    )
  }
  return UIColor(
    red: CGFloat((v >> 24) & 0xFF) / 255,
    green: CGFloat((v >> 16) & 0xFF) / 255,
    blue: CGFloat((v >> 8) & 0xFF) / 255,
    alpha: CGFloat(v & 0xFF) / 255
  )
}

private func fontWeight(_ name: String?) -> UIFont.Weight {
  switch name {
  case "regular": return .regular
  case "medium": return .medium
  case "semibold": return .semibold
  case "heavy": return .heavy
  case "black": return .black
  default: return .bold
  }
}

// Opacity 0 -> 1 -> 0 over the overlay's window, on the composition timeline.
private func visibilityAnimation(
  totalSeconds: Double,
  startSeconds: Double,
  endSeconds: Double,
  fadeInSeconds: Double,
  fadeOutSeconds: Double
) -> CAKeyframeAnimation {
  let fadeIn = max(minOverlayFadeSeconds, fadeInSeconds)
  let fadeOut = max(minOverlayFadeSeconds, fadeOutSeconds)
  let start = min(max(0, startSeconds), totalSeconds)
  let end = min(max(start, endSeconds), totalSeconds)
  let fullIn = min(start + fadeIn, end)
  let fullOut = max(end - fadeOut, fullIn)

  let raw = [0, start, fullIn, fullOut, end, totalSeconds]
  var times: [NSNumber] = []
  var previous = 0.0
  for t in raw {
    let n = min(1, max(previous, t / totalSeconds))
    times.append(NSNumber(value: n))
    previous = n
  }
  times[0] = 0
  times[times.count - 1] = 1

  let animation = CAKeyframeAnimation(keyPath: "opacity")
  animation.values = [0.0, 0.0, 1.0, 1.0, 0.0, 0.0]
  animation.keyTimes = times
  animation.calculationMode = .linear
  animation.duration = totalSeconds
  animation.beginTime = AVCoreAnimationBeginTimeAtZero
  animation.fillMode = .both
  animation.isRemovedOnCompletion = false
  return animation
}

// Shown from start to end with no fade at all: a discrete animation holds each value
// until the next key time, so the overlay appears and disappears on exactly those frames.
private func hardCutAnimation(
  totalSeconds: Double,
  startSeconds: Double,
  endSeconds: Double
) -> CAKeyframeAnimation? {
  let start = min(max(0, startSeconds), totalSeconds)
  let end = min(max(start, endSeconds), totalSeconds)
  // A discrete animation needs one MORE key time than values (each value holds from its key time to the
  // next; the last key time is 1.0). With equal counts Core Animation ignores the key times and the
  // overlay never hides.
  var times: [NSNumber] = [0]
  var values: [Double] = []
  if start > 0 {
    values.append(0)
    times.append(NSNumber(value: start / totalSeconds))
  }
  values.append(1)
  if end < totalSeconds {
    times.append(NSNumber(value: end / totalSeconds))
    values.append(0)
  }
  times.append(1)
  // Visible for the whole video: no animation needed.
  if values.count == 1 { return nil }
  let animation = CAKeyframeAnimation(keyPath: "opacity")
  animation.values = values
  animation.keyTimes = times
  animation.calculationMode = .discrete
  animation.duration = totalSeconds
  animation.beginTime = AVCoreAnimationBeginTimeAtZero
  animation.fillMode = .both
  animation.isRemovedOnCompletion = false
  return animation
}

private func addTimed(
  _ layer: CALayer,
  overlay: OverlaySpec,
  totalSeconds: Double
) {
  let start = (overlay.startMs ?? 0) / 1000
  let end = (overlay.endMs ?? (totalSeconds * 1000)) / 1000
  // Both fades given as exactly 0: a true hard cut. A missing fade keeps the default.
  if let fadeInMs = number(overlay.style["fadeInMs"]),
     let fadeOutMs = number(overlay.style["fadeOutMs"]),
     fadeInMs == 0, fadeOutMs == 0 {
    if let animation = hardCutAnimation(totalSeconds: totalSeconds, startSeconds: start, endSeconds: end) {
      layer.opacity = 0
      layer.add(animation, forKey: "visibility")
    } else {
      layer.opacity = 1
    }
    return
  }
  let fadeIn = (number(overlay.style["fadeInMs"]) ?? 0) / 1000
  let fadeOut = (number(overlay.style["fadeOutMs"]) ?? 0) / 1000
  layer.opacity = 0
  layer.add(
    visibilityAnimation(
      totalSeconds: totalSeconds,
      startSeconds: start,
      endSeconds: end,
      fadeInSeconds: fadeIn,
      fadeOutSeconds: fadeOut
    ),
    forKey: "visibility"
  )
}

// Core Animation in AVVideoCompositionCoreAnimationTool has its origin at the
// bottom left; yFromTop (0 top ... 1 bottom) is converted here.
private func makeTextOverlay(_ overlay: OverlaySpec, size: CGSize) -> CALayer {
  let scale = size.width / 1080
  let style = overlay.style
  let fontSize = CGFloat(number(style["fontSize"]) ?? 56) * scale
  let weight = fontWeight(style["fontWeight"] as? String)
  let textColor = color(style["color"] as? String, fallback: .white)
  // Build 1.0.4: separate across/down padding and one fixed line height (a multiple of the font size).
  // Without these keys the layout is exactly what older builds drew.
  let padX = CGFloat(number(style["backgroundPaddingX"]) ?? number(style["backgroundPadding"]) ?? 0) * scale
  let padY = CGFloat(number(style["backgroundPaddingY"]) ?? number(style["backgroundPadding"]) ?? 0) * scale
  let lineHeightEm = number(style["lineHeight"]).map { CGFloat($0) }
  let maxWidth = size.width * CGFloat(number(style["maxWidth"]) ?? 0.86)
  let yFromTop = CGFloat(number(style["yCenter"]) ?? 0.75)
  let text = (style["uppercase"] as? Bool) == true ? overlay.text.uppercased() : overlay.text
  // An iOS font by PostScript name; the system font at the weight when there is none or it is unavailable.
  let font: UIFont = (style["fontName"] as? String).flatMap { UIFont(name: $0, size: fontSize) }
    ?? UIFont.systemFont(ofSize: fontSize, weight: weight)

  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = .center
  paragraph.lineBreakMode = .byWordWrapping
  var attributes: [NSAttributedString.Key: Any] = [
    .font: font,
    .foregroundColor: textColor,
    .kern: CGFloat(number(style["letterSpacing"]) ?? 0) * scale,
    .paragraphStyle: paragraph,
  ]
  // A fixed line height: a line with an emoji (whose font is taller) is no taller than any other line, so the
  // box is lines x lineHeight and the text is centred in each line by raising the baseline by half the spare space.
  var fixedLineHeight: CGFloat?
  if let em = lineHeightEm {
    let lineHeight = fontSize * em
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    attributes[.baselineOffset] = (lineHeight - font.lineHeight) / 2
    fixedLineHeight = lineHeight
  }
  let attributed = NSAttributedString(string: text, attributes: attributes)
  let bounds = attributed.boundingRect(
    with: CGSize(width: maxWidth - 2 * padX, height: .greatestFiniteMagnitude),
    options: [.usesLineFragmentOrigin, .usesFontLeading],
    context: nil
  )
  let textWidth = ceil(bounds.width) + 2
  // With a fixed line height the height is the line count times it (measured, never from font metrics).
  let textHeight: CGFloat
  if let fixed = fixedLineHeight {
    textHeight = (bounds.height / fixed).rounded() * fixed
  } else {
    textHeight = ceil(bounds.height) + 2
  }

  let container = CALayer()
  container.bounds = CGRect(x: 0, y: 0, width: textWidth + 2 * padX, height: textHeight + 2 * padY)
  container.position = CGPoint(x: size.width / 2, y: size.height * (1 - yFromTop))
  if let bg = style["backgroundColor"] as? String {
    container.backgroundColor = color(bg, fallback: .clear).cgColor
  }
  container.cornerRadius = CGFloat(number(style["cornerRadius"]) ?? 0) * scale
  if (style["shadow"] as? Bool) == true {
    container.shadowColor = UIColor.black.cgColor
    container.shadowOpacity = 0.6
    container.shadowRadius = 4 * scale
    container.shadowOffset = CGSize(width: 0, height: -2 * scale)
  }

  let textLayer = CATextLayer()
  textLayer.string = attributed
  textLayer.isWrapped = true
  textLayer.alignmentMode = .center
  textLayer.contentsScale = 2
  textLayer.frame = CGRect(x: padX, y: padY, width: textWidth, height: textHeight)
  container.addSublayer(textLayer)
  return container
}

private func makeImageOverlay(_ overlay: OverlaySpec, size: CGSize) -> CALayer? {
  guard let url = overlay.url,
        let image = UIImage(contentsOfFile: url.path),
        let cgImage = image.cgImage,
        image.size.width > 0 else { return nil }
  let width = size.width * CGFloat(overlay.width ?? 0.3)
  let height = width * image.size.height / image.size.width
  let layer = CALayer()
  layer.contents = cgImage
  layer.contentsGravity = .resizeAspect
  layer.bounds = CGRect(x: 0, y: 0, width: width, height: height)
  layer.position = CGPoint(
    x: size.width * CGFloat(overlay.x ?? 0.5),
    y: size.height * (1 - CGFloat(overlay.y ?? 0.15))
  )
  return layer
}

// MARK: - Render

private struct Segment {
  let compStart: CMTime
  let duration: CMTime
  let naturalSize: CGSize
  let preferredTransform: CGAffineTransform
}

private func segmentTransform(_ seg: Segment, index: Int, settings: RenderSettings) -> CGAffineTransform {
  let w0 = settings.width
  let h0 = settings.height
  // Where the displayed (rotated) frame lands, then move it back to the origin.
  let rect = CGRect(origin: .zero, size: seg.naturalSize).applying(seg.preferredTransform)
  let w = abs(rect.width)
  let h = abs(rect.height)
  guard w > 0, h > 0 else { return seg.preferredTransform }

  var t = seg.preferredTransform.concatenating(CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
  let s = settings.fill ? max(w0 / w, h0 / h) : min(w0 / w, h0 / h)
  t = t.concatenating(CGAffineTransform(scaleX: s, y: s))
  t = t.concatenating(CGAffineTransform(translationX: (w0 - w * s) / 2, y: (h0 - h * s) / 2))

  if settings.punchIn && index % 2 == 1 {
    t = t
      .concatenating(CGAffineTransform(translationX: -w0 / 2, y: -h0 / 2))
      .concatenating(CGAffineTransform(scaleX: punchInScale, y: punchInScale))
      .concatenating(CGAffineTransform(translationX: w0 / 2, y: h0 / 2))
  }
  return t
}

private func render(
  json: String,
  options: [String: Any],
  progress: @escaping @Sendable (Double) -> Void
) async throws -> [String: Any] {
  let settings = parseSettings(options)
  let (clips, overlays) = try parseInstructions(json)
  let renderSize = CGSize(width: settings.width, height: settings.height)

  // ── Composition: clips back to back, no gaps ──
  let composition = AVMutableComposition()
  guard let videoTrack = composition.addMutableTrack(
    withMediaType: .video,
    preferredTrackID: kCMPersistentTrackID_Invalid
  ) else {
    throw fail("ERR_RENDER_COMPOSITION_FAILED", "could not create video track")
  }
  var audioTrack: AVMutableCompositionTrack?
  var assets: [URL: AVURLAsset] = [:]
  var segments: [Segment] = []
  var cursor = CMTime.zero

  for clip in clips {
    let asset: AVURLAsset
    if let cached = assets[clip.url] {
      asset = cached
    } else {
      guard FileManager.default.fileExists(atPath: clip.url.path) else {
        throw fail("ERR_RENDER_FILE_NOT_FOUND", "File not found: \(clip.url.path)")
      }
      asset = AVURLAsset(url: clip.url)
      guard asset.isReadable else {
        throw fail("ERR_RENDER_READ_FAILED", "asset is not readable: \(clip.url.lastPathComponent)")
      }
      assets[clip.url] = asset
    }
    guard let sourceVideo = asset.tracks(withMediaType: .video).first else {
      throw fail("ERR_RENDER_NO_VIDEO", "no video track in \(clip.url.lastPathComponent)")
    }

    let start = CMTime(value: Int64(max(0, clip.startMs).rounded()), timescale: 1000)
    var end = CMTime(value: Int64(clip.endMs.rounded()), timescale: 1000)
    if end > asset.duration { end = asset.duration }
    guard end > start else { continue }
    let range = CMTimeRange(start: start, end: end)

    do {
      try videoTrack.insertTimeRange(range, of: sourceVideo, at: cursor)
      if let sourceAudio = asset.tracks(withMediaType: .audio).first {
        if audioTrack == nil {
          audioTrack = composition.addMutableTrack(
            withMediaType: .audio,
            preferredTrackID: kCMPersistentTrackID_Invalid
          )
        }
        try audioTrack?.insertTimeRange(range, of: sourceAudio, at: cursor)
      }
    } catch {
      throw fail("ERR_RENDER_COMPOSITION_FAILED", error.localizedDescription)
    }

    segments.append(Segment(
      compStart: cursor,
      duration: range.duration,
      naturalSize: sourceVideo.naturalSize,
      preferredTransform: sourceVideo.preferredTransform
    ))
    cursor = CMTimeAdd(cursor, range.duration)
  }

  guard !segments.isEmpty else {
    throw fail("ERR_RENDER_BAD_INSTRUCTIONS", "every clip range is empty")
  }
  let totalDuration = composition.duration
  let totalSeconds = CMTimeGetSeconds(totalDuration)
  guard totalSeconds > 0 else {
    throw fail("ERR_RENDER_COMPOSITION_FAILED", "empty composition")
  }
  if RenderState.shared.isCancelled {
    throw fail("ERR_RENDER_CANCELLED", "render cancelled")
  }

  // ── Video: one instruction per clip (hard cuts), own transform per clip ──
  let videoComposition = AVMutableVideoComposition()
  videoComposition.renderSize = renderSize
  videoComposition.frameDuration = CMTime(value: 1, timescale: renderFPS)
  var instructions: [AVMutableVideoCompositionInstruction] = []
  for (i, seg) in segments.enumerated() {
    let instruction = AVMutableVideoCompositionInstruction()
    let isLast = i == segments.count - 1
    let end = isLast ? totalDuration : CMTimeAdd(seg.compStart, seg.duration)
    instruction.timeRange = CMTimeRange(start: seg.compStart, end: end)
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
    layer.setTransform(segmentTransform(seg, index: i, settings: settings), at: seg.compStart)
    instruction.layerInstructions = [layer]
    instructions.append(instruction)
  }
  videoComposition.instructions = instructions

  // ── Visual overlays: timed layers on top of the video ──
  var visual: [CALayer] = []
  for overlay in overlays {
    switch overlay.kind {
    case "text", "caption":
      if overlay.text.isEmpty { continue }
      let layer = makeTextOverlay(overlay, size: renderSize)
      addTimed(layer, overlay: overlay, totalSeconds: totalSeconds)
      visual.append(layer)
    case "image":
      if let layer = makeImageOverlay(overlay, size: renderSize) {
        addTimed(layer, overlay: overlay, totalSeconds: totalSeconds)
        visual.append(layer)
      }
    default:
      break
    }
  }
  if !visual.isEmpty {
    let parent = CALayer()
    parent.frame = CGRect(origin: .zero, size: renderSize)
    let videoLayer = CALayer()
    videoLayer.frame = parent.frame
    parent.addSublayer(videoLayer)
    for layer in visual { parent.addSublayer(layer) }
    videoComposition.animationTool = AVVideoCompositionCoreAnimationTool(
      postProcessingAsVideoLayer: videoLayer,
      in: parent
    )
  }

  // ── Audio: 20 ms seam fades on the clip audio, sound effects on their own tracks ──
  var audioParameters: [AVMutableAudioMixInputParameters] = []
  if let audioTrack = audioTrack {
    let params = AVMutableAudioMixInputParameters(track: audioTrack)
    let half = CMTime(seconds: seamFadeSeconds, preferredTimescale: 44100)
    for seg in segments.dropFirst() where CMTimeGetSeconds(seg.duration) > 4 * seamFadeSeconds {
      let seam = seg.compStart
      params.setVolumeRamp(
        fromStartVolume: 1, toEndVolume: 0,
        timeRange: CMTimeRange(start: CMTimeSubtract(seam, half), duration: half)
      )
      params.setVolumeRamp(
        fromStartVolume: 0, toEndVolume: 1,
        timeRange: CMTimeRange(start: seam, duration: half)
      )
    }
    audioParameters.append(params)
  }
  for overlay in overlays where overlay.kind == "sfx" {
    guard let url = overlay.url,
          FileManager.default.fileExists(atPath: url.path) else { continue }
    let sfxAsset = AVURLAsset(url: url)
    guard let source = sfxAsset.tracks(withMediaType: .audio).first,
          let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
    else { continue }
    let at = CMTime(seconds: max(0, (overlay.startMs ?? 0) / 1000), preferredTimescale: 1000)
    guard at < totalDuration else { continue }
    let length = min(sfxAsset.duration, CMTimeSubtract(totalDuration, at))
    do {
      try track.insertTimeRange(CMTimeRange(start: .zero, duration: length), of: source, at: at)
    } catch {
      continue
    }
    let params = AVMutableAudioMixInputParameters(track: track)
    params.setVolume(overlay.volume, at: .zero)
    audioParameters.append(params)
  }
  var audioMix: AVMutableAudioMix?
  if !audioParameters.isEmpty {
    let mix = AVMutableAudioMix()
    mix.inputParameters = audioParameters
    audioMix = mix
  }

  // ── Export ──
  let outputURL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("render_\(UUID().uuidString).mp4")
  try? FileManager.default.removeItem(at: outputURL)

  // The preset picks the encoder quality; renderSize (above) is the real output
  // size. The bitrate option is advisory only: nothing here enforces it.
  let preset = settings.width <= 720 ? AVAssetExportPreset1280x720 : AVAssetExportPresetHighestQuality
  guard let session = AVAssetExportSession(asset: composition, presetName: preset) else {
    throw fail("ERR_RENDER_EXPORT_FAILED", "could not create export session")
  }
  session.outputURL = outputURL
  session.outputFileType = .mp4
  session.videoComposition = videoComposition
  session.audioMix = audioMix
  session.shouldOptimizeForNetworkUse = true
  RenderState.shared.setSession(session)

  let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
  timer.schedule(deadline: .now(), repeating: 0.1)
  timer.setEventHandler { progress(Double(session.progress)) }
  timer.resume()

  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    session.exportAsynchronously {
      continuation.resume()
    }
  }
  timer.cancel()

  switch session.status {
  case .completed:
    break
  case .cancelled:
    try? FileManager.default.removeItem(at: outputURL)
    throw fail("ERR_RENDER_CANCELLED", "render cancelled")
  default:
    try? FileManager.default.removeItem(at: outputURL)
    throw fail("ERR_RENDER_EXPORT_FAILED", session.error?.localizedDescription ?? "export failed")
  }
  progress(1)

  let attributes = try? FileManager.default.attributesOfItem(atPath: outputURL.path)
  let sizeBytes = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
  guard sizeBytes > 0 else {
    try? FileManager.default.removeItem(at: outputURL)
    throw fail("ERR_RENDER_EXPORT_FAILED", "output file is empty")
  }

  // Check the file itself: it must have video and not be shorter than the edit.
  let outputAsset = AVURLAsset(url: outputURL)
  let outputSeconds = CMTimeGetSeconds(outputAsset.duration)
  if outputAsset.tracks(withMediaType: .video).isEmpty {
    try? FileManager.default.removeItem(at: outputURL)
    throw fail("ERR_RENDER_EMPTY_VIDEO", "the rendered file has no video track")
  }
  if !outputSeconds.isFinite || totalSeconds - outputSeconds > 0.150 {
    try? FileManager.default.removeItem(at: outputURL)
    throw fail(
      "ERR_RENDER_TRUNCATED",
      "rendered \(Int((outputSeconds.isFinite ? outputSeconds : 0) * 1000)) ms, expected \(Int(totalSeconds * 1000)) ms"
    )
  }

  return [
    "uri": outputURL.absoluteString,
    "durationMs": Int((totalSeconds * 1000).rounded()),
    "actualDurationMs": Int((outputSeconds * 1000).rounded()),
    "sizeBytes": sizeBytes,
  ]
}
