import { test, expect, type Page } from "@playwright/test";

// AGT-MEM (M4) — the pattern-library save affordances, end-to-end on the v2 shell + dev
// mock: "Save pattern to memory" on a drum clip's context menu, and "Save flow to
// memory" in the Lyrics tab. Both land in the SAME memory panel M3 shipped
// (TopbarTools.tsx's MemoryTool), under the drum_pattern / lyric_framework tiers.

async function bootV2(page: Page, agentMemory = true): Promise<void> {
  await page.addInitScript((flag: boolean) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { theme: "dark", agentMemory: flag }, keyOverrides: {},
    }));
  }, agentMemory);
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

async function openMemoryPanel(page: Page): Promise<void> {
  await page.getByLabel("More tools").click();
  await page.getByLabel("What Moshi remembers").click();
  await expect(page.getByText("What Moshi remembers")).toBeVisible();
}

test("Save pattern to memory: a drum clip's context menu writes it, shows a toast, and it lands in the memory panel", async ({ page }) => {
  await bootV2(page);
  // Seed track 0 ("Drums") carries a real drum clip ("loop") with kick/snare/hat notes.
  const clip = page.getByTestId("v2-clip").first();
  await clip.click({ button: "right" });
  const menu = page.getByTestId("v2-clip-menu");
  await expect(menu).toBeVisible();
  const saveBtn = menu.getByTestId("clip-save-pattern");
  await expect(saveBtn).toBeVisible();
  await saveBtn.click();

  const toast = page.getByTestId("v2-memory-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("pattern");

  await openMemoryPanel(page);
  const tier = page.getByTestId("memory-tier-drum_pattern");
  await expect(tier).toContainText("loop"); // the clip's own name became the card's name
  await expect(tier).toContainText("kick:"); // the verbatim lane syntax, not raw JSON
  await expect(tier).not.toContainText("{\"name\""); // never raw JSON in the panel
});

test("Save pattern to memory does not appear on a non-drum clip's menu", async ({ page }) => {
  await bootV2(page);
  // Seed track 1+ carries melodic content (bass line, pitches below the drum range) —
  // find a clip that is NOT the drum "loop" clip by targeting a later track's lane.
  const clips = page.getByTestId("v2-clip");
  const count = await clips.count();
  let sawNonDrumMenu = false;
  for (let i = 0; i < count; i++) {
    await clips.nth(i).click({ button: "right" });
    const menu = page.getByTestId("v2-clip-menu");
    await expect(menu).toBeVisible();
    const hasSave = await menu.getByTestId("clip-save-pattern").count();
    await page.keyboard.press("Escape");
    if (hasSave === 0) { sawNonDrumMenu = true; break; }
  }
  expect(sawNonDrumMenu).toBe(true);
});

test("Save flow to memory: a lyric sheet's structure writes it, shows a toast, and it lands in the memory panel", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-add-line").click();
  await page.getByTestId("lyric-add-line").click();

  const saveBtn = page.getByTestId("lyric-save-flow");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();

  const toast = page.getByTestId("v2-memory-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("flow");

  await openMemoryPanel(page);
  const tier = page.getByTestId("memory-tier-lyric_framework");
  await expect(tier).toContainText("grid");
  // Structure only — the sheet has no typed words yet, but even if it did, the panel
  // must never be able to show lyric TEXT for this tier (only role/syllables/rhyme).
  await expect(tier).not.toContainText("verse 1");
});

test("Save flow to memory is disabled with an empty sheet (nothing to derive structure from)", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await expect(page.getByTestId("lyric-save-flow")).toBeDisabled();
});

test("both save affordances are unreachable when the agentMemory setting is off", async ({ page }) => {
  await bootV2(page, false);

  const clip = page.getByTestId("v2-clip").first();
  await clip.click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-save-pattern")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await expect(page.getByTestId("lyric-save-flow")).toHaveCount(0);
});
