//
//  AuthSheet.swift
//  DropDayCamera
//
//  Lightweight sign-in / sign-up sheet so creators can publish to the same
//  DropDay backend the Expo app uses.
//

import SwiftUI

struct AuthSheet: View {
    let onAuthenticated: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var mode: Mode = .signIn
    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var isLoading = false
    @State private var error: String?

    enum Mode { case signIn, signUp }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    VStack(spacing: 6) {
                        Image(systemName: "drop.fill")
                            .font(.system(size: 40))
                            .foregroundStyle(Theme.accent)
                        Text(mode == .signIn ? "Welcome back" : "Join DropDay")
                            .font(.title2.bold())
                            .foregroundStyle(Theme.text)
                        Text("Sign in to post your Drop")
                            .font(.subheadline)
                            .foregroundStyle(Theme.textMuted)
                    }
                    .padding(.top, 12)

                    if mode == .signUp {
                        field("Username", text: $username, icon: "person.fill")
                    }
                    field("Email", text: $email, icon: "envelope.fill",
                          keyboard: .emailAddress)
                    field("Password", text: $password, icon: "lock.fill", secure: true)

                    if let error {
                        Text(error)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    Button(action: submit) {
                        HStack {
                            if isLoading { ProgressView().tint(.white) }
                            else { Text(mode == .signIn ? "Sign In" : "Create Account").bold() }
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(Theme.accent, in: RoundedRectangle(cornerRadius: 14))
                    }
                    .disabled(isLoading)

                    Button {
                        withAnimation { mode = mode == .signIn ? .signUp : .signIn; error = nil }
                    } label: {
                        Text(mode == .signIn
                             ? "No account? Sign up"
                             : "Already have an account? Sign in")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Theme.accent)
                    }
                }
                .padding(20)
            }
            .background(Theme.bg)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Cancel") { dismiss() }
                        .foregroundStyle(Theme.textMuted)
                }
            }
        }
    }

    private func field(_ placeholder: String, text: Binding<String>, icon: String,
                       secure: Bool = false,
                       keyboard: UIKeyboardType = .default) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(Theme.textMuted)
                .frame(width: 18)
            Group {
                if secure {
                    SecureField("", text: text, prompt: Text(placeholder)
                        .foregroundColor(Theme.textMuted))
                } else {
                    TextField("", text: text, prompt: Text(placeholder)
                        .foregroundColor(Theme.textMuted))
                        .keyboardType(keyboard)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .foregroundStyle(Theme.text)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.border, lineWidth: 1))
    }

    private func submit() {
        error = nil
        isLoading = true
        Task {
            do {
                if mode == .signIn {
                    try await SupabaseService.shared.signIn(email: email, password: password)
                } else {
                    try await SupabaseService.shared.signUp(
                        email: email, password: password, username: username
                    )
                }
                isLoading = false
                dismiss()
                onAuthenticated()
            } catch {
                isLoading = false
                self.error = error.localizedDescription
            }
        }
    }
}
