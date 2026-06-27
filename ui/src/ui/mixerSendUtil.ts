// Pure helpers for the mixer's sends / returns / bus surface. No React, no store —
// they map a UI gesture (a + Bus click, a send slider, a remove) to a single
// { command, args } call on the seam, and select the snapshot slices the strips
// render from. Keeping this logic out of the .tsx keeps the swappable seam honest
// (the UI couples to the backend ONLY through these command builders) and lets the
// slider→exec round-trip be unit-tested without mounting React (mixerSendUtil.test.ts).

import type { Snapshot, Track, Bus, Send } from "../types";

// The send level range the backend honours. set_send_level clamps -100..6 dB; we
// expose -60..6 (matching add_send and a usable fader throw — -60 reads as "off").
export const SEND_DB_MIN = -60;
export const SEND_DB_MAX = 6;

export const clampSendDb = (db: number): number =>
  Math.min(SEND_DB_MAX, Math.max(SEND_DB_MIN, db));

export type SeamCommand<A extends Record<string, unknown> = Record<string, unknown>> = {
  command: string;
  args: A;
};

// ── snapshot selectors ──────────────────────────────────────────────────────
export const busesOf = (s: Snapshot): Bus[] => s.buses ?? [];

export const returnStripsOf = (s: Snapshot): Track[] =>
  s.tracks.filter((t) => t.isReturn);

export const channelTracksOf = (s: Snapshot): Track[] =>
  s.tracks.filter((t) => !t.isReturn && !t.isGroup);

export const findSend = (track: Track, bus: number): Send | undefined =>
  (track.sends ?? []).find((s) => s.bus === bus);

// ── command builders (the only path to the seam) ────────────────────────────
export function addBusCommand(name?: string): SeamCommand {
  return { command: "create_bus", args: name ? { name } : {} };
}

export function addSendCommand(trackId: string, bus: number, db: number): SeamCommand<{ trackId: string; bus: number; db: number }> {
  return { command: "add_send", args: { trackId, bus, db: clampSendDb(db) } };
}

export function setSendLevelCommand(trackId: string, bus: number, db: number): SeamCommand<{ trackId: string; bus: number; db: number }> {
  return { command: "set_send_level", args: { trackId, bus, db: clampSendDb(db) } };
}

export function removeSendCommand(trackId: string, bus: number): SeamCommand<{ trackId: string; bus: number }> {
  return { command: "remove_send", args: { trackId, bus } };
}
