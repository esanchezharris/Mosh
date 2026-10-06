// The soft clipper panel's maths: MoshSoftClipPlugin, exactly (research key "softclip").
//
// Per sample and per channel (MoshSoftClipPlugin.cpp:56-66): y = c·tanh(g·x/c), with
// g = 10^(drive/20) and c = 10^(ceiling/20). Its slope at 0 is g, so Drive is also gain:
// quiet input comes out `drive` dB louder; the output never reaches the ceiling. In dB the
// curve has one fixed shape that slides with (drive − ceiling):
//   out = ceiling + 20·log10(tanh(u)),  u = 10^((in + drive − ceiling)/20).
// The knee (where the two asymptotes meet, u = 1) is at in = ceiling − drive, and the
// output there is 2.37 dB under the ceiling. No oversampling: a sample peak, not true peak.
import type { Plugin } from "../../types";
import { clamp, fmtDb, param, physOf, type Range } from "./params";

export const DRIVE: Range = { min: 0, max: 24 };
export const CEILING: Range = { min: -12, max: 0 };
export const DRIVE_DEFAULT_DB = 6;
export const CEILING_DEFAULT_DB = -0.5;
/** The plot's input axis keeps the knee on screen at every setting (it spans -36..0). */
export const IN_LO = -36, IN_HI = 6, OUT_LO = -36, OUT_HI = 0;

export type ClipSettings = { driveDb: number; ceilDb: number };

export function clipSettings(plugin: Plugin): ClipSettings {
  return { driveDb: physOf(param(plugin, 0), DRIVE), ceilDb: physOf(param(plugin, 1), CEILING) };
}

/** u: how far into the curve an input level is (1 at the knee). */
const uOf = (inDb: number, driveDb: number, ceilDb: number): number => 10 ** ((inDb + driveDb - ceilDb) / 20);

/** The output level (dBFS) for an input level (dBFS). */
export function clipOutDb(inDb: number, driveDb: number, ceilDb: number): number {
  const t = Math.tanh(uOf(inDb, driveDb, ceilDb));
  return ceilDb + 20 * Math.log10(Math.max(t, 1e-300));
}

/** How hard it is clipping: the reduction (dB, ≥ 0) against the driven but unclipped
 *  signal, 20·log10(u / tanh u). 0 for quiet input, 2.37 dB at the knee. */
export function clipGrDb(inDb: number, driveDb: number, ceilDb: number): number {
  const u = uOf(inDb, driveDb, ceilDb);
  if (u < 1e-4) return 20 * Math.log10(1 + (u * u) / 3);
  return 20 * Math.log10(u / Math.tanh(u));
}

export const kneeInDb = (driveDb: number, ceilDb: number): number => ceilDb - driveDb;

/** The settings that put the knee at (`kneeIn`, `ceilDb`): the ceiling is the knee's
 *  height, the drive is the ceiling minus the knee's input level. Both are rounded to
 *  0.1 dB and clamped (the ceiling first, so the drive follows the ceiling it really got).
 *  The knee handle's pointer drag and its arrow keys both go through this, so moving the
 *  knee up by pointer or by key sends the same pair. */
export function kneeTo(kneeIn: number, ceilDb: number): ClipSettings {
  const r = (v: number) => Math.round(v * 10) / 10;
  const ceil = clamp(r(ceilDb), CEILING.min, CEILING.max);
  return { driveDb: clamp(r(ceil - kneeIn), DRIVE.min, DRIVE.max), ceilDb: ceil };
}

/** The input level where the reduction reaches `grDb` (bisection on the monotonic
 *  u/tanh u), relative to the knee. ~1 dB of reduction starts 4.2 dB under the knee. */
export function grOnsetBelowKneeDb(grDb = 1): number {
  const target = 10 ** (grDb / 20);
  let lo = 1e-4, hi = 50;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (mid / Math.tanh(mid) < target) lo = mid; else hi = mid;
  }
  return 20 * Math.log10((lo + hi) / 2);
}
/** Computed once: where the shaded "clipping" zone starts, in dB from the knee. */
export const CLIP_ZONE_FROM_KNEE_DB = grOnsetBelowKneeDb(1);

/** "-0.5 dBFS". */
export const fmtDbfs = (db: number): string => `${(Math.round(db * 10) / 10 || 0).toFixed(1)} dBFS`;

/** The minimized line: "drive +6.0 dB · ceiling -0.5 dBFS". */
export function clipSummary(plugin: Plugin): string {
  const s = clipSettings(plugin);
  return `drive ${fmtDb(s.driveDb)} · ceiling ${fmtDbfs(s.ceilDb)}`;
}

/** The honest one-liner under the plot: drive is gain, and where the knee sits. */
export function clipHint(s: ClipSettings): string {
  return `knee ${fmtDbfs(kneeInDb(s.driveDb, s.ceilDb))} · quiet input ${fmtDb(s.driveDb)}`;
}
