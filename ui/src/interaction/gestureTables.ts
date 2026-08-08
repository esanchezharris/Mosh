// DAW gesture-table presets. Each is a flat list of rules the resolver scores by
// specificity (see gestures.ts). Switching DAW = swapping the active table; a user
// can layer their own rule overrides on top later.
//
// Structural conventions:
//   • Mosh & FL treat the whole clip uniformly → rules target the "clip" ancestor
//     (depth 1); trim is the depth-2 "clip.edge".
//   • Ableton distinguishes header vs body → rules target "clip.header"/"clip.body"
//     (depth 2). (No depth-1 additive rules: region depth dominates modifier count,
//     so a depth-1 modifier rule could never out-rank a depth-2 region default.)
//   • The ruler transport surface (seek + shift-loop) is shared by every DAW.

import { EditorAction as A } from "./actions";
import type { GestureRule, GestureTable } from "./gestures";

// Seek on click, loop on shift-drag — identical across DAWs.
const RULER_RULES: GestureRule[] = [
  { region: "ruler", gesture: "click", action: A.SEEK },
  { region: "ruler", gesture: "drag", mods: { shift: true }, action: A.LOOP_REGION },
];

// ── Mosh — the current native behavior, expressed as the default table. Modal tools
// (split/range) ride along as tool-conditioned rules instead of hardcoded branches.
const MOSH: GestureTable = [
  // whole clip (header + body via the "clip" ancestor)
  { region: "clip", gesture: "click", action: A.SELECT },
  { region: "clip", gesture: "click", mods: { shift: true }, action: A.ADDITIVE_SELECT },
  { region: "clip", gesture: "click", mods: { meta: true }, action: A.ADDITIVE_SELECT },
  { region: "clip", gesture: "click", tool: "split", action: A.SPLIT },
  { region: "clip", gesture: "drag", action: A.MOVE },
  { region: "clip", gesture: "dblclick", action: A.OPEN },
  { region: "clip", gesture: "contextmenu", action: A.CONTEXT_MENU },
  // trim handles only bite in the move tool (matches the move-tool-only .trim divs);
  // in other tools the edge falls back to the clip's move/select behavior
  { region: "clip.edge", gesture: "drag", tool: "move", action: A.TRIM },
  // meta (⌘) + edge-drag time-STRETCHES instead of trimming (Ableton warp handle).
  // More specific than TRIM (same region/tool, +1 modifier) so it wins on ⌘-drag.
  { region: "clip.edge", gesture: "drag", tool: "move", mods: { meta: true }, action: A.STRETCH },
  // empty lanes
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  { region: "empty", gesture: "drag", tool: "range", action: A.TIME_SELECT },
  ...RULER_RULES,
];

// ── Ableton — header moves, body time-selects, edge trims. Empty-ground double-click
// creates a clip and opens its editor (Live 12, SPEC §8); the live shell's lanes are
// the executing surface.
const ABLETON: GestureTable = [
  { region: "clip.header", gesture: "click", action: A.SELECT },
  { region: "clip.header", gesture: "drag", action: A.MOVE },
  { region: "clip.body", gesture: "click", action: A.SELECT },
  { region: "clip.body", gesture: "drag", action: A.TIME_SELECT },
  { region: "clip.body", gesture: "dblclick", action: A.OPEN },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  { region: "empty", gesture: "dblclick", action: A.CREATE_CLIP },
  ...RULER_RULES,
];

// ── FL — the whole clip body drags to move (true pattern-painting is out of scope:
// the IR is linear). Edge trims; empty marquees.
const FL: GestureTable = [
  { region: "clip", gesture: "click", action: A.SELECT },
  { region: "clip", gesture: "drag", action: A.MOVE },
  { region: "clip", gesture: "dblclick", action: A.OPEN },
  { region: "clip", gesture: "contextmenu", action: A.CONTEXT_MENU },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  ...RULER_RULES,
];

// ── Pro Tools — the Smart Tool: top of clip = Grabber (move), lower = Selector
// (time-select), edges = Trim. Same shape as Ableton's header/body split.
const PROTOOLS: GestureTable = [
  { region: "clip.header", gesture: "click", action: A.SELECT },
  { region: "clip.header", gesture: "drag", action: A.MOVE },
  { region: "clip.body", gesture: "click", action: A.SELECT },
  { region: "clip.body", gesture: "drag", action: A.TIME_SELECT },
  { region: "clip.body", gesture: "dblclick", action: A.OPEN },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  ...RULER_RULES,
];

// ── Logic — the default Pointer tool: dragging a region moves it (whole clip).
// Marquee (Logic's range tool) is out of scope here. Edge trims; empty marquees.
const LOGIC: GestureTable = [
  { region: "clip", gesture: "click", action: A.SELECT },
  { region: "clip", gesture: "drag", action: A.MOVE },
  { region: "clip", gesture: "dblclick", action: A.OPEN },
  { region: "clip", gesture: "contextmenu", action: A.CONTEXT_MENU },
  { region: "clip.edge", gesture: "drag", action: A.TRIM },
  { region: "empty", gesture: "click", action: A.DESELECT },
  { region: "empty", gesture: "drag", action: A.MARQUEE },
  ...RULER_RULES,
];

export const GESTURE_TABLES: Record<string, GestureTable> = {
  mosh: MOSH,
  ableton: ABLETON,
  fl: FL,
  protools: PROTOOLS,
  logic: LOGIC,
};

export function getGestureTable(name: string): GestureTable {
  return GESTURE_TABLES[name] ?? GESTURE_TABLES.mosh;
}
