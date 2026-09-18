import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief row 4 — the recording loop V3 already wires (#702), pinned end to end against
// the mock: arm from the track header, count-in from the top bar, record / stop in the Booth
// (each stop lands a take), pick a take, Keep flattens the comp, one undo restores it.
// Audibility, latency and a real input device are the owner's rows in docs/VERIFICATION.md.

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

test("arm, record twice, pick a take, Keep, undo — every step reads back", async ({ page }) => {
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

  await enterBooth(page);
  const takes = page.getByTestId("v3-take");
  await expect(takes).toHaveCount(0);                                   // anti-vacuity baseline
  await expect(page.getByTestId("v3-takes")).toContainText("No takes yet");

  const record = page.getByTestId("v3-booth-record");
  await record.click();
  await expect(page.getByTestId("v3-record")).toHaveClass(/on/);        // transport shows recording
  await record.click();
  await expect(page.getByTestId("v3-record")).not.toHaveClass(/on/);
  await expect(takes).toHaveCount(1);                                   // the stop landed a take
  await expect(takes.first()).toHaveClass(/kept/);

  await record.click();
  await record.click();
  await expect(takes).toHaveCount(2);
  await expect(takes.nth(1)).toHaveClass(/kept/);
  await expect(takes.nth(0)).not.toHaveClass(/kept/);

  await takes.nth(0).click();                                           // set_current_take
  await expect(takes.nth(0)).toHaveClass(/kept/);
  await expect(takes.nth(1)).not.toHaveClass(/kept/);

  await page.getByTestId("v3-take-next").click();                       // Next: back to take 2
  await expect(takes.nth(1)).toHaveClass(/kept/);
  await page.getByTestId("v3-take-keep").click();                       // keep_take flattens
  await expect(takes).toHaveCount(0);
  await expect(page.getByTestId("v3-takes")).toContainText("No takes yet");

  await page.keyboard.press("ControlOrMeta+z");                         // one undo restores the comp
  await expect(takes).toHaveCount(2);

  await page.getByTestId("v3-booth-studio").click();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
});
