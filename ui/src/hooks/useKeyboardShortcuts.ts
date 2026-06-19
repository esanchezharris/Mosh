import { useEffect } from "react";
import { useStore } from "../store";
import { pickFiles, pickSaveFile, nativeMenuPresent, onEvent } from "../bridge";
import { matchShortcut } from "../keymap";
import { runAction, type ActionCtx, type ActionId } from "../menuActions";

// THE single keyboard-shortcut layer (CTL-002). Mounted once from App. Both the
// keydown handler and the native-menu bridge route through the SAME data-driven
// keymap + runAction dispatcher, so there is exactly ONE place that defines what a
// shortcut does. (This replaces the old inline keydown handler that lived in
// Arrange.tsx — there is no second window 'keydown' listener.)
//
// Double-fire: in the packaged app a real NSMenu owns the File/Edit accelerators.
// Native-menu-owned chords are YIELDED here (return without preventDefault) so the
// keystroke falls through to the menu and fires exactly once; the menu then forwards
// the action back over the "mosh_menu" event, which we dispatch through runAction —
// the same path a click takes. In Vite dev (no native menu) we own everything.

// A fresh action context per dispatch so selection/transport are read live.
const ctx = (): ActionCtx => ({ store: useStore.getState(), pickFiles, pickSaveFile });

const isEditable = (el: HTMLElement | null) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);

export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const def = matchShortcut(e);
      if (!def) return;

      // Never hijack typing (track-name input, number-field, textarea, select…).
      if (def.guardEditable !== false &&
          (isEditable(e.target as HTMLElement | null) || isEditable(document.activeElement as HTMLElement | null)))
        return;

      // Yield native-menu-owned accelerators to the real menu in the packaged app.
      if (def.nativeMenuOwned && nativeMenuPresent()) return;

      e.preventDefault();
      void runAction(def.id, ctx());
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Native menu bar → WebView: each File/Edit item (click or accelerator) forwards
  // { action, file? } here so it runs through the same dispatcher as a shortcut.
  useEffect(() => {
    return onEvent("mosh_menu", (raw) => {
      const p = (raw ?? {}) as { action?: ActionId; file?: string };
      if (!p.action) return;
      void runAction(p.action, ctx(), p.file ? { file: p.file } : {});
    });
  }, []);
}
