import { test, expect, type Page } from "@playwright/test";

// L3 reachability (DAW-parity P5): the v2 Inspector Clip tab makes the shipped clip-edit
// commands — fades (+curves), reverse, normalize, gain, loop region — reachable with a
// mouse. Values are asserted by ROUND-TRIP: the control writes a command, the mock's
// snapshot feeds the control's value back, so a stuck wire (UI shows a value the backend
// never got) fails. Ledger: docs/verification/REACHABILITY.md.

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

async function openClipTab(page: Page) {
  const wave = page.locator(".v2-clip.wave").first();
  await expect(wave).toBeVisible();
  await wave.click();
  await page.getByTestId("v2-insp-tab-clip").click();
}

test.beforeEach(async ({ page }) => {
  await bootV2(page);
});

test("fade in/out sliders + curve selects round-trip through the snapshot", async ({ page }) => {
  await openClipTab(page);
  const fadeIn = page.getByTestId("v2-clip-fadein");
  await expect(fadeIn).toBeVisible();
  await fadeIn.fill("0.5");
  const fadeOut = page.getByTestId("v2-clip-fadeout");
  await fadeOut.fill("1");

  // Curve select is progressive-disclosure alongside the sliders.
  await page.getByTestId("v2-clip-fadeout-curve").selectOption("sCurve");

  // Round-trip: leave the tab and come back — the values must have survived the
  // command → mock state → snapshot → control cycle, not just local input state.
  await page.getByTestId("v2-insp-tab-mix").click();
  await page.getByTestId("v2-insp-tab-clip").click();
  await expect(page.getByTestId("v2-clip-fadein")).toHaveValue("0.5");
  await expect(page.getByTestId("v2-clip-fadeout")).toHaveValue("1");
  await expect(page.getByTestId("v2-clip-fadeout-curve")).toHaveValue("sCurve");
});

test("reverse toggles and survives a tab round-trip", async ({ page }) => {
  await openClipTab(page);
  const rev = page.getByTestId("v2-clip-reverse");
  await expect(rev).toBeVisible();
  const before = await rev.getAttribute("aria-pressed");
  await rev.click();
  await page.getByTestId("v2-insp-tab-mix").click();
  await page.getByTestId("v2-insp-tab-clip").click();
  const after = await page.getByTestId("v2-clip-reverse").getAttribute("aria-pressed");
  expect(after).not.toBe(before);
});

test("normalize moves the clip gain", async ({ page }) => {
  await openClipTab(page);
  const gain = page.getByTestId("v2-clip-gain");
  await expect(gain).toBeVisible();
  const before = await gain.inputValue();
  await page.getByTestId("v2-clip-normalize").click();
  // The seeded mock clip normalizes to a non-zero gain; the slider reflects it.
  await expect.poll(async () => page.getByTestId("v2-clip-gain").inputValue()).not.toBe(before);
});

test("normalize stays fully reachable inside the production-width Inspector", async ({ page }) => {
  await openClipTab(page);
  const body = page.getByTestId("v2-insp-body");
  const normalize = page.getByTestId("v2-clip-normalize");
  await expect(normalize).toBeVisible();

  // Regression for #534: the number input kept its browser intrinsic width, making the
  // Normalize row wider than the 286px rail. Playwright/Accessibility could still
  // activate the off-screen button by silently horizontal-scrolling the whole WebView,
  // which hid the native production failure. Pin the pre-activation geometry instead.
  const geometry = await body.evaluate((element, button) => {
    const panel = element.getBoundingClientRect();
    const action = (button as HTMLElement).getBoundingClientRect();
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      panelRight: panel.right,
      actionRight: action.right,
    };
  }, await normalize.elementHandle());
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
  expect(geometry.actionRight).toBeLessThanOrEqual(geometry.panelRight + 0.5);
});

test("loop region: toggle discloses start/length and round-trips", async ({ page }) => {
  await openClipTab(page);
  await expect(page.getByTestId("v2-clip-loop-start")).toHaveCount(0); // progressive disclosure
  await page.getByTestId("v2-clip-loop").click();
  await expect(page.getByTestId("v2-clip-loop-start")).toBeVisible();
  await page.getByTestId("v2-clip-loop-length").fill("1");
  await page.getByTestId("v2-insp-tab-mix").click();
  await page.getByTestId("v2-insp-tab-clip").click();
  await expect(page.getByTestId("v2-clip-loop")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("v2-clip-loop-length")).toHaveValue("1");
});
