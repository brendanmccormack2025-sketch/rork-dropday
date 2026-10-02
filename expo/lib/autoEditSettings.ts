import AsyncStorage from "@react-native-async-storage/async-storage";
import { DEFAULT_SENSITIVITY, type Sensitivity } from "@/lib/silenceDetection";

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
