import { test, expect } from "@playwright/test";
import { bootV3, bootV3Start, commandTrace } from "./helpers";

// Optional AI tools (docs/AI-TOOLS-OPTIONAL-BRIEF-2026-11-02.md). A friend's Mac has no
// Python, no Beatbox venv and no Stable Audio 3 (?mockAiTools=off): nothing generative is
// offered, and asking Moshi for a beat gets a plain answer instead of a dead end. The
// default mock is the owner's Mac, where every surface is still there (the control).

async function audioRow(page: Parameters<typeof bootV3>[0]) {
  await page.getByTestId("v3-import-audio").click();
  const browser = page.getByTestId("v3-browser");
  await expect(browser.getByText("kick.wav", { exact: true })).toBeVisible();
  return browser;
}

async function selectChords(page: Parameters<typeof bootV3>[0]) {
  const source = page.getByRole("button", { name: "chords, audio clip", exact: true });
  await source.focus(); await page.keyboard.press("Enter");
  await expect(source).toHaveAttribute("aria-pressed", "true");
}

test("a Mac without AI tools offers no generative surface, and the dock says why", async ({ page }) => {
  await bootV3(page, "mockAiTools=off");

  await expect(page.getByTestId("v3-phone-trigger")).toBeVisible();        // the TopBar is there
  await expect(page.getByTestId("v3-training-trigger")).toHaveCount(0);   // no LoRA

  await selectChords(page);
  await expect(page.getByTestId("v3-reimagine-open")).toHaveCount(0);     // no Re-Imagine

  const browser = await audioRow(page);
  await expect(browser.getByTestId("sample-row").first()).toBeVisible();
  await expect(browser.getByTestId("sample-sketch-beatbox")).toHaveCount(0); // no Beatbox → beat

  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();
  await expect(page.getByTestId("v3-moshi-dock")).toContainText("That needs AI tools");
  const trace = (await commandTrace(page)).map((e) => e.command);
  expect(trace.length).toBeGreaterThan(0);   // anti-vacuity: the trace is recording
  for (const c of ["generate_beat_recipe", "list_colors", "list_loras", "list_transform_targets"]) expect(trace).not.toContain(c);
});

test("control: the owner's Mac keeps every generative surface", async ({ page }) => {
  await bootV3(page);
  await expect(page.getByTestId("v3-training-trigger")).toBeVisible();
  await selectChords(page);
  await expect(page.getByTestId("v3-reimagine-open")).toBeEnabled();
  const browser = await audioRow(page);
  await expect(browser.getByTestId("sample-sketch-beatbox").first()).toBeVisible();
});

// "Add AI tools" (§5.4): the Start page's Ready step offers the setup under Go to the Booth;
// ?mockFault=ai-install-fail fails the beatbox step once, as native would on a network error.
test("Start page: a failed install says why, never blocks the Booth, and Try again finishes it", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "ai-install-fail", aiToolsOff: true });
  await page.getByTestId("v3-start-new").click();
  await page.getByTestId("v3-start-skip-beat").click();
  await page.getByTestId("v3-start-ready").click();
  await expect(page.getByTestId("v3-start")).toHaveAttribute("data-step", "ready");

  const offer = page.getByTestId("v3-start-ai-tools");
  await expect(offer).toContainText("About 0.8 GB");
  await page.getByTestId("v3-start-ai-tools-open").click();
  await page.getByTestId("v3-ai-tools-install").click();
  const card = page.getByTestId("v3-ai-tools-card");
  await expect(card).toHaveAttribute("data-phase", "failed");
  await expect(page.getByTestId("v3-ai-tools-error")).toContainText("Couldn't install the beatbox tool. Check your internet and try again.");
  await expect(page.getByTestId("v3-ai-tools-detail")).toContainText("librosa");
  await expect(page.getByTestId("v3-start-go-booth")).toBeEnabled();

  await page.getByTestId("v3-ai-tools-install").click();
  await expect(card).toHaveAttribute("data-phase", "installing");
  await expect(page.getByTestId("v3-start-go-booth")).toBeEnabled();
  await expect(page.getByTestId("v3-ai-tools-done")).toBeVisible();

  await page.getByTestId("v3-start-go-booth").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
});

test("the dock's 'That needs AI tools' reply opens the setup; Settings then offers Remove", async ({ page }) => {
  await bootV3(page, "mockAiTools=off");
  await page.getByTestId("v3-moshi-field").fill("build me a lofi sketch");
  await page.getByTestId("v3-moshi-send").click();
  await page.getByTestId("v3-ai-tools-offer").click();
  await expect(page.getByTestId("v3-ai-tools-modal")).toBeVisible();
  await page.getByTestId("v3-ai-tools-install").click();
  await expect(page.getByTestId("v3-ai-tools-done")).toBeVisible();
  await page.getByTestId("v3-ai-tools-close").click();
  await expect(page.getByTestId("v3-ai-tools-modal")).toHaveCount(0);

  // The tools are on now: Beatbox → beat is offered in Files.
  const browser = await audioRow(page);
  await expect(browser.getByTestId("sample-sketch-beatbox").first()).toBeVisible();

  // Settings → AI tools: On, with Remove; removing hides Beatbox → beat again.
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-open-settings").click();
  const row = page.getByTestId("v3-ai-tools-settings");
  await expect(page.getByTestId("v3-ai-tools-state")).toHaveText("On");
  await row.getByTestId("v3-ai-tools-remove").click();
  await expect(page.getByTestId("v3-ai-tools-state")).toHaveText("Not installed");
  await expect(row.getByTestId("v3-ai-tools-settings-install")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(browser.getByTestId("sample-sketch-beatbox")).toHaveCount(0);
});
