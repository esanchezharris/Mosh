// The gesture resolver — the precedence-critical core of the configurable editor.
//
// Interaction is modelled as (region × gesture × modifier [× tool]) → action and
// resolved with CSS-like specificity so a DAW preset (or a user override) can be a
// flat table of rules instead of nested if/else branches. The comparison is a TOTAL
// order, so the outcome of any context is always unambiguous — including the
// shift+drag-on-header case the spec calls out.
//
// Specificity (compared descending, lexicographically):
//   [ regionDepth , toolConditioned , modifierCount ]
// region dominates (most-specific region wins), then a tool condition (the modal
// tool is a strong mode — split/range must beat a bare modifier on the same region),
// then modifier count (region default is the 0-modifier rule); ties fall to source
// order. Tool ranks above modifiers so e.g. split-tool + shift-click still SPLITs.

import type { EditorAction, Gesture, Mods, Region, Tool } from "./actions";

export interface GestureRule {
  region: Region; // exact zone, an ancestor ("clip"), or "*" (any)
  gesture: Gesture;
  mods?: Mods; // REQUIRED modifiers (true = must be held); unlisted = don't-care
  tool?: Tool; // optional: only applies when this modal tool is active (Mosh)
  action: EditorAction;
}

export type GestureTable = GestureRule[];

export interface GestureContext {
  region: Region; // the concrete zone hit, e.g. "clip.header"
  gesture: Gesture;
  mods: Mods;
  tool?: Tool;
}

const MOD_KEYS = ["shift", "alt", "meta", "ctrl"] as const;

// Depth = dotted-segment count; "*" is the rootless wildcard at depth 0.
export function regionDepth(region: Region): number {
  return region === "*" ? 0 : region.split(".").length;
}

// A rule region matches a ctx region if it is the same, an ancestor at a dot
// boundary ("clip" matches "clip.header" but not "clipper"), or the "*" wildcard.
export function regionMatches(ruleRegion: Region, ctxRegion: Region): boolean {
  if (ruleRegion === "*" || ruleRegion === ctxRegion) return true;
  return ctxRegion.startsWith(ruleRegion + ".");
}

function modsRequired(mods?: Mods): number {
  if (!mods) return 0;
  return MOD_KEYS.reduce((n, k) => n + (mods[k] ? 1 : 0), 0);
}

// Every required modifier must be held; extras in ctx are ignored (don't-care).
function modsSatisfied(rule: Mods | undefined, ctx: Mods): boolean {
  if (!rule) return true;
  return MOD_KEYS.every((k) => (rule[k] ? !!ctx[k] : true));
}

function matches(rule: GestureRule, c: GestureContext): boolean {
  if (rule.gesture !== c.gesture) return false;
  if (!regionMatches(rule.region, c.region)) return false;
  if (!modsSatisfied(rule.mods, c.mods)) return false;
  if (rule.tool !== undefined && rule.tool !== c.tool) return false;
  return true;
}

// Compare specificity of `a` vs `b`: >0 means a is more specific.
function moreSpecific(a: GestureRule, b: GestureRule): number {
  const da = regionDepth(a.region), db = regionDepth(b.region);
  if (da !== db) return da - db;
  const ta = a.tool !== undefined ? 1 : 0, tb = b.tool !== undefined ? 1 : 0;
  if (ta !== tb) return ta - tb; // a modal-tool condition beats a bare modifier rule
  const ma = modsRequired(a.mods), mb = modsRequired(b.mods);
  return ma - mb;
}

// Resolve a context to an action via the table, or null if nothing matches. The
// winner is the most specific matching rule; ties break to the earliest in the table.
export function resolveGesture(table: GestureTable, c: GestureContext): EditorAction | null {
  let bestIdx = -1;
  for (let i = 0; i < table.length; i++) {
    if (!matches(table[i], c)) continue;
    if (bestIdx === -1 || moreSpecific(table[i], table[bestIdx]) > 0) bestIdx = i;
    // strictly-greater keeps the earliest rule on a tie (stable source order)
  }
  return bestIdx === -1 ? null : table[bestIdx].action;
}
