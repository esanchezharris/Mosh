// AGT-MEM (M3) — the explicit "remember…" fastPath (with its confirm toast + Undo) and
// the memory panel (per-tier view, per-item delete, per-tier clear), end-to-end on the
// v2 shell + dev mock. agent_memory_* is served in-process by bridge.mock.ts, so this
// exercises the REAL mock contract every command below actually speaks against.

import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null,
      values: { theme: "dark", agentMemory: true },
      keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v2");
  await page.getByTestId("v2-agent-trigger").click();
  await expect(page.getByTestId("v2-agent-panel")).toBeVisible();
});

async function openMemoryPanel(page: import("@playwright/test").Page) {
  await page.getByLabel("More tools").click();
  await page.getByLabel("What Moshi remembers").click();
  await expect(page.getByText("What Moshi remembers")).toBeVisible();
}

test("'remember I love heavy 808s' shows a confirm toast, and the preference lands in the memory panel", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("remember I love heavy 808s");
  await page.getByTestId("agent-send").click();

  const toast = page.getByTestId("v2-memory-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("love heavy 808s");

  await openMemoryPanel(page);
  await expect(page.getByTestId("memory-tier-preference")).toContainText("love heavy 808s");
});

test("the toast's Undo removes the just-written preference", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("remember I always quantize to 16ths");
  await page.getByTestId("agent-send").click();

  await page.getByTestId("v2-memory-toast-undo").click();
  await expect(page.getByTestId("v2-memory-toast")).toHaveCount(0);

  await openMemoryPanel(page);
  await expect(page.getByTestId("memory-tier-preference")).toContainText("nothing yet");
});

test("'remember this for this project' scopes the note to the project tier, not the global one", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("remember this song is a lofi sketch for this project");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-memory-toast")).toBeVisible();

  await openMemoryPanel(page);
  await expect(page.getByTestId("memory-tier-project")).toContainText("lofi sketch");
  await expect(page.getByTestId("memory-tier-preference")).toContainText("nothing yet");
});

test("per-item delete in the panel removes just that item", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("remember I like wide low end");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-memory-toast")).toBeVisible();

  await openMemoryPanel(page);
  const tier = page.getByTestId("memory-tier-preference");
  await expect(tier).toContainText("wide low end");
  await tier.locator(".mem-del").click();
  await expect(tier).toContainText("nothing yet");
});

test("per-tier Clear asks for confirmation, then empties the tier", async ({ page }) => {
  const input = page.getByTestId("agent-input");
  await input.fill("remember I like wide low end");
  await page.getByTestId("agent-send").click();
  await expect(page.getByTestId("v2-memory-toast")).toBeVisible();

  await openMemoryPanel(page);
  const tier = page.getByTestId("memory-tier-preference");
  await expect(tier).toContainText("wide low end");

  await tier.getByRole("button", { name: "Clear" }).click();
  const confirm = page.getByTestId("memory-clear-confirm");
  await expect(confirm).toBeVisible();

  // Cancel first — the item must survive.
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(tier).toContainText("wide low end");

  // Now really clear it.
  await tier.getByRole("button", { name: "Clear" }).click();
  await page.getByTestId("memory-clear-confirm-confirm").click();
  await expect(tier).toContainText("nothing yet");
});

test("the memory panel is unreachable when the agentMemory setting is off", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null,
      values: { theme: "dark", agentMemory: false },
      keyOverrides: {},
    }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-agent-trigger")).toBeVisible();

  await page.getByLabel("More tools").click();
  await expect(page.getByLabel("What Moshi remembers")).toHaveCount(0);
});
