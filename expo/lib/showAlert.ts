/**
 * Cross-platform alert that ALWAYS works — even on web where React Native's
 * Alert.alert can be unreliable in iframe-based previews.
 *
 * On web: writes a visible DOM overlay AND fires window.alert as a fallback.
 * On native: uses React Native's Alert.alert normally.
 */

import { Alert, Platform } from "react-native";

/** Show an alert that's guaranteed visible on all platforms. */
export function showAlert(title: string, message: string): void {
  if (Platform.OS === "web") {
    // ── DOM overlay — impossible to miss ──────────────────────────
    try {
      const existing = document.getElementById("__trial_error_overlay");
      if (existing) existing.remove();

      const overlay = document.createElement("div");
      overlay.id = "__trial_error_overlay";
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:999999;background:rgba(0,0,0,0.85);" +
        "display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;";
      overlay.onclick = () => overlay.remove();

      const box = document.createElement("div");
      box.style.cssText =
        "background:#1c1c1e;border:1px solid #ff453a;border-radius:16px;padding:24px 28px;" +
        "max-width:400px;width:90%;text-align:center;box-shadow:0 0 40px rgba(255,69,58,0.3);";

      const h = document.createElement("div");
      h.textContent = title;
      h.style.cssText =
        "font-size:18px;font-weight:700;color:#ff453a;margin-bottom:12px;";

      const p = document.createElement("div");
      p.textContent = message;
      p.style.cssText =
        "font-size:14px;color:rgba(255,255,255,0.8);line-height:1.5;margin-bottom:20px;word-break:break-word;";

      const btn = document.createElement("button");
      btn.textContent = "OK";
      btn.style.cssText =
        "background:#ff453a;color:#fff;border:none;border-radius:8px;" +
        "padding:10px 32px;font-size:15px;font-weight:600;cursor:pointer;";
      btn.onclick = (e) => { e.stopPropagation(); overlay.remove(); };

      box.append(h, p, btn);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    } catch {
      // DOM manipulation failed (e.g. SSR) — fall through to window.alert
    }

    // ── window.alert fallback ─────────────────────────────────────
    try {
      window.alert(`${title}\n\n${message}`);
    } catch {
      // Nothing more we can do
    }
  } else {
    // ── Native: standard React Native Alert ────────────────────────
    Alert.alert(title, message, [{ text: "OK" }]);
  }
}
