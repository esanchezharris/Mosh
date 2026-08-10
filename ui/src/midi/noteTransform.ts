// Pure note-transform logic for the mock's transform_notes case — the TS mirror
// of MoshOps::cmdTransformNotes (Live 12's Transform tools row: Reverse / Invert /
// Legato / Humanize / ×2 / /2). The deterministic modes work inside the TARGETS'
// own span (min start … max end), so a selection transforms within the
// selection's span. Humanize randomness is deterministic-seeded from the same
// canonical payload the engine uses (mode|clipId, amount, each target's
// pitch/velocity/start) — the mock and the engine are separate environments, so
// byte-identical STREAMS are not required; replay determinism within each is
// (the velocityTransform.ts contract).

import { splitmix64 } from "./velocityTransform";
import { resolveKey, scaleMask, snapToScale } from "../musicalKey";

export type NoteTransformMode =
  | "reverse" | "invert" | "legato" | "humanize" | "x2" | "d2"
  | "setLength" | "addInterval" | "fitToScale";
export type NoteTransformTarget = { start: number; length: number; pitch: number; velocity: number };
export type NoteTransformResult = NoteTransformTarget;

/** FNV-1a 64-bit over the same canonical payload the engine seeds humanize from. */
export function noteSeed(
  mode: string,
  clipId: string,
  amount: number,
  targets: readonly NoteTransformTarget[],
): bigint {
  let h = 1469598103934665603n;
  const M = (1n << 64n) - 1n;
  const mix = (v: bigint) => { h ^= v & M; h = (h * 1099511628211n) & M; };
  for (const c of `${mode}|${clipId}`) mix(BigInt(c.codePointAt(0)!));
  mix(BigInt(amount));
  for (const n of targets) {
    mix(BigInt(n.pitch));
    mix(BigInt(n.velocity));
    mix(BigInt(Math.round(n.start * 1e6)));
  }
  return h;
}

/** The new {start, length, pitch, velocity} for every target, in input order —
 *  EXCEPT addInterval, which returns the chord tones to ADD (source notes are
 *  never mutated; a tone that would stack on an existing pitch at the same
 *  start — from `opts.clipNotes` or an earlier addition — is skipped). */
export function transformNotes(
  targets: readonly NoteTransformTarget[],
  mode: NoteTransformMode,
  opts: {
    amount?: number; clipId?: string;
    lengthBeats?: number;                    // setLength (validated > 0 by the caller)
    semitones?: number;                      // addInterval (signed)
    key?: { tonic?: string; mode?: string }; // fitToScale — the session key (A-minor default)
    clipNotes?: readonly { start: number; pitch: number }[];   // addInterval dupe-skip domain
  } = {},
): NoteTransformResult[] {
  const amount = Math.max(0, Math.min(100, Math.round(opts.amount ?? 0)));

  if (mode === "setLength")
    return targets.map((t) => ({ ...t, length: Math.max(1e-4, opts.lengthBeats ?? t.length) }));

  if (mode === "addInterval") {
    const semis = Math.round(opts.semitones ?? 0);
    const sounding = new Set((opts.clipNotes ?? targets).map((n) => `${n.start}|${n.pitch}`));
    const out: NoteTransformResult[] = [];
    for (const t of targets) {
      const cand = Math.max(0, Math.min(127, t.pitch + semis));
      const key = `${t.start}|${cand}`;
      if (cand !== t.pitch && !sounding.has(key)) {
        sounding.add(key);
        out.push({ start: t.start, length: t.length, pitch: cand, velocity: t.velocity });
      }
    }
    return out;
  }

  if (mode === "fitToScale") {
    // The session key's mask; snapToScale is musicalKey.ts's own (nearest in-scale,
    // ties DOWNWARD) — the engine ports the same algorithm against the same tables.
    const mask = scaleMask(resolveKey(opts.key));
    return targets.map((t) => ({ ...t, pitch: snapToScale(t.pitch, mask) }));
  }
  let spanStart = Infinity, spanEnd = 0, topPitch = 0;
  for (const t of targets) {
    spanStart = Math.min(spanStart, t.start);
    spanEnd = Math.max(spanEnd, t.start + t.length);
    topPitch = Math.max(topPitch, t.pitch);
  }

  if (mode === "humanize") {
    const maxTimeDev = (amount / 100) * 0.25;   // ±amount% of a 16th at 4/4
    const rand = splitmix64(noteSeed(mode, opts.clipId ?? "", amount, targets));
    return targets.map((t) => ({
      start: Math.max(0, t.start + (rand() * 2 - 1) * maxTimeDev),
      length: t.length,
      pitch: t.pitch,
      velocity: Math.max(1, Math.min(127, t.velocity + Math.round((rand() * 2 - 1) * amount))),
    }));
  }

  // Legato's next-onset map: each distinct start extends to the NEXT distinct
  // start; the last group extends to the span end (chords share the onset, so no
  // note collapses to zero length).
  const onsets: number[] = [];
  if (mode === "legato") {
    const starts = targets.map((t) => t.start).sort((a, b) => a - b);
    for (const s of starts)
      if (onsets.length === 0 || s > onsets[onsets.length - 1] + 1e-9) onsets.push(s);
  }
  const legatoEnd = (start: number) => onsets.find((o) => o > start + 1e-9) ?? spanEnd;

  return targets.map((t) => {
    switch (mode) {
      case "reverse":
        return { ...t, start: spanStart + (spanEnd - (t.start + t.length)) };
      case "invert":
        return { ...t, pitch: Math.max(0, Math.min(127, 2 * topPitch - t.pitch)) };
      case "legato":
        return { ...t, length: Math.max(1e-4, legatoEnd(t.start) - t.start) };
      case "x2":
        return { ...t, start: spanStart + 2 * (t.start - spanStart), length: 2 * t.length };
      case "d2":
        return { ...t, start: spanStart + 0.5 * (t.start - spanStart), length: 0.5 * t.length };
    }
  });
}
