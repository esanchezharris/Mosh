import { test, expect, type Page } from "@playwright/test";

// E2E for the guest-Mac graceful-degradation pass (v2 shell, against the in-memory mock
// backend). The mock's default `capabilities` (bridge.mock.ts's list_transform_targets
// case) simulates a fully-equipped dev Mac; these tests drive the degraded (guest)
// posture directly via the dev-only window.__moshStore handle — the same mechanism
// v2-shell.spec.ts uses for multiplayer presence the in-memory mock can't reproduce.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

async function setCapabilities(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const store = (window as unknown as { __moshStore?: { getState: () => { capabilities: Record<string, unknown> }; setState: (s: object) => void } }).__moshStore;
    const current = store?.getState().capabilities ?? {};
    store?.setState({ capabilities: { ...current, ...p } });
  }, patch);
}

test("guest Mac (no transcribe venv): the clip-menu AI actions are disabled with a setup tooltip", async ({ page }) => {
  await bootV2(page);
  const clip = page.locator('[data-testid="v2-clip"][title="chords"]');
  const lyrics = page.getByTestId("clip-build-lyrics");
  const flow = page.getByTestId("clip-build-flow");

  // Confirm the mock-default (fully-equipped) state first — this proves init()'s
  // one-time async loadCapabilities() fetch has already settled, so the override below
  // can't race it (a patch issued while that fetch is still in flight would get clobbered
  // the instant it resolves).
  await clip.click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(lyrics).toBeEnabled();
  await page.keyboard.press("Escape");

  await setCapabilities(page, { transcribe: false });
  await clip.click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(lyrics).toBeVisible();      // progressive disclosure — stays discoverable
  await expect(lyrics).toBeDisabled();
  await expect(lyrics).toHaveAttribute("title", "needs the AI setup — run setup-guest.sh");
  await expect(flow).toBeDisabled();
  await expect(flow).toHaveAttribute("title", "needs the AI setup — run setup-guest.sh");

  const convertToMidi = page.getByRole("menuitem", { name: "Convert to MIDI" });
  await expect(convertToMidi).toBeDisabled();

  // Split/Duplicate/Remove are untouched by the AI-capability gate.
  await expect(page.getByRole("menuitem", { name: "Split here" })).toBeEnabled();
});

test("a fully-equipped Mac (the mock default) keeps the clip-menu AI actions enabled", async ({ page }) => {
  await bootV2(page);
  await page.locator('[data-testid="v2-clip"][title="chords"]').click({ button: "right" });
  await expect(page.getByTestId("v2-clip-menu")).toBeVisible();
  await expect(page.getByTestId("clip-build-lyrics")).toBeEnabled();
  await expect(page.getByTestId("clip-build-flow")).toBeEnabled();
});

test("Build flow from this take shows a working badge, then clears on completion", async ({ page }) => {
  await bootV2(page);
  const clip = page.locator('[data-testid="v2-clip"][title="chords"]');
  await clip.click({ button: "right" });
  await page.getByTestId("clip-build-flow").click();
  // The mock resolves quickly; assert the sheet landed (the store's skeleton_status
  // handler cleared buildingSkeleton on "done" — regression guard for the store gap).
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-lyrics").click();
  await expect(page.getByTestId("lyric-panel")).toHaveAttribute("data-has-sheet", "true");
  await expect(clip.getByTestId("clip-building-skeleton")).toHaveCount(0);
  await expect(page.getByTestId("v2-error")).toHaveCount(0);
});

test("transform target picker shows a preview badge when no real RAVE model is installed", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-create-transform").click();
  await expect(gen.getByTestId("xform-target")).toBeVisible();
  // The mock's default capabilities.transformReal is false (no RAVE model bundled).
  await expect(gen.getByTestId("xform-preview")).toBeVisible();
  await expect(gen.getByTestId("xform-preview")).toHaveText("preview");
});

test("transform target picker hides the preview badge once a real RAVE model is reported", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-track-header").nth(2).click();
  await page.getByTestId("v2-insp-tab-gen").click();
  const gen = page.getByTestId("generative");
  await gen.getByTestId("gen-create-transform").click();
  await expect(gen.getByTestId("xform-target")).toBeVisible();
  // Wait for the initial (mock-default) capabilities fetch to settle before overriding —
  // patching earlier races init()'s one-time async loadCapabilities() call, which would
  // otherwise clobber the override the instant it resolves.
  await expect(gen.getByTestId("xform-preview")).toBeVisible();
  await setCapabilities(page, { transformReal: true });
  await expect(gen.getByTestId("xform-preview")).toHaveCount(0);
});

test("the Type-beat Training popover labels itself preview under the fake backend", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-overflow").click();
  await page.getByTestId("v2-tool-training").click();
  await expect(page.getByTestId("training-preview-badge")).toBeVisible();
  await expect(page.getByTestId("training-preview-badge")).toHaveText("preview");
});

test("the Training popover hides the preview badge once a remote GPU backend is configured", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-overflow").click();
  await page.getByTestId("v2-tool-training").click();
  // Confirm the mock-default (fake) badge first — proves the initial capabilities fetch
  // already settled, so the override below can't race it.
  await expect(page.getByTestId("training-preview-badge")).toBeVisible();
  await setCapabilities(page, { trainingBackend: "remote_http" });
  await expect(page.getByTestId("training-preview-badge")).toHaveCount(0);
});
