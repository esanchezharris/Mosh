import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Demo readiness (2026-09-23), keys + dock group: Space reaches the transport from a clicked
// clip and from the empty dock field (A2).
// Never join a multiplayer room in this file — an active session disables the loop.

type MoshWindow = Window & { __moshStore?: { getState: () => {
  transport: { playing: boolean };
} } };
const playing = (page: Page) =>
  page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().transport.playing);

test("A2: Space plays and pauses after clicking a clip (the clip keeps Enter only)", async ({ page }) => {
  await bootV3(page);
  const clip = page.locator('[data-testid="v3-track"]').filter({ hasText: "Keys" }).getByTestId("v3-clip").first();
  await clip.click();
  await expect(clip).toBeFocused();                       // the clip, not the body, owns the keystroke
  await expect(clip).toHaveAttribute("aria-pressed", "true");
  expect(await playing(page)).toBe(false);

  await page.keyboard.press("Space");
  await expect.poll(() => playing(page)).toBe(true);
  await page.keyboard.press("Space");
  await expect.poll(() => playing(page)).toBe(false);
  await expect(clip).toHaveAttribute("aria-pressed", "true");   // Space no longer re-selects; selection kept
});

test("A2: Space in the empty Moshi field plays; once the field has text it types", async ({ page }) => {
  await bootV3(page);
  const field = page.getByTestId("v3-moshi-field");
  await field.click();
  await expect(field).toBeFocused();

  await page.keyboard.press("Space");
  await expect.poll(() => playing(page)).toBe(true);
  await expect(field).toHaveValue("");
  await page.keyboard.press("Space");
  await expect.poll(() => playing(page)).toBe(false);

  await page.keyboard.type("hi");
  await page.keyboard.press("Space");
  await expect(field).toHaveValue("hi ");
  expect(await playing(page)).toBe(false);
});
