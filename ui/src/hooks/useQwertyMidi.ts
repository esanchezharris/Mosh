// Mounts the computer keyboard as a MIDI controller. One listener, CAPTURE phase, mounted
// once beside useKeyboardShortcuts.
//
// Capture phase is the whole design. When the instrument owns a key it calls
// preventDefault + stopPropagation there, so no downstream listener — the app keymap, the
// piano roll, a focused control — ever sees it. That single fact IS Ableton's "single-letter
// shortcuts need Shift while the keyboard is on" rule; there is no shadow keymap and no
// per-shortcut exception anywhere else in the codebase.
//
// STUCK NOTES are the failure mode that actually bites, so they get five exits: blur, tab
// hide, Escape, toggling off, unmount — plus the one that catches people out, a keydown
// where Cmd has just gone down. macOS does not deliver keyup for other keys while Cmd is
// held, so without that a Cmd+Tab mid-chord leaves every note sounding. The engine's own
// TTL sweep is the final backstop underneath all of it.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { notePreview } from "../audio/notePreview";
import { wireNotePreview } from "../audio/wireNotePreview";
import { isEditableTarget } from "../interaction/keymap";
import {
  qwertyClaims, qwertyControl, qwertyPitch, qwertyReduce, qwertyTargetTrackId,
  QWERTY_DEFAULTS, type QwertyState,
} from "../interaction/qwertyMidi";

/** Read at event time, never subscribed to — a keypress must not re-render the app. */
export const qwertyState = { ...QWERTY_DEFAULTS };

/** Callers that need to react to the toggle (the piano roll's readout) subscribe here. */
type Listener = (s: QwertyState) => void;
const listeners = new Set<Listener>();
export function onQwertyChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function commit(next: QwertyState) {
  Object.assign(qwertyState, next);
  for (const fn of listeners) fn({ ...qwertyState });
}

export function setQwertyActive(active: boolean) {
  if (qwertyState.active === active) return;
  if (!active) notePreview.releaseAll();
  commit({ ...qwertyState, active });
}

export function useQwertyMidi() {
  // The keys currently down, and the pitch each one sounded. Authoritative over the DOM:
  // e.repeat is unreliable in WKWebView, and the pitch must be remembered because the
  // octave can shift between a key going down and coming up.
  const held = useRef(new Map<string, number>());

  useEffect(() => {
    const releaseEverything = () => {
      held.current.clear();
      notePreview.releaseAll();
    };

    const targetTrack = (): string | null => {
      const s = useStore.getState();
      return qwertyTargetTrackId(s.snapshot?.tracks, s.editingClipId, s.selectedTrackId ?? null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // Cmd just went down: macOS will swallow the keyups for anything still held.
      if ((e.metaKey || e.ctrlKey) && held.current.size > 0) releaseEverything();
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      if (e.key === "Escape" && held.current.size > 0) { releaseEverything(); return; }
      if (!qwertyClaims(e, qwertyState.active)) return;

      e.preventDefault();
      e.stopPropagation();

      const control = qwertyControl(e.key);
      if (control) {
        // Changing octave mid-chord would strand the sounding notes at pitches the new
        // layout can no longer address, so release first.
        if (control === "octDown" || control === "octUp") releaseEverything();
        commit(qwertyReduce(qwertyState, e.key));
        return;
      }

      const key = e.key.toUpperCase();
      if (held.current.has(key)) return;              // OS key-repeat, not a new press
      const pitch = qwertyPitch(key, qwertyState.octave);
      if (pitch == null) return;
      const trackId = targetTrack();
      if (!trackId) return;

      held.current.set(key, pitch);
      notePreview.hold(`qwerty:${key}`, trackId, pitch, qwertyState.velocity);
      window.dispatchEvent(new CustomEvent("mosh-qwerty-note", { detail: { pitch, velocity: qwertyState.velocity, down: true } }));
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = e.key.toUpperCase();
      const pitch = held.current.get(key);
      if (pitch == null) return;
      held.current.delete(key);
      notePreview.release(`qwerty:${key}`);
      window.dispatchEvent(new CustomEvent("mosh-qwerty-note", { detail: { pitch, down: false } }));
    };

    const onHide = () => { if (document.visibilityState === "hidden") releaseEverything(); };

    window.addEventListener("keydown", onKeyDown, true);   // capture — see the header note
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", releaseEverything);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", releaseEverything);
      document.removeEventListener("visibilitychange", onHide);
      releaseEverything();
    };
  }, []);

  // Shared with the piano roll — either mount alone must be enough to make audition work.
  useEffect(() => { wireNotePreview(); }, []);
}
