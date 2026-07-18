import { test, expect, type Page } from "@playwright/test";
import { bootV2 } from "./helpers";

// Edge-case regression net for the v2 shell — one describe per sweep lens.
// Born from docs/playtest-prep/EDGECASE_SWEEP_V2_2026-07-18.md; each test cites
// the finding it pins. All state forcing goes through the sanctioned dev-only
// `window.__moshStore` side-channel (same discipline as multiplayer.spec).

type StoreHandle = {
  getState: () => {
    exec: (cmd: string, args?: object) => Promise<unknown>;
    snapshot: { tracks: { id: string; name: string; clips: { id: string; type: string }[] }[] };
    select: (ids: string[]) => void;
    lastError: string | null;
  };
  setState: (s: object) => void;
};

function store(page: Page) {
  return {
    exec: (cmd: string, args: object = {}) =>
      page.evaluate(
        ([c, a]) => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().exec(c as string, a as object),
        [cmd, args] as const,
      ),
    setState: (s: object) =>
      page.evaluate((st) => (window as unknown as { __moshStore: StoreHandle }).__moshStore.setState(st), s),
    snapshot: () =>
      page.evaluate(() => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().snapshot),
    lastError: () =>
      page.evaluate(() => (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState().lastError),
  };
}

test.describe("L1 · overlay/Escape stacking", () => {
  test("overflow menu dismisses on Escape (#41)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-overflow").click();
    await expect(page.getByTestId("v2-overflow-tools")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("v2-overflow-tools")).not.toBeVisible();
    await expect(page.getByTestId("v2-overflow")).toHaveAttribute("aria-expanded", "false");
  });

  test("Escape closes the overflow menu on top, NOT the modal beneath it (#43)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
    // The modal backdrop covers the topbar, so a pointer can't reach ⋯ here; force
    // the menu open via direct DOM click (same component path) to pin the ORDERING
    // property: Escape must pop the most-recently-opened overlay first.
    await page.evaluate(() => (document.querySelector('[data-testid="v2-overflow"]') as HTMLElement).click());
    await expect(page.getByTestId("v2-overflow-tools")).toBeVisible();
    await page.keyboard.press("Escape");
    // topmost only: the menu goes, the MP modal stays
    await expect(page.getByTestId("v2-overflow-tools")).not.toBeVisible();
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mp-launcher-modal")).not.toBeVisible();
  });

  test("join with an unknown room code shows INLINE feedback in the panel (#42)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    await page.getByLabel("Room code to join").fill("JUNK-CODE-999");
    await page.getByTestId("mp-launcher-modal").getByRole("button", { name: "Join", exact: true }).click();
    // 3 tracks in the mock project → the destructive-join confirm gates first
    await page.getByTestId("mp-join-confirm").getByRole("button", { name: "Join anyway" }).click();
    const inline = page.getByTestId("mp-join-error");
    await expect(inline).toBeVisible();
    await expect(inline).toContainText(/no such room/i);
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible(); // still there to retry
    expect(await store(page).lastError()).toMatch(/no such room/i);    // global surface too
  });

  test("piano roll still closes on Escape (stack sanity)", async ({ page }) => {
    await bootV2(page);
    const midiClip = page.locator('[data-clip-id]').filter({ has: page.locator(":scope") }).nth(1);
    await midiClip.dblclick();
    await expect(page.getByRole("dialog", { name: /piano roll/i })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: /piano roll/i })).not.toBeVisible();
  });
});
