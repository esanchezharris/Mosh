import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// V3 parity brief row 10 — multiplayer create / join / leave from the V3 top bar, against the
// mock peer: mp_create_session answers MOCK-ROOM-abcdef0123456789, adds peer "Bo", and locks
// the SECOND track to Bo. The owner's two-Mac row in docs/VERIFICATION.md stays manual.

test("Invite opens the shared session dialog; create shows the room code, roster and Bo's lock", async ({ page }) => {
  await bootV3(page);
  const lockBadges = page.getByTestId("v3-track-lock");
  await expect(lockBadges).toHaveCount(0);                         // anti-vacuity baseline
  const trigger = page.getByTestId("v3-mp-trigger");
  await expect(trigger).toHaveText("Invite");
  await trigger.click();
  const modal = page.getByTestId("mp-launcher-modal");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Create session" }).click();
  await expect(modal.locator(".mp-code")).toHaveValue("MOCK-ROOM-abcdef0123456789");
  await expect(modal.locator(".mp-peer")).toHaveCount(2);
  await expect(trigger).toHaveText("Shared");

  // exactly one row is Bo's; its controls are read-only and its clips do not open the editor
  const locked = page.locator('[data-testid="v3-track"][data-locked-by="bo"]');
  await expect(locked).toHaveCount(1);
  await expect(lockBadges).toHaveCount(1);
  await expect(lockBadges.first()).toHaveText("Bo");
  await expect(locked.getByRole("button", { name: "Mute" })).toBeDisabled();
  await expect(locked.getByRole("button", { name: "Arm" })).toBeDisabled();
  const free = page.locator('[data-testid="v3-track"]:not([data-locked-by])').first();
  await expect(free.getByRole("button", { name: "Mute" })).toBeEnabled();

  await modal.getByRole("button", { name: "Leave session" }).click();
  await expect(lockBadges).toHaveCount(0);
  await expect(trigger).toHaveText("Invite");
});

test("a bad join code reports inline and keeps the dialog open to retry", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-mp-trigger").click();
  const modal = page.getByTestId("mp-launcher-modal");
  await modal.getByLabel("Room code to join").fill("NOT-A-ROOM");
  await modal.getByRole("button", { name: "Join", exact: true }).click();
  // the seeded session has local tracks, so the join gate asks first
  await page.getByTestId("mp-join-confirm").getByRole("button", { name: "Join anyway" }).click();
  await expect(page.getByTestId("mp-join-error")).toContainText("no such room");
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("v3-mp-trigger")).toHaveText("Invite");
});

test("Escape and the scrim both close the dialog, and it is exclusive with History", async ({ page }) => {
  await bootV3(page);
  await page.getByTestId("v3-mp-trigger").click();
  const modal = page.getByTestId("mp-launcher-modal");
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await page.getByTestId("v3-mp-trigger").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("mp-launcher-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(modal).toHaveCount(0);
  // exclusive-open: opening the dialog closes the History flyout (the dialog's scrim then
  // owns the pointer, as Settings does, so the reverse order is a close-then-open)
  await page.getByTestId("v3-history").click();
  await expect(page.getByTestId("v3-history-flyout")).toBeVisible();
  await page.getByTestId("v3-mp-trigger").click();
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("v3-history-flyout")).toHaveCount(0);
});
