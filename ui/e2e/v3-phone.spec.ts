import { test, expect } from "@playwright/test";
import { bootV3 } from "./helpers";

// MOSHI phone pad, desktop half — the QR a phone actually scans. The whole point of this
// surface is that the encoded URL is the LAN-IP Safari pad (`http://<ip>:<port>/pad#token=…`):
// a `mosh://` deep link is unopenable without the native companion app, and a `.local`
// host does not resolve from an iPhone. Reaching the pad from a real phone stays an owner
// row in docs/VERIFICATION.md; this pins what the desktop hands it.

const PAD_URL = /^http:\/\/\d+\.\d+\.\d+\.\d+:\d+\/pad#token=[a-f0-9]{32,128}$/;

async function enterBooth(page: Parameters<typeof bootV3>[0]) {
  await page.getByTestId("v3-file-trigger").click();
  await page.getByTestId("v3-templates").hover();
  await page.getByTestId("v3-template-booth").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
}

test("Phone pairs to the LAN-IP Safari pad, never to mosh:// or a .local host", async ({ page }) => {
  await bootV3(page);
  const trigger = page.getByTestId("v3-phone-trigger");
  await expect(trigger).toHaveText("Phone");
  await expect(trigger).not.toHaveClass(/\bon\b/);          // anti-vacuity baseline
  await expect(page.getByTestId("v3-phone-modal")).toHaveCount(0);

  await trigger.click();
  const modal = page.getByTestId("v3-phone-modal");
  await expect(modal).toBeVisible();

  const url = page.getByTestId("v3-phone-url");
  await expect(url).toHaveText(PAD_URL);
  await expect(modal).not.toContainText("mosh://");
  await expect(modal).not.toContainText(".local");
  await expect(page.getByTestId("v3-phone-qr")).toHaveAttribute("src", /^data:image\/png/);
  await expect(trigger).toHaveClass(/\bon\b/);              // the server is up

  await page.getByTestId("v3-phone-stop").click();
  await expect(modal).toHaveCount(0);
  await expect(trigger).not.toHaveClass(/\bon\b/);
});

test("the Booth's own Phone button appears once a phone is paired, and opens the same dialog", async ({ page }) => {
  await bootV3(page);
  await enterBooth(page);
  // Until a phone is paired the Booth keeps the button off the screen; the TopBar pairs one.
  await expect(page.getByTestId("v3-booth-phone")).toHaveCount(0);
  await page.getByTestId("v3-phone-trigger").click();
  await expect(page.getByTestId("v3-phone-url")).toHaveText(PAD_URL);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("v3-phone-modal")).toHaveCount(0);

  await page.getByTestId("v3-booth-phone").click();
  await expect(page.getByTestId("v3-phone-modal")).toBeVisible();
  await expect(page.getByTestId("v3-phone-url")).toHaveText(PAD_URL);
});

test("Escape and the scrim close it, and it is exclusive with Invite and History", async ({ page }) => {
  await bootV3(page);
  const modal = page.getByTestId("v3-phone-modal");
  await page.getByTestId("v3-phone-trigger").click();
  await expect(modal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);

  await page.getByTestId("v3-phone-trigger").click();
  await expect(modal).toBeVisible();
  await page.getByTestId("v3-phone-backdrop").click({ position: { x: 5, y: 5 } });
  await expect(modal).toHaveCount(0);

  // exclusive-open: opening this dialog closes the History flyout and the Invite dialog.
  // Only this direction is drivable by pointer — a modal's own scrim then owns every
  // click, so the reverse is a close-then-open (PhoneLauncher.test.ts pins both ways).
  await page.getByTestId("v3-history").click();
  await expect(page.getByTestId("v3-history-flyout")).toBeVisible();
  await page.getByTestId("v3-phone-trigger").click();
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("v3-history-flyout")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await page.getByTestId("v3-mp-trigger").click();
  await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("v3-phone-trigger").click();
  await expect(modal).toBeVisible();
  await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);
});
