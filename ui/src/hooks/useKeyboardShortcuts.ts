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
      const eachSelected = (fn: (id: string) => void) => { for (const id of s.selection) fn(id); };

      switch (action) {
        case EA.UNDO: prevent(); void s.exec("undo"); break;
        case EA.REDO: prevent(); void s.exec("redo"); break;
        case EA.PLAY_PAUSE: prevent(); void s.exec("set_transport", { action: "toggle" }); break;
        case EA.RECORD: prevent(); void s.exec("set_transport", { action: "record" }); break;
        case EA.SAVE: prevent(); void s.exec("save"); break;
        case EA.DELETE:
          if (s.editingClipId || s.automationTrackId) break;
          if (s.selection.size === 0) break;
          prevent();
          eachSelected((id) => void s.exec("remove_clip", { clipId: id }));
          s.clearSelection();
          break;
        case EA.COPY: if (s.selection.size) { prevent(); s.copySelection(); } break;
        case EA.CUT: if (s.selection.size) { prevent(); void s.cutSelection(); } break;
        case EA.PASTE: if (s.clipboard) { prevent(); void s.pasteClipboard(); } break;
        case EA.DUPLICATE: prevent(); eachSelected((id) => void s.exec("duplicate_clip", { clipId: id })); break;
        case EA.GROUP: {
          prevent();
          const sel = new Set(s.selection);
          const trackIds = s.snapshot?.tracks
            .filter((t) => !t.isGroup && t.clips.some((c) => sel.has(c.id)))
            .map((t) => t.id) ?? [];
          if (trackIds.length) void s.exec("create_group_track", { trackIds });
          break;
        }
        case EA.TO_START: prevent(); void s.exec("set_transport", { action: "to_start" }); break;
        case EA.TO_END: prevent(); void s.exec("set_transport", { action: "to_end" }); break;
        case EA.TOOL_MOVE: s.setTool("move"); break;
        case EA.TOOL_SPLIT: s.setTool("split"); break;
        case EA.TOOL_RANGE: s.setTool("range"); break;
        case EA.SPLIT: {
          prevent();
          const pos = s.transport.position;
          for (const t of s.snapshot?.tracks ?? [])
            for (const c of t.clips)
              if (s.selection.has(c.id) && c.start < pos && pos < c.start + c.length)
                void s.exec("split_clip", { clipId: c.id, time: pos });
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
