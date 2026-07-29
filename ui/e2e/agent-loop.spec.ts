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
  await page.getByTestId("v2-agent-trigger").click();
  await expect(page.getByTestId("v2-agent-panel")).toBeVisible();
});

test("a lofi ask runs as a two-step task in the drawer and one Undo reverts it", async ({ page }) => {
  const lanes = page.getByTestId("v2-lane");
  // The composer renders before the snapshot lands (AppV2 gates only the lane
  // list on it) — anchor on a lane so the baseline count can't read 0.
  await expect(lanes.first()).toBeVisible();
  const lanesBefore = await lanes.count();

  const input = page.getByTestId("agent-input");
  await input.fill("build me a lofi sketch");
  await page.getByTestId("agent-send").click();

  // The drawer opens for the task, then auto-collapses a beat (2.6s) after the
  // clean finish — that collapse is the drawer's contract, so wait it OUT
  // instead of racing the timer with assertions (the mock loop finishes almost
  // instantly, and on a loaded machine the old assert-then-click block could
  // overrun the window and find every drawer element unmounted).
  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(lanes).toHaveCount(lanesBefore + 1); // the pattern's new drum track
  await expect(drawer).toBeHidden({ timeout: 15_000 });

  // The composer face recalls the last task (the designed re-entry after
  // auto-collapse); the reopened drawer never re-arms the collapse timer, so
  // everything below is race-free.
  await page.getByTestId("agent-drawer-toggle").click();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/Moshi done/i)).toBeVisible();
  await expect(page.getByTestId("agent-step-0")).toBeVisible();
  await expect(page.getByTestId("agent-step-1")).toBeVisible();
  await expect(page.getByTestId("agent-plan")).toContainText("lay dusty drums");

  // Undo task — the whole two-step task (tempo + track + notes) is ONE undo unit.
  await page.getByTestId("agent-undo-task").click();
  await expect(lanes).toHaveCount(lanesBefore);
});

test("an unscripted ask parks politely with no steps", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  // vague-taste phrasing so the ROUTER sends it to the loop (a plain short ask
  // stays on the legacy single-shot path by design)
  await input.fill("give the whole thing a better vibe");
  await page.getByTestId("agent-send").click();

  const drawer = page.getByTestId("agent-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText(/needs you/i)).toBeVisible();
  await expect(page.getByTestId("agent-step-0")).toHaveCount(0);
});
