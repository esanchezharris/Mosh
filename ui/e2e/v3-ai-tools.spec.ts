import { test, expect } from "@playwright/test";
import { bootV3, commandTrace } from "./helpers";

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
