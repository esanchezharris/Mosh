import { test, expect, type Page } from "@playwright/test";
import { bootV3 } from "./helpers";

// Demo readiness (2026-09-23), keys + dock group: Space reaches the transport from a clicked
// clip and from the empty dock field (A2), and a live Moshi task shows its progress with a
// Stop that ends it before the owner's next edit, which then gets its own undo step (A7).
// Never join a multiplayer room in this file — an active session disables the loop.

type MoshWindow = Window & { __moshStore?: { getState: () => {
  transport: { playing: boolean };
  snapshot?: { session: { tempo: number } };
} } };
const playing = (page: Page) =>
  page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().transport.playing);
const tempo = (page: Page) =>
  page.evaluate(() => (window as unknown as MoshWindow).__moshStore!.getState().snapshot?.session.tempo ?? -1);

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

test("A7: a live task shows step and elapsed with Stop; after it ends the next edit is its own undo step", async ({ page }) => {
  // Hold the loop's compile call (the second model call) so the task is observably live.
  // Every call answers 503, exactly as the hermetic dev server would, so the loop falls back
  // to its deterministic script (plan: tempo 80, then a compiled drum step).
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let held = 0;
  await page.route("**/api/brain/chat", async (route) => {
    if (held === 0 && /give the commands for the next step/i.test(route.request().postData() ?? "")) {
      held++;
      await released;
    }
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "hermetic e2e brain" }) });
  });

  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  await expect(tracks.first()).toBeVisible();
  const before = await tracks.count();
  expect(await tempo(page)).toBe(120);

  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();

  const status = page.getByTestId("v3-moshi-task");
  await expect(status).toContainText(/Working · step 1\/2 · 0:\d\d/);
  await expect.poll(() => tempo(page)).toBe(80);               // step 1 landed; step 2 is waiting on the model
  expect(held).toBe(1);
  await expect(page.getByTestId("v3-add-drum-beat")).toBeDisabled();   // no owner edit can join the task's undo step

  await page.getByTestId("v3-moshi-stop").click();
  await expect(status).toContainText("Stopping after this step…");
  await expect(page.getByTestId("v3-moshi-stop")).toBeDisabled();

  release();
  await expect(status).toHaveCount(0, { timeout: 15_000 });
  const field = page.getByTestId("v3-moshi-field");
  await expect(field).toBeEnabled();
  await expect(field).toHaveAttribute("placeholder", "Ask Moshi");
  await expect(page.getByTestId("v3-add-drum-beat")).toBeEnabled();
  await expect(tracks).toHaveCount(before + 1);                // the in-flight step still finished

  // The owner's next edit is its own undo step: ⌘Z removes only it, the task's work survives.
  await page.getByTestId("v3-add-audio").click();
  await expect(tracks).toHaveCount(before + 2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(before + 1);
  expect(await tempo(page)).toBe(80);
  // …and the task is still one undo step of its own.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(before);
  await expect.poll(() => tempo(page)).toBe(120);
});

test("D2: a dock receipt retires on the next manual edit, so its Undo never reverts that edit", async ({ page }) => {
  // Real-app walkthrough 2026-09-23: "Set tempo to 90 BPM · Undo" stayed up after + Drum beat,
  // and pressing it would have undone the beat, not the tempo.
  await bootV3(page);
  const tracks = page.getByTestId("v3-track");
  await expect(tracks.first()).toBeVisible();
  const before = await tracks.count();

  await page.getByTestId("v3-moshi-field").fill("set the tempo to 90");
  await page.getByTestId("v3-moshi-send").click();
  const receipt = page.getByTestId("v3-receipt");
  await expect(receipt).toContainText("90");
  await expect.poll(() => tempo(page)).toBe(90);

  // Play / pause move no undo step: the receipt (and its Undo) stays honest.
  await page.getByTestId("v3-play").click();
  await expect.poll(() => playing(page)).toBe(true);
  await page.getByTestId("v3-play").click();
  await expect.poll(() => playing(page)).toBe(false);
  await expect(receipt).toBeVisible();

  // + Drum beat is a new undo step on top of the tempo: the receipt goes.
  await page.getByTestId("v3-add-drum-beat").click();
  await expect(tracks).toHaveCount(before + 1);
  await expect(receipt).toHaveCount(0);
  await expect(page.getByTestId("v3-moshi-dock")).not.toContainText(/90 bpm/i);   // nor its caption

  // ⌘Z reverts the beat and only the beat; the tempo ask is still its own step.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(tracks).toHaveCount(before);
  expect(await tempo(page)).toBe(90);
});
