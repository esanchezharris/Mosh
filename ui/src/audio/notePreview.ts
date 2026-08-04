// Live note audition, UI side. Turns "the producer is touching this note" into
// audition_note commands, and — more importantly — into as FEW of them as possible.
//
// A module-level singleton rather than a hook or store state, deliberately: a pointermove
// handler has to be able to fire this at frame rate with zero re-render, which is the same
// discipline liveFeel() uses for the interaction constants.
//
// TWO THROTTLE LAYERS, because dragging a note up an octave crosses twelve pitches in a
// few hundred milliseconds and each one is a bridge round trip:
//
//   1. PITCH IDEMPOTENCE. hold() at a pitch the voice already holds is a no-op. Pitch is
//      already quantised to a grid row, so this bounds a vertical drag to at most one
//      command per CROSSED SEMITONE — an exact bound, not a heuristic.
//   2. A RETRIGGER GATE. Inside the window, the pitch is remembered and fired on the
//      trailing edge, so a fast sweep sends a handful of notes and — critically — the
//      pitch left SOUNDING is the one the producer settled on, not whichever happened to
//      land last before the gate closed.
//
// Note-off correctness: release() sends the note-off for the pitch the voice RECORDED, never
// for wherever the pointer currently is. Getting that backwards is how you leak a stuck note
// on every drag.

export const CMD_AUDITION_NOTE = "audition_note";
export const CMD_ALL_NOTES_OFF = "all_notes_off";

/** How long a voice must wait before it may retrigger at a new pitch. */
const RETRIGGER_MS = 40;

export type ExecFn = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

type Voice = {
  trackId: string;
  pitch: number;
  /** Set while the retrigger gate is closed; fired on the trailing edge. */
  pending: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  lastFiredMs: number;
};

export interface NotePreview {
  configure(o: { exec: ExecFn; enabled: () => boolean; now?: () => number }): void;
  /** Fire-and-forget: the engine releases it on its own TTL, so no note-off is needed. */
  tap(trackId: string, pitch: number, velocity?: number): void;
  /** Sustain until release(voiceId). Re-calling at the same pitch is a no-op. */
  hold(voiceId: string, trackId: string, pitch: number, velocity?: number): void;
  release(voiceId: string): void;
  releaseAll(): void;
  /** Test hook — must be 0 after releaseAll(). */
  outstanding(): number;
}

function create(): NotePreview {
  let exec: ExecFn | null = null;
  let enabled: () => boolean = () => false;
  let now: () => number = () => Date.now();
  const voices = new Map<string, Voice>();

  const send = (command: string, args: Record<string, unknown>) => {
    // Never let a failed audition surface as an unhandled rejection: it is a sound, not
    // an edit, and a dead bridge must not break the gesture in progress.
    try { void exec?.(command, args)?.catch?.(() => {}); } catch { /* noop */ }
  };

  const fire = (v: Voice, pitch: number, velocity: number) => {
    v.pitch = pitch;
    v.lastFiredMs = now();
    send(CMD_AUDITION_NOTE, { trackId: v.trackId, pitch, velocity, action: "on" });
  };

  const stop = (v: Voice) => {
    if (v.timer != null) { clearTimeout(v.timer); v.timer = null; }
    v.pending = null;
    if (v.pitch >= 0) send(CMD_AUDITION_NOTE, { trackId: v.trackId, pitch: v.pitch, action: "off" });
    v.pitch = -1;
  };

  return {
    configure(o) { exec = o.exec; enabled = o.enabled; if (o.now) now = o.now; },

    tap(trackId, pitch, velocity = 100) {
      if (!enabled() || !exec) return;
      send(CMD_AUDITION_NOTE, { trackId, pitch, velocity, action: "blip" });
    },

    hold(voiceId, trackId, pitch, velocity = 100) {
      if (!enabled() || !exec) return;
      let v = voices.get(voiceId);
      if (!v) {
        v = { trackId, pitch: -1, pending: null, timer: null, lastFiredMs: -Infinity };
        voices.set(voiceId, v);
      }
      // Switching target track mid-gesture: release on the old one first, or its note
      // hangs with nothing left holding a reference to it.
      if (v.trackId !== trackId) { stop(v); v.trackId = trackId; }
      if (v.pitch === pitch) return;                       // layer 1: pitch idempotence

      const since = now() - v.lastFiredMs;
      if (since >= RETRIGGER_MS) {
        if (v.pitch >= 0) send(CMD_AUDITION_NOTE, { trackId, pitch: v.pitch, action: "off" });
        fire(v, pitch, velocity);
        return;
      }
      // layer 2: inside the gate — remember it, and fire on the trailing edge so the
      // pitch left sounding is the one the drag settled on.
      v.pending = pitch;
      if (v.timer == null) {
        v.timer = setTimeout(() => {
          const cur = voices.get(voiceId);
          if (!cur) return;
          cur.timer = null;
          const next = cur.pending;
          cur.pending = null;
          if (next == null || next === cur.pitch) return;
          if (cur.pitch >= 0) send(CMD_AUDITION_NOTE, { trackId: cur.trackId, pitch: cur.pitch, action: "off" });
          fire(cur, next, velocity);
        }, RETRIGGER_MS - since);
      }
    },

    release(voiceId) {
      const v = voices.get(voiceId);
      if (!v) return;
      stop(v);
      voices.delete(voiceId);
    },

    releaseAll() {
      for (const v of voices.values()) {
        if (v.timer != null) clearTimeout(v.timer);
      }
      voices.clear();
      // One panic rather than a note-off per voice: it also clears anything the engine is
      // holding that this module never knew about (a hardware controller, a previous page).
      if (exec) send(CMD_ALL_NOTES_OFF, {});
    },

    outstanding() { return voices.size; },
  };
}

export const notePreview: NotePreview = create();

/** For tests: an isolated instance, so one spec's voices cannot leak into another. */
export const createNotePreview = create;
