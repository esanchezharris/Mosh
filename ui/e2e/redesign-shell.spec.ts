import { test, expect, type Page } from "@playwright/test";

// The redesign shell (Inspector right rail) is gated behind the default-off
// `redesignShell` setting. Seed it on before boot, the way hands-free.spec seeds a
// single setting override.
async function bootRedesign(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { redesignShell: true } }));
  });
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

test("flag on: the Session rail is open by default with Moshi + inspector", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("dock-right")).toBeVisible();
  await expect(page.getByTestId("session-rail")).toBeVisible();
  await expect(page.getByTestId("participant-moshi")).toBeVisible();
  await expect(page.getByTestId("inspector")).toBeVisible();
});

test("flag off (default): no Inspector rail", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("inspector-expand")).toHaveCount(0);
});

test("flag on: Inspector shows the selected track's mix controls", async ({ page }) => {
  await bootRedesign(page);
  await page.getByTestId("track-header").first().click();
  const insp = page.getByTestId("inspector");
  await expect(insp).toBeVisible();
  await expect(insp.getByText("Volume", { exact: true })).toBeVisible();
  await expect(insp.getByText("Pan", { exact: true })).toBeVisible();
});

test("flag on: top-right presence cluster (AI pill + Share)", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("presence")).toBeVisible();
  await expect(page.getByTestId("ai-pill")).toBeVisible();
  await expect(page.getByTestId("share")).toBeVisible();
});

test("flag off (default): no presence cluster", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("presence")).toHaveCount(0);
});

test("flag on: a track's FX drawer opens from the header and collapses again", async ({ page }) => {
  await bootRedesign(page);
  const toggle = page.getByTestId("track-fx-toggle").first();
  await expect(toggle).toBeVisible();
  await expect(page.getByTestId("fx-drawer")).toHaveCount(0);
  await toggle.click();
  const drawer = page.getByTestId("fx-drawer").first();
  await expect(drawer).toBeVisible();
  await expect(drawer.getByRole("button", { name: "+ Plugin", exact: true })).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId("fx-drawer")).toHaveCount(0);
});

test("flag off (default): no per-track FX toggle", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("track-fx-toggle")).toHaveCount(0);
});

test("flag on: the agent prompt lives in a dedicated bottom bar", async ({ page }) => {
  await bootRedesign(page);
  const bar = page.getByTestId("promptbar");
  await expect(bar).toBeVisible();
  await expect(bar.locator(".agent-composer")).toBeVisible();
});

test("flag off (default): no bottom prompt bar (prompt stays in the Moshi dock)", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("promptbar")).toHaveCount(0);
});

test("flag on: section navigator shows sections, adds one, and has zoom presets", async ({ page }) => {
  await bootRedesign(page);
  const nav = page.getByTestId("section-nav");
  await expect(nav).toBeVisible();
  await expect(page.getByTestId("section-seg")).toHaveCount(3); // seeded Intro / Verse / Hook
  await page.getByTestId("section-add").click();
  await expect(page.getByTestId("section-seg")).toHaveCount(4);
  await expect(nav.getByRole("button", { name: "8B", exact: true })).toBeVisible();
});

test("flag off (default): no section navigator", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("section-nav")).toHaveCount(0);
});

test("flag on: collapsing the Session rail keeps Moshi mounted (not torn down)", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("participant-moshi")).toBeVisible();
  await expect(page.getByTestId("moshi-stage")).toHaveCount(1);
  // Collapse via the divider double-click.
  await page.getByTestId("dock-rdivider").dblclick();
  await expect(page.getByTestId("inspector-expand")).toBeVisible(); // collapsed → edge tab
  await expect(page.getByTestId("dock-right")).toBeHidden();         // panel hidden, NOT removed
  await expect(page.getByTestId("moshi-stage")).toHaveCount(1);      // Moshi survives the collapse
  // Re-expand.
  await page.getByTestId("inspector-expand").click();
  await expect(page.getByTestId("dock-right")).toBeVisible();
  await expect(page.getByTestId("moshi-stage")).toHaveCount(1);
});

test("flag on: the bottom dock is gone; generative lives in the Inspector", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("dock")).toHaveCount(0); // bottom dock removed
  await expect(page.getByTestId("inspector").getByTestId("generative")).toBeVisible();
});

test("flag off (default): the bottom dock is present", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("dock")).toBeVisible();
});

test('flag on: the "+" control consolidates file/options/export (topbar drops File + Export)', async ({ page }) => {
  await bootRedesign(page);
  const plus = page.getByTestId("file-options");
  await expect(plus).toBeVisible();
  // The classic topbar File menu + Export popover are gone — the "+" owns them now.
  await expect(page.locator(".topbar-tools").getByRole("button", { name: "File", exact: true })).toHaveCount(0);

  await plus.click();
  const menu = page.getByTestId("file-options-menu");
  await expect(menu.getByText("New", { exact: true })).toBeVisible();
  await expect(menu.getByText("Save", { exact: true })).toBeVisible();
  await expect(page.getByTestId("export-run")).toBeVisible(); // shared Export controls
});

test('flag on: the "+" Settings sub-panel swaps in and back', async ({ page }) => {
  await bootRedesign(page);
  await page.getByTestId("file-options").click();
  await page.getByTestId("fo-settings").click();
  const head = page.locator(".fo-sub-head");
  await expect(head).toContainText("Settings");
  await head.getByRole("button", { name: "Back" }).click();
  // Back to the file actions.
  await expect(page.getByTestId("file-options-menu")).toBeVisible();
});

test('flag off (default): no "+" control; the topbar keeps File + Export', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("file-options")).toHaveCount(0);
  await expect(page.locator(".topbar-tools").getByRole("button", { name: "File", exact: true })).toBeVisible();
});

test("flag on: annotation ruler shows the seeded pin and a double-click adds one", async ({ page }) => {
  await bootRedesign(page);
  const strip = page.getByTestId("annotation-ruler");
  await expect(strip).toBeVisible();
  await expect(page.getByTestId("annotation-pin")).toHaveCount(1); // seeded "tighten this transition"

  page.once("dialog", (d) => d.accept("smooth the build")); // window.prompt for the new note
  await strip.dblclick({ position: { x: 300, y: 6 } });
  await expect(page.getByTestId("annotation-pin")).toHaveCount(2);
});

test("flag on: clicking a pin opens it with its author and can delete it", async ({ page }) => {
  await bootRedesign(page);
  await page.getByTestId("annotation-pin").first().locator(".annotation-flag").click();
  const pop = page.locator(".annotation-pop");
  await expect(pop).toBeVisible();
  await expect(pop).toContainText("tighten this transition");
  await expect(pop).toContainText("you"); // author tag
  await pop.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByTestId("annotation-pin")).toHaveCount(0);
});

test("flag on: clicking the annotation strip still seeks the ruler beneath it (no dead-zone)", async ({ page }) => {
  await bootRedesign(page);
  await expect(page.getByTestId("position")).toHaveText("1.1.1"); // parked at start
  // A bare-strip click must bubble through to the ruler's seek (the strip only swallows pins).
  await page.getByTestId("annotation-ruler").click({ position: { x: 420, y: 6 } });
  await expect(page.getByTestId("position")).not.toHaveText("1.1.1");
});

test("flag off (default): no annotation ruler", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/");
  await expect(page.getByTestId("arrangement")).toBeVisible();
  await expect(page.getByTestId("annotation-ruler")).toHaveCount(0);
});
