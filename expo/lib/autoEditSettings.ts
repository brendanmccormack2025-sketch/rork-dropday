import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SENSITIVITY, type Sensitivity } from "@/lib/silenceDetection";

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
