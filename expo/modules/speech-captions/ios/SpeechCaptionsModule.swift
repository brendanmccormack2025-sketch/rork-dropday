import AVFoundation
import ExpoModulesCore
import NaturalLanguage
import Speech

// Audio is recognized in chunks of this length (seconds). Apple documents a
// one-minute limit for server-based recognition and no stated limit for
// on-device, but long single requests are unreliable, so every request stays
// well under a minute.
private let chunkSeconds: Double = 55

// Neighbouring chunks overlap by this much so a word on a boundary is heard
// whole by at least one of them; the merge below keeps each word exactly once.
private let chunkOverlapSeconds: Double = 2

// A single chunk that has not finished after this long is cancelled.
private let chunkTimeoutSeconds: Double = 90

struct SpeechFailure {
  let code: String
  let reason: String
}

final class SpeechException: GenericException<SpeechFailure>, @unchecked Sendable {
  override var code: String { param.code }
  override var reason: String { param.reason }
}

private func fail(_ code: String, _ reason: String) -> SpeechException {
  return SpeechException(SpeechFailure(code: code, reason: reason))
}

public class SpeechCaptionsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SpeechCaptions")

    // Resolves null when the file has no audio track. Rejects with an
    // ERR_SPEECH_* code otherwise. Work runs off the main thread.
    AsyncFunction("transcribeAsync") { (uri: String, locale: String?, promise: Promise) in
      Task.detached(priority: .userInitiated) {
        do {
          let result = try await transcribe(uri: uri, localeId: locale)
          promise.resolve(result)
        } catch let e as Exception {
          promise.reject(e)
        } catch {
          promise.reject(fail("ERR_SPEECH_FAILED", error.localizedDescription))
        }
      }
    }
  }
}

private func fileURL(from uri: String) throws -> URL {
  let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty {
    throw fail("ERR_SPEECH_BAD_ARGUMENT", "uri is empty")
  }
  if trimmed.hasPrefix("/") {
    return URL(fileURLWithPath: trimmed)
  }
  guard let url = URL(string: trimmed), url.isFileURL else {
    throw fail("ERR_SPEECH_BAD_ARGUMENT", "uri must be a local file:// URL or absolute path")
  }
  return url
}

private func requestAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
  return await withCheckedContinuation { continuation in
    SFSpeechRecognizer.requestAuthorization { status in
      continuation.resume(returning: status)
    }
  }
}

// Writes [startSeconds, startSeconds + lengthSeconds) of the asset's audio to a
// temporary m4a. The caller deletes the file.
private func exportAudio(asset: AVAsset, startSeconds: Double, lengthSeconds: Double) async throws -> URL {
  guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
    throw fail("ERR_SPEECH_EXPORT_FAILED", "could not create export session")
  }
  let outputURL = URL(fileURLWithPath: NSTemporaryDirectory())
    .appendingPathComponent("speech_\(UUID().uuidString).m4a")
  session.outputURL = outputURL
  session.outputFileType = .m4a
  session.timeRange = CMTimeRange(
    start: CMTime(seconds: startSeconds, preferredTimescale: 600),
    duration: CMTime(seconds: lengthSeconds, preferredTimescale: 600)
  )

  await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
    session.exportAsynchronously {
      continuation.resume()
    }
  }

  guard session.status == .completed else {
    try? FileManager.default.removeItem(at: outputURL)
    throw fail("ERR_SPEECH_EXPORT_FAILED", session.error?.localizedDescription ?? "export did not complete")
  }
  return outputURL
}

// Makes sure only one of the result handler and the timeout resumes the continuation.
private final class OnceFlag {
  private let lock = NSLock()
  private var used = false
  func claim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if used { return false }
    used = true
    return true
  }
  func isUsed() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return used
  }
}

// Collects the segments of EVERY recognition result of one request. On-device
// recognition can deliver several final results (one per utterance, after a pause)
// and starts a new transcription each time, so keeping only one result loses every
// word but the first utterance's.
//  - A result whose first segment starts at the same time as the previous result's is
//    the same utterance, grown or revised: it replaces it.
//  - Any other result (earlier or later first segment) is a restart: the previous
//    segments are kept and the new ones are appended. If the restart begins before the
//    end of what was collected, its times are relative to the restart: they are shifted
//    forward by the previous last segment's end. Otherwise they are already absolute.
private struct CollectedSegment {
  let substring: String
  let timestamp: Double
  let duration: Double
  let confidence: Float
}

private final class SegmentCollector: @unchecked Sendable {
  private let lock = NSLock()
  private var committed: [CollectedSegment] = []
  private var current: [CollectedSegment] = []
  private var polling = false

  func add(_ segments: [SFTranscriptionSegment]) {
    lock.lock()
    defer { lock.unlock() }
    guard let first = segments.first else { return }
    var shift = 0.0
    if let previousFirst = current.first, abs(first.timestamp - previousFirst.timestamp) > 0.05 {
      committed.append(contentsOf: current)
      if let last = committed.last, first.timestamp < last.timestamp + last.duration {
        shift = last.timestamp + last.duration
      }
    }
    current = segments.map {
      CollectedSegment(substring: $0.substring, timestamp: $0.timestamp + shift, duration: $0.duration, confidence: $0.confidence)
    }
  }

  func all() -> [CollectedSegment] {
    lock.lock()
    defer { lock.unlock() }
    return committed + current
  }

  // True the first time only: one completion poll per request.
  func startPolling() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if polling { return false }
    polling = true
    return true
  }
}

// True when the audio file has at least minSeconds of speech-level sound (100 ms
// windows with an RMS above about -40 dBFS).
private func hasSpeechLevelSound(url: URL, minSeconds: Double = 2.0) -> Bool {
  guard let file = try? AVAudioFile(forReading: url) else { return false }
  let format = file.processingFormat
  let windowFrames = AVAudioFrameCount(max(1, format.sampleRate / 10))
  guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: windowFrames) else { return false }
  var loudWindows = 0
  while file.framePosition < file.length {
    do {
      try file.read(into: buffer, frameCount: windowFrames)
    } catch {
      break
    }
    guard buffer.frameLength > 0, let channel = buffer.floatChannelData?[0] else { break }
    var sum: Float = 0
    for i in 0..<Int(buffer.frameLength) {
      sum += channel[i] * channel[i]
    }
    if (sum / Float(buffer.frameLength)).squareRoot() > 0.01 { loudWindows += 1 }
  }
  return Double(loudWindows) * 0.1 >= minSeconds
}

// Holds the recognition task so the timeout closure can cancel it without
// capturing a mutable local.
private final class TaskBox {
  var task: SFSpeechRecognitionTask?
}

// "No speech detected" is not a failure: it means an empty transcript.
private func isNoSpeech(_ error: Error) -> Bool {
  let e = error as NSError
  return e.domain == "kAFAssistantErrorDomain" && e.code == 1110
}

private func recognize(
  url: URL,
  recognizer: SFSpeechRecognizer,
  hasSound: Bool
) async throws -> [CollectedSegment] {
  return try await withCheckedThrowingContinuation { continuation in
    let request = SFSpeechURLRecognitionRequest(url: url)
    // Never fall back to Apple's servers.
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.taskHint = .dictation

    let once = OnceFlag()
    let box = TaskBox()
    let collector = SegmentCollector()

    // After a final result the request may still deliver the next utterance, so it is
    // finished only once the task itself is completed.
    func finishWhenCompleted() {
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) {
        guard let task = box.task else { return }
        if task.state == .completed || task.state == .canceling {
          if once.claim() {
            continuation.resume(returning: collector.all())
          }
        } else if !once.isUsed() {
          finishWhenCompleted()
        }
      }
    }

    box.task = recognizer.recognitionTask(with: request) { result, error in
      if let result = result {
        collector.add(result.bestTranscription.segments)
        if result.isFinal && collector.startPolling() {
          finishWhenCompleted()
        }
      }
      if let error = error, once.claim() {
        let segments = collector.all()
        if !segments.isEmpty {
          // Words were recognized before the request ended with an error: keep them.
          continuation.resume(returning: segments)
        } else if isNoSpeech(error) {
          if hasSound {
            // "No speech detected" for audio that has sound is a failure, not an empty transcript.
            continuation.resume(throwing: fail("ERR_SPEECH_NO_SPEECH_DETECTED", "the recognizer heard no speech in audio that has sound (\(error.localizedDescription))"))
          } else {
            continuation.resume(returning: [])
          }
        } else {
          continuation.resume(throwing: fail("ERR_SPEECH_RECOGNITION_FAILED", error.localizedDescription))
        }
      }
    }

    DispatchQueue.global().asyncAfter(deadline: .now() + chunkTimeoutSeconds) {
      if once.claim() {
        box.task?.cancel()
        continuation.resume(throwing: fail("ERR_SPEECH_TIMEOUT", "recognition timed out"))
      }
    }
  }
}


// ── iOS 26+: SpeechAnalyzer / SpeechTranscriber ─────────────────────────────────
// Apple's newer on-device transcription model (the one behind Notes and Voice Memos): much more accurate than the
// older on-device SFSpeechRecognizer, made for long-form audio, still entirely on the phone. Used when the phone and
// language support it; anything else (older iOS, unsupported language, any error) falls back to SFSpeechRecognizer.
// The API calls follow a shipping open-source tool (finnvoor/yap) that reads word times the same way.

private struct TimedWord: Sendable {
  let text: String
  let startMs: Int
  let endMs: Int
}

#if compiler(>=6.2)
@available(iOS 26.0, *)
private func analyzerWords(_ text: AttributedString) -> [TimedWord] {
  let tokenizer = NLTokenizer(unit: .word)
  let string = String(text.characters)
  tokenizer.string = string
  var out: [TimedWord] = []
  for wordRange in tokenizer.tokens(for: string.startIndex..<string.endIndex) {
    guard let attrStart = AttributedString.Index(wordRange.lowerBound, within: text),
          let attrEnd = AttributedString.Index(wordRange.upperBound, within: text) else { continue }
    let slice = text[attrStart..<attrEnd]
    let word = String(slice.characters).trimmingCharacters(in: .whitespacesAndNewlines)
    if word.isEmpty { continue }
    let ranges = slice.runs.compactMap(\.audioTimeRange)
    guard let first = ranges.first, let last = ranges.last else { continue }
    let startS = first.start.seconds
    let endS = last.end.seconds
    guard startS.isFinite, endS.isFinite else { continue }
    out.append(TimedWord(text: word, startMs: Int((startS * 1000).rounded()), endMs: Int((max(endS, startS) * 1000).rounded())))
  }
  return out
}

/// nil: not usable on this phone / for this language (the caller falls back). Throws on a failure while transcribing.
@available(iOS 26.0, *)
private func transcribeWithAnalyzer(asset: AVAsset, durationSeconds: Double, localeId: String?) async throws -> (words: [TimedWord], locale: String)? {
  guard SpeechTranscriber.isAvailable else { return nil }
  let wanted = localeId.map { Locale(identifier: $0) } ?? Locale.current
  let supported = await SpeechTranscriber.supportedLocales
  guard let locale = supported.first(where: { $0.identifier(.bcp47) == wanted.identifier(.bcp47) })
    ?? supported.first(where: { $0.language.languageCode == wanted.language.languageCode && $0.region == wanted.region })
    ?? supported.first(where: { $0.language.languageCode == wanted.language.languageCode })
  else { return nil }

  let transcriber = SpeechTranscriber(
    locale: locale,
    transcriptionOptions: [],
    reportingOptions: [],
    attributeOptions: [.audioTimeRange]
  )
  let modules: [any SpeechModule] = [transcriber]

  // The language model is downloaded once (by the system) when it is not on the phone yet.
  let installed = await SpeechTranscriber.installedLocales
  if !installed.contains(where: { $0.identifier(.bcp47) == locale.identifier(.bcp47) }) {
    _ = try? await AssetInventory.reserve(locale: locale)
    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
      try await request.downloadAndInstall()
    }
  }

  let audioURL = try await exportAudio(asset: asset, startSeconds: 0, lengthSeconds: durationSeconds)
  defer { try? FileManager.default.removeItem(at: audioURL) }
  let audioFile = try AVAudioFile(forReading: audioURL)

  let analyzer = SpeechAnalyzer(modules: modules)
  try await analyzer.start(inputAudioFile: audioFile, finishAfterFile: true)

  var words: [TimedWord] = []
  for try await result in transcriber.results {
    words.append(contentsOf: analyzerWords(result.text))
  }
  return (words, locale.identifier)
}
#endif

private func transcribe(uri: String, localeId: String?) async throws -> [String: Any]? {
  let url = try fileURL(from: uri)
  guard FileManager.default.fileExists(atPath: url.path) else {
    throw fail("ERR_SPEECH_FILE_NOT_FOUND", "File not found: \(url.path)")
  }

  let asset = AVURLAsset(url: url)
  guard asset.isReadable else {
    throw fail("ERR_SPEECH_READ_FAILED", "asset is not readable")
  }
  let durationSeconds = CMTimeGetSeconds(asset.duration)
  guard durationSeconds.isFinite, durationSeconds > 0 else {
    throw fail("ERR_SPEECH_READ_FAILED", "could not determine duration")
  }
  guard asset.tracks(withMediaType: .audio).first != nil else {
    return nil
  }

  #if compiler(>=6.2)
  if #available(iOS 26.0, *) {
    do {
      if let r = try await transcribeWithAnalyzer(asset: asset, durationSeconds: durationSeconds, localeId: localeId) {
        var seen = Set<String>()
        let words: [[String: Any]] = r.words
          .sorted { $0.startMs < $1.startMs }
          .filter { seen.insert("\($0.startMs):\($0.text.lowercased())").inserted }
          .map { ["text": $0.text, "startMs": $0.startMs, "endMs": $0.endMs, "confidence": 1.0] }
        return [
          "words": words,
          "durationMs": Int((durationSeconds * 1000).rounded()),
          "locale": r.locale,
          "onDevice": true,
          "engine": "speechAnalyzer",
        ]
      }
    } catch {
      // the older recognizer below gets a try
    }
  }
  #endif

  // On-device recognition must exist for this locale; there is no server fallback.
  let locale = localeId.map { Locale(identifier: $0) } ?? Locale.current
  guard let recognizer = SFSpeechRecognizer(locale: locale) else {
    throw fail("ERR_SPEECH_LOCALE_UNSUPPORTED", "Speech recognition does not support \(locale.identifier)")
  }
  guard recognizer.supportsOnDeviceRecognition else {
    throw fail(
      "ERR_SPEECH_ON_DEVICE_UNAVAILABLE",
      "On-device recognition is not available for \(recognizer.locale.identifier) on this phone"
    )
  }
  guard recognizer.isAvailable else {
    throw fail("ERR_SPEECH_UNAVAILABLE", "Speech recognizer is not available right now")
  }

  let status = await requestAuthorization()
  guard status == .authorized else {
    throw fail("ERR_SPEECH_NOT_AUTHORIZED", "Speech recognition permission was not granted (\(status.rawValue))")
  }

  // Chunk start times (seconds). One chunk for anything up to chunkSeconds.
  var starts: [Double] = [0]
  while starts[starts.count - 1] + chunkSeconds < durationSeconds {
    starts.append(starts[starts.count - 1] + chunkSeconds - chunkOverlapSeconds)
  }

  var words: [[String: Any]] = []
  for (i, start) in starts.enumerated() {
    let length = min(chunkSeconds, durationSeconds - start)
    // Each word is kept by the chunk that owns it: the cut between two chunks is
    // the middle of their overlap.
    let lowerMs = i == 0 ? 0 : Int(((start + chunkOverlapSeconds / 2) * 1000).rounded())
    let upperMs = i == starts.count - 1
      ? Int.max
      : Int(((starts[i + 1] + chunkOverlapSeconds / 2) * 1000).rounded())

    let audioURL = try await exportAudio(asset: asset, startSeconds: start, lengthSeconds: length)
    defer { try? FileManager.default.removeItem(at: audioURL) }

    let hasSound = hasSpeechLevelSound(url: audioURL)
    let segments = try await recognize(url: audioURL, recognizer: recognizer, hasSound: hasSound)
    for segment in segments {
      let startMs = Int(((start + segment.timestamp) * 1000).rounded())
      let endMs = Int(((start + segment.timestamp + segment.duration) * 1000).rounded())
      if startMs < lowerMs || startMs >= upperMs { continue }
      words.append([
        "text": segment.substring,
        "startMs": startMs,
        "endMs": endMs,
        "confidence": Double(segment.confidence),
      ])
    }
  }

  // The same word can come back from two results (or two chunks): keep it once.
  words.sort { ($0["startMs"] as? Int ?? 0) < ($1["startMs"] as? Int ?? 0) }
  var unique: [[String: Any]] = []
  for word in words {
    if let last = unique.last,
       let lastText = last["text"] as? String,
       let text = word["text"] as? String,
       lastText.lowercased() == text.lowercased(),
       abs((last["startMs"] as? Int ?? 0) - (word["startMs"] as? Int ?? 0)) < 150 {
      continue
    }
    unique.append(word)
  }

  return [
    "words": unique,
    "durationMs": Int((durationSeconds * 1000).rounded()),
    "locale": recognizer.locale.identifier,
    "onDevice": true,
  ]
}
