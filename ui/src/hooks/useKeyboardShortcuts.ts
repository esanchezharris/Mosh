import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, onEvent, nativeMenuPresent, brainChat } from "../bridge";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";
import { EditorAction as EA } from "../interaction/actions";
import { liveKeymap } from "../interaction/config";
import { isEditableTarget, resolveKey } from "../interaction/keymap";

const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile, chat: brainChat });

const NATIVE_MENU_ACTIONS = new Set<string>([EA.UNDO, EA.REDO, EA.CUT, EA.COPY, EA.PASTE, EA.SAVE, EA.PLAY_PAUSE]);

const emptyAgentPromptSpace = (target: EventTarget | null, action: string): boolean =>
  action === EA.PLAY_PAUSE &&
  target instanceof HTMLInputElement &&
  !!target.closest(".agent-composer") &&
  target.value.trim() === "";

const dispatch = (id: ActionId) => runAction(id, ctx());

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveKey(liveKeymap(), e);
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
        case EA.SAVE: prevent(); void dispatch("save"); break;
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
