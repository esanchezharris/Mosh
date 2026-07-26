import { test, expect, type Page } from "@playwright/test";

// UI-REACH — load_drum_kit ("Reset kit"). Its old UI_REACH_GAPS reason said this "wants
// a kit picker", which was wrong: there is exactly one bundled kit, no list_drum_kits
// enumeration anywhere, and no kit name in the snapshot — a picker is not buildable
// today. What IS real: reloading the bundled default onto every pad, undoing whatever
// per-lane "⋯" sample swaps (assign_sample) did. Ships in the DrumSequencer toolbar next
// to Clear/Pattern. Drives a REAL click against the shipped v2 shell.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

/** Reads the mock's command log (read-only, never itself logged) — here only to OBSERVE,
 *  after a real click gesture already dispatched the command being checked. */
async function lastCommand(page: Page): Promise<{ command: string; ok: boolean }> {
  return page.evaluate(async () => {
    const store = (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a?: object) => Promise<{ data?: { entries: { command: string; ok: boolean }[] } }> } } }).__moshStore;
    const res = await store.getState().exec("get_command_log", { limit: 1 });
    return res.data!.entries[0];
  });
}

test("load_drum_kit — Reset kit in the drum sequencer toolbar dispatches a real reload", async ({ page }) => {
  await bootV2(page);
  // Open the drum grid the way a producer would: double-click the seed project's
  // Drums-track clip, then pick the Drums tab (mirrors drum-pattern.spec.ts).
  await page.locator(".v2-clip.drum, .v2-clip.midi").first().dblclick();
  await expect(page.getByTestId("piano-roll")).toBeVisible();
  await page.getByRole("button", { name: "Drums", exact: true }).click();
  await expect(page.getByTestId("drum-sequencer")).toBeVisible();

  const resetBtn = page.getByTestId("dr-reset-kit");
  await expect(resetBtn).toBeVisible(); // the seed track is already type:"drum"
  await resetBtn.click();

  const last = await lastCommand(page);
  expect(last).toMatchObject({ command: "load_drum_kit", ok: true });
});
