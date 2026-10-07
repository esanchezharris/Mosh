import { test, expect } from "@playwright/test";
import { bootV2, expectDispatched } from "./helpers";

// The rights registry in the training popover, driven through its own form.
//
// What is under test is the WORDING of a blocked source. The registry reports why a
// source cannot be trained on as a terse reason string, and the popover shows it in
// two places — the badge on the source's row and the "Blocked:" list under the rows.
// Those two used to translate the reason separately, so the commonest state of all (a
// source just added, waiting on approval) read "Needs approval" on the row and
// "Missing: not approved_for_training" right below it.

test("a new source says it needs approval in both places, and approving it clears the block", async ({ page }) => {
  await bootV2(page);
  await page.getByTestId("v2-overflow").click();
  await page.getByTestId("v2-tool-training").click();
  await expect(page.getByTestId("training-tool-body")).toBeVisible();

  const sources = page.getByTestId("training-sources");
  await expect(sources.getByText("no sources yet")).toBeVisible();

  await page.getByPlaceholder("Track/beat name").fill("Night Drive");
  await page.getByPlaceholder("Creator/artist name").fill("e2e");
  await page.getByPlaceholder("Local file path").fill("/Users/you/night-drive.wav");
  await page.getByPlaceholder("Paste your rights claim text").fill("my own work");
  await page.getByPlaceholder("link + proof note").fill("session files");
  await page.getByRole("button", { name: "Add source", exact: true }).click();
  await expectDispatched(page, "import_training_source", { title: "Night Drive", localPath: "/Users/you/night-drive.wav" });

  // Registered, complete, and blocked on exactly one thing: nobody has approved it.
  const row = sources.locator(".plugin-row", { hasText: "Night Drive" });
  await expect(row.locator(".cmdlog-badge")).toHaveText("Needs approval");
  await expect(sources.getByRole("listitem")).toHaveText(["beat-001: Needs approval"]);
  await expect(sources.getByRole("status")).toHaveText("1 source needs review");

  await row.getByRole("button", { name: "Approve" }).click();
  await expectDispatched(page, "approve_training_source", { sourceId: "beat-001", approved: true });

  await expect(row.locator(".cmdlog-badge")).toHaveText("Ready for training");
  await expect(sources.getByRole("status")).toHaveText("All sources ready for training");
  await expect(sources.getByRole("listitem")).toHaveCount(0);
});
