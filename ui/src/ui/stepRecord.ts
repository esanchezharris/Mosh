// Ableton-style STEP RECORD: press keys, notes land at the insert marker, the marker
// advances. A pure reducer, so the one rule that actually matters is testable without a
// keyboard, a clip, or a DOM.
//
// THE RULE: the marker advances only when the held set drains to EMPTY. Press three keys
// together and you get a chord at one beat; press them in sequence and you get three
// consecutive beats. Advancing on key-DOWN instead would make chords impossible — which is
// the whole reason this is a reducer with a held set rather than a counter.
//
// The insert marker is view state, deliberately: CLAUDE.md's prime directives put
// selection/scroll/zoom in the UI, and a cursor in the engine would be a second model of
// "where we are" that has to be synced, persisted, undone and multiplayer-locked. The UI
// already knows the grid and the clip, so it can place a note without help.

export type StepState = {
  /** Where the next note lands, in clip-local beats. */
  insertBeat: number;
  /** Pitches currently held down. */
  held: number[];
};

export type StepAction =
  | { t: "down"; pitch: number }
  | { t: "up"; pitch: number }
  | { t: "setInsert"; beat: number }
  | { t: "back" };

export type StepResult = {
  next: StepState;
  /** A note to write, when this action produced one. */
  add?: { pitch: number; start: number };
};

export const STEP_INITIAL: StepState = { insertBeat: 0, held: [] };

export function stepReduce(s: StepState, a: StepAction, stepBeats: number): StepResult {
  const step = stepBeats > 0 ? stepBeats : 1;
  switch (a.t) {
    case "down": {
      // A key already held is a repeat, not a new note — the OS fires keydown repeatedly
      // while a key is down, and each one would otherwise stack another note on the beat.
      if (s.held.includes(a.pitch)) return { next: s };
      return {
        next: { ...s, held: [...s.held, a.pitch] },
        add: { pitch: a.pitch, start: s.insertBeat },
      };
    }
    case "up": {
      if (!s.held.includes(a.pitch)) return { next: s };
      const held = s.held.filter((p) => p !== a.pitch);
      // Only the LAST release advances — that is what makes a chord one beat wide.
      return { next: held.length === 0 ? { insertBeat: s.insertBeat + step, held } : { ...s, held } };
    }
    case "back":
      // Step backwards (to fix the note just entered). Never past the clip start, and it
      // does not delete — the producer can overwrite or undo.
      return { next: { ...s, insertBeat: Math.max(0, s.insertBeat - step) } };
    case "setInsert":
      return { next: { ...s, insertBeat: Math.max(0, a.beat) } };
    default:
      return { next: s };
  }
}
