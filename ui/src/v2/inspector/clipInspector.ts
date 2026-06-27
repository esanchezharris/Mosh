// Pure model for the clip inspector (G4a). Given a selected clip, it reports which
// per-clip fields are editable and builds the exact MoshOps command descriptors for
// gain / mute / rename. Keeping this command-shaping in a pure helper (no React, no
// store) makes the contract unit-testable and keeps the one-mutation-path honest: the
// component just hands these descriptors to `exec`.
//
// Backend contract (src/moshops/MoshOps.cpp):
//   rename_clip    { clipId, name }              — any clip
//   set_clip_mute  { clipId, mute }              — any clip
//   set_clip_gain  { clipId, gainDb }            — WAVE/audio clips only; clamps [-48,24]

import type { Clip } from "../../types";

// Mirror the engine's clamp (ac->setGainDB(jlimit(-48, 24, …))) so the slider can't
// over-drive and the displayed value matches what the backend will store.
export const GAIN_MIN_DB = -48;
export const GAIN_MAX_DB = 24;

export type ClipCommand =
  | { command: "rename_clip"; args: { clipId: string; name: string } }
  | { command: "set_clip_mute"; args: { clipId: string; mute: boolean } }
  | { command: "set_clip_gain"; args: { clipId: string; gainDb: number } };

export interface ClipInspectorModel {
  clipId: string;
  name: string;
  muted: boolean;
  gainDb: number;
  canRename: boolean;
  canMute: boolean;
  canSetGain: boolean;
  rename: (name: string) => Extract<ClipCommand, { command: "rename_clip" }>;
  toggleMute: () => Extract<ClipCommand, { command: "set_clip_mute" }>;
  setMute: (mute: boolean) => Extract<ClipCommand, { command: "set_clip_mute" }>;
  setGain: (gainDb: number) => Extract<ClipCommand, { command: "set_clip_gain" }> | null;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function clipInspectorModel(clip: Clip): ClipInspectorModel {
  const clipId = clip.id;
  const muted = clip.mute ?? false;
  const gainDb = clip.gainDb ?? 0;
  // Gain is an audio-clip concept; set_clip_gain rejects non-audio clips.
  const canSetGain = clip.type === "wave";

  return {
    clipId,
    name: clip.name,
    muted,
    gainDb,
    canRename: true,
    canMute: true,
    canSetGain,
    rename: (name) => ({ command: "rename_clip", args: { clipId, name } }),
    setMute: (mute) => ({ command: "set_clip_mute", args: { clipId, mute } }),
    toggleMute: () => ({ command: "set_clip_mute", args: { clipId, mute: !muted } }),
    setGain: (db) =>
      canSetGain
        ? { command: "set_clip_gain", args: { clipId, gainDb: clamp(db, GAIN_MIN_DB, GAIN_MAX_DB) } }
        : null,
  };
}
