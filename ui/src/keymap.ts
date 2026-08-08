// The logical action vocabulary shared by the menus (native macOS menu bar + the
// WebView File menu) and their single dispatcher (menuActions.runAction). The live
// keyboard/gesture resolution layer lives in interaction/keymap.ts; this file is
// just the id enum menuActions maps to MoshOps command(s).

/** Every logical action a menu item or shortcut can trigger. `menuActions.runAction`
 *  is the single dispatcher that maps each id → its MoshOps command(s). */
export type ActionId =
  | "new_project" | "open_project" | "open_recent" | "save" | "save_as" | "export_audio"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "delete"
  | "play_pause" | "continue_play" | "record" | "capture_midi" | "to_start" | "to_end"
  | "duplicate" | "group" | "split"
  | "nudge_left" | "nudge_right" | "nudge_up" | "nudge_down"
  | "tool_move" | "tool_split" | "tool_range"
  | "seek" | "loop_region"
  // Live-12 arrangement keys (SPEC §8; bound in the ableton keymap preset)
  | "loop_toggle" | "deactivate" | "snap_toggle"
  | "zoom_in" | "zoom_out" | "zoom_to_selection" | "grid_narrow" | "grid_widen"
  // Wave 0 (menus.json): creation + selection + quantize
  | "select_loop" | "quantize" | "select_all" | "invert_selection"
  | "insert_audio_track" | "insert_midi_track" | "insert_midi_clip"
  | "consolidate" | "grid_triplet"
  // Crop Clip wave: ⇧⌘J trims the selected clips to the time selection
  | "crop_clip"
  // Bounce wave: ⌘B bounces the selected track to a new track
  | "bounce_track"
  // Freeze wave: ⌥⇧⌘F freezes/unfreezes the selected track (toggle)
  | "freeze_track"
  // Settings-overlay wave: ⌘, opens the live shell's Settings overlay
  | "settings"
  // Keymap-audit wave: cross-track nudge, ungroup, insert silence, create fade
  | "ungroup" | "insert_silence" | "create_fade"
  | "felt_wrong";
