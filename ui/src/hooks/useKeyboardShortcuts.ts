import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, onEvent, nativeMenuPresent } from "../bridge";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";
import { EditorAction as EA } from "../interaction/actions";
import { liveKeymap } from "../interaction/config";
import { isEditableTarget, resolveKey, type ShortcutScope } from "../interaction/keymap";

const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile });

const NATIVE_MENU_ACTIONS = new Set<string>([
  EA.OPEN_PROJECT, EA.SAVE, EA.SAVE_AS,
  EA.UNDO, EA.REDO, EA.CUT, EA.COPY, EA.PASTE, EA.PLAY_PAUSE,
]);

const SHORTCUT_SCOPES = new Set<ShortcutScope>(["global", "arrangement", "pianoRoll", "drum", "modal"]);

export function shortcutScopeForTarget(target: EventTarget | null): ShortcutScope {
  const element = target instanceof Element ? target : null;
  if (!element) return "arrangement";
  if (element.closest('dialog[open], [role="dialog"], [aria-modal="true"]')) return "modal";
  const owner = element.closest<HTMLElement>("[data-shortcut-scope]");
  const scope = owner?.dataset.shortcutScope as ShortcutScope | undefined;
  return scope && SHORTCUT_SCOPES.has(scope) ? scope : "arrangement";
}

const emptyAgentPromptSpace = (target: EventTarget | null, action: string): boolean =>
  action === EA.PLAY_PAUSE &&
  target instanceof HTMLInputElement &&
  !!target.closest(".agent-composer") &&
  target.value.trim() === "";

const dispatch = (id: ActionId) => runAction(id, ctx());

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveKey(liveKeymap(), e, shortcutScopeForTarget(e.target));
      if (!action) return;
      if (isEditableTarget(e.target) && !emptyAgentPromptSpace(e.target, action)) return;
      if (nativeMenuPresent() && NATIVE_MENU_ACTIONS.has(action)) return;

      const s = useStore.getState();
      const prevent = () => e.preventDefault();

      switch (action) {
        case EA.UNDO: prevent(); void dispatch("undo"); break;
        case EA.REDO: prevent(); void dispatch("redo"); break;
        case EA.PLAY_PAUSE: prevent(); void dispatch("play_pause"); break;
        case EA.RECORD: prevent(); void dispatch("record"); break;
        case EA.OPEN_PROJECT: prevent(); void dispatch("open_project"); break;
        case EA.SAVE: prevent(); void dispatch("save"); break;
        case EA.SAVE_AS: prevent(); void dispatch("save_as"); break;
        case EA.EXPORT_AUDIO: prevent(); void dispatch("export_audio"); break;
        case EA.DELETE:
          if (s.editingClipId || s.automationTrackId) break;
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
          if (s.editingClipId || s.automationTrackId) break;
          if (s.selection.size === 0) break;
          prevent();
          void dispatch("nudge_left");
          break;
        case EA.NUDGE_RIGHT:
          if (s.editingClipId || s.automationTrackId) break;
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
        case EA.SHOW_ARRANGEMENT: prevent(); void dispatch("show_arrangement"); break;
        case EA.SHOW_DRUM: prevent(); void dispatch("show_drum"); break;
        case EA.SHOW_PIANO_ROLL: prevent(); void dispatch("show_piano_roll"); break;
        case EA.SHOW_MIXER: prevent(); void dispatch("show_mixer"); break;
        case EA.SHOW_BROWSER: prevent(); void dispatch("show_browser"); break;
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
