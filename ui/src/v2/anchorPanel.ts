// Placement math for a panel anchored to a trigger, clamped into the viewport.
//
// Pure and DOM-free on purpose: the two callers (the topbar overflow menu and the
// add-track menu) both used to hand-roll this inline, so neither half could be tested
// without driving a browser. `useAnchoredPanel` supplies the rects; this decides where
// the panel goes.
//
// The panel is rendered `position: fixed`, so these coordinates are viewport
// coordinates and are NOT affected by `.v2-shell`'s horizontal scroll. That is
// deliberate — `.v2-shell` is `overflow-x: auto` with a 1120px min-width floor (#52),
// so an absolutely-positioned panel anchored inside it can sit outside the viewport
// entirely on a narrow window. Fixed + clamped is what keeps it reachable.

/** Gap between the trigger and the panel edge. */
export const kPanelGap = 8;
/** Minimum breathing room between the panel and the viewport edge. */
export const kViewportMargin = 8;

export type AnchorRect = { left: number; right: number; top: number; bottom: number };
export type Viewport = { width: number; height: number };

export type AnchorOpts = {
  /** The panel's rendered width. Used for the horizontal clamp. */
  panelWidth: number;
  /** Rough panel height — only ever used to CHOOSE a direction, never to position. */
  estimatedPanelHeight: number;
  /** "start" aligns the panel's left edge to the trigger's; "end" aligns right edges. */
  align: "start" | "end";
};

/** Where the panel goes, in viewport coordinates. Exactly one of top/bottom is set. */
export type Placement = { left: number; top?: number; bottom?: number };

export function placeAnchoredPanel(rect: AnchorRect, viewport: Viewport, opts: AnchorOpts): Placement {
  const wanted = opts.align === "end" ? rect.right - opts.panelWidth : rect.left;
  const maxLeft = viewport.width - opts.panelWidth - kViewportMargin;
  // Order matters: `Math.max` LAST. On a viewport narrower than the panel, maxLeft goes
  // negative, and clamping the other way round (max first, then min) would pin the panel
  // to that negative value — off the LEFT edge, which is strictly worse than the overflow
  // we are fixing. This way an unfittable panel starts at the margin and overflows right,
  // keeping its first content on screen.
  const left = Math.max(kViewportMargin, Math.min(wanted, maxLeft));

  // Flip up when there isn't room below. Anchoring the panel's BOTTOM above the trigger
  // (rather than its top below it) makes the flipped placement independent of the panel's
  // real height — so `estimatedPanelHeight` only ever picks a direction and never has to
  // be accurate. (Lifted from AddTrackMenu, where a full 8-track session pushed the
  // trailing add-track row to the bottom of the window and left "Instrument" unreachable.)
  const roomBelow = viewport.height - rect.bottom;
  return roomBelow >= opts.estimatedPanelHeight
    ? { left, top: rect.bottom + kPanelGap }
    : { left, bottom: viewport.height - rect.top + kPanelGap };
}
