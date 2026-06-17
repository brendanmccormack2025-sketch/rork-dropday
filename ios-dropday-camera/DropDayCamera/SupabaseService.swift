//
//  SupabaseService.swift
//  DropDayCamera
//
//  Lightweight Supabase client (auth + storage + REST) built directly on
//  URLSession so the native app can sign in and publish Drops to the same
//  backend the Expo app uses — no third-party SDK required.
//

import Foundation

nonisolated struct SupabaseSession: Codable, Sendable {
    let accessToken: String
    let refreshToken: String
    let userId: String
}

nonisolated enum SupabaseError: LocalizedError {
    case notConfigured
    case notAuthenticated
    case auth(String)
    case upload(String)
    case post(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured: return "Backend is not configured."
        case .notAuthenticated: return "Please sign in to post your Drop."
        case .auth(let m): return m
        case .upload(let m): return m
        case .post(let m): return m
        }
    }
}

nonisolated final class SupabaseService: @unchecked Sendable {
    static let shared = SupabaseService()

    private let baseURL: URL?
    private let anonKey: String
    private let bucket = "drops"
    private let sessionKey = "supabase_session"

    private(set) var session: SupabaseSession? {
        didSet { persistSession() }
    }

    private init() {
        let urlString = Config.EXPO_PUBLIC_SUPABASE_URL.isEmpty
            ? "https://tfdjymogbtfavdzgfqas.supabase.co"
            : Config.EXPO_PUBLIC_SUPABASE_URL
        self.baseURL = URL(string: urlString)
        self.anonKey = Config.EXPO_PUBLIC_SUPABASE_ANON_KEY.isEmpty
            ? "sb_publishable_AiHj_P8vz6ZGWtPFAom8cw_bWyi2MuA"
            : Config.EXPO_PUBLIC_SUPABASE_ANON_KEY
        self.session = Self.loadSession(key: sessionKey)
    }

    var isAuthenticated: Bool { session != nil }

    // MARK: - Auth

    func signIn(email: String, password: String) async throws {
        guard let baseURL else { throw SupabaseError.notConfigured }
        let url = baseURL.appendingPathComponent("auth/v1/token")
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "grant_type", value: "password")]
        guard let finalURL = components?.url else { throw SupabaseError.notConfigured }

        var request = URLRequest(url: finalURL)
        request.httpMethod = "POST"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email, "password": password
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SupabaseError.auth(Self.message(from: data) ?? "Invalid email or password.")
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let accessToken = json["access_token"] as? String,
              let refreshToken = json["refresh_token"] as? String else {
            throw SupabaseError.auth("Unexpected sign-in response.")
        }
        let userId = (json["user"] as? [String: Any])?["id"] as? String ?? ""
        session = SupabaseSession(accessToken: accessToken, refreshToken: refreshToken, userId: userId)
    }

    func signUp(email: String, password: String, username: String) async throws {
        guard let baseURL else { throw SupabaseError.notConfigured }
        let url = baseURL.appendingPathComponent("auth/v1/signup")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(anonKey, forHTTPHeaderField: "apikey")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "email": email,
            "password": password,
            "data": ["username": username]
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw SupabaseError.auth(Self.message(from: data) ?? "Could not create account.")
        }

        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let accessToken = json["access_token"] as? String,
           let refreshToken = json["refresh_token"] as? String {
            let userId = (json["user"] as? [String: Any])?["id"] as? String ?? ""
            session = SupabaseSession(accessToken: accessToken, refreshToken: refreshToken, userId: userId)
        } else {
            // Email confirmation may be required; sign in afterwards.
            try await signIn(email: email, password: password)
        }
    }

    func signOut() {
        session = nil
    }

    // MARK: - Upload

    /// Uploads a video file to Supabase Storage and returns the public URL.
    /// Does NOT create a post row — the Expo app handles that after the user
    /// reviews and confirms on the edit screen.
    @discardableResult
    func uploadVideo(videoURL: URL) async throws -> String {
        guard let baseURL else { throw SupabaseError.notConfigured }
        guard let session else { throw SupabaseError.notAuthenticated }

        let data = try Data(contentsOf: videoURL)
        let path = "\(session.userId)/drop_\(UUID().uuidString).mp4"

        let uploadURL = baseURL
            .appendingPathComponent("storage/v1/object")
            .appendingPathComponent(bucket)
            .appendingPathComponent(path)

        var uploadRequest = URLRequest(url: uploadURL)
        uploadRequest.httpMethod = "POST"
        uploadRequest.setValue(anonKey, forHTTPHeaderField: "apikey")
        uploadRequest.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        uploadRequest.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        uploadRequest.setValue("true", forHTTPHeaderField: "x-upsert")
        uploadRequest.httpBody = data

        let (uploadData, uploadResponse) = try await URLSession.shared.data(for: uploadRequest)
        guard let uploadHTTP = uploadResponse as? HTTPURLResponse,
              (200..<300).contains(uploadHTTP.statusCode) else {
            throw SupabaseError.upload(Self.message(from: uploadData) ?? "Upload failed.")
        }

        return baseURL
            .appendingPathComponent("storage/v1/object/public")
            .appendingPathComponent(bucket)
            .appendingPathComponent(path)
            .absoluteString
    }

    // MARK: - Publish

    /// Uploads a recorded video file and creates a post row. Returns the public URL.
    @discardableResult
    func publishDrop(videoURL: URL, caption: String?) async throws -> String {
        guard let baseURL else { throw SupabaseError.notConfigured }
        guard let session else { throw SupabaseError.notAuthenticated }

        let data = try Data(contentsOf: videoURL)
        let path = "\(session.userId)/drop_\(UUID().uuidString).mp4"

        // 1. Upload to storage
        let uploadURL = baseURL
            .appendingPathComponent("storage/v1/object")
            .appendingPathComponent(bucket)
            .appendingPathComponent(path)

        var uploadRequest = URLRequest(url: uploadURL)
        uploadRequest.httpMethod = "POST"
        uploadRequest.setValue(anonKey, forHTTPHeaderField: "apikey")
        uploadRequest.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        uploadRequest.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        uploadRequest.setValue("true", forHTTPHeaderField: "x-upsert")
        uploadRequest.httpBody = data

        let (uploadData, uploadResponse) = try await URLSession.shared.data(for: uploadRequest)
        guard let uploadHTTP = uploadResponse as? HTTPURLResponse,
              (200..<300).contains(uploadHTTP.statusCode) else {
            throw SupabaseError.upload(Self.message(from: uploadData) ?? "Upload failed.")
        }

        let publicURL = baseURL
            .appendingPathComponent("storage/v1/object/public")
            .appendingPathComponent(bucket)
            .appendingPathComponent(path)
            .absoluteString

        // 2. Insert post row
        let postsURL = baseURL.appendingPathComponent("rest/v1/posts")
        var postRequest = URLRequest(url: postsURL)
        postRequest.httpMethod = "POST"
        postRequest.setValue(anonKey, forHTTPHeaderField: "apikey")
        postRequest.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
        postRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        postRequest.setValue("return=representation", forHTTPHeaderField: "Prefer")

        var body: [String: Any] = [
            "user_id": session.userId,
            "media_url": publicURL,
            "media_type": "video"
        ]
        if let caption, !caption.isEmpty { body["caption"] = caption }
        postRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (postData, postResponse) = try await URLSession.shared.data(for: postRequest)
        guard let postHTTP = postResponse as? HTTPURLResponse,
              (200..<300).contains(postHTTP.statusCode) else {
            throw SupabaseError.post(Self.message(from: postData) ?? "Could not publish Drop.")
        }

        return publicURL
    }

    // MARK: - Persistence

    private func persistSession() {
        if let session, let data = try? JSONEncoder().encode(session),
           let json = String(data: data, encoding: .utf8) {
            KeychainHelper.save(json, for: sessionKey)
        } else {
            KeychainHelper.delete(sessionKey)
        }
    }

    private static func loadSession(key: String) -> SupabaseSession? {
        guard let json = KeychainHelper.read(key),
              let data = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(SupabaseSession.self, from: data)
    }

    private static func message(from data: Data) -> String? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return (json["msg"] as? String)
            ?? (json["message"] as? String)
            ?? (json["error_description"] as? String)
            ?? (json["error"] as? String)
    }
}
