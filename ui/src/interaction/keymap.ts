import { EditorAction, type EditorAction as Action } from "./actions";

export type KeyCombo = string;
export type Keymap = Partial<Record<Action, KeyCombo | KeyCombo[]>>;
export type ShortcutScope = "global" | "arrangement" | "pianoRoll" | "drum" | "modal";
export type ScopedKeymap = Partial<Record<ShortcutScope, Keymap>>;
export const SHORTCUT_SCOPES: readonly ShortcutScope[] = ["global", "arrangement", "pianoRoll", "drum", "modal"];

export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

export interface ShortcutRow {
  action: Action;
  combo: string;
  display: string;
  label: string;
  scope: ShortcutScope;
}

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "AltGraph", "CapsLock", "OS"]);
const EDITOR_ACTION_NAMES: ReadonlySet<string> = new Set(Object.values(EditorAction));
const SHORTCUT_SCOPE_NAMES: ReadonlySet<string> = new Set(SHORTCUT_SCOPES);

function isEditorAction(value: string): value is Action {
  return EDITOR_ACTION_NAMES.has(value);
}

export function isShortcutScope(value: string | undefined): value is ShortcutScope {
  return value !== undefined && SHORTCUT_SCOPE_NAMES.has(value);
}

const boundActions = (keymap: Keymap): Action[] => Object.keys(keymap).filter(isEditorAction);

export function normalizeKeyName(key: string): string {
  if (key === " " || /^(space|spacebar)$/i.test(key)) return "Space";
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

export function eventToCombo(e: KeyEventLike): KeyCombo {
  if (MODIFIER_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(normalizeKeyName(e.key));
  return parts.join("+");
}

export function canonicalCombo(combo: KeyCombo): KeyCombo {
  let mod = false, shift = false, alt = false, key = "";
  for (const raw of combo.split("+")) {
    const t = raw.trim();
    const l = t.toLowerCase();
    if (["mod", "cmd", "command", "meta", "ctrl", "control", "win", "super"].includes(l)) mod = true;
    else if (l === "shift") shift = true;
    else if (["alt", "option", "opt"].includes(l)) alt = true;
    else key = normalizeKeyName(t);
  }
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (shift) parts.push("Shift");
  if (alt) parts.push("Alt");
  if (key) parts.push(key);
  return parts.join("+");
}

const asArray = (combo: KeyCombo | KeyCombo[]): KeyCombo[] => Array.isArray(combo) ? combo : [combo];

function resolveInScope(keymap: Keymap | undefined, combo: KeyCombo): Action | null {
  if (!keymap) return null;
  for (const action of boundActions(keymap)) {
    const bound = keymap[action];
    if (bound && asArray(bound).some((candidate) => canonicalCombo(candidate) === combo)) return action;
  }
  return null;
}

export function resolveKey(keymap: ScopedKeymap, e: KeyEventLike, scope: ShortcutScope = "arrangement"): Action | null {
  const combo = eventToCombo(e);
  if (!combo) return null;
  if (scope !== "global") {
    const focused = resolveInScope(keymap[scope], combo);
    if (focused) return focused;
  }
  return resolveInScope(keymap.global, combo);
}

export function isEditableTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  return !!e && (e.tagName === "INPUT" || e.tagName === "TEXTAREA" || e.tagName === "SELECT" || e.isContentEditable);
}

const A = EditorAction;

const MOSH_GLOBAL: Keymap = {
  [A.PLAY_PAUSE]: "Space",
  [A.RECORD]: "R",
  [A.UNDO]: "Mod+Z",
  [A.REDO]: "Mod+Shift+Z",
  [A.OPEN_PROJECT]: "Mod+O",
  [A.SAVE]: "Mod+S",
  [A.SAVE_AS]: "Mod+Shift+S",
  [A.EXPORT_AUDIO]: "Mod+E",
  [A.TO_START]: "Home",
  [A.TO_END]: "End",
};

const MOSH_ARRANGEMENT: Keymap = {
  [A.DELETE]: ["Delete", "Backspace"],
  [A.COPY]: "Mod+C",
  [A.CUT]: "Mod+X",
  [A.PASTE]: "Mod+V",
  [A.DUPLICATE]: "Mod+D",
  [A.GROUP]: "Mod+G",
  [A.NUDGE_LEFT]: "ArrowLeft",
  [A.NUDGE_RIGHT]: "ArrowRight",
  [A.TOOL_MOVE]: "1",
  [A.TOOL_SPLIT]: "2",
  [A.TOOL_RANGE]: "3",
};

const without = (keymap: Keymap, ...actions: Action[]): Keymap => {
  const copy = { ...keymap };
  for (const action of actions) delete copy[action];
  return copy;
};

const MOSH: ScopedKeymap = { global: MOSH_GLOBAL, arrangement: MOSH_ARRANGEMENT };
const ABLETON: ScopedKeymap = {
  global: { ...without(MOSH_GLOBAL, A.EXPORT_AUDIO), [A.RECORD]: "F9", [A.SPLIT]: "Mod+E" },
  arrangement: MOSH_ARRANGEMENT,
};
const FL: ScopedKeymap = {
  global: {
    ...without(MOSH_GLOBAL, A.EXPORT_AUDIO),
    [A.EXPORT_AUDIO]: "Mod+R",
    [A.SHOW_ARRANGEMENT]: "F5",
    [A.SHOW_DRUM]: "F6",
    [A.SHOW_PIANO_ROLL]: "F7",
    [A.SHOW_MIXER]: "F9",
    [A.SHOW_BROWSER]: "Alt+F8",
  },
  arrangement: {
    ...MOSH_ARRANGEMENT,
    [A.DUPLICATE]: "Mod+B",
    [A.TOOL_SPLIT]: "C",
    [A.TOOL_RANGE]: "E",
  },
};
const PROTOOLS: ScopedKeymap = {
  global: { ...without(MOSH_GLOBAL, A.EXPORT_AUDIO), [A.RECORD]: "Mod+Space", [A.TO_START]: "Enter", [A.SPLIT]: "Mod+E" },
  arrangement: { ...MOSH_ARRANGEMENT, [A.TOOL_RANGE]: "F7", [A.TOOL_MOVE]: "F8" },
};
const LOGIC: ScopedKeymap = {
  global: { ...without(MOSH_GLOBAL, A.EXPORT_AUDIO), [A.TO_START]: "Enter", [A.SPLIT]: "Mod+T" },
  arrangement: MOSH_ARRANGEMENT,
};

export const KEYMAPS: Record<string, ScopedKeymap> = { mosh: MOSH, ableton: ABLETON, fl: FL, protools: PROTOOLS, logic: LOGIC };

export function getKeymap(name: string): ScopedKeymap {
  return KEYMAPS[name] ?? KEYMAPS.mosh;
}

export function rebindAction(keymap: ScopedKeymap, action: Action, combo: KeyCombo): ScopedKeymap {
  const next: ScopedKeymap = {};
  let rebound = false;
  for (const scope of SHORTCUT_SCOPES) {
    const bindings = keymap[scope];
    if (!bindings) continue;
    const nextBindings = { ...bindings };
    if (Object.prototype.hasOwnProperty.call(bindings, action)) {
      nextBindings[action] = combo;
      rebound = true;
    }
    next[scope] = nextBindings;
  }
  if (!rebound) next.global = { ...(next.global ?? {}), [action]: combo };
  return next;
}

export function removeCombo(keymap: ScopedKeymap, combo: KeyCombo): ScopedKeymap {
  const reserved = canonicalCombo(combo);
  const next: ScopedKeymap = {};
  for (const scope of SHORTCUT_SCOPES) {
    const bindings = keymap[scope];
    if (!bindings) continue;
    const nextBindings = { ...bindings };
    for (const action of boundActions(bindings)) {
      const bound = bindings[action];
      if (!bound) continue;
      const remaining = asArray(bound).filter((candidate) => canonicalCombo(candidate) !== reserved);
      if (remaining.length === 0) {
        delete nextBindings[action];
      } else if (Array.isArray(bound)) {
        nextBindings[action] = remaining;
      } else {
        const first = remaining[0];
        if (first !== undefined) nextBindings[action] = first;
      }
    }
    next[scope] = nextBindings;
  }
  return next;
}

export const SHORTCUT_LABELS: Partial<Record<Action, string>> = {
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

export function displayCombo(combo: string): string {
  return combo.split("+").map((part) => ({ Mod: "⌘", Shift: "⇧", Alt: "⌥" }[part] ?? part)).join("");
}

export function shortcutRows(keymap: ScopedKeymap, scope: ShortcutScope = "arrangement"): ShortcutRow[] {
  const rows: ShortcutRow[] = [];
  const claimed = new Set<string>();
  const addScope = (owner: ShortcutScope) => {
    const bindings = keymap[owner];
    if (!bindings) return;
    for (const action of boundActions(bindings)) {
      const bound = bindings[action];
      const combos = bound ? asArray(bound).map(canonicalCombo).filter(Boolean) : [];
      const effective = combos.filter((combo) => !claimed.has(combo));
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

export const REBINDABLE_ACTIONS: Action[] = Array.from(new Set(
  Object.values(KEYMAPS).flatMap((map) =>
    Object.values(map).flatMap((bindings) => bindings ? boundActions(bindings) : [])),
));
