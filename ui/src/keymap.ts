// The logical action vocabulary shared by the menus (native macOS menu bar + the
// WebView File menu) and their single dispatcher (menuActions.runAction). The live
// keyboard/gesture resolution layer lives in interaction/keymap.ts; this file is
// just the id enum menuActions maps to MoshOps command(s).

/** Every logical action a menu item or shortcut can trigger. `menuActions.runAction`
 *  is the single dispatcher that maps each id → its MoshOps command(s). */
export type ActionId =
  | "new_project" | "open_project" | "open_recent" | "save" | "save_as" | "export_audio"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "delete"
  | "play_pause" | "record" | "to_start" | "to_end"
  | "duplicate" | "group" | "split"
  | "tool_move" | "tool_split" | "tool_range"
  | "seek" | "loop_region";
