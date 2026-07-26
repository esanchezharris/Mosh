import { test, expect, type Page } from "@playwright/test";

// UI-REACH — set_input_monitor. The snapshot already carried track.monitor
// (off|automatic|on) and cmdSetInputMonitor was complete backend-side, but nothing in
// either shell ever called it (commandClassification.ts UI_REACH_GAPS). A "Monitor"
// select now sits in the v2 Inspector's Mix tab. Drives a REAL gesture (a real <select>
// change) against the shipped v2 shell.

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
 *  after a real click/select gesture already dispatched the command being checked. */
async function lastCommand(page: Page): Promise<{ command: string; ok: boolean }> {
  return page.evaluate(async () => {
    const store = (window as unknown as { __moshStore: { getState: () => { exec: (c: string, a?: object) => Promise<{ data?: { entries: { command: string; ok: boolean }[] } }> } } }).__moshStore;
    const res = await store.getState().exec("get_command_log", { limit: 1 });
    return res.data!.entries[0];
  });
}

test("set_input_monitor — a mouse-only user can set input monitoring from the Inspector Mix tab", async ({ page }) => {
  await bootV2(page);
  const header = page.getByTestId("v2-track-header").first();
  const trackId = await header.getAttribute("data-track-id");
  await header.click(); // select — Mix is the default inspector tab

  const select = page.getByTestId("v2-input-monitor");
  await expect(select).toBeVisible();
  await expect(select).toHaveValue("automatic"); // unset in the seed project

  await select.selectOption("on");
  await expect(select).toHaveValue("on");

  // The snapshot reflects the change (this IS a real command, not local-only state).
  const monitor = await page.evaluate(
    (id) => (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: { id: string; monitor?: string }[] } } } })
      .__moshStore.getState().snapshot.tracks.find((t) => t.id === id)?.monitor,
    trackId,
  );
  expect(monitor).toBe("on");

  const last = await lastCommand(page);
  expect(last).toMatchObject({ command: "set_input_monitor", ok: true });
});
