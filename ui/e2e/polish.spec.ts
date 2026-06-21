import { test, expect } from "@playwright/test";
import { boot, newProject, selectTrack, addMidiClip } from "./helpers";

// Final-polish guards: keyboard-dismiss consistency across modals, sane empty
// states, and graceful narrow-window behaviour.

test.describe("keyboard a11y — every modal closes on Escape", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await selectTrack(page, 0);
  });

  test("plugin browser closes on Escape", async ({ page }) => {
    await page.getByRole("button", { name: "+ Plugin", exact: true }).click();
    await expect(page.getByTestId("plugin-browser")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("plugin-browser")).toBeHidden();
  });

  test("automation panel closes on Escape", async ({ page }) => {
    await page.getByTestId("open-automation").click();
    await expect(page.getByTestId("automation-panel")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("automation-panel")).toBeHidden();
  });

  test("modals carry dialog semantics", async ({ page }) => {
    await page.getByRole("button", { name: "+ Plugin", exact: true }).click();
    const dialog = page.getByTestId("plugin-browser").getByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-label", "Add plugin");
  });

  test("opening a modal moves keyboard focus into the dialog (aria-modal is honest)", async ({ page }) => {
    const focusInside = (tid: string) =>
      page.evaluate((id) => !!document.activeElement?.closest(`[data-testid="${id}"]`), tid);

    // plugin browser — its filter input autofocuses
    await page.getByRole("button", { name: "+ Plugin", exact: true }).click();
    await expect(page.getByTestId("plugin-browser")).toBeVisible();
    await expect.poll(() => focusInside("plugin-browser")).toBe(true);
    await page.keyboard.press("Escape");

    // automation panel — the dialog container takes focus on open
    await page.getByTestId("open-automation").click();
    await expect(page.getByTestId("automation-panel")).toBeVisible();
    await expect.poll(() => focusInside("automation-panel")).toBe(true);
    await page.keyboard.press("Escape");

    // piano roll — same
    await addMidiClip(page);
    await page.locator('[data-testid="lane"] .clip.midi').first().dblclick();
    await expect(page.getByTestId("piano-roll")).toBeVisible();
    await expect.poll(() => focusInside("piano-roll")).toBe(true);
  });
});

test.describe("empty states", () => {
  test.beforeEach(async ({ page }) => {
    await boot(page);
    await newProject(page);
  });

  test("empty arrangement + rack guide the user", async ({ page }) => {
    await expect(page.locator(".empty-hint")).toBeVisible();
    await expect(page.getByTestId("toolbar")).toBeVisible(); // controls still present
    await expect(page.locator(".rack-label")).toContainText("select a track");
  });

  test("empty mixer shows the master strip and a no-tracks note", async ({ page }) => {
    await page.getByTestId("view-toggle").getByRole("button", { name: "Mixer" }).click();
    await expect(page.getByTestId("mixer")).toBeVisible();
    await expect(page.getByTestId("master-strip")).toBeVisible();
    await expect(page.getByTestId("channel-strip")).toHaveCount(0);
    await expect(page.locator(".mix-strips .rack-empty")).toHaveText("no tracks");
  });
});

test("the Arrange/Mixer toggle stays on-screen even when the topbar OVERFLOWS", async ({ page }) => {
  // Bug #2 only manifests when the topbar overflows its width — the trailing toggle
  // scrolls off the right under the hidden scrollbar. So the guard MUST run at an
  // overflowing width: at the default 1440px the bar fits and the toggle sits at the
  // right edge via plain flex layout, which would pass with OR without the sticky pin
  // (false confidence). A narrow width forces real overflow.
  const VW = 640;
  await page.setViewportSize({ width: VW, height: 720 });
  await boot(page);

  const topbar = page.getByTestId("topbar");
  // precondition: the bar genuinely overflows here, so the sticky pin is what matters
  const overflow = await topbar.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow, "topbar must overflow at this width for the test to be meaningful").toBeGreaterThan(0);
  // scrolled fully left (default): a NON-sticky trailing toggle would be off the right
  // edge here; position:sticky;right:0 is the only thing keeping it in the viewport
  await topbar.evaluate((el) => (el.scrollLeft = 0));

  const toggle = page.getByTestId("view-toggle");
  await expect(toggle).toBeVisible();
  const box = (await toggle.boundingBox())!;
  expect(box.x + box.width, "toggle right edge must be within the viewport").toBeLessThanOrEqual(VW + 1);
  expect(box.x).toBeGreaterThanOrEqual(0);
  // and it's still operable
  await toggle.getByRole("button", { name: "Mixer" }).click();
  await expect(page.getByTestId("mixer")).toBeVisible();
});

test("primary topbar controls stay inside the viewport at installed narrow width", async ({ page }) => {
  const VW = 1440;
  await page.setViewportSize({ width: VW, height: 858 });
  await boot(page);

  const controls = [
    page.getByRole("button", { name: "File", exact: true }),
    page.locator('button[title="Browse audio samples"]'),
    page.locator('button[title="Settings"]'),
    page.locator('button[title="Export the mix"]'),
    page.getByRole("button", { name: "Arrange", exact: true }),
    page.getByRole("button", { name: "Mixer", exact: true }),
  ];

  for (const control of controls) {
    await expect(control).toBeVisible();
    const box = (await control.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(VW + 1);
  }
});

test("track header controls stay left of the arrangement lane", async ({ page }) => {
  await boot(page);
  await selectTrack(page, 0);
  await addMidiClip(page);

  const volume = page.getByTestId("track-header").first().locator('input[type="range"]');
  const laneClip = page.getByTestId("clip").first();
  await expect(volume).toBeVisible();
  await expect(laneClip).toBeVisible();

  const volumeBox = (await volume.boundingBox())!;
  const laneBox = (await page.getByTestId("lane").first().boundingBox())!;
  const clipBox = (await laneClip.boundingBox())!;

  expect(volumeBox.x + volumeBox.width, "volume control must not intrude into lane hit area").toBeLessThanOrEqual(laneBox.x - 2);
  expect(clipBox.x, "first clip must render inside the lane, not under the track header").toBeGreaterThanOrEqual(laneBox.x);
});

test.describe("narrow window", () => {
  test.use({ viewport: { width: 820, height: 720 } });

  test("core controls stay visible and usable at 820px", async ({ page }) => {
    await boot(page);
    await expect(page.getByTestId("topbar")).toBeVisible();
    await expect(page.getByTestId("toolbar")).toBeVisible();
    await expect(page.getByTestId("arrangement")).toBeVisible();
    await expect(page.getByTestId("transport-play")).toBeVisible();
    await expect(page.getByTestId("view-toggle")).toBeVisible();
    // the File menu still opens (not clipped off-screen)
    await page.getByRole("button", { name: "File", exact: true }).click();
    await expect(page.getByTestId("file-menu")).toBeVisible();
  });

  test("toolbar actions do not clip off the right edge at 820px", async ({ page }) => {
    await boot(page);
    const toolbar = page.getByTestId("toolbar");
    await expect(toolbar).toBeVisible();

    const overflow = await toolbar.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "toolbar should wrap visible controls instead of horizontal clipping").toBeLessThanOrEqual(1);

    for (const name of ["Undo", "Redo"]) {
      const button = page.getByRole("button", { name, exact: true });
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      expect(box, `${name} button must have a layout box`).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width, `${name} right edge must be inside the viewport`).toBeLessThanOrEqual(821);
    }
  });
});
