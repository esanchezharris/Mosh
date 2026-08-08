// Selection-follow (Live 12's detail dock): the dock's clip view tracks the CLIP
// SELECTION, not a double-click. The decisions live in followSelection() — pure, so
// the matrix is unit-testable without a DOM; useSelectionFollow() applies them.
//
// The matrix (owner-confirmed Live 12 behaviour):
//   click a clip (including the click that starts a move/trim drag) → open its view
//   ⌘-click ADDS a clip                                     → open the added clip's view
//   ⌘-click REMOVES the currently-shown clip                → close the view
//   ⌘-click removes some OTHER clip                          → shown view stays
//   selection cleared (track header, empty-lane click)       → close the view
//   empty-lane DRAG (time selection)                         → do NOT close
//   same selected clip clicked again after a manual close    → re-open (re-affirm)
//
// `select()` emits a fresh Set on every call — including clicking an already
// selected clip — so this hook sees every click, not just membership changes.

import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useLive } from "./liveState";

export type FollowDecision = { open: string } | "close" | null;

export function followSelection(
  prevSelection: ReadonlySet<string>,
  selection: ReadonlySet<string>,
  editingClipId: string | null,
  emptyDragInFlight: boolean,
): FollowDecision {
  const added = [...selection].filter((id) => !prevSelection.has(id));
  // The shown clip left the selection with NOTHING replacing it: close — unless an
  // empty-lane gesture is in flight, where the pointer-down deselect of a
  // TIME-SELECTION drag must not close (the click case closes at pointer-up).
  // If the same gesture selected ANOTHER clip, that's a switch, not a close —
  // clicking a different clip shows its view, so fall through to the open below.
  if (editingClipId && !selection.has(editingClipId) && added.length === 0)
    return emptyDragInFlight ? null : "close";

  // A new member arrived: click / additive-add / switch. The newest owns the view.
  if (added.length > 0 && added[added.length - 1] !== editingClipId)
    return { open: added[added.length - 1] };

  // No membership change: the one selected clip whose view was closed (editor ✕ /
  // Escape) gets its view re-affirmed by the click — select() emitted for it.
  if (selection.size === 1) {
    const only = [...selection][0];
    if (only !== editingClipId) return { open: only };
  }
  return null;
}

export function useSelectionFollow() {
  const selection = useStore((s) => s.selection);
  const prevRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = new Set(selection);
    const s = useStore.getState();
    const decision = followSelection(
      prev, selection, s.editingClipId, useLive.getState().emptyDragInFlight,
    );
    if (decision === "close") s.closePianoRoll();
    else if (decision) s.openPianoRoll(decision.open);
  }, [selection]);
}
