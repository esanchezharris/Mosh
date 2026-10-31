import type { RemotePairingInfo } from "../bridge";

// The Start page's Phone step, React-free. The pairing token lives 5 minutes unscanned
// (RemoteCompanionProtocol.h pairingTtlMs); once a pad is in use each poll keeps it alive
// for 2 h (PR #783), so the countdown only matters before the first connect.
//
// `expiresAtMs` is EPOCH ms from the bridge, so comparing it with Date.now() is sound.
// (`loop.phoneSeenMs` is ms since the Mac booted and is never compared with anything.)

/** Show the "phone not here yet?" help after this long without a phone. */
export const STALLED_AFTER_MS = 60_000;
/** The countdown turns to a warning under this. */
export const WARN_UNDER_MS = 60_000;
/** After the first connect, hand off to the Booth this long later. */
export const CONNECT_HANDOFF_MS = 1_500;

export type PairingPhase =
  | "idle"        // not shown yet: the singer has not asked for the code
  | "starting"    // asked; waiting for the server
  | "failed"      // the server didn't start
  | "showing"     // QR on screen, valid
  | "expired"     // QR on screen, lapsed: offer a new one
  | "connected";  // a phone polled (latched)

export interface PairingView {
  phase: PairingPhase;
  /** "4:59" while showing, else "". */
  countdown: string;
  warn: boolean;
  stalled: boolean;
  /** "New code" is offered only before a phone connects: a re-mint cuts a phone off. */
  canRemint: boolean;
}

export function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export interface PairingInput {
  requested: boolean;
  pairing: RemotePairingInfo | null | undefined;
  /** The page's own record of a start failure (lastError after starting). */
  error: string | null;
  everConnected: boolean;
  shownAtMs: number | null;
  nowMs: number;
}

export function pairingView({ requested, pairing, error, everConnected, shownAtMs, nowMs }: PairingInput): PairingView {
  if (everConnected) return { phase: "connected", countdown: "", warn: false, stalled: false, canRemint: false };
  if (!requested) return { phase: "idle", countdown: "", warn: false, stalled: false, canRemint: false };
  if (!pairing) {
    return error
      ? { phase: "failed", countdown: "", warn: false, stalled: false, canRemint: true }
      : { phase: "starting", countdown: "", warn: false, stalled: false, canRemint: false };
  }
  const left = pairing.expiresAtMs - nowMs;
  const stalled = shownAtMs !== null && nowMs - shownAtMs >= STALLED_AFTER_MS;
  if (pairing.expiresAtMs > 0 && left <= 0) {
    return { phase: "expired", countdown: "0:00", warn: true, stalled, canRemint: true };
  }
  return {
    phase: "showing",
    countdown: pairing.expiresAtMs > 0 ? formatCountdown(left) : "",
    warn: pairing.expiresAtMs > 0 && left < WARN_UNDER_MS,
    stalled,
    canRemint: true,
  };
}
