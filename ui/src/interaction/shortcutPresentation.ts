import { EditorAction, type EditorAction as Action } from "./actions";
import {
  canonicalCombo,
  isEditorAction,
  type KeyCombo,
  type ScopedKeymap,
  type ShortcutScope,
} from "./keymap";

export interface ShortcutRow {
  action: Action;
  combo: string;
  display: string;
  label: string;
  scope: ShortcutScope;
}

const A = EditorAction;
const SHORTCUT_LABELS: Partial<Record<Action, string>> = {
  [A.OPEN_PROJECT]: "Open project",
  [A.SAVE]: "Save",
  [A.SAVE_AS]: "Save As",
  [A.EXPORT_AUDIO]: "Export audio",
  [A.UNDO]: "Undo",
  [A.REDO]: "Redo",
  [A.CUT]: "Cut",
  [A.COPY]: "Copy",
  [A.PASTE]: "Paste",
  [A.DELETE]: "Delete",
  [A.DUPLICATE]: "Duplicate",
  [A.GROUP]: "Group",
  [A.PLAY_PAUSE]: "Play / pause",
  [A.RECORD]: "Record",
  [A.TO_START]: "To start",
  [A.TO_END]: "To end",
  [A.NUDGE_LEFT]: "Nudge left",
  [A.NUDGE_RIGHT]: "Nudge right",
  [A.TOOL_MOVE]: "Move tool",
  [A.TOOL_SPLIT]: "Split tool",
  [A.TOOL_RANGE]: "Select / Range tool",
  [A.SPLIT]: "Split at playhead",
  [A.SHOW_ARRANGEMENT]: "Arrangement",
  [A.SHOW_DRUM]: "Drum window",
  [A.SHOW_PIANO_ROLL]: "Piano Roll",
  [A.SHOW_MIXER]: "Mixer",
  [A.SHOW_BROWSER]: "Browser",
};

const combos = (combo: KeyCombo | KeyCombo[]): KeyCombo[] => Array.isArray(combo) ? combo : [combo];

export function displayCombo(combo: string): string {
  return combo.split("+").map((part) => ({ Mod: "⌘", Shift: "⇧", Alt: "⌥" }[part] ?? part)).join("");
}

export function shortcutRows(keymap: ScopedKeymap, scope: ShortcutScope = "arrangement"): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  const claimed = new Set<string>();
  const addScope = (owner: ShortcutScope) => {
    const bindings = keymap[owner];
    if (!bindings) return;
    for (const action of Object.keys(bindings).filter(isEditorAction)) {
      const bound = bindings[action];
      const candidates = bound ? combos(bound).map(canonicalCombo).filter(Boolean) : [];
      const effective = candidates.filter((combo) => !claimed.has(combo));
      if (!effective.length) continue;
      effective.forEach((combo) => claimed.add(combo));
      const label = SHORTCUT_LABELS[action];
      if (!label) continue;
      rows.push({
        action,
        combo: effective.join(" · "),
        display: effective.map(displayCombo).join(" · "),
        label,
        scope: owner,
      });
    }
  };
  if (scope !== "global") addScope(scope);
  addScope("global");
  return rows;
}
