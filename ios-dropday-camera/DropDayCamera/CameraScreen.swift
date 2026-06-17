//
//  CameraScreen.swift
//  DropDayCamera
//
//  Full-screen viewfinder with hold-to-record, double-tap flip, drag-to-lock,
//  and a progress ring around the capture button.
//

import SwiftUI
import AVFoundation

struct CameraScreen: View {
    @StateObject private var model = CameraViewModel()
    @State private var showPreview = false
    @State private var dragLock: CGFloat = 0   // 0...1 progress toward locking
    @State private var pressStarted = false
    @State private var pressWorkItem: DispatchWorkItem?

    private let lockDistance: CGFloat = 90
    private let ringSize: CGFloat = 96
    private let ringStroke: CGFloat = 5

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            switch model.permission {
            case .unknown:
                ProgressView().tint(Theme.accent)
            case .denied:
                permissionDenied
            case .granted:
                cameraBody
            }
        }
        .task {
            if model.permission == .unknown {
                await model.requestPermissions()
            } else {
                model.resume()
            }
        }
        .onChange(of: model.recordedURL) { _, url in
            if url != nil { showPreview = true }
        }
        .fullScreenCover(isPresented: $showPreview, onDismiss: {
            model.discard()
            model.resume()
        }) {
            if let url = model.recordedURL {
                PreviewScreen(videoURL: url) {
                    showPreview = false
                }
            }
        }
        .statusBarHidden(true)
    }

    // MARK: - Camera body

    @ViewBuilder
    private var cameraBody: some View {
        #if targetEnvironment(simulator)
        simulatorPlaceholder
        #else
        ZStack {
            CameraPreviewView(session: model.session)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture(count: 2) { model.flipCamera() }

            topBar
            recordingIndicator
            bottomControls

            if let error = model.errorMessage {
                errorToast(error)
            }
        }
        #endif
    }

    // MARK: - Top bar

    private var topBar: some View {
        VStack {
            HStack(alignment: .center) {
                circleButton(systemName: "xmark") {
                    // Return to the Expo app
                    if let url = URL(string: "rork-fgum9ff0goqjv4vh7u4xf://feed") {
                        UIApplication.shared.open(url) { _ in
                            model.pause()
                        }
                    } else {
                        model.pause()
                    }
                }

                Spacer()

                if !model.isRecording {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.danger).frame(width: 6, height: 6)
                        Text("DROP")
                            .font(.system(size: 11, weight: .heavy))
                            .foregroundStyle(.white)
                            .tracking(1.5)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(.ultraThinMaterial, in: Capsule())
                }

                Spacer()

                HStack(spacing: 8) {
                    if !model.isFront {
                        circleButton(systemName: model.torchOn ? "bolt.fill" : "bolt.slash.fill",
                                     tint: model.torchOn ? Theme.accent : .white) {
                            model.toggleTorch()
                        }
                    }
                    circleButton(systemName: "arrow.triangle.2.circlepath") {
                        model.flipCamera()
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)

            Spacer()
        }
    }

    // MARK: - Recording indicator

    private var recordingIndicator: some View {
        VStack {
            if model.isRecording {
                HStack(spacing: 7) {
                    Circle()
                        .fill(Theme.danger)
                        .frame(width: 8, height: 8)
                        .opacity(model.isRecording ? 1 : 0.3)
                    Text(timeString(model.elapsed))
                        .font(.system(size: 14, weight: .bold, design: .monospaced))
                        .foregroundStyle(.white)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.top, 64)
                .transition(.move(edge: .top).combined(with: .opacity))
            }
            Spacer()
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.8), value: model.isRecording)
    }

    // MARK: - Bottom controls

    private var bottomControls: some View {
        VStack {
            Spacer()

            if model.isRecording && !model.isLocked {
                lockHint
                    .padding(.bottom, 8)
                    .transition(.opacity)
            }

            if model.isRecording && model.isLocked {
                HStack(spacing: 6) {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(Theme.accent)
                    Text("LOCKED · TAP TO STOP")
                        .font(.system(size: 10, weight: .heavy))
                        .foregroundStyle(.white)
                        .tracking(1)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(.ultraThinMaterial, in: Capsule())
                .overlay(Capsule().stroke(Theme.accent, lineWidth: 1))
                .padding(.bottom, 8)
            }

            if !model.isRecording {
                Text("Hold to record  ·  Double-tap to flip")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.7))
                    .shadow(color: .black.opacity(0.6), radius: 6)
                    .padding(.bottom, 12)
            }

            captureButton
                .padding(.bottom, 36)
        }
    }

    private var lockHint: some View {
        VStack(spacing: 2) {
            Image(systemName: "chevron.up")
                .font(.system(size: 20, weight: .bold))
                .foregroundStyle(Theme.accent)
                .offset(y: -dragLock * 18)
            Text("SLIDE UP TO LOCK")
                .font(.system(size: 10, weight: .heavy))
                .foregroundStyle(.white.opacity(0.85))
                .tracking(0.6)
        }
        .opacity(0.7 + dragLock * 0.3)
    }

    private var captureButton: some View {
        ZStack {
            Circle()
                .stroke(Color.white.opacity(0.18), lineWidth: ringStroke)
                .frame(width: ringSize, height: ringSize)

            Circle()
                .trim(from: 0, to: model.progress)
                .stroke(Theme.accent, style: StrokeStyle(lineWidth: ringStroke, lineCap: .round))
                .frame(width: ringSize, height: ringSize)
                .rotationEffect(.degrees(-90))

            Group {
                if model.isLocked {
                    RoundedRectangle(cornerRadius: 6)
                        .fill(.white)
                        .frame(width: 26, height: 26)
                } else if model.isRecording {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Theme.accent)
                        .frame(width: 30, height: 30)
                } else {
                    Circle()
                        .fill(.white)
                        .frame(width: ringSize - 30, height: ringSize - 30)
                }
            }
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: model.isRecording)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: model.isLocked)
        }
        .frame(width: ringSize + 28, height: ringSize + 28)
        .scaleEffect(model.isRecording ? 1.1 : 1)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: model.isRecording)
        .contentShape(Circle())
        .gesture(captureGesture)
    }

    // MARK: - Gesture

    private var captureGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                if !pressStarted {
                    pressStarted = true
                    handlePressDown()
                }
                if model.isRecording && !model.isLocked {
                    let up = max(0, -value.translation.height)
                    dragLock = min(1, up / lockDistance)
                    if up >= lockDistance {
                        model.lockRecording()
                    }
                }
            }
            .onEnded { _ in
                pressStarted = false
                handlePressUp()
            }
    }

    private func handlePressDown() {
        if model.isLocked {
            // A locked recording is stopped by tapping again.
            model.stopRecording()
            return
        }
        // Small delay distinguishes a hold from an accidental tap.
        let item = DispatchWorkItem {
            model.startRecording()
        }
        pressWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: item)
    }

    private func handlePressUp() {
        pressWorkItem?.cancel()
        pressWorkItem = nil
        withAnimation { dragLock = 0 }
        if model.isLocked { return }
        if model.isRecording {
            model.stopRecording()
        }
    }

    // MARK: - Helpers

    private func circleButton(systemName: String, tint: Color = .white,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 40, height: 40)
                .background(.ultraThinMaterial, in: Circle())
        }
    }

    private func errorToast(_ message: String) -> some View {
        VStack {
            Spacer()
            Text(message)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.white)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Theme.danger.opacity(0.9), in: Capsule())
                .padding(.bottom, 160)
        }
    }

    private func timeString(_ t: TimeInterval) -> String {
        let total = Int(t)
        return String(format: "%01d:%02d", total / 60, total % 60)
    }

    // MARK: - States

    private var permissionDenied: some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.fill")
                .font(.system(size: 44))
                .foregroundStyle(Theme.accent)
            Text("Camera Access Needed")
                .font(.title2.bold())
                .foregroundStyle(.white)
            Text("DropDay needs camera and microphone access to record your Drops. Enable it in Settings.")
                .font(.subheadline)
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14))
            }
        }
        .padding(32)
    }

    private var simulatorPlaceholder: some View {
        VStack(spacing: 18) {
            Image(systemName: "camera.viewfinder")
                .font(.system(size: 52))
                .foregroundStyle(Theme.accent)
            Text("DropDay Camera")
                .font(.title2.bold())
                .foregroundStyle(.white)
            Text("Install this app on your device via the Rork App to record Drops.")
                .font(.subheadline)
                .foregroundStyle(Theme.textMuted)
                .multilineTextAlignment(.center)
        }
        .padding(32)
    }
}

#Preview {
    CameraScreen()
}
