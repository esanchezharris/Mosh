// The editor's ACTION vocabulary — the shared alphabet both resolvers speak.
//
// A keymap maps {action: keyCombo}; a gesture table maps (region × gesture × modifier)
// → action. Both draw from this one set, so a binding ("Mod+Z" / "drag on clip.header")
// always resolves to a member of EditorAction, which the Arrange handlers then execute.
// This is UI-local interaction config; it never crosses the bridge.

// const-object enum (matches the codebase's string-union idiom, e.g. Tool). The string
// VALUES are persisted in templates/localStorage, so they must stay stable + unique.
export const EditorAction = {
  NONE: "none",

  // pointer — selection / structure
  SELECT: "select",
  ADDITIVE_SELECT: "additive_select",
  DESELECT: "deselect",
  MOVE: "move",
  TRIM: "trim",
  STRETCH: "stretch", // meta+edge-drag on a wave clip: time-stretch (warp) instead of trim
  TIME_SELECT: "time_select",
  MARQUEE: "marquee",
  SPLIT: "split",
  OPEN: "open",
  PAINT: "paint",
  CONTEXT_MENU: "context_menu",

  // pointer — transport surface (ruler)
  SEEK: "seek",
  LOOP_REGION: "loop_region",

  // keyboard — edit
  DELETE: "delete",
  COPY: "copy",
  CUT: "cut",
  PASTE: "paste",
  DUPLICATE: "duplicate",
  UNDO: "undo",
  REDO: "redo",
  SAVE: "save",
  GROUP: "group",
  // FU-CLIP-NUDGE — fine-move the selected clip(s) by a fixed increment,
  // independent of drag/snap (see interaction/keymap.ts for the binding).
  NUDGE_LEFT: "nudge_left",
  NUDGE_RIGHT: "nudge_right",

  // keyboard — transport
  PLAY_PAUSE: "play_pause",
  RECORD: "record",
  TO_START: "to_start",
  TO_END: "to_end",

  // keyboard — tools (modal)
  TOOL_MOVE: "tool_move",
  TOOL_SPLIT: "tool_split",
  TOOL_RANGE: "tool_range",
} as const;

export type EditorAction = (typeof EditorAction)[keyof typeof EditorAction];

// ── Regions: formalised zones on the existing DOM. Dotted names form a hierarchy
// (clip.header is a child of clip), which the gesture resolver uses for CSS-like
// cascade: a rule on "clip" applies to "clip.header" as a less-specific fallback.
export type Region = string; // open string — rules may target ancestors ("clip", "*")

// ── Gestures: discrete pointer/key interactions the table is keyed by.
export type Gesture = "click" | "drag" | "dblclick" | "contextmenu";

// ── Modifier state at the moment of a gesture (platform Mod folded by the caller).
export interface Mods {
  shift?: boolean;
  alt?: boolean;
  meta?: boolean; // Cmd (macOS)
  ctrl?: boolean;
}

// ── Modal tool (Mosh keeps move/split/range). An optional resolution condition: a
// gesture rule may require a tool, letting the Mosh table express tool-modal behavior
// without hardcoded branches. Ableton/FL tables simply don't constrain on tool.
export type Tool = "move" | "split" | "range";
