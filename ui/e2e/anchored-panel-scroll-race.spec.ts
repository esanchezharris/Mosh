// The click that OPENS an anchored panel may itself have scrolled — and that scroll must
// not close the panel it just opened.
//
// Found chasing an intermittent v2-shell.spec failure ("the add-track menu reaches drum
// and instrument tracks"): it failed ~2 of 11 full-suite runs and never in isolation. The
// mechanism is not a test artifact. `useAnchoredPanel` dismisses on any capture-phase
// `scroll` on document. Scroll events are delivered ASYNCHRONOUSLY, at the next rendering
// step — while the click that opened the panel runs `setOpen(true)`, commits, and arms the
// listener all synchronously inside the click task. So a scroll queued *before* the panel
// existed gets delivered *after* its listener is armed, and the panel closes the instant
// it opens.
//
// A real user hits this: trackpad momentum keeps firing scroll events for hundreds of ms
// after the fingers lift, so "flick the track list, then click Add track" is the same
// race. Playwright hits it because .click() calls scrollIntoViewIfNeeded first, and after
// one track is added the trailing "Add track" row has moved down far enough to need it.
//
// This spec makes the race DETERMINISTIC rather than 1-in-5: change scroll position and
// click in the SAME task, so the scroll event is guaranteed to be queued before the panel
// opens and delivered after. RED before the fix, green after.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

test("a panel survives the scroll caused by the very click that opened it", async ({ page }) => {
  await bootV2(page);

  const scrolled = await page.evaluate(() => {
    const sc = document.querySelector(".v2-tl-scroll") as HTMLElement | null;
    const btn = document.querySelector('[data-testid="v2-track-add"]') as HTMLButtonElement | null;
    if (!sc || !btn) return "no elements";
    // Move the scroller — this QUEUES a scroll event for the next rendering step.
    const before = { top: sc.scrollTop, left: sc.scrollLeft };
    if (sc.scrollHeight > sc.clientHeight) sc.scrollTop += 20;
    else if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft += 20;
    else return "not scrollable";
    const moved = sc.scrollTop !== before.top || sc.scrollLeft !== before.left;
    // ...and open the panel synchronously, in the SAME task, before that event lands.
    btn.click();
    return moved ? "ok" : "did not move";
  });
  // Guard against a vacuous pass: if nothing scrolled, this test proves nothing.
  expect(scrolled).toBe("ok");

  // The panel must still be there once the queued scroll has been delivered.
  await expect(page.getByTestId("v2-track-add-drum")).toBeVisible();
});

test("a scroll that happens AFTER the panel is open still dismisses it", async ({ page }) => {
  // The other half: the fix must not defeat the deliberate dismiss-on-scroll behaviour
  // (v2-edgecases.spec pins it for the topbar overflow menu — a fixed-position panel that
  // stays put while its trigger scrolls away is worse than one that closes).
  await bootV2(page);
  await page.getByTestId("v2-track-add").click();
  await expect(page.getByTestId("v2-track-add-drum")).toBeVisible();

  await page.evaluate(() => document.dispatchEvent(new Event("scroll")));
  await expect(page.getByTestId("v2-track-add-drum")).toHaveCount(0);
});
