// The keymap layer — {action: keyCombo} dictionaries, one per DAW, plus the pure
// resolver that looks up an action from a keyboard event. useKeyboardShortcuts mounts
// the single app-level keydown handler and dispatches through this table-driven lookup.
// Combos are platform-neutral ("Mod" = Cmd or Ctrl) and rebindable through the settings
// schema's 'key' type.

import { EditorAction, type EditorAction as Action } from "./actions";

export type KeyCombo = string; // e.g. "Mod+Shift+Z", "Space", "Delete", "1"
export type Keymap = Partial<Record<Action, KeyCombo | KeyCombo[]>>;

// A minimal keyboard-event shape so the resolver is testable without a real event
// (a DOM KeyboardEvent satisfies it).
export interface KeyEventLike {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
}

const MODIFIER_KEYS = new Set(["Shift", "Meta", "Control", "Alt", "AltGraph", "CapsLock", "OS"]);

// Canonical key-name: Space normalised, letters uppercased, everything else verbatim.
export function normalizeKeyName(key: string): string {
  if (key === " " || /^(space|spacebar)$/i.test(key)) return "Space";
  if (key.length === 1 && /[a-z]/i.test(key)) return key.toUpperCase();
  return key;
}

// A keyboard event → canonical combo string ("Mod+Shift+Z"). A lone modifier press
// yields "" so the resolver ignores it (no action fires while just holding Cmd).
export function eventToCombo(e: KeyEventLike): KeyCombo {
  if (MODIFIER_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(normalizeKeyName(e.key));
  return parts.join("+");
}

// Normalise a written combo ("cmd+z", "Shift+Mod+Z") into the canonical form so
// presets/overrides can be authored loosely and still match eventToCombo output.
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

const asArray = (c: KeyCombo | KeyCombo[]): KeyCombo[] => (Array.isArray(c) ? c : [c]);

// Look up the action bound to a keyboard event, or null if unbound.
export function resolveKey(keymap: Keymap, e: KeyEventLike): Action | null {
  const combo = eventToCombo(e);
  if (!combo) return null;
  for (const action of Object.keys(keymap) as Action[]) {
    const bound = keymap[action];
    if (!bound) continue;
    if (asArray(bound).some((c) => canonicalCombo(c) === combo)) return action;
  }
  return null;
}

// True when the event target should keep full keyboard control (typing into a field).
export function isEditableTarget(el: EventTarget | null): boolean {
  const e = el as HTMLElement | null;
  return (
    !!e &&
    (e.tagName === "INPUT" ||
      e.tagName === "TEXTAREA" ||
      e.tagName === "SELECT" ||
      e.isContentEditable)
  );
}

const A = EditorAction;

// ── Mosh — the consolidated native keymap (the previously-live undo/redo/delete/space
// PLUS the documented-but-unmounted set: save/record/copy/cut/paste/duplicate/group/
// home-end/tool-switch). The live three are byte-for-byte the same combos.
const MOSH: Keymap = {
  [A.PLAY_PAUSE]: "Space",
  [A.RECORD]: "R",
  [A.UNDO]: "Mod+Z",
  [A.REDO]: "Mod+Shift+Z",
  [A.SAVE]: "Mod+S",
  [A.DELETE]: ["Delete", "Backspace"],
  [A.COPY]: "Mod+C",
  [A.CUT]: "Mod+X",
  [A.PASTE]: "Mod+V",
  [A.DUPLICATE]: "Mod+D",
  [A.GROUP]: "Mod+G",
  // FU-CLIP-NUDGE — plain arrow keys are unbound everywhere else in the app (no
  // gesture/keymap collision across any DAW preset below), so they're free for a
  // fine, fixed-increment clip move that's independent of drag/snap.
  [A.NUDGE_LEFT]: "ArrowLeft",
  [A.NUDGE_RIGHT]: "ArrowRight",
  [A.TO_START]: "Home",
  [A.TO_END]: "End",
  [A.TOOL_MOVE]: "1",
  [A.TOOL_SPLIT]: "2",
  [A.TOOL_RANGE]: "3",
  // Taste loop: "felt wrong" capture. Mod+Shift+F is free in every preset below
  // (no keymap or gesture collision), and inherited by all of them.
  [A.FELT_WRONG]: "Mod+Shift+F",
};

// Per-DAW variants — the core is shared; only a few flavor bindings differ so a
// template switch is observable. (DAW interaction identity lives mostly in gestures.)
const ABLETON: Keymap = { ...MOSH, [A.SPLIT]: "Mod+E", [A.RECORD]: "F9" };
const FL: Keymap = { ...MOSH, [A.SPLIT]: "Mod+E", [A.DUPLICATE]: "Mod+B" };

// Pro Tools — Separate Clip = ⌘E; Selector = F7, Grabber = F8; Record = ⌘Space
// (PT also uses numpad 3); Return = back to start.
const PROTOOLS: Keymap = {
  ...MOSH,
  [A.SPLIT]: "Mod+E",
  [A.RECORD]: "Mod+Space",
  [A.TOOL_RANGE]: "F7",
  [A.TOOL_MOVE]: "F8",
  [A.TO_START]: "Enter",
};

// Logic — Split at Playhead = ⌘T; Record stays R (mosh core); Return = back to start.
const LOGIC: Keymap = {
  ...MOSH,
  [A.SPLIT]: "Mod+T",
  [A.TO_START]: "Enter",
};

export const KEYMAPS: Record<string, Keymap> = { mosh: MOSH, ableton: ABLETON, fl: FL, protools: PROTOOLS, logic: LOGIC };

export function getKeymap(name: string): Keymap {
  return KEYMAPS[name] ?? KEYMAPS.mosh;
}

// The actions a user can rebind — the union of every preset's bound actions. The
// settings schema generates one 'key' descriptor per entry (empty = inherit preset).
export const REBINDABLE_ACTIONS: Action[] = Array.from(
  new Set<Action>([
    ...(Object.keys(MOSH) as Action[]),
    ...(Object.keys(ABLETON) as Action[]),
    ...(Object.keys(FL) as Action[]),
    ...(Object.keys(PROTOOLS) as Action[]),
    ...(Object.keys(LOGIC) as Action[]),
  ]),
);
