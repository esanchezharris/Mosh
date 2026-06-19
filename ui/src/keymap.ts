// The single keyboard-shortcut registry (CTL-002 consolidation). One data-driven
// keymap drives BOTH the web keydown layer (useKeyboardShortcuts) and the menus
// (native macOS menu bar + the WebView File menu), so there is exactly ONE place
// that says "this chord → this action". Phase 5 makes this keymap user-editable:
// keep it pure data + a pure matcher so a loaded keymap can replace DEFAULT_KEYMAP
// without touching any handler.
//
// Double-fire contract: in the packaged app a real NSMenu owns its accelerators.
// Entries flagged `nativeMenuOwned` are YIELDED by the web keydown layer when a
// native menu is present (see useKeyboardShortcuts) so the menu fires them exactly
// once; in Vite dev (no native menu) the web layer owns everything.

/** Every logical action a menu item or shortcut can trigger. `menuActions.runAction`
 *  is the single dispatcher that maps each id → its MoshOps command(s). */
export type ActionId =
  | "new_project" | "open_project" | "save" | "save_as" | "export_audio"
  | "undo" | "redo" | "cut" | "copy" | "paste" | "delete"
  | "play_pause";

export interface KeyChord {
  /** Matched case-insensitively against KeyboardEvent.key (e.g. "s", "Delete"). */
  key?: string;
  /** Matched against KeyboardEvent.code (e.g. "Space"). Wins over `key` when set. */
  code?: string;
  /** true → require Cmd/Ctrl; falsy → require NO Cmd/Ctrl. */
  mod?: boolean;
  /** true → require Shift; false → require no Shift; undefined → don't care. */
  shift?: boolean;
}

export interface ShortcutDef {
  id: ActionId;
  chord: KeyChord;
  group: "file" | "edit" | "transport";
  /** In the native app a real menu owns this accelerator; the web layer yields it. */
  nativeMenuOwned: boolean;
  /** Skip while a text field / contentEditable is focused. Defaults to true. */
  guardEditable?: boolean;
}

/** The subset of KeyboardEvent the pure matcher reads (so it is unit-testable). */
export interface KeyEventLike {
  key: string;
  code?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export const DEFAULT_KEYMAP: ShortcutDef[] = [
  // ── File (native-menu-owned in the packaged app) ───────────────────────────
  { id: "new_project",  chord: { key: "n", mod: true, shift: false }, group: "file", nativeMenuOwned: true },
  { id: "open_project", chord: { key: "o", mod: true, shift: false }, group: "file", nativeMenuOwned: true },
  { id: "save",         chord: { key: "s", mod: true, shift: false }, group: "file", nativeMenuOwned: true },
  { id: "save_as",      chord: { key: "s", mod: true, shift: true  }, group: "file", nativeMenuOwned: true },
  { id: "export_audio", chord: { key: "e", mod: true, shift: false }, group: "file", nativeMenuOwned: true },
  // ── Edit (native-menu-owned in the packaged app) ───────────────────────────
  { id: "undo",  chord: { key: "z", mod: true, shift: false }, group: "edit", nativeMenuOwned: true },
  { id: "redo",  chord: { key: "z", mod: true, shift: true  }, group: "edit", nativeMenuOwned: true },
  { id: "cut",   chord: { key: "x", mod: true, shift: false }, group: "edit", nativeMenuOwned: true },
  { id: "copy",  chord: { key: "c", mod: true, shift: false }, group: "edit", nativeMenuOwned: true },
  { id: "paste", chord: { key: "v", mod: true, shift: false }, group: "edit", nativeMenuOwned: true },
  // Delete: no native key-equivalent (would hijack ⌫ in text fields), so the web
  // layer owns it on both platforms — guarded against editable focus.
  { id: "delete", chord: { key: "Delete",    mod: false }, group: "edit", nativeMenuOwned: false },
  { id: "delete", chord: { key: "Backspace", mod: false }, group: "edit", nativeMenuOwned: false },
  // ── Transport (web-owned) ──────────────────────────────────────────────────
  { id: "play_pause", chord: { code: "Space", mod: false }, group: "transport", nativeMenuOwned: false },
];

/** True iff the event satisfies the chord (Mod = Cmd OR Ctrl). Pure. */
export function matchChord(e: KeyEventLike, c: KeyChord): boolean {
  const mod = !!(e.metaKey || e.ctrlKey);
  if (!!c.mod !== mod) return false;
  if (c.shift !== undefined && c.shift !== !!e.shiftKey) return false;
  if (c.code !== undefined) return e.code === c.code;
  if (c.key !== undefined) return e.key.toLowerCase() === c.key.toLowerCase();
  return false;
}

/** The first shortcut whose chord matches the event, or null. Pure. */
export function matchShortcut(e: KeyEventLike, keymap: ShortcutDef[] = DEFAULT_KEYMAP): ShortcutDef | null {
  return keymap.find((d) => matchChord(e, d.chord)) ?? null;
}
