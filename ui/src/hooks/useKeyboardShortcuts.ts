import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, onEvent, nativeMenuPresent, brainChat } from "../bridge";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";
import { EditorAction as EA } from "../interaction/actions";
import { liveKeymap } from "../interaction/config";
import { isEditableTarget, resolveKey } from "../interaction/keymap";
import { unshiftForQwerty } from "../interaction/qwertyMidi";
import { qwertyState } from "./useQwertyMidi";
import { useLive } from "../live/liveState";

const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });

// Actions the WebView layer yields to the native menu when one is present (the menu
// fires them with its key-equivalent, so a keystroke lands exactly once). PLAY_PAUSE
// is deliberately NOT in this set: the transport menu item carries NO Space
// key-equivalent (a modifier-less equivalent would hijack the key from the DOM), so
// Space must be handled right here — see MenuController.cpp's transportPlayPause.
const NATIVE_MENU_ACTIONS = new Set<string>([EA.UNDO, EA.REDO, EA.CUT, EA.COPY, EA.PASTE, EA.SAVE]);

const emptyAgentPromptSpace = (target: EventTarget | null, action: string): boolean =>
  action === EA.PLAY_PAUSE &&
  target instanceof HTMLInputElement &&
  !!target.closest(".agent-composer") &&
  target.value.trim() === "";

// The arrangement-vs-editor keymap gates below used to read "a clip editor is open"
// (editingClipId set) — true when the piano roll was MODAL and always focused. The
// live shell docks the editor non-modally and the dock now FOLLOWS the clip
// selection, so editingClipId is almost always set there. Live's actual scope is
// FOCUS: the editor owns its note-level keys (0, ⌘1..4, ⌘U, ⌘A, Delete, nudge)
// only while the pointer/keyboard context is inside it; the arrangement keeps them
// otherwise. The modal mounts (classic/v2) focus the roll on open and the backdrop
// keeps focus inside, so this check is true there exactly as before — v2/classic
// semantics unchanged by construction.
export function editorKeyFocused(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && !!el.closest('[data-testid="piano-roll"]');
}

const dispatch = (id: ActionId) => runAction(id, ctx());

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const km = liveKeymap();
      let action = resolveKey(km, e);
      // While the computer MIDI keyboard is on it CLAIMS its letters (in capture phase, so
      // an unmodified A never reaches here). Ableton's escape hatch is to add Shift — so a
      // Shift+<owned key> event, which the instrument deliberately ignores, is retried
      // here without the Shift. That is what keeps Shift+S meaning solo rather than
      // meaning nothing at all.
      if (!action) {
        const alt = unshiftForQwerty(e, qwertyState.active);
        if (alt) action = resolveKey(km, alt);
      }
      if (!action) return;
      // Packaged WKWebView sometimes retargets a focused range input's Arrow keydown
      // to window. The DOM focus owner is still authoritative: inspector controls keep
      // their arrows until focus actually returns to the arrangement.
      const keyboardOwner = isEditableTarget(e.target) ? e.target : document.activeElement;
      if (isEditableTarget(keyboardOwner) && !emptyAgentPromptSpace(keyboardOwner, action)) return;
      if (nativeMenuPresent() && NATIVE_MENU_ACTIONS.has(action)) return;

      const s = useStore.getState();
      const prevent = () => e.preventDefault();

      switch (action) {
        case EA.UNDO: prevent(); void dispatch("undo"); break;
        case EA.REDO: prevent(); void dispatch("redo"); break;
        case EA.PLAY_PAUSE: prevent(); void dispatch("play_pause"); break;
        case EA.CONTINUE_PLAY: prevent(); void dispatch("continue_play"); break;
        // ⌘, — Live's Preferences: the live shell's Settings overlay (macOS
        // standard). Toggles UI-local overlay state; inert in shells that don't
        // mount it (AppLive owns the surface).
        case EA.SETTINGS:
          prevent();
          useLive.getState().toggleSettings();
          break;
        // A — Live's Automation Mode: the global automation-lane VIEW toggle (the
        // top-bar button's key). UI-local state in useLive — the lanes themselves
        // are a later wave; NOT the record-mode command (set_track_automation_mode).
        case EA.AUTOMATION_VIEW:
          prevent();
          useLive.getState().toggleAutomationView();
          break;
        case EA.RECORD: prevent(); void dispatch("record"); break;
        case EA.SAVE: prevent(); void dispatch("save"); break;
        case EA.DELETE:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("delete");
          break;
        case EA.COPY: if (s.selection.size) { prevent(); void dispatch("copy"); } break;
        case EA.CUT: if (s.selection.size) { prevent(); void dispatch("cut"); } break;
        case EA.PASTE: if (s.clipboard) { prevent(); void dispatch("paste"); } break;
        case EA.DUPLICATE: if (s.selection.size) { prevent(); void dispatch("duplicate"); } break;
        case EA.GROUP: prevent(); void dispatch("group"); break;
        // FU-CLIP-NUDGE — no-op with no clip selected; suppressed while a clip
        // editor modal (piano-roll/automation) is open, matching DELETE above.
        case EA.NUDGE_LEFT:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("nudge_left");
          break;
        case EA.NUDGE_RIGHT:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("nudge_right");
          break;
        case EA.TO_START: prevent(); void dispatch("to_start"); break;
        case EA.TO_END: prevent(); void dispatch("to_end"); break;
        case EA.TOOL_MOVE: void dispatch("tool_move"); break;
        case EA.TOOL_SPLIT: void dispatch("tool_split"); break;
        case EA.TOOL_RANGE: void dispatch("tool_range"); break;
        case EA.SPLIT: prevent(); void dispatch("split"); break;
        // ── Live-12 arrangement keys (SPEC §8; ableton preset) ──────────────────
        // Loop and zoom are always safe; the grid/snap/deactivate keys are gated off
        // while a clip editor is open because the editor's OWN layer binds the same
        // combos for its own grid/notes (Cmd+1..4, 0) — same precedent as DELETE and
        // NUDGE above. RENAME is deliberately absent here: its only surface today is
        // the live shell's inline clip rename (ui/src/live/useLiveKeys.ts resolves it
        // through the same keymap), so a shared dispatch would be a dead key in the
        // other shells.
        case EA.LOOP_TOGGLE: prevent(); void dispatch("loop_toggle"); break;
        case EA.ZOOM_IN: prevent(); void dispatch("zoom_in"); break;
        case EA.ZOOM_OUT: prevent(); void dispatch("zoom_out"); break;
        case EA.GRID_NARROW:
          if (s.editingClipId && editorKeyFocused()) break;
          prevent(); void dispatch("grid_narrow"); break;
        case EA.GRID_WIDEN:
          if (s.editingClipId && editorKeyFocused()) break;
          prevent(); void dispatch("grid_widen"); break;
        case EA.GRID_TRIPLET:
          if (s.editingClipId && editorKeyFocused()) break;   // the FOCUSED editor owns Mod+3 for its own grid
          prevent(); void dispatch("grid_triplet"); break;
        case EA.CONSOLIDATE:
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent(); void dispatch("consolidate"); break;
        // ⇧⌘J — Crop Clip: ARRANGEMENT-context only in Live 12 (absent from the MIDI
        // editor's Edit menu), so a FOCUSED editor swallows nothing and we gate the same
        // way; with no clip selected the key is inert (DELETE/CONSOLIDATE precedent).
        case EA.CROP:
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent(); void dispatch("crop_clip"); break;
        // ⌘B — Bounce to New Track: a track command; inert with no track selected
        // (the engine renders offline and owns the group/return/master refusals).
        case EA.BOUNCE:
          if (s.editingClipId && editorKeyFocused()) break;
          if (!s.selectedTrackId) break;
          prevent(); void dispatch("bounce_track"); break;
        // ⌥⇧⌘F — Freeze Track: a track command (toggle — unfreezes a frozen track);
        // inert with no track selected, same gate as bounce.
        case EA.FREEZE_TRACK:
          if (s.editingClipId && editorKeyFocused()) break;
          if (!s.selectedTrackId) break;
          prevent(); void dispatch("freeze_track"); break;
        case EA.SNAP_TOGGLE:
          if (s.editingClipId && editorKeyFocused()) break;
          prevent(); void dispatch("snap_toggle"); break;
        case EA.DEACTIVATE:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent(); void dispatch("deactivate"); break;
        // Wave 0 (menus.json) — quantize + the selection keys are gated to the
        // arrangement while an editor is open (its own layer binds the same combos
        // for notes); the creation keys are safe anywhere.
        case EA.QUANTIZE:
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent(); void dispatch("quantize"); break;
        case EA.SELECT_ALL:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          prevent(); void dispatch("select_all"); break;
        case EA.INVERT_SELECTION:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          prevent(); void dispatch("invert_selection"); break;
        case EA.SELECT_LOOP: prevent(); void dispatch("select_loop"); break;
        case EA.INSERT_AUDIO_TRACK: prevent(); void dispatch("insert_audio_track"); break;
        case EA.INSERT_MIDI_TRACK: prevent(); void dispatch("insert_midi_track"); break;
        case EA.INSERT_MIDI_CLIP: prevent(); void dispatch("insert_midi_clip"); break;
        // Keymap-audit wave — the cross-track nudge is gated exactly like the ←/→
        // one (a FOCUSED editor owns arrows for note transpose; the arrangement
        // otherwise). Ungroup / Insert Silence / Create Fade have no editor conflict.
        case EA.NUDGE_UP:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("nudge_up");
          break;
        case EA.NUDGE_DOWN:
          if (s.automationTrackId) break;
          if (s.editingClipId && editorKeyFocused()) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("nudge_down");
          break;
        case EA.UNGROUP: prevent(); void dispatch("ungroup"); break;
        case EA.INSERT_SILENCE: prevent(); void dispatch("insert_silence"); break;
        case EA.CREATE_FADE:
          if (s.selection.size === 0) break;
          prevent(); void dispatch("create_fade"); break;
        case EA.FELT_WRONG: prevent(); void dispatch("felt_wrong"); break;
        // REC-001 — ⇧⌘C. prevent() matters: the browser's own Copy would otherwise
        // also fire on the Mod+C half of the chord in some WebKit builds.
        case EA.CAPTURE_MIDI: prevent(); void dispatch("capture_midi"); break;
        default: break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    return onEvent("mosh_menu", (raw) => {
      const p = (raw ?? {}) as { action?: ActionId; file?: string };
      if (!p.action) return;
      void runAction(p.action, ctx(), p.file ? { file: p.file } : {});
    });
  }, []);
}
