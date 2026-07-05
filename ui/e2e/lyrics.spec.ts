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

// ── L2: the generation loop — Finish gaps → proposals → accept/reject/regenerate ──

async function seedGappedLine(page: Page) {
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-add-line").click();
  await page.getByTestId("lyric-line-0").getByLabel("line 1", { exact: true }).fill("they counted me out ___ ___");
  await page.getByTestId("lyric-panel").getByText("Lyrics", { exact: true }).click(); // blur
}

test("Finish gaps generates ranked proposals; accept commits one", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await seedGappedLine(page);
  await page.getByTestId("lyric-finish").click();
  const props = page.getByTestId("lyric-proposals-0");
  await expect(props).toBeVisible();
  await expect(props.getByTestId(/lyric-prop-0-/)).not.toHaveCount(0);
  // accept the top proposal → it commits into the line and the proposals clear
  await page.getByTestId("lyric-accept-0-0").click();
  await expect(page.getByTestId("lyric-line-0")).toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("lyric-proposals-0")).toHaveCount(0);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("reject clears the proposals", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await seedGappedLine(page);
  await page.getByTestId("lyric-finish").click();
  await expect(page.getByTestId("lyric-proposals-0")).toBeVisible();
  await page.getByTestId("lyric-reject-0").click();
  await expect(page.getByTestId("lyric-proposals-0")).toHaveCount(0);
});

test("suggest line shows an inline ghost; Tab accepts it", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-suggest").click();
  // The next-bar suggestion lands as a greyed inline ghost (NOT the full proposal block).
  const ghost = page.getByTestId("ghost-line-0");
  await expect(ghost).toBeVisible();
  await expect(page.getByTestId("lyric-proposals-0")).toHaveCount(0);
  // Tab accepts the ghost → it commits into the line and the ghost is gone.
  await page.getByTestId("ghost-text-0").press("Tab");
  await expect(page.getByTestId("lyric-line-0")).toHaveAttribute("data-status", "accepted");
  await expect(page.getByTestId("ghost-line-0")).toHaveCount(0);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("the inline ghost is dismissed with Esc (the line is removed)", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-suggest").click();
  await expect(page.getByTestId("ghost-line-0")).toBeVisible();
  // Esc dismisses → the greyed ghost vanishes and no committed line is left behind.
  await page.getByTestId("ghost-text-0").press("Escape");
  await expect(page.getByTestId("ghost-line-0")).toHaveCount(0);
  await expect(page.getByTestId("lyric-lines").getByRole("listitem")).toHaveCount(0);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

// ── L1: the precise flow visualizer — Analyze flow → stress + rhyme grade per line ──

test("Analyze flow draws precise per-line phonology (syllables + rhyme grade)", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  await page.getByTestId("lyric-add-line").click();
  await page.getByTestId("lyric-line-0").getByLabel("line 1", { exact: true }).fill("lighting up the flame");
  await page.getByTestId("lyric-panel").getByText("Lyrics", { exact: true }).click(); // blur
  // No visualizer before analysis…
  await expect(page.getByTestId("flow-viz-0")).toHaveCount(0);
  await page.getByTestId("lyric-analyze").click();
  // …then the precise read appears: the syllable count and the visualizer row. The
  // editor commits typed bars to the SEED (finalized text is set only on accept), so
  // a typed line analyzes as "seed".
  const viz = page.getByTestId("flow-viz-0");
  await expect(viz).toBeVisible();
  await expect(page.getByTestId("flow-syl-0")).toContainText("/16");
  await expect(viz).toHaveAttribute("data-analyzed", "seed");
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

// ── §7: the "Sound like me" style-RAG opt-in toggles + persists ────────────────────

test("the style-RAG 'Sound like me' opt-in toggles on", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await page.getByTestId("lyric-create").click();
  const box = page.getByTestId("lyric-stylebias").getByRole("checkbox");
  await expect(box).not.toBeChecked();
  await box.check();
  await expect(box).toBeChecked();
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

// ── Phase 3: the audio "mumble take" — right-click a vocal take → auto-build a sheet ──

test("right-click a wave take → Build lyrics from this take → a sheet appears", async ({ page }) => {
  await bootV2(page);
  // The seed's only wave clip is "chords" (on track index 2); the menu item is wave-only.
  await page.locator('[data-testid="v2-clip"][title="chords"]').click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-build-lyrics")).toBeVisible();
  await page.getByTestId("clip-build-lyrics").click();
  // The mock transcribes+analyzes, then lands a sheet on the clip's OWN track. Open it.
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-lyrics").click();
  await expect(page.getByTestId("lyric-panel")).toHaveAttribute("data-has-sheet", "true");
  await expect(page.getByTestId("lyric-lines").getByRole("listitem")).toHaveCount(2);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("a MIDI clip does NOT offer 'Build lyrics from this take'", async ({ page }) => {
  await bootV2(page);
  await page.locator('[data-testid="v2-clip"][title="loop"]').click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-build-lyrics")).toHaveCount(0);
});

test("accepting a proposal grows the 'in your voice' corpus count", async ({ page }) => {
  await bootV2(page);
  await openLyrics(page);
  await seedGappedLine(page);
  // No corpus chip before any accept.
  await expect(page.getByTestId("lyric-corpus-count")).toHaveCount(0);
  await page.getByTestId("lyric-finish").click();
  await page.getByTestId("lyric-accept-0-0").click();
  // The accept auto-accumulates → the readout appears.
  await expect(page.getByTestId("lyric-corpus-count")).toContainText("in your voice");
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

// ── Phase 2: the mumble->skeleton flow — right-click a hummed take → editable grid → confirm ──

test("right-click a wave take → Build flow from this take → an editable grid → confirm", async ({ page }) => {
  await bootV2(page);
  await page.locator('[data-testid="v2-clip"][title="chords"]').click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-build-flow")).toBeVisible();
  await page.getByTestId("clip-build-flow").click();
  // The mock lands a WORDLESS `proposed` skeleton on the clip's OWN track. Open it.
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-lyrics").click();
  await expect(page.getByTestId("lyric-panel")).toHaveAttribute("data-has-sheet", "true");
  // The grid editor: a confirm bar + per-line editable syllable counts (no text input yet).
  await expect(page.getByTestId("skeleton-confirm-bar")).toBeVisible();
  await expect(page.getByTestId("skeleton-line-0")).toBeVisible();
  // Extraction (pipeline correction): the line the take REALLY sang lands verbatim with
  // the "sung" provenance badge — his words survive, visibly.
  await expect(page.getByTestId("lyric-origin-2")).toHaveAttribute("data-origin", "sung");
  await expect(page.getByTestId("lyric-line-2")).toContainText("♪ sung");
  const before = (await page.getByTestId("skel-count-0").textContent()) ?? "";
  await page.getByTestId("skel-inc-0").click();   // nudge the syllable target up
  await expect(page.getByTestId("skel-count-0")).not.toHaveText(before);
  // Confirm the grid → lines flip proposed→seed (editor gone) and "Finish gaps" lights up.
  await page.getByTestId("skeleton-confirm").click();
  await expect(page.getByTestId("skeleton-confirm-bar")).toHaveCount(0);
  await expect(page.getByTestId("skeleton-line-0")).toHaveCount(0);
  await expect(page.getByTestId("lyric-finish")).toBeEnabled();
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("a MIDI clip does NOT offer 'Build flow from this take'", async ({ page }) => {
  await bootV2(page);
  await page.locator('[data-testid="v2-clip"][title="loop"]').click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-build-flow")).toHaveCount(0);
});

// ── Phase 3 Stage 2: sing mode — the sheet + take flow render in the generative drawer ──

test("sing mode: build a flow → + Sing → guide render → accept", async ({ page }) => {
  await bootV2(page);
  await page.locator('[data-testid="v2-clip"][title="chords"]').click({ button: "right" });
  await page.getByTestId("clip-build-flow").click();
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-lyrics").click();
  await expect(page.getByTestId("lyric-panel")).toHaveAttribute("data-has-sheet", "true");

  // The Gen tab offers "+ Sing" only once the track carries a lyric sheet.
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  const singBtn = gen.getByTestId("gen-create-sing");
  await expect(singBtn).toBeVisible();
  await singBtn.click();

  // SingControls: flow coverage from the take + the locked-to-self enrollment copy.
  await expect(gen.getByTestId("sing-flow")).toContainText("3/3");
  await expect(gen.getByTestId("sing-voice")).toContainText("not enrolled");

  await gen.getByTestId("gen-render").click();
  await expect(gen.getByTestId("render-status")).toHaveText("ready");
  const accept = gen.getByTestId("gen-accept");
  await expect(accept).toBeEnabled();
  await accept.click();
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("sing without a sheet is not offered (+ Sing hidden)", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").nth(0).click();
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  await expect(gen.getByTestId("gen-create")).toBeVisible();
  await expect(gen.getByTestId("gen-create-sing")).toHaveCount(0);
});
