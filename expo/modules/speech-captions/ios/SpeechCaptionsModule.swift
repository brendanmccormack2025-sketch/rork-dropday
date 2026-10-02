import AVFoundation
import ExpoModulesCore
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
}

// "No speech detected" is not a failure: it means an empty transcript.
private func isNoSpeech(_ error: Error) -> Bool {
  let e = error as NSError
  return e.domain == "kAFAssistantErrorDomain" && e.code == 1110
}

private func recognize(url: URL, recognizer: SFSpeechRecognizer) async throws -> [SFTranscriptionSegment] {
  return try await withCheckedThrowingContinuation { continuation in
    let request = SFSpeechURLRecognitionRequest(url: url)
    // Never fall back to Apple's servers.
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    request.taskHint = .dictation

    let once = OnceFlag()
    var task: SFSpeechRecognitionTask?
    task = recognizer.recognitionTask(with: request) { result, error in
      if let result = result, result.isFinal {
        if once.claim() {
          continuation.resume(returning: result.bestTranscription.segments)
        }
        return
      }
      if let error = error, once.claim() {
        if isNoSpeech(error) {
          continuation.resume(returning: [])
        } else {
          continuation.resume(throwing: fail("ERR_SPEECH_RECOGNITION_FAILED", error.localizedDescription))
        }
      }
    }

    DispatchQueue.global().asyncAfter(deadline: .now() + chunkTimeoutSeconds) {
      if once.claim() {
        task?.cancel()
        continuation.resume(throwing: fail("ERR_SPEECH_TIMEOUT", "recognition timed out"))
      }
    }
  }
}

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

    let segments = try await recognize(url: audioURL, recognizer: recognizer)
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

  return [
    "words": words,
    "durationMs": Int((durationSeconds * 1000).rounded()),
    "locale": recognizer.locale.identifier,
    "onDevice": true,
  ]
}
