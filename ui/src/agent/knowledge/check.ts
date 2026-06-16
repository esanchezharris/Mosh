// A declarative, SERIALIZABLE conformance check for a recipe card. The seed cards used a
// JS closure for `check` (script-local) — fine for hand-authored cards, but an LLM or a
// YouTube miner can only emit DATA, not a closure. A CheckSpec encodes WHICH conformance
// reader to run + its target, with every session ref a `$token` (resolved against the
// card's bindings exactly like a command arg), so a candidate card from ANY source is
// fully runnable + re-validatable through the same loop. Pure + browser-safe (the product
// imports card.ts, which references CheckSpec).
import type { MidiNote } from "../../types";
import { resolveValue } from "./recipe";
import {
  patternConformance, swingConformance, humanizeConformance, automationConformance, sendConformance,
  type ConformanceResult, type PatternSpec,
} from "./conformance";

// A session-ref: the exact string "$name" (→ bindings[name]) or a literal number/id.
type Ref = string | number;

export type CheckSpec =
  | { kind: "pattern"; clip: Ref; pattern: PatternSpec; tol?: number }
  | { kind: "swing"; clip: Ref; division: number; swing: number; tol?: number }
  | { kind: "humanize"; clip: Ref; maxOffsetBeats: number }
  | { kind: "automation"; track: Ref; pluginIndex: Ref; paramIndex: Ref; direction: "up" | "down"; minPoints?: number }
  | { kind: "send"; track: Ref; bus: Ref; db?: number; tol?: number };

export const CHECK_KINDS = ["pattern", "swing", "humanize", "automation", "send"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

// ── snapshot slice accessors (the conformance substrate; shared with the loop) ──────
export function clipNotes(snap: any, clipId: string): MidiNote[] {
  for (const t of snap?.tracks || []) for (const c of t.clips || []) if (c.id === clipId) return c.notes || [];
  return [];
}
export function findTrack(snap: any, trackId: string): any {
  return (snap?.tracks || []).find((t: any) => t.id === trackId);
}
export function findParam(snap: any, trackId: string, pluginIndex: number, paramIndex: number): any {
  const p = (findTrack(snap, trackId)?.plugins || []).find((x: any) => x.index === pluginIndex);
  return (p?.params || []).find((x: any) => x.index === paramIndex);
}

// Run a declarative check against the before/after snapshots. `bindings` are the base
// arrangement's $token table; `runtime` are ids captured mid-recipe (e.g. create_bus →
// busNumber). Base wins on a name collision — the same precedence applyRecipe uses.
export function runCheck(
  spec: CheckSpec,
  before: any,
  after: any,
  bindings: Record<string, unknown>,
  runtime: Record<string, unknown> = {},
): ConformanceResult {
  const scope = { ...runtime, ...bindings };
  const str = (r: Ref): string => String(resolveValue(r, scope));
  const num = (r: Ref): number => Number(resolveValue(r, scope));

  switch (spec.kind) {
    case "pattern":
      return patternConformance(clipNotes(after, str(spec.clip)), spec.pattern, spec.tol);
    case "swing":
      return swingConformance(clipNotes(after, str(spec.clip)), { division: spec.division, swing: spec.swing, tol: spec.tol });
    case "humanize": {
      const clip = str(spec.clip);
      return humanizeConformance(clipNotes(before, clip), clipNotes(after, clip), { maxOffsetBeats: spec.maxOffsetBeats });
    }
    case "automation": {
      const track = str(spec.track), pi = num(spec.pluginIndex), ri = num(spec.paramIndex);
      const param = findParam(after, track, pi, ri);
      if (!param) return { conformant: false, detail: `automation: no param ${track}/${pi}/${ri}` };
      return automationConformance(param, { direction: spec.direction, minPoints: spec.minPoints });
    }
    case "send": {
      const track = str(spec.track);
      const trk = findTrack(after, track);
      if (!trk) return { conformant: false, detail: `send: no track ${track}` };
      return sendConformance(trk, { bus: num(spec.bus), db: spec.db, tol: spec.tol });
    }
  }
}
