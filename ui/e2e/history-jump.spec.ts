// CAP-PRJ-005 — clicking a row in the command log restores the session to that point.
//
// The whole gesture, mouse-only, against the mock backend: add a track, do something
// NON-UNDOABLE, add another track, then click the earlier step in the history panel.
//
// The non-undoable commands in the middle are the entire point. Play/stop write two
// lines to the command log and nothing to the undo stack, so the row a producer clicks
// sits FOUR rows back but only ONE undo transaction back. A panel that restored by row
// position would undo three times here and delete a track the producer never touched —
// and would do it silently, which is the failure mode CAP-PRJ-005 exists to remove.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

async function addAudioTrack(page: import("@playwright/test").Page) {
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-audio").click();
  await expect(page.getByTestId("v2-track-add")).toHaveAttribute("aria-expanded", "false");
}

// Robust to whatever the previous interaction left open: a jump re-renders the list,
// which can dismiss the anchored panel, so neither "it is still open" nor "it closed"
// may be assumed (see the anchored-panel scroll-dismissal fix in #615).
async function openCommandLog(page: import("@playwright/test").Page) {
  const log = page.getByTestId("command-log");
  if (await log.isVisible().catch(() => false)) return;
  const overflow = page.getByTestId("v2-overflow");
  if ((await overflow.getAttribute("aria-expanded")) !== "true") await overflow.click();
  await page.getByTestId("v2-tool-command-log").click();
  await expect(log).toBeVisible();
}

test("clicking a history row restores to that point, counting transactions not rows", async ({ page }) => {
  await bootV2(page);
  const headers = page.getByTestId("v2-track-header");
  const before = await headers.count();

  await addAudioTrack(page);
  await expect(headers).toHaveCount(before + 1);
  // ── the non-undoable pair: two more LOG LINES, zero undo transactions ──
  await page.getByTestId("v2-play").click();
  await page.getByTestId("v2-stop").click();
  await addAudioTrack(page);
  await expect(headers).toHaveCount(before + 2);

  await openCommandLog(page);
  const log = page.getByTestId("command-log");
  await expect(log).toContainText("set_transport");

  // Only the rows that opened their own undo transaction are controls. The newest one is
  // where the session already is, so the first offered restore is the FIRST track-add —
  // four rows up the list from where a row count would put it.
  const restores = page.getByTestId("command-log-restore");
  await expect(restores.first()).toBeVisible();
  const restoreCount = await restores.count();
  const rowCount = await log.locator("> *").count();
  expect(restoreCount).toBeLessThan(rowCount); // the set_transport rows offer nothing

  await restores.first().click();
  await expect(headers).toHaveCount(before + 1);

  // Reopening shows the panel agreeing with where the session now is, so the producer
  // can walk forward again rather than being stranded.
  await openCommandLog(page);
  await expect(page.getByTestId("command-log")).toContainText("create_track");
  await expect(page.getByTestId("command-log-restore").first()).toBeVisible();
});
