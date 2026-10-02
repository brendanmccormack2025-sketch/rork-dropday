import AVFoundation
import ExpoModulesCore

// Longest video the module will analyze (seconds). Longer inputs are rejected
// with ERR_LOUDNESS_TOO_LONG instead of being read.
private let maxDurationSeconds: Double = 240

// Decoded PCM format handed to the RMS loop: mono, 16-bit, 16 kHz. AVAssetReader
// does the down-mix and resample, so the loop below only ever sees this format.
private let analysisSampleRate: Int = 16_000

// Loudness floor for digital silence (dBFS). Keeps log10(0) out of the result.
private let silenceFloorDb: Double = -100

final class LoudnessBadArgumentException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_LOUDNESS_BAD_ARGUMENT" }
  override var reason: String { "Invalid argument: \(param)" }
}

final class LoudnessFileNotFoundException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_LOUDNESS_FILE_NOT_FOUND" }
  override var reason: String { "File not found: \(param)" }
}

final class LoudnessTooLongException: GenericException<Double>, @unchecked Sendable {
  override var code: String { "ERR_LOUDNESS_TOO_LONG" }
  override var reason: String {
    "Video is \(Int(param)) s long; the limit is \(Int(maxDurationSeconds)) s"
  }
}

final class LoudnessReadFailedException: GenericException<String>, @unchecked Sendable {
  override var code: String { "ERR_LOUDNESS_READ_FAILED" }
  override var reason: String { "Could not read audio: \(param)" }
}

public class AudioLoudnessModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AudioLoudness")

    // Resolves null when the file has no audio track. Rejects with one of the
    // ERR_LOUDNESS_* codes otherwise. Runs on a background queue.
    AsyncFunction("getLoudnessAsync") { (uri: String, windowMs: Int) -> [String: Any]? in
      return try computeLoudness(uri: uri, windowMs: windowMs)
    }
    .runOnQueue(DispatchQueue.global(qos: .userInitiated))
  }
}

private func fileURL(from uri: String) throws -> URL {
  let trimmed = uri.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmed.isEmpty {
    throw LoudnessBadArgumentException("uri is empty")
  }
  if trimmed.hasPrefix("/") {
    return URL(fileURLWithPath: trimmed)
  }
  guard let url = URL(string: trimmed), url.isFileURL else {
    throw LoudnessBadArgumentException("uri must be a local file:// URL or absolute path")
  }
  return url
}

private func computeLoudness(uri: String, windowMs: Int) throws -> [String: Any]? {
  guard windowMs >= 10, windowMs <= 1000 else {
    throw LoudnessBadArgumentException("windowMs must be between 10 and 1000")
  }

  let url = try fileURL(from: uri)
  guard FileManager.default.fileExists(atPath: url.path) else {
    throw LoudnessFileNotFoundException(url.path)
  }

  let asset = AVURLAsset(url: url)

  guard asset.isReadable else {
    throw LoudnessReadFailedException("asset is not readable")
  }

  let durationSeconds = CMTimeGetSeconds(asset.duration)
  guard durationSeconds.isFinite, durationSeconds > 0 else {
    throw LoudnessReadFailedException("could not determine duration")
  }
  if durationSeconds > maxDurationSeconds {
    throw LoudnessTooLongException(durationSeconds)
  }

  guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
    return nil
  }

  let reader: AVAssetReader
  do {
    reader = try AVAssetReader(asset: asset)
  } catch {
    throw LoudnessReadFailedException(error.localizedDescription)
  }

  let outputSettings: [String: Any] = [
    AVFormatIDKey: kAudioFormatLinearPCM,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
    AVLinearPCMIsNonInterleaved: false,
    AVNumberOfChannelsKey: 1,
    AVSampleRateKey: analysisSampleRate,
  ]
  let output = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
  output.alwaysCopiesSampleData = false
  guard reader.canAdd(output) else {
    throw LoudnessReadFailedException("cannot attach audio output")
  }
  reader.add(output)
  guard reader.startReading() else {
    throw LoudnessReadFailedException(reader.error?.localizedDescription ?? "startReading failed")
  }

  let durationMs = Int((durationSeconds * 1000).rounded())
  let windowSamples = max(1, analysisSampleRate * windowMs / 1000)
  let expectedWindows = Int((Double(durationMs) / Double(windowMs)).rounded(.up))
  let maxWindows = expectedWindows + 2

  var windows: [Double] = []
  windows.reserveCapacity(maxWindows)

  var sumSquares: Double = 0
  var samplesInWindow = 0
  var sawFirstBuffer = false
  var scratch = [Int16](repeating: 0, count: 8192)

  func closeWindow() {
    let rms = (sumSquares / Double(samplesInWindow)).squareRoot()
    let db = rms > 0 ? max(silenceFloorDb, 20 * log10(rms)) : silenceFloorDb
    windows.append((db * 10).rounded() / 10)
    sumSquares = 0
    samplesInWindow = 0
  }

  var finished = false
  while !finished {
    try autoreleasepool {
      guard reader.status == .reading,
            let sampleBuffer = output.copyNextSampleBuffer() else {
        finished = true
        return
      }

      // Audio that starts after t=0 leaves the beginning of the clip silent.
      if !sawFirstBuffer {
        sawFirstBuffer = true
        let startSeconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
        if startSeconds.isFinite, startSeconds > 0.05 {
          let leading = min(Int(startSeconds * 1000 / Double(windowMs)), maxWindows)
          windows.append(contentsOf: [Double](repeating: silenceFloorDb, count: leading))
        }
      }

      guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
      let sampleCount = CMBlockBufferGetDataLength(block) / MemoryLayout<Int16>.size
      if sampleCount == 0 { return }
      if scratch.count < sampleCount {
        scratch = [Int16](repeating: 0, count: sampleCount)
      }

      let copyStatus = scratch.withUnsafeMutableBytes { raw -> OSStatus in
        guard let base = raw.baseAddress else { return -1 }
        return CMBlockBufferCopyDataBytes(
          block,
          atOffset: 0,
          dataLength: sampleCount * MemoryLayout<Int16>.size,
          destination: base
        )
      }
      guard copyStatus == kCMBlockBufferNoErr else {
        throw LoudnessReadFailedException("buffer copy failed (\(copyStatus))")
      }

      for i in 0..<sampleCount {
        let v = Double(scratch[i]) / 32768.0
        sumSquares += v * v
        samplesInWindow += 1
        if samplesInWindow == windowSamples {
          closeWindow()
        }
      }
    }
  }

  if reader.status == .failed {
    throw LoudnessReadFailedException(reader.error?.localizedDescription ?? "reader failed")
  }
  if reader.status == .cancelled {
    throw LoudnessReadFailedException("reader was cancelled")
  }

  // Keep a trailing partial window only when it is at least half full.
  if samplesInWindow * 2 >= windowSamples {
    closeWindow()
  }

  // Audio that ends before the video leaves the tail silent, so window index
  // always maps to time: window i covers [i * windowMs, (i + 1) * windowMs).
  if windows.count < expectedWindows {
    windows.append(contentsOf: [Double](repeating: silenceFloorDb, count: expectedWindows - windows.count))
  }

  if windows.count > expectedWindows {
    windows.removeLast(windows.count - expectedWindows)
  }

  return [
    "durationMs": durationMs,
    "windows": windows,
  ]
}
