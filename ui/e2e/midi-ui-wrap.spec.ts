import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2,
      template: null,
      values: { theme: "dark" },
      keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

test("a real file drag imports a new audio clip", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CDP file drag is Chromium-only");
  await bootV2(page);
  const before = await page.locator('[data-testid="v2-lane"] [data-testid="v2-clip"]').count();
  const timeline = page.getByTestId("v2-timeline");
  const box = await timeline.boundingBox();
  if (!box) throw new Error("timeline has no bounds");

  const fixture = path.resolve("../resources/drumkits/mosh-kit/kick.wav");
  const client = await page.context().newCDPSession(page);
  const data = { items: [], files: [fixture], dragOperationsMask: 1 };
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await client.send("Input.dispatchDragEvent", { type: "dragEnter", ...point, data });
  await expect(page.getByTestId("v2-drop")).toBeVisible();
  await client.send("Input.dispatchDragEvent", { type: "dragOver", ...point, data });
  await client.send("Input.dispatchDragEvent", { type: "drop", ...point, data });

  await expect(page.locator('[data-testid="v2-lane"] [data-testid="v2-clip"]')).toHaveCount(before + 1);
  await expect(page.getByTestId("v2-clip").filter({ hasText: "kick" })).toBeVisible();
});

test("MIDI conversion exposes adaptive grid and triplet drum modes", async ({ page }) => {
  await bootV2(page);

  const waveClip = page.getByTestId("v2-clip").filter({ hasText: "chords" });
  await waveClip.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Convert to MIDI" }).click();
  await expect(page.getByTestId("v2-track-header")).toHaveCount(4);

  const converted = page.getByTestId("v2-clip").filter({ hasText: "MIDI • chords" });
  await expect(converted).toBeVisible();
  await page.getByRole("button", { name: "Adaptive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Adaptive", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("combobox", { name: "Grid division" }).selectOption("1/8T");
  await expect(page.getByRole("combobox", { name: "Grid division" })).toHaveValue("1/8T");

  const timeline = page.getByTestId("v2-timeline");
  const morphSurface = timeline.locator("[data-mix-morph]");
  await expect(morphSurface).toHaveAttribute("data-mix-morph", "0.00");
  await timeline.evaluate((el) => {
    el.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -220, altKey: true }));
  });
  await expect(morphSurface).toHaveAttribute("data-mix-morph", "0.12");

  const drumClip = page.getByTestId("v2-clip").filter({ hasText: "loop" });
  await drumClip.click();
  await page.getByTestId("v2-insp-tab-midi").click();
  await page.getByTestId("v2-open-drumgrid").click();
  const drumWindow = page.getByRole("dialog", { name: /Drum Machine/ });
  await expect(drumWindow).toBeVisible();
  const steps = drumWindow.getByRole("combobox", { name: "Pattern length (steps)" });
  await expect(steps.locator("option")).toHaveText(["8", "12 (triplet)", "16", "24 (triplet)", "32"]);
  await expect(drumWindow.getByRole("button", { name: "Apply Swing" })).toBeVisible();
});
