import { offsetFrom, setClockOffset } from "./clock";
import { settings } from "./settings";

/**
 * Measuring the clock offset (`clock.ts`) and keeping it across launches, so a
 * drill offline on a device with a wrong clock is still dated right.
 */

/** The offset last measured, in effect from the first paint. */
export function loadClockOffset(): void {
  setClockOffset(settings.clockOffsetMs.get());
}

/** Ask our own origin the time and keep the offset. Keeps the old one on failure. */
export async function measureClock(): Promise<void> {
  try {
    const sentAt = Date.now();
    const res = await fetch("/", { method: "HEAD", cache: "no-store" });
    const receivedAt = Date.now();
    const date = res.headers.get("date");
    const offset = date ? offsetFrom(date, sentAt, receivedAt) : null;
    if (offset === null) return;
    settings.clockOffsetMs.set(offset);
    setClockOffset(offset);
  } catch {
    // Offline: the last measurement stands.
  }
}
