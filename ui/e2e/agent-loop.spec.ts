// Phase-B agentic loop, end-to-end on the v2 shell + dev mock: the composer ask
// becomes a multi-step task (the deterministic loopBrainMock script — the brain
// proxy is unreachable under Playwright), the drawer docks above the composer
// with live chips, and ONE "Undo task" reverts the whole thing.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null,
      values: { theme: "dark", agenticLoop: true },
      keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-composer")).toBeVisible();
});

test("a lofi ask runs as a two-step task in the drawer and one Undo reverts it", async ({ page }) => {
  const lanes = page.getByTestId("v2-lane");
  const lanesBefore = await lanes.count();

  const input = page.getByTestId("agent-input");
  await input.fill("build me a lofi sketch");
  await page.getByTestId("agent-send").click();

  // The drawer appears and the two steps land as chips.
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("agent-step-0")).toBeVisible();
  await expect(page.getByTestId("agent-step-1")).toBeVisible();
  await expect(drawer.getByText(/Moshi done/i)).toBeVisible();
  await expect(page.getByTestId("agent-plan")).toContainText("lay dusty drums");
  await expect(lanes).toHaveCount(lanesBefore + 1); // the pattern's new drum track

  // Undo task — the whole two-step task (tempo + track + notes) is ONE undo unit.
  await page.getByTestId("agent-undo-task").click();
  await expect(lanes).toHaveCount(lanesBefore);
});

test("an unscripted ask parks politely with no steps", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("do the mysterious thing");
  await page.getByTestId("agent-send").click();

  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/needs you/i)).toBeVisible();
  await expect(page.getByTestId("agent-step-0")).toHaveCount(0);
});
