import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, onEvent } from "../bridge";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";

// Native-menu bridge (CTL-002). Mounted once from App.
//
// Keyboard SHORTCUTS themselves live in the configurable interaction layer — the
// keymap-driven keydown in Arrange (interaction/keymap.ts resolveKey → EditorAction),
// which is per-DAW-template and rebindable (Phase 5). This hook is now ONLY the
// other half of the menu story: in the packaged app a real NSMenu owns the File/Edit
// accelerators and fires each once; MenuController forwards the chosen item back over
// the "mosh_menu" event, which we dispatch through runAction — the SAME path a click
// takes. (Arrange's keydown yields native-menu-owned chords when a native menu is
// present, so they fire exactly once, here.)

const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile });

export function useKeyboardShortcuts() {
  useEffect(() => {
    return onEvent("mosh_menu", (raw) => {
      const p = (raw ?? {}) as { action?: ActionId; file?: string };
      if (!p.action) return;
      void runAction(p.action, ctx(), p.file ? { file: p.file } : {});
    });
  }, []);
}
