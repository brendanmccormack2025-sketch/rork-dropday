//
//  Theme.swift
//  DropDayCamera
//
//  Shared design tokens mirroring the Trial brand:
//  near-black backdrop with an electric-blue accent.
//

import SwiftUI

enum Theme {
    static let bg = Color(hex: 0x050505)
    static let bgElevated = Color(hex: 0x0A0A0A)
    static let card = Color(hex: 0x0F0F0F)
    static let border = Color(hex: 0x1C1C1E)
    static let text = Color(hex: 0xF5F5F5)
    static let textMuted = Color(hex: 0x999999)
    static let textDim = Color(hex: 0x555555)
    static let accent = Color(hex: 0x0A84FF)
    static let accentGlow = Color(hex: 0x3B82F6)
    static let danger = Color(hex: 0xFF453A)
    static let success = Color(hex: 0x30D158)

    /// Max recording length for a single Drop, in seconds.
    static let maxRecordingSeconds: Double = 60
}

extension Color {
    init(hex: UInt, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}
