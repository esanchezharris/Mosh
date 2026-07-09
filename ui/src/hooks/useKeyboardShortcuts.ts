import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, onEvent, nativeMenuPresent } from "../bridge";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";
import { EditorAction as EA } from "../interaction/actions";
import { liveKeymap } from "../interaction/config";
import { isEditableTarget, resolveKey } from "../interaction/keymap";

const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile });

const NATIVE_MENU_ACTIONS = new Set<string>([EA.UNDO, EA.REDO, EA.CUT, EA.COPY, EA.PASTE, EA.SAVE, EA.PLAY_PAUSE]);

const emptyAgentPromptSpace = (target: EventTarget | null, action: string): boolean =>
  action === EA.PLAY_PAUSE &&
  target instanceof HTMLInputElement &&
  !!target.closest(".agent-composer") &&
  target.value.trim() === "";

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveKey(liveKeymap(), e);
      if (!action) return;
      if (isEditableTarget(e.target) && !emptyAgentPromptSpace(e.target, action)) return;
      if (nativeMenuPresent() && NATIVE_MENU_ACTIONS.has(action)) return;

      const s = useStore.getState();
      const prevent = () => e.preventDefault();
      const dispatch = (id: ActionId, opts: Parameters<typeof runAction>[2] = {}) => {
        void runAction(id, ctx(), opts);
      };

      switch (action) {
        case EA.UNDO: prevent(); dispatch("undo"); break;
        case EA.REDO: prevent(); dispatch("redo"); break;
        case EA.PLAY_PAUSE: prevent(); dispatch("play_pause"); break;
        case EA.RECORD: prevent(); dispatch("record"); break;
        case EA.SAVE: prevent(); dispatch("save"); break;
        case EA.DELETE:
          if (s.selection.size === 0) break;
          prevent(); dispatch("delete");
          break;
        case EA.COPY: if (s.selection.size) { prevent(); dispatch("copy"); } break;
        case EA.CUT: if (s.selection.size) { prevent(); dispatch("cut"); } break;
        case EA.PASTE: if (s.clipboard) { prevent(); dispatch("paste"); } break;
        case EA.DUPLICATE: prevent(); dispatch("duplicate"); break;
        case EA.GROUP: {
          prevent();
          dispatch("group");
          break;
        }
        case EA.TO_START: prevent(); dispatch("to_start"); break;
        case EA.TO_END: prevent(); dispatch("to_end"); break;
        case EA.TOOL_MOVE: dispatch("tool_move"); break;
        case EA.TOOL_SPLIT: dispatch("tool_split"); break;
        case EA.TOOL_RANGE: dispatch("tool_range"); break;
        case EA.SPLIT: {
          prevent();
          dispatch("split", { position: s.transport.position });
          break;
        }
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
