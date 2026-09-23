import { expect, test } from "@playwright/test";
import { bootV3 } from "./helpers";

for (const width of [900, 1440]) {
  test(`V3 direct fixture, pinned target and inspector fit at ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await bootV3(page);
    const open = page.getByTestId("v3-reimagine-open");
    await expect(open).toBeDisabled();
    const source = page.getByRole("button", { name: "chords, audio clip", exact: true });
    await source.focus(); await page.keyboard.press("Enter");
    await expect(source).toHaveAttribute("aria-pressed", "true");
    await open.click();
    await page.getByTestId("gen-prompt").fill("V3 deterministic fixture.");
    await page.getByTestId("gen-nl").fill("35");
    await page.getByTestId("gen-seed-input").fill("17");
    await page.getByTestId("gen-render").click();
    await expect(page.getByTestId("gen-accept")).toBeEnabled();
    await expect(page.getByTestId("engine-badge")).toHaveText("Test fixture");
    await page.getByTestId("v3-clip").first().click();
    await expect(page.getByTestId("gen-target")).toContainText("chords");
    await page.getByTestId("gen-result").click();
    await expect(page.getByTestId("gen-result")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("gen-source").click();
    await expect(page.getByTestId("gen-source")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("gen-accept").click();
    await expect(page.getByTestId("gen-status")).toHaveText("Result kept");
    // Generate again with the seed left alone must not re-run seed 17: it steps to 18, the
    // field shows it, and that is what reaches the engine.
    await expect(page.getByTestId("gen-render")).toHaveText("Generate again");
    await expect(page.getByTestId("gen-seed-input")).toHaveValue("17");
    await page.getByTestId("gen-render").click();
    await expect(page.getByTestId("gen-seed-input")).toHaveValue("18");
    await expect(page.getByTestId("gen-accept")).toBeEnabled();
    const seeds = await page.evaluate(() => ((window as unknown as { __moshCmdTrace?: { command: string; args: { seed?: number } }[] }).__moshCmdTrace ?? [])
      .filter((entry) => entry.command === "set_render_param").map((entry) => entry.args.seed));
    expect(seeds).toEqual([17, 18]);
    await page.getByTestId("gen-accept").click();
    await expect(page.getByTestId("gen-status")).toHaveText("Result kept");
    await expect(page.locator(".direct-reimagine .nlabel")).toHaveCSS("color", "rgb(242, 238, 230)");
    const inspector = page.getByTestId("v3-inspector");
    expect(await inspector.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await inspector.locator(".ibody").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`v3-direct-${width}.png`) });
    await page.getByTestId("v3-reimagine-close").click();
    await expect(open).toBeDisabled(); // The new selection is MIDI.
  });
}

test("V3 File exposes existing save, export and browser import actions", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-file-trigger").click();
  await expect(page.getByRole("menuitem", { name: "Save As…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Export audio…" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Import audio…" }).click();
  await expect(page.getByTestId("v3-browser")).toBeVisible();
  await expect(page.getByTestId("v3-file-menu")).toHaveAttribute("aria-hidden", "true");
});
