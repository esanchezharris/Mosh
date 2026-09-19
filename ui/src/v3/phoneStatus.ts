import type { RemotePairingInfo } from "../bridge";
import type { LoopState } from "../types";

/** How long after its last poll a phone still counts as attached. The pad polls two or
 *  three times a second, so three seconds is several missed polls, not one slow one. */
export const PHONE_PRESENCE_MS = 3000;

/** The one line the Booth shows about the phone: who is driving, or how to get one.
 *  `nowMs` and `loop.phoneSeenMs` must share a clock — see the caller's note. */
export function phoneStatusLine(
  loop: LoopState | null | undefined,
  pairing: RemotePairingInfo | null | undefined,
  nowMs: number,
): string | null {
  const seen = loop?.phoneSeenMs ?? 0;
  if (loop && seen > 0 && nowMs - seen < PHONE_PRESENCE_MS) {
    const activity = loop.transport?.recording ? "recording"
      : loop.transport?.playing ? "playing"
      : loop.phase;
    const part = loop.contributions.find((candidate) => candidate.id === loop.currentId);
    return `Phone connected · ${part ? `${part.label} ${activity}` : activity}`;
  }
  if (pairing) return "Phone pad ready · scan the QR";
  return null;
}
