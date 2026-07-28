import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useEscapeToClose } from "./useEscapeToClose";
import { placeAnchoredPanel, type Placement } from "../v2/anchorPanel";

// Open/close + viewport-clamped placement for a panel anchored to a trigger button.
// Shared by the topbar overflow menu and the add-track menu, which each hand-rolled a
// partial version of this.
//
// Two things it deliberately does NOT do the way the old inline versions did:
//
// 1. **No full-screen dismiss overlay.** Both call sites used to render
//    `<div style={{ position: "fixed", inset: 0, zIndex: 55 }} onClick={close} />`.
//    Nothing in the topbar establishes a stacking context, so that invisible sheet
//    painted above every control in it: with the menu open, hover feedback died across
//    the whole topbar and a click on "Invite" hit the overlay and merely closed the menu
//    instead of opening the launcher. A capture-phase `pointerdown` listener dismisses
//    just as reliably and leaves the page interactive — the same approach `Pop` in
//    ui/TopbarTools.tsx already uses. Capture phase matters: the menu must close BEFORE
//    the clicked control's own handler runs, or the click is swallowed by the re-render.
//
// 2. **It closes on scroll.** The panel is `position: fixed` (viewport coordinates) while
//    the trigger lives inside `.v2-shell`, which is `overflow-x: auto` with a 1120px
//    min-width floor (#52) and so genuinely scrolls on a narrow window. Repositioning on
//    every scroll frame is more machinery than a menu warrants; closing keeps the panel
//    from drifting away from the control it belongs to.

export type AnchoredPanel = {
  open: boolean;
  /** Placement in viewport coordinates. Null until the first toggle measures the trigger. */
  at: Placement | null;
  anchorRef: RefObject<HTMLButtonElement>;
  /** Attach to the panel so its own scrollers don't count as "outside". */
  panelRef: RefObject<HTMLDivElement>;
  toggle: () => void;
  close: () => void;
};

export function useAnchoredPanel(
  panelWidth: number,
  estimatedPanelHeight: number,
  align: "start" | "end",
): AnchoredPanel {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Render-stable: the Escape stack re-pushes whenever this identity changes, which would
  // hoist the panel back to the top of the stack on unrelated re-renders (see #41/#43).
  const close = useCallback(() => setOpen(false), []);
  useEscapeToClose(open, close);

  // Primitives, not an options object — an object literal at the call site re-identifies
  // every render and would churn `toggle` (and every effect keyed on it).
  const toggle = useCallback(() => {
    const r = anchorRef.current?.getBoundingClientRect();
    if (r) {
      setAt(placeAnchoredPanel(r, { width: window.innerWidth, height: window.innerHeight }, {
        panelWidth, estimatedPanelHeight, align,
      }));
    }
    setOpen((o) => !o);
  }, [panelWidth, estimatedPanelHeight, align]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return; // let the trigger's own onClick toggle
      setOpen(false);
    };
    const onDismiss = (e: Event) => {
      // The panel's own inner scrollers (e.g. the Training popover's overflow:auto body)
      // must not dismiss the menu they live in.
      if (e.type === "scroll" && panelRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("scroll", onDismiss, true);
    window.addEventListener("resize", onDismiss);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("scroll", onDismiss, true);
      window.removeEventListener("resize", onDismiss);
    };
  }, [open]);

  return { open, at, anchorRef, panelRef, toggle, close };
}
