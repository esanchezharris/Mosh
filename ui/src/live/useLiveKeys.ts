// The live shell's own key layer — resolves the keymap actions whose only SURFACE is
// this shell (RENAME → the lane overlay; FIND → the browser's search field;
// ZOOM_BACK → zoom-to-fit the span/selection), through the SAME liveKeymap() table
// the app dispatcher uses. The bindings live in the ableton preset; this hook is just
// where those resolved actions land. The shared dispatcher in useKeyboardShortcuts
// has no cases for them precisely so they stay live-only — a bare window listener
// with a hardcoded "Mod+R"-style check is exactly what the keymap table exists to
// prevent.
//
// Precedence falls out of listener order, as everywhere else in the app: the escape
// stack (capture) → the QWERTY instrument (capture) → the app keymap (bubble, no-op
// for these) → this (bubble). Mount AFTER useKeyboardShortcuts.

import { useEffect } from "react";
import { useStore } from "../store";
import { useSettings } from "../settings/store";
import { useShell } from "../v2/shellState";
import { EditorAction as EA } from "../interaction/actions";
import { liveKeymap } from "../interaction/config";
import { isEditableTarget, resolveKey } from "../interaction/keymap";
import { editorKeyFocused } from "../hooks/useKeyboardShortcuts";
import { useLive } from "./liveState";
import { zoomToFitSpan, contentFitSpan } from "./zoomFit";
import { popZoomView } from "./zoomHistory";

export function useLiveKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = resolveKey(liveKeymap(), e);
      if (action !== EA.RENAME && action !== EA.FIND && action !== EA.ZOOM_BACK
          && action !== EA.ZOOM_TO_SELECTION && action !== EA.EXPAND_CLIP) return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      const s = useStore.getState();

      // ⌥⌘E — Expanded Clip View. Sticky (the liveClipExpanded setting), inert with
      // no clip open — Live greys the menu item then, so the key doing nothing is
      // the honest equivalent.
      if (action === EA.EXPAND_CLIP) {
        if (!s.editingClipId) return;
        e.preventDefault();
        const st = useSettings.getState();
        st.set("liveClipExpanded", !st.get("liveClipExpanded"));
        return;
      }

      // ⌘F — focus the browser's search field (Live's Search in Browser). Surface
      // only; the field lives in Browser.tsx and filters across categories.
      if (action === EA.FIND) {
        e.preventDefault();
        const field = document.querySelector<HTMLInputElement>('[data-testid="live-bsearch"]');
        field?.focus();
        field?.select();
        return;
      }

      // X — zoom BACK: pop Live's zoom history (one entry per press; empty stack =
      // no-op, matching Live). Entries are recorded at every zoom mutation point
      // (⌘+/⌘−, ruler drag-zoom, fit-to-span) in zoomHistory.ts.
      if (action === EA.ZOOM_BACK) {
        if (s.editingClipId && editorKeyFocused()) return;   // a FOCUSED editor owns its own zoom
        e.preventDefault();
        popZoomView();
        return;
      }

      // Z — zoom to the TIME SELECTION (Live's Zoom to Time Selection). With no
      // selection drawn, Live falls back to fitting the arrangement content.
      if (action === EA.ZOOM_TO_SELECTION) {
        if (s.editingClipId && editorKeyFocused()) return;
        const span = useShell.getState().timeRange ?? contentFitSpan();
        if (!span) return;
        e.preventDefault();
        zoomToFitSpan(span);
        return;
      }

      // ⌘R — rename the one selected clip. Focus-scoped like the shared gates: the
      // dock now FOLLOWS selection (editingClipId is almost always set), so the old
      // "editor open" check would have made rename unreachable — what matters is
      // whether the editor itself has the keys.
      if (s.editingClipId && editorKeyFocused()) return;
      // Live renames the one selected clip; a multi-selection is ambiguous, so the
      // key is honestly inert there rather than renaming the arbitrary first.
      if (s.selection.size !== 1) return;
      e.preventDefault();
      useLive.getState().setRenamingClip([...s.selection][0]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
