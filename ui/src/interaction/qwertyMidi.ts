// The computer keyboard as a MIDI controller — Ableton's layout, and the rule that makes
// it able to coexist with an app full of single-letter shortcuts.
//
// THE COLLISION, AND ABLETON'S ANSWER. Once A..K play notes, they cannot also mean their
// app shortcuts. Ableton's rule is: while the computer MIDI keyboard is ON, a single-letter
// shortcut needs Shift (Shift+S to solo, and so on). That is implemented HERE, in one
// place — qwertyClaims() decides whether a key belongs to the instrument, and the hook that
// mounts it claims those keys in the CAPTURE phase so nothing downstream ever sees them.
// There is no second keymap and no per-shortcut special case.

export type KeyEventLike = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  repeat?: boolean;
};

/** White keys, C upwards. */
export const QWERTY_WHITE = ["A", "S", "D", "F", "G", "H", "J", "K"] as const;
/** Black keys, as semitone offsets from the octave root. */
export const QWERTY_BLACK: Readonly<Record<string, number>> = { W: 1, E: 3, T: 6, Y: 8, U: 10 };
/** Octave down / up, then velocity down / up — Ableton's Z X C V. */
export const QWERTY_OCTAVE_DOWN = "Z", QWERTY_OCTAVE_UP = "X";
export const QWERTY_VEL_DOWN = "C", QWERTY_VEL_UP = "V";

const WHITE_SEMITONES = [0, 2, 4, 5, 7, 9, 11, 12];

/** Every key the instrument owns while it is active. */
export const QWERTY_KEYS: ReadonlySet<string> = new Set<string>([
  ...QWERTY_WHITE,
  ...Object.keys(QWERTY_BLACK),
  QWERTY_OCTAVE_DOWN, QWERTY_OCTAVE_UP, QWERTY_VEL_DOWN, QWERTY_VEL_UP,
]);

export type QwertyState = {
  active: boolean;
  /** Octave of the layout's root. 3 puts the A key at C3 (MIDI 48), as Ableton does. */
  octave: number;
  velocity: number;
};

export const QWERTY_DEFAULTS: QwertyState = { active: false, octave: 3, velocity: 100 };

const norm = (key: string) => (key.length === 1 ? key.toUpperCase() : key);

/** The MIDI pitch a key plays, or null if it is not a note key. */
export function qwertyPitch(key: string, octave: number): number | null {
  const k = norm(key);
  const white = QWERTY_WHITE.indexOf(k as typeof QWERTY_WHITE[number]);
  const semis = white >= 0 ? WHITE_SEMITONES[white]
              : k in QWERTY_BLACK ? QWERTY_BLACK[k]
              : null;
  if (semis == null) return null;
  const pitch = (octave + 1) * 12 + semis;   // MIDI 60 == C4 == octave 4
  return pitch >= 0 && pitch <= 127 ? pitch : null;
}

export type QwertyControl = "octDown" | "octUp" | "velDown" | "velUp";
export function qwertyControl(key: string): QwertyControl | null {
  switch (norm(key)) {
    case QWERTY_OCTAVE_DOWN: return "octDown";
    case QWERTY_OCTAVE_UP:   return "octUp";
    case QWERTY_VEL_DOWN:    return "velDown";
    case QWERTY_VEL_UP:      return "velUp";
    default: return null;
  }
}

/**
 * Does the instrument own this event?
 *
 * Only while active, only for its own keys, and only WITHOUT modifiers — that last part is
 * the whole Ableton rule: Shift+S still solos, Cmd+S still saves. Option is excluded too,
 * since it is the app-wide "bypass snap" modifier and must keep working during a drag.
 */
export function qwertyClaims(e: KeyEventLike, active: boolean): boolean {
  if (!active) return false;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return false;
  return QWERTY_KEYS.has(norm(e.key));
}

/**
 * A Shift-stripped clone of an event on an OWNED key, so the ordinary keymap can still
 * resolve it — this is what makes "Shift+S to solo" work rather than merely making Shift+S
 * do nothing. Returns null when the event is not that case.
 */
export function unshiftForQwerty(e: KeyEventLike, active: boolean): KeyEventLike | null {
  if (!active || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return null;
  if (!QWERTY_KEYS.has(norm(e.key))) return null;
  return { ...e, shiftKey: false };
}

/** Apply a control key to the instrument's state. Unknown keys return the state unchanged. */
export function qwertyReduce(s: QwertyState, key: string): QwertyState {
  switch (qwertyControl(key)) {
    // Clamped so the layout always has somewhere to play: -1 puts the root at C-1 (pitch 0)
    // and 8 puts the top white key at C9 (pitch 120), both inside MIDI range.
    case "octDown": return { ...s, octave: Math.max(-1, s.octave - 1) };
    case "octUp":   return { ...s, octave: Math.min(8, s.octave + 1) };
    case "velDown": return { ...s, velocity: Math.max(1, s.velocity - 20) };
    case "velUp":   return { ...s, velocity: Math.min(127, s.velocity + 20) };
    default:        return s;
  }
}

/**
 * Which track the keyboard plays into: the track owning the clip being edited when the
 * piano roll is open, else the selected track. A computer MIDI keyboard that only worked
 * inside a modal editor would be a toy — audition_note mutates nothing, so playing into
 * the selected track needs no arm and no confirmation.
 */
export function qwertyTargetTrackId(
  tracks: readonly { id: string; clips?: readonly { id: string }[] }[] | undefined,
  editingClipId: string | null,
  selectedTrackId: string | null,
): string | null {
  if (editingClipId && tracks) {
    const owner = tracks.find((t) => (t.clips ?? []).some((c) => c.id === editingClipId));
    if (owner) return owner.id;
  }
  return selectedTrackId;
}
