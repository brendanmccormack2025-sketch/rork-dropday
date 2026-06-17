//
//  CaptureEngine.swift
//  DropDayCamera
//
//  AVFoundation recording pipeline that supports seamless camera flipping
//  mid-recording with a continuous, gap-free audio + video track.
//
//  Strategy: instead of AVCaptureMovieFileOutput (which forces a stop when the
//  camera input changes), we feed AVCaptureVideoDataOutput + AVCaptureAudioDataOutput
//  into a single AVAssetWriter. Flipping the camera only swaps the video device
//  input — the audio output never stops, so the asset writer's timeline stays
//  continuous and audio has no gap. The result is one seamless MP4 file.
//
//  This type is `nonisolated` so its capture-delegate callbacks can run freely on
//  background queues. UI state is reported back to the main actor via callbacks.
//

import AVFoundation
import UIKit

nonisolated final class CaptureEngine: NSObject {
    let session = AVCaptureSession()

    // MARK: Queues
    private let sessionQueue = DispatchQueue(label: "dropday.camera.session")
    private let dataQueue = DispatchQueue(label: "dropday.camera.data")

    // MARK: Capture I/O
    private var videoDeviceInput: AVCaptureDeviceInput?
    private var audioDeviceInput: AVCaptureDeviceInput?
    private let videoDataOutput = AVCaptureVideoDataOutput()
    private let audioDataOutput = AVCaptureAudioDataOutput()
    private var position: AVCaptureDevice.Position = .back

    // MARK: Writer state (only touched on dataQueue)
    private var assetWriter: AVAssetWriter?
    private var videoWriterInput: AVAssetWriterInput?
    private var audioWriterInput: AVAssetWriterInput?
    private var isWriting = false
    private var recording = false
    private var outputURL: URL?

    // MARK: Callbacks (always invoked on the main queue)
    var onError: ((String) -> Void)?
    var onRecordingStateChange: ((Bool) -> Void)?
    var onFinished: ((URL) -> Void)?
    var onConfigured: ((Bool) -> Void)?

    private let videoWidth = 1080
    private let videoHeight = 1920

    var currentPosition: AVCaptureDevice.Position { position }

    // MARK: - Setup

    func configure() {
        session.automaticallyConfiguresApplicationAudioSession = true
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.session.beginConfiguration()
            self.session.sessionPreset = .high

            var ok = true

            if let device = self.camera(for: .back),
               let input = try? AVCaptureDeviceInput(device: device),
               self.session.canAddInput(input) {
                self.session.addInput(input)
                self.videoDeviceInput = input
                self.position = .back
            } else {
                ok = false
            }

            if let mic = AVCaptureDevice.default(for: .audio),
               let audioIn = try? AVCaptureDeviceInput(device: mic),
               self.session.canAddInput(audioIn) {
                self.session.addInput(audioIn)
                self.audioDeviceInput = audioIn
            }

            self.videoDataOutput.videoSettings = [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
            ]
            self.videoDataOutput.alwaysDiscardsLateVideoFrames = false
            self.videoDataOutput.setSampleBufferDelegate(self, queue: self.dataQueue)
            if self.session.canAddOutput(self.videoDataOutput) {
                self.session.addOutput(self.videoDataOutput)
            } else {
                ok = false
            }

            self.audioDataOutput.setSampleBufferDelegate(self, queue: self.dataQueue)
            if self.session.canAddOutput(self.audioDataOutput) {
                self.session.addOutput(self.audioDataOutput)
            }

            self.configureVideoConnection()
            self.session.commitConfiguration()
            self.session.startRunning()

            let success = ok
            DispatchQueue.main.async { self.onConfigured?(success) }
        }
    }

    func startSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if !self.session.isRunning { self.session.startRunning() }
        }
    }

    func stopSession() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func camera(for position: AVCaptureDevice.Position) -> AVCaptureDevice? {
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.builtInWideAngleCamera],
            mediaType: .video,
            position: position
        )
        return discovery.devices.first
    }

    private func configureVideoConnection() {
        guard let conn = videoDataOutput.connection(with: .video) else { return }
        if conn.isVideoRotationAngleSupported(90) {
            conn.videoRotationAngle = 90
        }
        if conn.isVideoMirroringSupported {
            conn.automaticallyAdjustsVideoMirroring = false
            conn.isVideoMirrored = (position == .front)
        }
    }

    // MARK: - Camera flip (seamless — never stops recording)

    func flipCamera() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            let newPosition: AVCaptureDevice.Position = self.position == .back ? .front : .back
            guard let newDevice = self.camera(for: newPosition),
                  let newInput = try? AVCaptureDeviceInput(device: newDevice) else { return }

            self.session.beginConfiguration()
            if let current = self.videoDeviceInput {
                self.session.removeInput(current)
            }
            if self.session.canAddInput(newInput) {
                self.session.addInput(newInput)
                self.videoDeviceInput = newInput
                self.position = newPosition
            } else if let current = self.videoDeviceInput {
                self.session.addInput(current)
            }
            self.configureVideoConnection()
            self.session.commitConfiguration()
        }
    }

    // MARK: - Torch

    func setTorch(_ on: Bool) {
        sessionQueue.async { [weak self] in
            guard let self,
                  self.position == .back,
                  let device = self.videoDeviceInput?.device,
                  device.hasTorch else { return }
            do {
                try device.lockForConfiguration()
                device.torchMode = on ? .on : .off
                device.unlockForConfiguration()
            } catch {
                // Torch unavailable — ignore silently.
            }
        }
    }

    // MARK: - Recording

    func startRecording() {
        dataQueue.async { [weak self] in
            guard let self, !self.recording else { return }

            let url = FileManager.default.temporaryDirectory
                .appendingPathComponent("drop_\(UUID().uuidString).mp4")

            do {
                let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)

                let videoSettings: [String: Any] = [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: self.videoWidth,
                    AVVideoHeightKey: self.videoHeight,
                    AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
                    AVVideoCompressionPropertiesKey: [
                        AVVideoAverageBitRateKey: 8_000_000,
                        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
                    ]
                ]
                let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
                videoInput.expectsMediaDataInRealTime = true
                if writer.canAdd(videoInput) { writer.add(videoInput) }

                let audioSettings: [String: Any] = [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVNumberOfChannelsKey: 1,
                    AVSampleRateKey: 44_100,
                    AVEncoderBitRateKey: 128_000
                ]
                let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
                audioInput.expectsMediaDataInRealTime = true
                if writer.canAdd(audioInput) { writer.add(audioInput) }

                self.assetWriter = writer
                self.videoWriterInput = videoInput
                self.audioWriterInput = audioInput
                self.outputURL = url
                self.isWriting = false
                self.recording = true

                DispatchQueue.main.async { self.onRecordingStateChange?(true) }
            } catch {
                DispatchQueue.main.async {
                    self.onError?("Couldn't start recording. Please try again.")
                }
            }
        }
    }

    func stopRecording() {
        dataQueue.async { [weak self] in
            guard let self, self.recording, let writer = self.assetWriter else { return }
            self.recording = false

            guard self.isWriting else {
                self.cleanup()
                DispatchQueue.main.async { self.onRecordingStateChange?(false) }
                return
            }

            self.videoWriterInput?.markAsFinished()
            self.audioWriterInput?.markAsFinished()
            let url = self.outputURL

            writer.finishWriting { [weak self] in
                guard let self else { return }
                let status = writer.status
                DispatchQueue.main.async {
                    self.onRecordingStateChange?(false)
                    if status == .completed, let url {
                        self.onFinished?(url)
                    } else {
                        self.onError?("Recording failed to save.")
                    }
                }
                self.dataQueue.async { self.cleanup() }
            }
        }
    }

    private func cleanup() {
        assetWriter = nil
        videoWriterInput = nil
        audioWriterInput = nil
        isWriting = false
        outputURL = nil
    }

    // MARK: - Sample buffer delegate (runs on dataQueue, serialized)

    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard recording, let writer = assetWriter else { return }
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let isVideo = output === videoDataOutput

        if writer.status == .failed { return }

        if writer.status == .unknown {
            // Begin the writing session on the first video frame so the timeline
            // starts cleanly aligned to video.
            guard isVideo else { return }
            let startTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
            writer.startWriting()
            writer.startSession(atSourceTime: startTime)
            isWriting = true
        }

        guard isWriting else { return }

        if isVideo {
            if let input = videoWriterInput, input.isReadyForMoreMediaData {
                input.append(sampleBuffer)
            }
        } else {
            if let input = audioWriterInput, input.isReadyForMoreMediaData {
                input.append(sampleBuffer)
            }
        }
    }
}

extension CaptureEngine: AVCaptureVideoDataOutputSampleBufferDelegate,
                         AVCaptureAudioDataOutputSampleBufferDelegate {}
