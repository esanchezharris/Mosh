import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief row 4, rewritten for the Moshi recording loop (the Booth is now the
// desktop twin of the phone pad): pick a Lead, Put Me In, and every pass is PRESERVED —
// Keep promotes one to the Lead track and rolls straight into the next, Again marks one
// as a redo without deleting it, and one undo reverses that. Audibility, latency and a
// real input device stay owner rows in docs/VERIFICATION.md.

type MoshWindow = Window & { __moshStore?: { getState: () => { snapshot?: { session: { countInBars?: number } } } } };

async function enterBooth(page: Parameters<typeof bootV3>[0]) {
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  await page.getByTestId("v3-template-booth").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
}

test("count-in writes the engine setting and reads back through the snapshot", async ({ page }) => {
  await bootV3(page);
  const select = page.getByLabel("Count-in");
  await expect(select).toHaveValue("0");
  await select.selectOption("2");
  await expect(select).toHaveValue("2");
  expect(await page.evaluate(() => (window as unknown as MoshWindow).__moshStore?.getState().snapshot?.session.countInBars)).toBe(2);
  await select.selectOption("0");
  await expect(select).toHaveValue("0");
});

test("set up a Lead, keep one pass and redo another — every pass is preserved, and undo reverses the redo", async ({ page }) => {
  await bootV3(page);
  await page.getByLabel("Count-in").selectOption("0");

  // arm the audio track from its header (the mock simulates a connected input)
  const keys = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" });
  const arm = keys.getByRole("button", { name: "Arm" });
  await expect(arm).not.toHaveClass(/arm/);
  await arm.click();
  await expect(arm).toHaveClass(/arm/);
  // the Booth follows the SELECTED track; arming alone does not select
  await keys.getByRole("button", { name: /^Select track/ }).click();
  await expect(page.getByTestId("v3-inspector")).toHaveAttribute("data-track-id", (await keys.getAttribute("data-track-id"))!);
  await expect(page.locator('[data-testid="v3-track"]')).toHaveCount(3);   // anti-vacuity baseline

  await enterBooth(page);
  const parts = page.getByTestId("v3-loop-part");
  await expect(parts).toHaveCount(0);
  await expect(page.getByTestId("v3-loop-record")).toHaveCount(0);         // nothing to press before a Lead

  await page.getByTestId("v3-booth-setup").click();
  await expect(page.getByTestId("v3-loop-record")).toBeEnabled();

  // the takes lane really exists in the arrangement, named after the Lead
  await page.getByTestId("v3-booth-studio").click();
  await expect(page.locator('[data-testid="v3-track"]')).toHaveCount(4);
  await expect(page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys · Takes" })).toHaveCount(1);
  await enterBooth(page);

  const record = page.getByTestId("v3-loop-record");
  const stop = page.getByTestId("v3-loop-stop");
  const transportRec = page.getByTestId("v3-record");

  await record.click();
  await expect(transportRec).toHaveClass(/on/);                            // transport shows recording
  await stop.click();
  await expect(transportRec).not.toHaveClass(/on/);
  await expect(parts).toHaveCount(1);                                      // the pass was preserved
  await expect(parts.first()).not.toHaveClass(/kept/);
  await expect(parts.first()).toContainText("Part 1 · preserved");

  await record.click();
  await page.getByTestId("v3-loop-keep").click();
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(1)).toHaveClass(/kept/);
  await expect(parts.nth(1)).toContainText("Part 2 · kept");
  await expect(transportRec).toHaveClass(/on/);                            // Keep rolls straight into the next pass
  await stop.click();
  await expect(transportRec).not.toHaveClass(/on/);

  await parts.first().click();                                             // select Part 1
  await expect(page.getByTestId("v3-booth")).toContainText("Target · Part 1 · preserved");
  await page.getByTestId("v3-loop-again").click();
  await expect(parts.first()).toHaveClass(/rejected/);
  await expect(parts.first()).toContainText("Part 1 · preserved redo");
  await expect(transportRec).toHaveClass(/on/);                            // Again rolls back and rolls again
  await stop.click();
  await expect(transportRec).not.toHaveClass(/on/);

  // ONE undo reverses the Again and nothing else: Part 1 stops being a redo, Part 2 stays
  // kept, and the three passes captured before it are all still there.
  //
  // WHAT THIS PINS IS THE MOCK. The dev/e2e backend's undo is a whole-snapshot stack
  // (pushUndo() in ui/src/bridge.mock.ts), and its `loop_stop` does not push a step — so
  // in the mock the Stop above genuinely did not consume this ⌘Z. Natively it is TWO
  // steps, by design: `loop_stop` → loopFinalizeCapture() opens its own
  // beginTxn ("loop_capture") before stopping (MoshOps.Loop.cpp), because Tracktion lands
  // the recorded clip through the Edit's own UndoManager and would otherwise fold the
  // landing into whatever transaction the previous command left at the head of the stack.
  // So after a Stop that landed a real take, the first native ⌘Z removes that pass and the
  // second reverses the Again. That native ordering is covered by `--selftest-undo` and
  // written down in docs/PHONE_PAD.md; it is not knowable from this spec, which never
  // reaches the engine. Do not "fix" the count below to match the engine — it is right
  // about the backend it actually drives.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(parts).toHaveCount(3);
  await expect(parts.first()).not.toHaveClass(/rejected/);
  await expect(parts.first()).toContainText("Part 1 · preserved");
  await expect(parts.nth(1)).toHaveClass(/kept/);

  await page.getByTestId("v3-booth-studio").click();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
});
