// Pure model for the drag-to-rearrange pad. The layout is an ORDERED list of tiles (iOS-icon
// style): dragging reorders the list and the grid reflows (tiles animate out of the way). The
// DOM/FLIP animation lives in main.ts; this module holds the order, spans, reorder, and
// persistence — all pure so vitest can pin the reflow behaviour.

import type { Button } from "./types";

export const TILES: Button[] = ["keep", "again", "hear", "marker", "record", "stop"];

export const SPAN: Record<Button, number> = { record: 1, keep: 1, again: 1, hear: 1, marker: 1, stop: 1 };

export const DEFAULT_ORDER: Button[] = ["keep", "again", "hear", "marker", "record", "stop"];

export type Layout = { order: Button[]; navPos: "top" | "bottom" };
export type LayoutMode = "mosh" | "ableton";

export const DEFAULT_LAYOUT: Layout = { order: [...DEFAULT_ORDER], navPos: "bottom" };

/** Keep exactly the known tiles: drop unknowns, append any missing, dedupe — a stale
 *  localStorage value can never drop a button or inject a bad one. */
export function sanitizeOrder(order: unknown): Button[] {
  const seen = new Set<Button>();
  const out: Button[] = [];
  if (Array.isArray(order))
    for (const v of order)
      if (TILES.includes(v as Button) && !seen.has(v as Button)) {
        seen.add(v as Button);
        out.push(v as Button);
      }
  for (const t of TILES) if (!seen.has(t)) out.push(t);
  return out;
}

/** Apply a saved layout to this mode's tiles. Hidden tiles are never appended. */
export function orderForTiles(layout: Layout, available: readonly Button[]): Button[] {
  const ordered = layout.order.filter((button) => available.includes(button));
  for (const button of available) if (!ordered.includes(button)) ordered.push(button);
  return ordered;
}

/** Move `id` to sit at `toIndex` in the order (clamped). Pure. */
export function moveInOrder(order: Button[], id: Button, toIndex: number): Button[] {
  const from = order.indexOf(id);
  if (from < 0) return order.slice();
  const next = order.slice();
  next.splice(from, 1);
  const to = Math.max(0, Math.min(next.length, toIndex));
  next.splice(to, 0, id);
  return next;
}

export function serialize(layout: Layout): string {
  return JSON.stringify({ order: layout.order, navPos: layout.navPos });
}

export function parse(raw: string | null): Layout {
  if (!raw) return { ...DEFAULT_LAYOUT, order: [...DEFAULT_ORDER] };
  try {
    const o = JSON.parse(raw) as Partial<Layout>;
    return {
      order: sanitizeOrder(o.order),
      navPos: o.navPos === "top" ? "top" : "bottom",
    };
  } catch {
    return { ...DEFAULT_LAYOUT, order: [...DEFAULT_ORDER] };
  }
}

const KEY = "moshCompanionLayout";

function keyForMode(mode: LayoutMode): string {
  return mode === "mosh" ? KEY : `${KEY}.ableton`;
}

export function load(storage: Pick<Storage, "getItem">, mode: LayoutMode = "mosh"): Layout {
  return parse(storage.getItem(keyForMode(mode)));
}

export function save(storage: Pick<Storage, "setItem">, layout: Layout, mode: LayoutMode = "mosh"): void {
  storage.setItem(keyForMode(mode), serialize(layout));
}
