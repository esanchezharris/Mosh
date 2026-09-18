import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief rows 5–6: level / pan / mute / solo with readback and one undo; a bus and a
// send from the inspector with readback and one undo per step (send-level undo was repaired on
// main in 875a27c9, so one ⌘Z is the contract here).

type MoshWindow = Window & { __moshStore?: { getState: () => { snapshot?: { tracks: { id: string; volumeDb?: number; pan?: number; sends?: { bus: number; db: number }[] }[] } } } };
const trackState = (page: Parameters<typeof bootV3>[0], id: string) =>
  page.evaluate((tid) => (window as unknown as MoshWindow).__moshStore?.getState().snapshot?.tracks.find((t) => t.id === tid) ?? null, id);

async function selectBass(page: Parameters<typeof bootV3>[0]) {
  const bass = page.locator('[data-testid="v3-track"]').filter({ hasText: "Bass" });
  await bass.getByRole("button", { name: /^Select track/ }).click();
  const id = (await bass.getAttribute("data-track-id"))!;
  await expect(page.getByTestId("v3-inspector")).toHaveAttribute("data-track-id", id);
  return { bass, id };
}

test("level, pan, mute and solo read back from the snapshot and each undo in one step", async ({ page }) => {
  await bootV3(page);
  const { bass, id } = await selectBass(page);
  const inspector = page.getByTestId("v3-inspector");

  const vol = inspector.getByLabel("Vol");
  await vol.fill("-12");
  await vol.blur();                                                        // ⌘Z is ignored while an input has focus
  await expect(inspector.getByTestId("v3-fader-vol")).toHaveText("-12.0 dB");
  expect((await trackState(page, id))?.volumeDb).toBe(-12);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(inspector.getByTestId("v3-fader-vol")).toHaveText("-3.0 dB");          // the seeded value

  const pan = inspector.getByLabel("Pan");
  await pan.fill("0.5");
  await pan.blur();
  await expect(inspector.getByTestId("v3-fader-pan")).toHaveText("R 50");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(inspector.getByTestId("v3-fader-pan")).toHaveText("C");

  const mute = bass.getByRole("button", { name: "Mute" });
  await mute.click();
  await expect(mute).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(mute).toHaveAttribute("aria-pressed", "false");

  const solo = bass.getByRole("button", { name: "Solo" });
  await solo.click();
  await expect(solo).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(solo).toHaveAttribute("aria-pressed", "false");
});

test("+ Bus creates a return, Add routes a send, the level reads back, and each step undoes", async ({ page }) => {
  await bootV3(page);
  const { id } = await selectBass(page);
  const inspector = page.getByTestId("v3-inspector");
  const sends = inspector.getByTestId("v3-send");
  await expect(sends).toHaveCount(0);                                     // anti-vacuity baseline
  await expect(inspector.getByTestId("v3-sends")).toContainText("No buses yet");

  await inspector.getByTestId("v3-add-bus").click();
  await expect(sends).toHaveCount(1);                                      // the return is a bus row here (return tracks stay out of the arrangement)
  await expect(sends.first()).not.toHaveAttribute("data-send-db");
  await sends.first().getByTestId("v3-send-add").click();
  await expect(sends.first()).toHaveAttribute("data-send-db", "0");

  const level = sends.first().getByRole("slider");
  await level.fill("-6");
  await level.blur();
  await expect(sends.first()).toHaveAttribute("data-send-db", "-6");
  expect((await trackState(page, id))?.sends?.[0]?.db).toBe(-6);

  await page.keyboard.press("ControlOrMeta+z");                            // one undo: level back to 0
  await expect(sends.first()).toHaveAttribute("data-send-db", "0");
  await page.keyboard.press("ControlOrMeta+z");                            // send removed
  await expect(sends.first()).not.toHaveAttribute("data-send-db");
  await page.keyboard.press("ControlOrMeta+z");                            // bus removed
  await expect(sends).toHaveCount(0);
});
