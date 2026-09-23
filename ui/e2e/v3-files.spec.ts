import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// A23 (demo readiness): the V3 Browser's Files tab is on a Zoom screen share, so it shows NAMES
// only — no absolute home path in the path bar, the row meta, Recent imports or any tooltip.
// (The mock lists "/Users/you"; the packaged app lists ~/Library/Mosh/session/imports.)

const pathsOnScreen = (page: Parameters<typeof bootV3>[0]) =>
  page.getByTestId("v3-browser").evaluate((node) => {
    const texts = [node.textContent ?? "", ...[...node.querySelectorAll("[title]")].map((el) => el.getAttribute("title") ?? "")];
    return texts.filter((t) => /\/Users\//.test(t));
  });

test("the V3 Files tab shows file and folder names, never an absolute home path", async ({ page }) => {
  await bootV3(page);
  // A recent import from a private folder (native import_clip returns the copied file's full path,
  // which the browser remembers; the mock's import_clip does not, so seed the list the same way).
  await page.addInitScript(() => {
    window.localStorage.setItem("mosh.recentSamples.v2", JSON.stringify(["/Users/you/Music/private-bounce.wav"]));
  });
  await page.reload();
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();

  await page.getByTestId("v3-import-audio").click();
  const browser = page.getByTestId("v3-browser");
  await expect(browser).toBeVisible();
  await expect(browser.getByTestId("sample-row").first()).toBeVisible();
  // names are all there (anti-vacuity): a file, a folder, the current folder and the recent import
  await expect(browser.getByText("kick.wav", { exact: true })).toBeVisible();
  await expect(browser.getByText("Samples", { exact: true })).toBeVisible();
  await expect(browser.locator(".sb-path")).toHaveText("you");
  await expect(browser.getByRole("region", { name: "Recent imports" }).getByText("private-bounce.wav", { exact: true })).toBeVisible();
  expect(await pathsOnScreen(page)).toEqual([]);

  // open a folder: still names only
  await browser.getByRole("button", { name: /Samples/ }).first().click();
  await expect(browser.locator(".sb-path")).toHaveText("Samples");
  expect(await pathsOnScreen(page)).toEqual([]);
});
