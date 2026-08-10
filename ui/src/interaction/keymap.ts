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
  code?: string; // physical key ("KeyF") — real KeyboardEvents carry it; the Alt-letter fix reads it
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

// macOS Option TRANSFORMS letter keys: ⌥f sends key "ƒ", ⌥⇧f sends "Ï" — never the
// letter an Alt-binding names, so "Mod+Shift+Alt+F" could never match a real ⌥⇧⌘F
// keydown. The physical `code` ("KeyF") is layout- and transform-proof, so with Alt
// held the letter comes from the code. Letters only: digits/punctuation keep `key`
// (no binding names the transformed forms either, but non-Alt behavior is untouched
// by construction — shifted symbols like + vs = ride `key` and stay exactly as before).
function altLetterFromCode(e: KeyEventLike): string | null {
  if (!e.altKey || !e.code) return null;
  const m = /^Key([A-Z])$/.exec(e.code);
  return m ? m[1] : null;
}

// A keyboard event → canonical combo string ("Mod+Shift+Z"). A lone modifier press
// yields "" so the resolver ignores it (no action fires while just holding Cmd).
export function eventToCombo(e: KeyEventLike): KeyCombo {
  if (MODIFIER_KEYS.has(e.key)) return "";
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  // ⇧= sends the shifted SYMBOL (key "+", US layout), but ZOOM_IN binds the physical
  // ⌘⇧= chord as "Mod+Shift+=" — normalize the Equal code's shifted form back to "=".
  // Shift-only and non-Alt (the Alt pin keeps its transformed key); without Shift the
  // key already arrives as "=", so everything else rides e.key byte-identically.
  const shiftedEqual = e.shiftKey && !e.altKey && e.code === "Equal";
  parts.push(altLetterFromCode(e) ?? (shiftedEqual ? "=" : normalizeKeyName(e.key)));
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
  [A.CONTINUE_PLAY]: "Shift+Space",
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
  // REC-001 — Capture MIDI. Mod+Shift+C is Ableton's own binding AND is free in every
  // preset below (the only other Mod+Shift combos in use are Z and F), so it lives in the
  // shared core rather than in ABLETON: it is the right key everywhere, not a flavour.
  [A.CAPTURE_MIDI]: "Mod+Shift+C",
};

// Per-DAW variants — the core is shared; only a few flavor bindings differ so a
// template switch is observable. (DAW interaction identity lives mostly in gestures.)
//
// Ableton. Note what is deliberately NOT here: the MIDI editor's own vocabulary (F fold,
// G fold-to-scale, K highlight, T triplet, 0 deactivate, Cmd+U quantize, Cmd+1..4 grid,
// arrow transpose/nudge/velocity) lives in the editor's OWN keyboard layer, mounted only
// while the roll is open. Those keys are scoped to a surface rather than global, so
// binding them in a preset would claim them app-wide — and would fight the computer MIDI
// keyboard, which owns single letters whenever it is armed. Nothing is bound here that
// does not have a live handler: a preset entry with no action behind it is a key that
// silently does nothing.
//
// The Live-12 arrangement block below (SPEC §8) IS global — every handler exists (the
// shared dispatcher gates Mod+1..4 and 0 to the arrangement while an editor is open,
// so the editor's own layer keeps them there).
//
// The MOSH core binds bare 1/2/3 to its modal tools (Move/Split/Range). Live binds
// NOTHING there — in the clone those digits were silently switching a modal tool
// nobody asked for. The ableton preset drops exactly those three (kept everywhere else).
const MOSH_NO_MODAL_TOOLS: Keymap = { ...MOSH };
delete MOSH_NO_MODAL_TOOLS[A.TOOL_MOVE];
delete MOSH_NO_MODAL_TOOLS[A.TOOL_SPLIT];
delete MOSH_NO_MODAL_TOOLS[A.TOOL_RANGE];

const ABLETON: Keymap = {
  ...MOSH_NO_MODAL_TOOLS,
  [A.SPLIT]: "Mod+E",
  [A.RECORD]: "F9",
  [A.LOOP_TOGGLE]: "Mod+L",
  [A.SELECT_LOOP]: "Mod+Shift+L",
  [A.RENAME]: "Mod+R",
  // Live's menu says ⌘0 (Edit → Activate/Deactivate Clip(s)); the arrangement also
  // accepts plain 0 — both bound, matching Live.
  [A.DEACTIVATE]: ["0", "Mod+0"],
  [A.QUANTIZE]: "Mod+U",
  [A.SETTINGS]: "Mod+,",
  [A.AUTOMATION_VIEW]: "A",
  [A.SELECT_ALL]: "Mod+A",
  [A.INVERT_SELECTION]: "Mod+Shift+A",
  [A.INSERT_AUDIO_TRACK]: "Mod+T",
  [A.INSERT_MIDI_TRACK]: "Mod+Shift+T",
  [A.INSERT_MIDI_CLIP]: "Mod+Shift+M",
  [A.NUDGE_UP]: "ArrowUp",
  [A.NUDGE_DOWN]: "ArrowDown",
  [A.GROUP]: "Mod+G",
  [A.UNGROUP]: "Mod+Shift+G",
  [A.INSERT_SILENCE]: "Mod+I",
  [A.CREATE_FADE]: "Alt+Mod+F",
  [A.CONSOLIDATE]: "Mod+J",
  [A.CROP]: "Mod+Shift+J",
  [A.BOUNCE]: "Mod+B",
  [A.FREEZE_TRACK]: "Mod+Shift+Alt+F",   // ⌥⇧⌘F — Live 12's Freeze Track (toggle)
  [A.FIND]: "Mod+F",
  [A.GRID_NARROW]: "Mod+1",
  [A.GRID_WIDEN]: "Mod+2",
  [A.GRID_TRIPLET]: "Mod+3",
  [A.SNAP_TOGGLE]: "Mod+4",
  // ⌘+ in both physical forms (⌘= and ⌘⇧=) — a chord nobody should have to think about.
  [A.ZOOM_IN]: ["Mod+=", "Mod+Shift+="],
  [A.ZOOM_OUT]: "Mod+-",
  // X is Live's zoom-BACK (no history exists yet — PARITY.md); Z is View › Zoom to
  // Time Selection. Both land on the same zoom-to-fit until a zoom history exists.
  [A.ZOOM_BACK]: "X",
  [A.ZOOM_TO_SELECTION]: "Z",
  [A.EXPAND_CLIP]: "Alt+Mod+E",
};
const FL: Keymap = { ...MOSH, [A.SPLIT]: "Mod+E", [A.DUPLICATE]: "Mod+B" };

// Pro Tools — Separate Clip = ⌘E; Record = ⌘Space; Return = back to start.
// F1–F10 belong to the Pro Tools shell-local mode/tool layer so the shared
// dispatcher cannot also mutate an invisible global modal-tool selection.
// Pro Tools ⌘G creates an Edit/Mix track group, while Mosh's shared GROUP action
// creates a routing folder/submix. The Pro Tools shell does not render those
// group rows, so inheriting this binding silently changed routing and then hid
// the result. Omit it until the additive Edit Group model exists; Pro Tools Clip
// Groups are a separate ⌥⌘G workflow. Pro Tools also owns ⌘/Ctrl +/- as its
// local Nudge controls and ⌘/Ctrl = as the Edit/Mix switch, so shared zoom must
// not consume either physical Equal/Minus chord before the shell sees it.
const PROTOOLS_CORE: Keymap = { ...MOSH_NO_MODAL_TOOLS };
delete PROTOOLS_CORE[A.GROUP];
delete PROTOOLS_CORE[A.ZOOM_IN];
delete PROTOOLS_CORE[A.ZOOM_OUT];

const PROTOOLS: Keymap = {
  ...PROTOOLS_CORE,
  [A.SPLIT]: "Mod+E",
  [A.RECORD]: "Mod+Space",
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
