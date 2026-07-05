// WP-11 best-of-n serving policy (spec: docs/superpowers/specs/
// 2026-07-04-bestofn-serving-skeleton.md). Classification runs on the PARSED
// single-shot reply's command names (an exact finite-set lookup — never on the
// utterance, which would trade an observable skew for an unobservable NL error
// surface). Pure module: golden-tested, no bridge, no store.

import { AGENT_COMMANDS } from "./commands";
import type { AgentCommandCall } from "./executor";
import type { Snapshot } from "../types";

// Taste-relevant generative ops (program §5 Stage-2 item 3: populate, re-imagine
// parameters, arrangement) — where candidate diversity is worth ranking. Everything
// else is corrective: single-shot + validator-retry, latency-bound.
export const TASTE_COMMANDS = new Set<string>([
  // populate-class
  "add_note", "set_note", "quantize_notes",
  // re-imagine parameters
  "create_render_layer", "set_render_param", "render_layer",
  // arrangement
  "move_clip", "duplicate_clip", "trim_clip", "split_clip",
  "create_section", "move_section",
]);

/** taste ⇔ at least one taste command AND no destructive/corrective majority need:
 *  a mixed batch escalates only when taste ops dominate (≥ half) — a rename that
 *  happens to include one note tweak shouldn't burn 3 cloud draws. */
export function classifyCommands(calls: AgentCommandCall[]): "taste" | "corrective" {
  if (!calls.length) return "corrective";
  const taste = calls.reduce((n, c) => n + (TASTE_COMMANDS.has(c.command) ? 1 : 0), 0);
  return taste * 2 >= calls.length ? "taste" : "corrective";
}

// The compact id-manifest the scorer grounds against (the panel's answer to
// posting 3.7 MiB snapshots): just the live entity id sets.
export type IdManifest = {
  trackIds: string[]; clipIds: string[]; sectionIds: string[]; annotationIds: string[];
};

export function buildManifest(snap: Snapshot | null): IdManifest {
  const tracks = snap?.tracks ?? [];
  return {
    trackIds: tracks.map((t) => String(t.id)),
    clipIds: tracks.flatMap((t) => (t.clips ?? []).map((c) => String(c.id))),
    sectionIds: (snap?.sections ?? []).map((s) => String(s.id)),
    annotationIds: (snap?.annotations ?? []).map((a) => String(a.id)),
  };
}

// The catalog subset the scorer needs, serialized per-request from the ONE source
// of truth (commands.ts) — no committed copy to drift.
export function serializeCatalog(): { command: string; args: { name: string; type: string; required?: boolean }[] }[] {
  return AGENT_COMMANDS.map((c) => ({
    command: c.command,
    args: c.args.map((a) => ({ name: a.name, type: a.type, required: a.required !== false })),
  }));
}
