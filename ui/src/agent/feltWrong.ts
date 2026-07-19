// Felt-wrong hotkey (⌘⇧F) — workshop charter 2026-07-19, week-1 item 2.
//
// The moment "the bench passed but it FELT wrong" is the bench generator (charter
// settled point 6). ⌘⇧F captures that moment cheaply: a two-word tag, the command
// diff since the last felt-RIGHT waterline, and a snapshot (full when small, digest
// always) — archived through the existing best-effort DPO appender under the NEW
// source tag "felt-wrong". That lane is versioned and source-tagged exactly so the
// single-shot SFT surfaces can never accidentally fold it in (same posture as the
// "agent-loop" lane).
//
// Pure logic only in this module (unit-tested); the dialog + hotkey wiring live in
// ui/FeltWrongDialog.tsx and useKeyboardShortcuts.

import type { SessionLogEntry } from "./memory/sessionLog";

/** Commands that mean "the producer just blessed something" — the felt-right
 *  waterline. A capture reports what happened AFTER the most recent of these. */
const FELT_RIGHT_COMMANDS = new Set(["accept_render", "accept_lyric_proposal"]);

/** Newest entries a capture may carry — bounds the archive row. */
const DIFF_CAP = 100;

/** Full snapshots above this JSON size ride as digest-only. */
const SNAPSHOT_BYTE_GATE = 200_000;

// Waterline: how many session-log entries were already consumed by the previous
// capture. Session-scoped, in-memory — mirrors sessionLog's own lifetime.
let consumed = 0;

export type FeltWrongRow = {
  source: "felt-wrong";
  v: 1;
  tag: string;
  commandsSince: SessionLogEntry[];
  snapshotDigest: { tracks: number; clips: number; position: number | null };
  snapshot: unknown | null;
};

export function commandsSinceFeltRight(log: readonly SessionLogEntry[]): SessionLogEntry[] {
  let start = Math.min(consumed, log.length);
  for (let i = log.length - 1; i >= start; i--) {
    if (FELT_RIGHT_COMMANDS.has(log[i].command)) {
      start = i + 1;
      break;
    }
  }
  return log.slice(start).slice(-DIFF_CAP);
}

type SnapLike = {
  tracks?: { clips?: unknown[] }[];
  transport?: { position?: number };
};

export function snapshotDigest(snap: unknown): FeltWrongRow["snapshotDigest"] {
  const s = (snap ?? {}) as SnapLike;
  const tracks = Array.isArray(s.tracks) ? s.tracks : [];
  const clips = tracks.reduce((n, t) => n + (Array.isArray(t.clips) ? t.clips.length : 0), 0);
  const pos = s.transport?.position;
  return { tracks: tracks.length, clips, position: typeof pos === "number" ? pos : null };
}

export function buildFeltWrongRow(
  tag: string,
  log: readonly SessionLogEntry[],
  snapshot: unknown,
): FeltWrongRow {
  const clean = tag.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 48);
  if (!clean) throw new Error("felt-wrong tag must be non-empty");
  const commandsSince = commandsSinceFeltRight(log);
  consumed = log.length; // advance the waterline — the next capture starts fresh
  let full: unknown | null = snapshot ?? null;
  if (full !== null) {
    try {
      if (JSON.stringify(full).length > SNAPSHOT_BYTE_GATE) full = null;
    } catch {
      full = null;
    }
  }
  return {
    source: "felt-wrong",
    v: 1,
    tag: clean,
    commandsSince,
    snapshotDigest: snapshotDigest(snapshot),
    snapshot: full,
  };
}

export function __resetFeltWrongForTests(): void {
  consumed = 0;
}
