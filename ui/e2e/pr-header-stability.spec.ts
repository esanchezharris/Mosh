import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// Header stability across selection changes — the "the editor jumps when I delete a
// note" report. The velocity control used to mount only while a note was selected, so
// every select/delete reflowed every header control to its right. It is now always
// mounted (visibility-toggled); the header must not move, ever.

async function openRoll(page: Page): Promise<void> {
  await page.evaluate(() => {
    const st = (window as any).__moshStore.getState();
    const midi = st.snapshot.tracks.flatMap((t: any) => t.clips).find((c: any) => c.type === "midi");
    st.openPianoRoll(midi.id);
  });
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await page.waitForTimeout(400); // let the pop-in settle
}

test("the header does not reflow when a note is selected or deleted", async ({ page }) => {
  await bootV2(page, { theme: "dark" });
  await openRoll(page);

  const vp = (await page.locator(".pr-scroll").boundingBox())!;
  const beatPx = await page.evaluate(() => (window as any).__moshStore.getState().pianoRollBeatPx);
  // The quantize button sits right of the velocity control — the canary for reflow.
  const canary = () => page.getByTestId("pr-quantize").boundingBox().then((b) => b && [b.x, b.width]);
  // And the velocity control must be present (layout-owning) but invisible pre-selection.
  const vel = page.locator(".pr-vel");
  await expect(vel).toBeAttached();
  await expect(vel).toBeHidden();

  const before = await canary();

  // draw a note, select it (velocity control appears), then delete it (disappears)
  await page.mouse.click(vp.x + 4 * beatPx, vp.y + vp.height / 2);
  await page.waitForTimeout(250);
  const afterDraw = await canary();
  await page.mouse.click(vp.x + 4 * beatPx + 4, vp.y + vp.height / 2);
  await expect(vel).toBeVisible();
  const afterSelect = await canary();
  await page.keyboard.press("Delete");
  await expect(vel).toBeHidden();
  const afterDelete = await canary();

  for (const [label, box] of Object.entries({ afterDraw, afterSelect, afterDelete }))
    expect(box, `header reflowed ${label.replace("after", "after ")}`).toEqual(before);
});
