//
//  PreviewScreen.swift
//  DropDayCamera
//
//  Plays back the recorded Drop (the full seamless video) and lets the
//  creator add a caption and publish to the DropDay feed.
//

import SwiftUI
import AVKit

struct PreviewScreen: View {
    let videoURL: URL
    let onClose: () -> Void

    @State private var player: AVPlayer
    @State private var caption = ""
    @State private var isUploading = false
    @State private var uploadError: String?
    @State private var showAuth = false

    init(videoURL: URL, onClose: @escaping () -> Void) {
        self.videoURL = videoURL
        self.onClose = onClose
        _player = State(initialValue: AVPlayer(url: videoURL))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            LoopingPlayerView(player: player)
                .ignoresSafeArea()

            // Subtle gradient for control legibility
            LinearGradient(
                colors: [.black.opacity(0.5), .clear, .clear, .black.opacity(0.7)],
                startPoint: .top, endPoint: .bottom
            )
            .ignoresSafeArea()
            .allowsHitTesting(false)

            VStack {
                topBar
                Spacer()
                bottomPanel
            }


        }
        .statusBarHidden(true)
        .onAppear {
            player.actionAtItemEnd = .none
            player.play()
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: player.currentItem,
                queue: .main
            ) { _ in
                player.seek(to: .zero)
                player.play()
            }
        }
        .onDisappear { player.pause() }
        .sheet(isPresented: $showAuth) {
            AuthSheet { Task { await proceedToEdit() } }
        }
    }

    private var topBar: some View {
        HStack {
            Button(action: onClose) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.ultraThinMaterial, in: Circle())
            }
            Spacer()
            HStack(spacing: 6) {
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Theme.accent)
                Text("SEAMLESS DROP")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(.white)
                    .tracking(1)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(.ultraThinMaterial, in: Capsule())
            Spacer()
            Color.clear.frame(width: 40, height: 40)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
    }

    private var bottomPanel: some View {
        VStack(spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: "text.bubble.fill")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.textMuted)
                TextField("", text: $caption, prompt: Text("Add a caption…")
                    .foregroundColor(Theme.textMuted))
                    .foregroundStyle(.white)
                    .submitLabel(.done)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))

            if let error = uploadError {
                Text(error)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Theme.danger)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            Button {
                if SupabaseService.shared.isAuthenticated {
                    Task { await proceedToEdit() }
                } else {
                    showAuth = true
                }
            } label: {
                HStack(spacing: 8) {
                    if isUploading {
                        ProgressView().tint(.white)
                    } else {
                        Text("Next")
                            .font(.system(size: 17, weight: .bold))
                        Image(systemName: "arrow.right")
                            .font(.system(size: 17, weight: .bold))
                    }
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 16)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 16))
                .shadow(color: Theme.accent.opacity(0.5), radius: 14, y: 4)
            }
            .disabled(isUploading)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 32)
    }

    private func proceedToEdit() async {
        isUploading = true
        uploadError = nil
        do {
            // Upload video to Supabase storage — the Expo app will create the post row
            let publicURL = try await SupabaseService.shared.uploadVideo(videoURL: videoURL)

            // Return to the Expo app with the video URL and caption
            let expoScheme = "rork-fgum9ff0goqjv4vh7u4xf"
            var components = URLComponents()
            components.scheme = expoScheme
            components.host = "edit"
            components.queryItems = [
                URLQueryItem(name: "videoUrl", value: publicURL),
                URLQueryItem(name: "caption", value: caption.isEmpty ? nil : caption)
            ]

            guard let returnURL = components.url else {
                uploadError = "Could not open DropDay app."
                isUploading = false
                return
            }

            await UIApplication.shared.open(returnURL)
            onClose()
        } catch {
            isUploading = false
            uploadError = error.localizedDescription
        }
    }
}

/// Plays an AVPlayer full-bleed using a UIView-backed AVPlayerLayer.
struct LoopingPlayerView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerUIView {
        let view = PlayerUIView()
        view.playerLayer.player = player
        view.playerLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PlayerUIView, context: Context) {}

    final class PlayerUIView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer {
            // swiftlint:disable:next force_cast
            layer as! AVPlayerLayer
        }
    }
}
