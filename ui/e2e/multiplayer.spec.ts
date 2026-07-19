import { test, expect, type Page } from "@playwright/test";

// The #1 playtest blocker (2026-07-16): in the default v2 shell, the prominent
// "Invite" pill (TopBar) and the "Invite collaborator" button (RightRail) both just
// called mpCreateSession() — there was no discoverable Join-with-code entry anywhere
// in the default shell (it lived only in the buried "More tools" overflow). A guest
// who clicked the only affordance they could find created a second, disconnected
// session instead of joining the host's, and the host's room code was never shown
// anywhere prominent enough to read off to the other Mac.
//
// This spec drives the fix: both prominent buttons now open ONE modal carrying
// Create (with a re-visible/copyable room code) AND Join-with-code, and Join is
// gated behind a confirm dialog when the local project already has tracks (joining
// adopts the host's project in place — see MoshOps.cpp cmdMpApplyBootstrap).

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

type StoreHandle = { getState: () => { snapshot: unknown }; setState: (s: object) => void };

// Directly clears the local project's track list via the dev store handle (the same
// pattern e2e/v2-shell.spec.ts's enterPeersMode uses for mp/peers) — a fast, realistic
// stand-in for "a fresh/empty project" without depending on a v2 File menu.
async function clearLocalTracks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = (window as unknown as { __moshStore?: StoreHandle }).__moshStore;
    const snap = store?.getState().snapshot as { tracks?: unknown[] } | null | undefined;
    if (snap) store?.setState({ snapshot: { ...snap, tracks: [] } });
  });
}

test.describe("v2 multiplayer — discoverable Create/Join", () => {
  test("the top-bar Invite pill opens a modal with BOTH Create and Join, not create-on-click", async ({ page }) => {
    await bootV2(page);
    await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);
    await page.getByTestId("v2-share").click();
    const modal = page.getByTestId("mp-launcher-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Create session" })).toBeVisible();
    await expect(modal.getByLabel("Room code to join")).toBeVisible();
  });

  test("Create surfaces a copyable room code, and re-opening the pill re-shows it (host re-share path)", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    const modal = page.getByTestId("mp-launcher-modal");
    await modal.getByRole("button", { name: "Create session" }).click();
    const codeField = modal.getByLabel("Room code (share to invite)");
    await expect(codeField).toBeVisible();
    const code = await codeField.inputValue();
    expect(code.length).toBeGreaterThan(0);
    await expect(modal.getByRole("button", { name: "Copy" })).toBeVisible();

    await modal.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);
    // the pill now reads "Shared" — reopening re-surfaces the SAME code
    await expect(page.getByTestId("v2-share")).toContainText("Shared");
    await page.getByTestId("v2-share").click();
    await expect(page.getByTestId("mp-launcher-modal").getByLabel("Room code (share to invite)")).toHaveValue(code);
  });

  test("Join with a code on a project that already has tracks is gated behind a confirm dialog", async ({ page }) => {
    await bootV2(page);
    // bootV2's default seeded project ships 3 tracks (Drums/Bass/Keys) — a realistic
    // "you have unsaved work" case, not a contrived one.
    await page.getByTestId("v2-share").click();
    const modal = page.getByTestId("mp-launcher-modal");
    // Codes must use the mock's "MOCK-ROOM-…" format since the #42 failure path landed
    // (unknown codes now deliberately fail with "no such room" — see bridge.mock.ts).
    await modal.getByLabel("Room code to join").fill("MOCK-ROOM-remote-1");
    await modal.getByRole("button", { name: "Join", exact: true }).click();

    const confirm = page.getByTestId("mp-join-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText("3 tracks");
    // cancel first — must NOT join
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    await expect(modal.getByLabel("Room code (share to invite)")).toHaveCount(0);

    // now go through with it
    await modal.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByTestId("mp-join-confirm")).toBeVisible();
    await page.getByTestId("mp-join-confirm").getByRole("button", { name: "Join anyway" }).click();
    await expect(page.getByTestId("mp-join-confirm")).toHaveCount(0);
    await expect(modal.getByLabel("Room code (share to invite)")).toHaveValue("MOCK-ROOM-remote-1");
  });

  test("Join on an empty project does not prompt for confirmation", async ({ page }) => {
    await bootV2(page);
    await clearLocalTracks(page);
    await page.getByTestId("v2-share").click();
    const modal = page.getByTestId("mp-launcher-modal");
    await modal.getByLabel("Room code to join").fill("MOCK-ROOM-remote-2");
    await modal.getByRole("button", { name: "Join", exact: true }).click();
    await expect(page.getByTestId("mp-join-confirm")).toHaveCount(0);
    await expect(modal.getByLabel("Room code (share to invite)")).toHaveValue("MOCK-ROOM-remote-2");
  });

  test("the right-rail 'Invite collaborator' button opens the same Create/Join modal", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-invite").click();
    const modal = page.getByTestId("mp-launcher-modal");
    await expect(modal).toBeVisible();
    await expect(modal.getByRole("button", { name: "Create session" })).toBeVisible();
    await expect(modal.getByLabel("Room code to join")).toBeVisible();
  });

  test("Escape dismisses the modal", async ({ page }) => {
    await bootV2(page);
    await page.getByTestId("v2-share").click();
    await expect(page.getByTestId("mp-launcher-modal")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);
  });
});
