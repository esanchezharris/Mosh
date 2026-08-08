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
  // Empty-lane double-click → create a clip there and open its editor (Live 12,
  // SPEC §8). Bound in the ableton table only; the live shell's lanes execute it.
  CREATE_CLIP: "create_clip",

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
  CONTINUE_PLAY: "continue_play",  // ⇧Space — Live's Continue Playback: play from current; the stop leaves the playhead
  RECORD: "record",
  // REC-001 — Ableton's Capture MIDI. Transport-adjacent but the opposite direction in
  // time: RECORD decides what happens next, CAPTURE_MIDI rescues what already happened.
  CAPTURE_MIDI: "capture_midi",
  TO_START: "to_start",
  TO_END: "to_end",

  // keyboard — tools (modal)
  TOOL_MOVE: "tool_move",
  TOOL_SPLIT: "tool_split",
  TOOL_RANGE: "tool_range",

  // keyboard — Live-12 arrangement vocabulary (docs/live-clone/SPEC.md §8). Bound
  // per-preset (the ableton keymap); the handlers live in menuActions/useKeyboard-
  // Shortcuts and the live shell, never in ad-hoc key checks.
  RENAME: "rename",              // ⌘R — rename the selected clip (live: inline on the lane)
  DEACTIVATE: "deactivate",      // 0 / ⌘0 — mute/unmute the selected clip(s) (notes: the editor's own layer)
  LOOP_TOGGLE: "loop_toggle",    // ⌘L — loop the time selection, else toggle the loop
  SNAP_TOGGLE: "snap_toggle",    // ⌘4 — arrangement snap on/off
  ZOOM_IN: "zoom_in",            // ⌘+ — arrangement horizontal zoom
  ZOOM_OUT: "zoom_out",          // ⌘−
  ZOOM_BACK: "zoom_back",        // X — pop the zoom history (Live's real Zoom Back)
  ZOOM_TO_SELECTION: "zoom_to_selection",  // Z — zoom to the time selection, else fit content
  GRID_NARROW: "grid_narrow",    // ⌘1 — finer arrangement grid division
  GRID_WIDEN: "grid_widen",      // ⌘2 — coarser
  GRID_TRIPLET: "grid_triplet",  // ⌘3 — triplet arrangement grid (2/3 steps)
  // Wave 0 (menus.json ground truth — Live 12's complete menu tree):
  SELECT_LOOP: "select_loop",            // ⇧⌘L — draw the loop range as a time selection
  QUANTIZE: "quantize",                  // ⌘U — quantize the selected clips' notes to the grid
  SELECT_ALL: "select_all",              // ⌘A — select every clip (arrangement scope)
  INVERT_SELECTION: "invert_selection",  // ⇧⌘A
  INSERT_AUDIO_TRACK: "insert_audio_track",  // ⌘T
  INSERT_MIDI_TRACK: "insert_midi_track",    // ⇧⌘T
  INSERT_MIDI_CLIP: "insert_midi_clip",      // ⇧⌘M — over the time selection, else at the playhead
  NUDGE_UP: "nudge_up",                  // ↑ — move the selected clip(s) to the track above
  NUDGE_DOWN: "nudge_down",              // ↓ — to the track below
  UNGROUP: "ungroup",                    // ⇧⌘G — unwrap the group containing the selected track
  INSERT_SILENCE: "insert_silence",      // ⌘I — insert_time over the time selection, else 1 bar at the playhead
  CREATE_FADE: "create_fade",            // ⌥⌘F — Live's default edge fade on selected audio clips
  CONSOLIDATE: "consolidate",    // ⌘J — merge the selected MIDI clips (consolidate_clips; audio refused by the engine)
  CROP: "crop_clip",             // ⇧⌘J — trim the selected clips to the time selection (arrangement-context only)
  BOUNCE: "bounce_track",          // ⌘B — bounce the selected track to a new track (offline render)
  FREEZE_TRACK: "freeze_track",    // ⌥⇧⌘F — freeze/unfreeze the selected track (toggle, Live's same-key unfreeze)
  FIND: "find",                  // ⌘F — focus the browser search (surface: the live shell)
  EXPAND_CLIP: "expand_clip",    // ⌥⌘E — Expanded Clip View (surface: the live shell's dock)
  AUTOMATION_VIEW: "automation_view",  // A — Live's Automation Mode (the top-bar view toggle; lanes are a later wave)
  SETTINGS: "settings",            // ⌘, — Live's Preferences (macOS standard): the live shell's settings overlay

  // keyboard — taste loop (workshop 2026-07-19): "this passed but FEELS wrong" →
  // capture tag + command-diff + snapshot into the felt-wrong archive lane.
  FELT_WRONG: "felt_wrong",
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
