// Pure layout engine for the Phase-6 dock shell. Geometry ONLY — no React, no
// store, no DOM, no seam. This is the novel/risky core of the "actual leap"
// (resize redistribution + floating-window drag/resize), built and unit-tested
// ahead of the component so that when Phases 2–5 land, the DockShell component and
// the Phase-4 template wiring just consume these functions.
//
// Two layout primitives:
//   • fixed ZONES — left / center / bottom, separated by draggable dividers. A
//     divider drag trades pixels between two adjacent zones, each clamped to its
//     [min, max]. Zones collapse/expand, remembering their prior size.
//   • floating WINDOWS — free panels dragged/resized within the workspace bounds,
//     each with a minimum size; always kept fully on-screen.
//
// Everything is pure: each function returns a NEW object, never mutating inputs,
// so it drops straight into React state / a Zustand slice later.

export interface Zone {
  id: string;
  size: number;          // px along the zone's axis (width for left, height for bottom)
  min: number;
  max: number;
  collapsed?: boolean;
  prevSize?: number;     // size to restore on expand
}

export interface FloatWin {
  id: string;
  x: number; y: number;  // top-left, in workspace coords
  w: number; h: number;
  minW: number; minH: number;
}

export interface Bounds { w: number; h: number; }
export type ResizeEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── fixed zones ──────────────────────────────────────────────────────────────

/**
 * Divider drag between two adjacent zones. Positive `deltaPx` grows `a` and
 * shrinks `b`; the applied delta is limited so NEITHER zone leaves its [min,max]
 * range (the divider simply stops at the first wall it hits).
 */
export function resizeBetween(a: Zone, b: Zone, deltaPx: number): [Zone, Zone] {
  let d = deltaPx;
  if (d > 0) d = Math.min(d, a.max - a.size, b.size - b.min);
  else d = -Math.min(-d, a.size - a.min, b.max - b.size);
  return [{ ...a, size: a.size + d }, { ...b, size: b.size - d }];
}

/**
 * Resize a single zone by `deltaPx`, clamped to its [min,max]. Used when a zone
 * resizes against a flex-fill sibling (e.g. the bottom dock vs. the arrangement):
 * there's no second fixed zone to trade with, so we just clamp this one.
 */
export function resizeZone(z: Zone, deltaPx: number): Zone {
  return { ...z, size: clamp(z.size + deltaPx, z.min, z.max) };
}

export function collapseZone(z: Zone, collapsedSize = 0): Zone {
  if (z.collapsed) return z;
  return { ...z, collapsed: true, prevSize: z.size, size: collapsedSize };
}

export function expandZone(z: Zone): Zone {
  if (!z.collapsed) return z;
  return { ...z, collapsed: false, size: clamp(z.prevSize ?? z.min, z.min, z.max), prevSize: undefined };
}

export function toggleZone(z: Zone, collapsedSize = 0): Zone {
  return z.collapsed ? expandZone(z) : collapseZone(z, collapsedSize);
}

// ── floating windows ─────────────────────────────────────────────────────────

/** Keep a window fully on-screen and no smaller than its minimum. */
export function clampWindow(win: FloatWin, b: Bounds): FloatWin {
  const w = clamp(win.w, win.minW, Math.max(win.minW, b.w));
  const h = clamp(win.h, win.minH, Math.max(win.minH, b.h));
  const x = clamp(win.x, 0, Math.max(0, b.w - w));
  const y = clamp(win.y, 0, Math.max(0, b.h - h));
  return { ...win, x, y, w, h };
}

export function moveWindow(win: FloatWin, dx: number, dy: number, b: Bounds): FloatWin {
  return clampWindow({ ...win, x: win.x + dx, y: win.y + dy }, b);
}

/**
 * Resize from one edge/corner. The OPPOSITE edge stays anchored, the minimum
 * size is enforced, and the result is clamped to the workspace.
 */
export function resizeWindow(win: FloatWin, edge: ResizeEdge, dx: number, dy: number, b: Bounds): FloatWin {
  let { x, y, w, h } = win;
  const east = win.x + win.w, south = win.y + win.h;
  if (edge.includes("e")) w = Math.max(win.minW, win.w + dx);
  if (edge.includes("w")) { w = Math.max(win.minW, win.w - dx); x = east - w; }
  if (edge.includes("s")) h = Math.max(win.minH, win.h + dy);
  if (edge.includes("n")) { h = Math.max(win.minH, win.h - dy); y = south - h; }
  return clampWindow({ ...win, x, y, w, h }, b);
}

/** Z-order helper: move `id` to the end (top) of the order list. */
export function bringToFront(order: string[], id: string): string[] {
  return [...order.filter((x) => x !== id), id];
}

// ── layout presets (data only) ───────────────────────────────────────────────
// The Phase-4 template layer maps a template name → one of these. mosh/ableton
// are fixed-zone; fl adds a floating drum-sequencer window over the workspace.

export type LayoutName = "mosh" | "ableton" | "fl";
export interface DockLayout {
  zones: { left: Zone; center: Zone; bottom: Zone };
  floats: FloatWin[];
}

export function presetLayout(name: LayoutName): DockLayout {
  const base = (): DockLayout["zones"] => ({
    left: { id: "browser", size: 260, min: 180, max: 460 },
    center: { id: "arrange", size: 0, min: 320, max: Number.MAX_SAFE_INTEGER }, // flexes to fill
    bottom: { id: "detail", size: 200, min: 120, max: 520 },
  });

  if (name === "ableton") {
    const zones = base();
    zones.left.size = 220;
    zones.bottom.size = 240;
    return { zones, floats: [] };
  }
  if (name === "fl") {
    return {
      zones: base(),
      floats: [{ id: "drum-seq", x: 96, y: 132, w: 600, h: 340, minW: 380, minH: 240 }],
    };
  }
  return { zones: base(), floats: [] }; // mosh (house default)
}
