import { useEffect } from "react";
import { pushEscapeHandler } from "./escapeStack";

// Close an open overlay when Escape is pressed. Mirrors the PianoRoll / popover
// behaviour so every modal in the app dismisses the same way (keyboard a11y +
// muscle memory). No-op while `active` is false, and self-cleaning.
//
// AL-001: backed by the shared Escape STACK so that with multiple overlays open,
// Escape closes only the TOPMOST (most-recently-mounted) one — lower overlays
// stay put. The stack keeps a single window listener; each active overlay just
// pushes its close handler and pops it on unmount.
export function useEscapeStack(active: boolean, close: () => void): void {
  useEffect(() => {
    if (!active) return;
    return pushEscapeHandler(close);
  }, [active, close]);
}

// Back-compat alias: existing call sites import `useEscapeToClose`.
export const useEscapeToClose = useEscapeStack;
