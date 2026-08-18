import { getHapticFeedback } from "./github";

/** A short tick, if the user has haptics on and the device can produce one. */
export function haptic(ms: number = 10): void {
  if (getHapticFeedback() && navigator.vibrate) navigator.vibrate(ms);
}
