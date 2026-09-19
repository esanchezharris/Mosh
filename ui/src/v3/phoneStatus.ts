import type { RemotePairingInfo } from "../bridge";
import type { LoopState } from "../types";

/** How long after its last poll a phone still counts as attached, as the ENGINE applies
 *  it (kLoopPhoneWindowMs in MoshOps.Loop.cpp). The pad polls every 200 ms (5 Hz), so
 *  three seconds is many missed polls, not one slow one. Exported for documentation and
 *  for tests that pin the two constants together; nothing here does the arithmetic. */
export const PHONE_PRESENCE_MS = 3000;

/** The one line the Booth shows about the phone: who is driving, or how to get one.
 *
 *  Presence is the ENGINE's verdict (`loop.phoneConnected`), never a sum this side works
 *  out. `loop.phoneSeenMs` is `Time::getMillisecondCounterHiRes()` — milliseconds since
 *  the Mac booted — so comparing it to `Date.now()` compares two unrelated clocks and
 *  reports "no phone" forever. Diagnostics may show the stamp; nothing may decide on it. */
export function phoneStatusLine(
  loop: LoopState | null | undefined,
  pairing: RemotePairingInfo | null | undefined,
): string | null {
  if (loop?.phoneConnected === true) {
    const activity = loop.transport?.recording ? "recording"
      : loop.transport?.playing ? "playing"
      : loop.phase;
    const part = loop.contributions.find((candidate) => candidate.id === loop.currentId);
    return `Phone connected · ${part ? `${part.label} ${activity}` : activity}`;
  }
  if (pairing) return "Phone pad ready · scan the QR";
  return null;
}
