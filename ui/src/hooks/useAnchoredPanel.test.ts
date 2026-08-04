// useAnchoredPanel's scroll dismissal — and the race that made it close panels it had
// just opened.
//
// THE BUG THIS PINS. `main`'s e2e suite failed intermittently on "the add-track menu
// reaches drum and instrument tracks", timing out waiting for a menu item that never
// appeared. The panel log, captured by instrumenting every transition, was unambiguous:
//
//     |toggle:false->true@1088 |dismiss:scroll@1089
//
// The panel opened and a scroll event closed it ONE MILLISECOND later. The click that
// opens the panel is itself a scroll source — the browser scrolls the trigger into view
// first — and that scroll lands after the open, when the dismissal is already armed. The
// trailing add-track row sits at the END of the lane list, so it is exactly the trigger
// most likely to need scrolling to.
//
// It is a REAL user bug, not a test artifact: a producer who clicks a partly-offscreen
// trigger, or clicks while a trackpad glide is still settling, watches the menu blink open
// and vanish. Playwright just hits the timing every time.
//
// These tests are deterministic where the e2e was 3-in-8, and they come in a PAIR on
// purpose: one proves the self-inflicted scroll is ignored, the other proves a genuine
// later scroll still dismisses. Without the second, "fixing" this by deleting scroll
// dismissal entirely would pass.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAnchoredPanel } from "./useAnchoredPanel";

/** A minimal consumer: a trigger plus a panel that renders only while open. */
function Harness() {
  const { open, at, anchorRef, panelRef, toggle } = useAnchoredPanel(200, 200, "start");
  return React.createElement(
    "div",
    null,
    React.createElement("button", { ref: anchorRef, "data-testid": "trigger", onClick: toggle }, "open"),
    open && at
      ? React.createElement("div", { ref: panelRef, "data-testid": "panel" }, "panel")
      : null,
  );
}

/** Waits past one animation frame, which is when the scroll dismissal arms. */
const nextFrame = async () => {
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => r(null))); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

describe("useAnchoredPanel — scroll dismissal", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root.render(React.createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const trigger = () => host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
  const panel = () => host.querySelector('[data-testid="panel"]');
  const scroll = () => act(() => { document.dispatchEvent(new Event("scroll", { bubbles: true })); });

  it("opens on the trigger", () => {
    act(() => trigger().click());
    expect(panel()).not.toBeNull();
  });

  it("survives the scroll its OWN opening click caused", () => {
    act(() => trigger().click());
    // Same frame as the open — this is the browser scrolling the trigger into view, not
    // the user scrolling away from it.
    scroll();
    expect(panel(), "the panel closed itself: the opening click's scroll dismissed it").not.toBeNull();
  });

  it("still dismisses on a scroll that comes after it settled", async () => {
    act(() => trigger().click());
    await nextFrame();
    scroll();
    // The anti-vacuity half: deleting scroll dismissal outright would pass the test above
    // and fail this one. Scrolling AWAY from an open panel must still close it, because the
    // panel is position:fixed and would otherwise drift off its trigger.
    expect(panel(), "a genuine later scroll no longer dismisses the panel").toBeNull();
  });
});
