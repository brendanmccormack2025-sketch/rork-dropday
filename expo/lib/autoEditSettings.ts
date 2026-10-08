import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SENSITIVITY, type Sensitivity } from "@/lib/silenceDetection";

const SAVE_EDITED_KEY = "dropday:saveEditedToRoll";
const ENABLED_KEY = "dropday:autoEditEnabled";
const SENSITIVITY_KEY = "dropday:autoEditSensitivity";

/** Last Review sensitivity choice; Normal when unset or unreadable. */
export async function getAutoEditSensitivity(): Promise<Sensitivity> {
  try {
    const v = await AsyncStorage.getItem(SENSITIVITY_KEY);
    return v === "gentle" || v === "normal" || v === "tight" ? v : DEFAULT_SENSITIVITY;
  } catch {
    return DEFAULT_SENSITIVITY;
  }
}

export function setAutoEditSensitivity(value: Sensitivity): void {
  AsyncStorage.setItem(SENSITIVITY_KEY, value).catch(() => {});
}

/** "Auto-edit my videos" switch; on unless the user turned it off. */
export async function getAutoEditEnabled(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ENABLED_KEY)) !== "0";
  } catch {
    return true;
  }
}

export function setAutoEditEnabled(value: boolean): void {
  AsyncStorage.setItem(ENABLED_KEY, value ? "1" : "0").catch(() => {});
}

/**
 * "Save to camera roll" switch, remembered per user; on unless the user turned it off. A choice made before
 * it was per user (the single old key) still counts until the user sets their own.
 */
export async function getSaveEditedToRoll(userId?: string | null): Promise<boolean> {
  try {
    const own = userId ? await AsyncStorage.getItem(`${SAVE_EDITED_KEY}:${userId}`) : null;
    if (own !== null) return own !== "0";
    return (await AsyncStorage.getItem(SAVE_EDITED_KEY)) !== "0";
  } catch {
    return true;
  }
}

export function setSaveEditedToRoll(value: boolean, userId?: string | null): void {
  AsyncStorage.setItem(userId ? `${SAVE_EDITED_KEY}:${userId}` : SAVE_EDITED_KEY, value ? "1" : "0").catch(() => {});
}
