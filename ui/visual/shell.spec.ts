// Screenshot baselines for the REAL v2 shell, dark + light.
//
// The existing visual gate covers the token sheet and a drifted-consumers sheet — the design
// SYSTEM. Neither renders the shell, so composition, density and hierarchy had no coverage at
// all: a change could restyle every surface in the app and this suite would stay green. These
// shots close that hole, and they are also the before-state for the de-slop work.
//
// Runs as the `shell` project (see playwright.visual.config.ts) against a production Vite build
// with the mock explicitly enabled — NOT Storybook, which cannot render the shell at all. The
// reasoning is in shellFixture.ts.

import { test, expect } from "@playwright/test";
import { bootShell, shot, stillness, type Theme } from "./shellFixture";

const THEMES: Theme[] = ["dark", "light"];

for (const theme of THEMES) {
  test.describe(`v2 shell — ${theme}`, () => {
    test(`rest — ${theme}`, async ({ page }) => {
      await bootShell(page, theme);
      await shot(page, "shell-rest", theme);
    });

    test(`clip selected, inspector open — ${theme}`, async ({ page }) => {
      await bootShell(page, theme);
      await page.locator(".v2-clip").first().click();
      await page.getByTestId("v2-inspector").waitFor();
      await shot(page, "shell-selected", theme);
    });

    test(`left browser open — ${theme}`, async ({ page }) => {
      await bootShell(page, theme);
      await page.getByTestId("v2-browser-pull").click();
      await page.getByTestId("v2-browser-drawer").waitFor();
      await shot(page, "shell-browser", theme);
    });

    test(`overflow menu open — ${theme}`, async ({ page }) => {
      await bootShell(page, theme);
      await page.getByTestId("v2-overflow").click();
      await page.getByTestId("v2-overflow-tools").waitFor();
      await shot(page, "shell-overflow", theme);
    });

    test(`piano roll open — ${theme}`, async ({ page }) => {
      await bootShell(page, theme);
      // The Bass clip is the MIDI one in the seeded session; double-click opens the editor.
      await page.locator(".v2-clip.midi").first().dblclick();
      await page.getByTestId("piano-roll").waitFor();
      await stillness(page);
      await shot(page, "shell-pianoroll", theme);
    });

    // The agentic surface. Worth its own baseline because it is the one place the design
    // deliberately KEEPS the bright accent and motion — so it is exactly where an over-eager
    // "remove the lime everywhere" pass would do damage without any other shot noticing.
    //
    // The drawer is progressive-disclosure: `agent-drawer-toggle` only renders once a task
    // exists (Composer.tsx), so there is nothing to click at boot. Reaching it the way a user
    // does — an ask that runs as a task — via the deterministic loopBrainMock the agent-loop
    // spec already relies on. `agenticLoop` must be on for that path to exist.
    test(`agent drawer open — ${theme}`, async ({ page }) => {
      await bootShell(page, theme, { agenticLoop: true });
      await page.getByTestId("agent-input").fill("build me a lofi sketch");
      await page.getByTestId("agent-send").click();
      await page.getByTestId("agent-drawer").waitFor();
      await page.getByTestId("agent-step-0").waitFor();
      // Let the scripted steps run to completion so the drawer is in its settled end state
      // rather than mid-run, which would differ frame to frame.
      await expect(page.getByTestId("agent-undo-task")).toBeVisible({ timeout: 20_000 });
      await shot(page, "shell-agent", theme);
    });
  });
}
