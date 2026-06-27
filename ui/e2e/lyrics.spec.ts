import { test, expect, type Page } from "@playwright/test";

// E2E for the Finish-My-Song Lyrics tab (v2 shell) — driven against the in-memory mock
// backend (the same command/snapshot contract the native engine exposes). Covers L0:
// create a per-track sheet, write a line, the LIVE flow meter, and the rhyme tool.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

async function openLyrics(page: Page): Promise<void> {
  await page.getByTestId("v2-track-header").first().click();
  await expect(page.getByTestId("v2-inspector")).toBeVisible();
  await page.getByTestId("v2-insp-tab-lyrics").click();
  await expect(page.getByTestId("lyric-panel")).toBeVisible();
}

test("the Lyrics tab shows an empty state, then + Write Lyrics creates a sheet", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  const panel = page.getByTestId("lyric-panel");
  await expect(panel).not.toHaveAttribute("data-has-sheet", "true");
  await expect(panel.getByTestId("lyric-create")).toBeVisible();
  await panel.getByTestId("lyric-create").click();
  await expect(page.getByTestId("lyric-panel")).toHaveAttribute("data-has-sheet", "true");
  await expect(page.getByTestId("lyric-add-line")).toBeVisible();
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("adding a line shows the live flow meter (syllables vs the grid)", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-add-line").click();
  const row = page.getByTestId("lyric-line-0");
  await expect(row).toBeVisible();
  // Type bars; blur commits the seed and the flow meter recomputes locally (no round-trip).
  await row.getByLabel("line 1", { exact: true }).fill("yeah I came back lit the flame");
  await page.getByTestId("lyric-panel").getByText("Lyrics", { exact: true }).click(); // blur
  // 1/16 grid ⇒ target 16; the meter renders "<count>/16".
  await expect(page.getByTestId("flow-0")).toContainText("/16");
});

test("the rhyme tool returns ranked candidates (phonology, no LLM)", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  const tool = page.getByTestId("rhyme-tool");
  await tool.getByLabel("Rhyme word").fill("flame");
  await tool.getByTestId("rhyme-go").click();
  await expect(page.getByTestId("rhyme-results")).toBeVisible();
  await expect(page.getByTestId("rhyme-results")).toContainText("name");
});

test("a lyric line can be removed", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-add-line").click();
  await page.getByTestId("lyric-add-line").click();
  await expect(page.getByTestId("lyric-lines").getByRole("listitem")).toHaveCount(2);
  await page.getByTestId("lyric-rm-0").click();
  await expect(page.getByTestId("lyric-lines").getByRole("listitem")).toHaveCount(1);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});
