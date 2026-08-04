// CAP-TRK-002 (#613) — track icons, the last unbuilt piece of #550.
//
// What `--selftest` already proves, and this spec therefore does not repeat: the name
// round-trips through the snapshot, padded mixed case normalises, an unknown name is
// REJECTED without half-applying, undo restores the PREVIOUS icon rather than the default,
// "" removes the property, and — the acceptance criterion — the icon survives save/reload.
// No audio device is involved, so the harness can see all of it.
//
// What only a browser can prove, and what this spec is for: that a mouse-only producer can
// REACH the choice, and that making it changes the ARRANGEMENT rather than just the
// Inspector's own button state. An icon picker whose result nothing rendered would be
// exactly the class of surface this programme exists to remove — and it is the specific
// way this feature could ship "done" and be useless, since the entire point of a track
// icon is the header you glance at, not the panel you set it in.

import { test, expect } from "@playwright/test";
import { bootV2 } from "./helpers";

test.describe("track icons (#613)", () => {
  test("picking an icon changes the glyph in the track header", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();

    const headerIcon = page.getByTestId("v2-track-icon").first();
    await expect(headerIcon).toHaveAttribute("data-icon", "");
    // The DEFAULT glyph, captured before the click. Comparing against it is what makes
    // this a test of rendering rather than of an attribute we set from the same value:
    // data-icon could be right while the drawn glyph never moved.
    const before = await headerIcon.innerHTML();

    await page.getByTestId("v2-track-icon-guitar").click();

    await expect(headerIcon).toHaveAttribute("data-icon", "guitar");
    expect(await headerIcon.innerHTML()).not.toBe(before);
  });

  test("two different icons draw two different glyphs", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();
    const headerIcon = page.getByTestId("v2-track-icon").first();

    await page.getByTestId("v2-track-icon-keys").click();
    await expect(headerIcon).toHaveAttribute("data-icon", "keys");
    const keys = await headerIcon.innerHTML();

    await page.getByTestId("v2-track-icon-vocal").click();
    await expect(headerIcon).toHaveAttribute("data-icon", "vocal");
    // Ten names that all rendered the same picture would satisfy every other assertion
    // here. This is the one that fails if the glyph map is wired to a constant.
    expect(await headerIcon.innerHTML()).not.toBe(keys);
  });

  test("the chosen icon reads as pressed, and only that one", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();

    await page.getByTestId("v2-track-icon-bass").click();
    await expect(page.getByTestId("v2-track-icon-bass")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("v2-track-icon-keys")).toHaveAttribute("aria-pressed", "false");
    // "Default" is a choice, so it must stop reading as selected once an icon is set.
    await expect(page.getByTestId("v2-track-icon-none")).toHaveAttribute("aria-pressed", "false");
  });

  test("Default clears the icon back off the header", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();
    const headerIcon = page.getByTestId("v2-track-icon").first();
    const typeDefault = await headerIcon.innerHTML();

    await page.getByTestId("v2-track-icon-fx").click();
    await expect(headerIcon).toHaveAttribute("data-icon", "fx");

    await page.getByTestId("v2-track-icon-none").click();
    await expect(headerIcon).toHaveAttribute("data-icon", "");
    await expect(page.getByTestId("v2-track-icon-none")).toHaveAttribute("aria-pressed", "true");
    // Back to the TYPE default specifically — not to blank, and not stuck on fx.
    expect(await headerIcon.innerHTML()).toBe(typeDefault);
  });

  test("giving one track an icon leaves its neighbours alone", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-track-header").first().click();
    await page.getByTestId("v2-insp-tab-mix").click();
    await page.getByTestId("v2-track-icon-strings").click();

    await expect(page.getByTestId("v2-track-icon").first()).toHaveAttribute("data-icon", "strings");
    await expect(page.getByTestId("v2-track-icon").nth(1)).toHaveAttribute("data-icon", "");
  });
});
