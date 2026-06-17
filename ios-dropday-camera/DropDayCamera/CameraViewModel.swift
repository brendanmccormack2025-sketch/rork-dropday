//
//  CameraViewModel.swift
//  DropDayCamera
//
//  Main-actor view model that drives the camera UI and coordinates the
//  background CaptureEngine. Owns recording state, the progress timer, and
//  permission handling.
//

import SwiftUI
import AVFoundation
import Combine

@MainActor
final class CameraViewModel: ObservableObject {
    enum PermissionState {
        case unknown
        case granted
        case denied
    }

    @Published var permission: PermissionState = .unknown
    @Published var isConfigured = false
    @Published var isRecording = false
    @Published var isLocked = false
    @Published var torchOn = false
    @Published var isFront = false
    @Published var progress: Double = 0          // 0...1 of max duration
    @Published var elapsed: TimeInterval = 0
    @Published var recordedURL: URL?
    @Published var errorMessage: String?

    let engine = CaptureEngine()
    var session: AVCaptureSession { engine.session }

    private var timer: Timer?
    private var startDate: Date?

    init() {
        engine.onConfigured = { [weak self] ok in
            guard let self else { return }
            self.isConfigured = ok
            if !ok { self.errorMessage = "Camera is unavailable on this device." }
        }
        engine.onRecordingStateChange = { [weak self] recording in
            self?.isRecording = recording
        }
        engine.onFinished = { [weak self] url in
            self?.recordedURL = url
        }
        engine.onError = { [weak self] message in
            self?.errorMessage = message
            self?.resetRecordingState()
        }
    }

    // MARK: - Permissions

    func requestPermissions() async {
        let camGranted = await requestAccess(for: .video)
        let micGranted = await requestAccess(for: .audio)
        let granted = camGranted && micGranted
        permission = granted ? .granted : .denied
        if granted { engine.configure() }
    }

    private func requestAccess(for type: AVMediaType) async -> Bool {
        switch AVCaptureDevice.authorizationStatus(for: type) {
        case .authorized:
            return true
        case .notDetermined:
            return await AVCaptureDevice.requestAccess(for: type)
        default:
            return false
        }
    }

    // MARK: - Session lifecycle

    func resume() {
        if permission == .granted { engine.startSession() }
    }

    func pause() {
        if isRecording { stopRecording() }
        engine.stopSession()
    }

    // MARK: - Recording

    func startRecording() {
        guard !isRecording, permission == .granted else { return }
        errorMessage = nil
        startDate = Date()
        elapsed = 0
        progress = 0
        engine.startRecording()
        startTimer()
        Haptics.impact(.heavy)
    }

    func stopRecording() {
        guard isRecording else { return }
        engine.stopRecording()
        stopTimer()
        isLocked = false
        Haptics.impact(.medium)
    }

    func flipCamera() {
        engine.flipCamera()
        isFront.toggle()
        if isFront && torchOn {
            torchOn = false
            engine.setTorch(false)
        }
        Haptics.impact(.light)
    }

    func toggleTorch() {
        guard !isFront else { return }
        torchOn.toggle()
        engine.setTorch(torchOn)
        Haptics.impact(.light)
    }

    func lockRecording() {
        guard isRecording, !isLocked else { return }
        isLocked = true
        Haptics.impact(.heavy)
    }

    func discard() {
        if let url = recordedURL {
            try? FileManager.default.removeItem(at: url)
        }
        recordedURL = nil
        resetRecordingState()
    }

    private func resetRecordingState() {
        stopTimer()
        isRecording = false
        isLocked = false
        progress = 0
        elapsed = 0
    }

    // MARK: - Timer

    private func startTimer() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.03, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
        }
    }

    private func stopTimer() {
        timer?.invalidate()
        timer = nil
    }

    private func tick() {
        guard let start = startDate else { return }
        elapsed = Date().timeIntervalSince(start)
        progress = min(1, elapsed / Theme.maxRecordingSeconds)
        if elapsed >= Theme.maxRecordingSeconds {
            stopRecording()
        }
    }
}

enum Haptics {
    static func impact(_ style: UIImpactFeedbackGenerator.FeedbackStyle) {
        let generator = UIImpactFeedbackGenerator(style: style)
        generator.impactOccurred()
    }
}
