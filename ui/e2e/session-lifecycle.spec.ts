import { test, expect, type Page } from "@playwright/test";

// Session lifecycle: the launch picker, and project actions in the v2 overflow menu.
//
// The app has always reopened the last edit silently, and "New" lived under an unlabelled
// "+" glyph in the composer bar. So a session accumulated tracks for its whole lifetime
// with nothing in-product offering a way out — the 8-mostly-empty-tracks state this work
// started from. (Not a default-tracks bug: new_project provably yields ZERO tracks.)

async function bootPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2&picker=1");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
}

test("the picker offers Continue, and Continue costs no command", async ({ page }) => {
  await bootPicker(page);
  const picker = page.getByTestId("v2-session-picker");
  await expect(picker).toBeVisible();

  // The track count is the whole point of the screen: it makes an accumulated session
  // legible BEFORE it fills the arrangement. The mock seeds exactly 3.
  await expect(page.getByTestId("v2-picker-continue")).toContainText("3 tracks");

  await page.getByTestId("v2-picker-continue").click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("v2-track-header")).toHaveCount(3); // nothing was discarded
});

test("Escape is Continue, not a dead end", async ({ page }) => {
  // A picker that Escapes into a blank screen at launch would be worse than the problem.
  await bootPicker(page);
  await expect(page.getByTestId("v2-session-picker")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v2-session-picker")).toHaveCount(0);
  await expect(page.getByTestId("v2-track-header")).toHaveCount(3);
});

test("Start empty gives a genuinely empty arrangement", async ({ page }) => {
  await bootPicker(page);
  await page.getByTestId("v2-picker-new").click();
  await expect(page.getByTestId("v2-session-picker")).toHaveCount(0);
  await expect(page.getByTestId("v2-empty")).toBeVisible();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(0);
});

test("the current project is not offered as a Recent (it is already Continue)", async ({ page }) => {
  await bootPicker(page);
  const rows = page.getByTestId("v2-picker-recent");
  await expect(rows).toHaveCount(2); // 3 seeded, minus the current one
  await expect(rows.first()).toHaveText("late-night");
});

test("a Recent row opens that project", async ({ page }) => {
  await bootPicker(page);
  await page.getByTestId("v2-picker-recent").first().click();
  await expect(page.getByTestId("v2-session-picker")).toHaveCount(0);
  // The topbar names the open project.
  await expect(page.locator(".v2-proj-name")).toHaveText("late-night");
});

test("the project you leave stays reachable from Recent", async ({ page }) => {
  // Mirrors the native rememberProject(editPath) delta: "Start empty" must not be a
  // one-way door out of the session the picker just described.
  await bootPicker(page);
  await page.getByTestId("v2-picker-new").click();
  await expect(page.getByTestId("v2-empty")).toBeVisible();

  const recents = await page.evaluate(() =>
    ((window as any).__moshStore.getState().snapshot.session.recentProjects ?? []).map((p: any) => p.name));
  expect(recents, "the session we left is gone from Recent").toContain("session");
});

test("NO picker without the dev flag — the guard for every other spec", async ({ page }) => {
  // The picker is gated on being inside the real JUCE WebView, so it is structurally
  // absent from the ~30 other Playwright specs and every vitest. This is the assertion
  // that keeps that true; if it ever fails, the whole suite is about to start failing.
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
  await expect(page.getByTestId("v2-session-picker")).toHaveCount(0);
});

test("the overflow menu carries the project actions, with New gated by a confirm", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: {}, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-timeline")).toBeVisible();

  await page.getByTestId("v2-overflow").click();
  const menu = page.locator('.v2-menu[role="menu"]');
  await expect(menu.locator('[data-action="new_project"]')).toBeVisible();
  await expect(menu.locator('[data-action="open_project"]')).toBeVisible();
  await expect(menu.locator('[data-action="save"]')).toBeVisible();
  await expect(menu.locator('[data-action="save_as"]')).toBeVisible();

  // Mid-session New is gated — nothing happens until the dialog is confirmed.
  await menu.locator('[data-action="new_project"]').click();
  await expect(page.getByTestId("v2-new-project-confirm")).toBeVisible();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(3); // still intact

  await page.getByTestId("v2-new-project-confirm-confirm").click();
  await expect(page.getByTestId("v2-empty")).toBeVisible();
});
