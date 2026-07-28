import { describe, it, expect } from "vitest";
import { placeAnchoredPanel, kPanelGap, kViewportMargin, type AnchorRect } from "./anchorPanel";

// The behaviour under test is the CLAMP. Before this module existed, both callers
// positioned their panel straight off the trigger rect with no viewport awareness —
// `{ left: rect.right - panelWidth, top: rect.bottom + 8 }` — which is exactly what the
// cases below reject. That shipped code IS the sabotage for these tests, so none of them
// can be vacuous: substituting it fails every case except the first.

const VP = { width: 1280, height: 800 };
const rect = (o: Partial<AnchorRect> = {}): AnchorRect =>
  ({ left: 600, right: 640, top: 40, bottom: 64, ...o });

describe("placeAnchoredPanel", () => {
  it("aligns to the trigger and drops below when everything fits", () => {
    const p = placeAnchoredPanel(rect(), VP, { panelWidth: 248, estimatedPanelHeight: 420, align: "end" });
    expect(p.left).toBe(640 - 248);
    expect(p.top).toBe(64 + kPanelGap);
    expect(p.bottom).toBeUndefined();
  });

  it("aligns the LEFT edge to the trigger under align:start", () => {
    const p = placeAnchoredPanel(rect(), VP, { panelWidth: 248, estimatedPanelHeight: 200, align: "start" });
    expect(p.left).toBe(600);
  });

  it("clamps a right-overflowing panel back inside the viewport", () => {
    // The real bug shape: the trigger sits at the far right of a 1120px-min-width topbar
    // on a narrower window, so the natural placement runs off the screen.
    const p = placeAnchoredPanel(rect({ left: 1240, right: 1280 }), VP, {
      panelWidth: 248, estimatedPanelHeight: 420, align: "start",
    });
    expect(p.left).toBe(VP.width - 248 - kViewportMargin);
    expect(p.left + 248).toBeLessThanOrEqual(VP.width);
  });

  it("clamps a left-overflowing panel to the margin", () => {
    const p = placeAnchoredPanel(rect({ left: -40, right: 10 }), VP, {
      panelWidth: 248, estimatedPanelHeight: 420, align: "start",
    });
    expect(p.left).toBe(kViewportMargin);
  });

  it("never returns a negative left, even when the panel cannot fit the viewport", () => {
    // maxLeft goes negative here. Clamping max-first would pin the panel OFF the left
    // edge; the margin floor has to win.
    const p = placeAnchoredPanel(rect(), { width: 200, height: 800 }, {
      panelWidth: 248, estimatedPanelHeight: 420, align: "end",
    });
    expect(p.left).toBe(kViewportMargin);
    expect(p.left).toBeGreaterThanOrEqual(0);
  });

  it("flips upward by anchoring bottom when there is no room below", () => {
    const p = placeAnchoredPanel(rect({ top: 700, bottom: 740 }), VP, {
      panelWidth: 248, estimatedPanelHeight: 420, align: "start",
    });
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(VP.height - 700 + kPanelGap);
  });

  it("flips on the estimate boundary, exclusive", () => {
    const opts = { panelWidth: 248, estimatedPanelHeight: 200, align: "start" as const };
    // roomBelow === estimate → still drops down (>=)
    expect(placeAnchoredPanel(rect({ top: 576, bottom: 600 }), VP, opts).top).toBeDefined();
    // one pixel less → flips
    expect(placeAnchoredPanel(rect({ top: 577, bottom: 601 }), VP, opts).bottom).toBeDefined();
  });

  it("clamps horizontally in the flipped case too", () => {
    const p = placeAnchoredPanel(rect({ left: 1240, right: 1280, top: 700, bottom: 740 }), VP, {
      panelWidth: 248, estimatedPanelHeight: 420, align: "start",
    });
    expect(p.left).toBe(VP.width - 248 - kViewportMargin);
    expect(p.bottom).toBeDefined();
  });
});
