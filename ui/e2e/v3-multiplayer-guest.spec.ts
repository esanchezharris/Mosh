import { test, expect, type Page } from "@playwright/test";
import { bootV3, expectDispatched } from "./helpers";

// Ported from the retired multiplayer.spec.ts and guest-degradation.spec.ts (v2 shell).
// v3-multiplayer.spec.ts already covers: Invite opens the dialog with Create + Join, Create shows
// the room code and roster, Leave, the bad-code failure path, Escape and the scrim. This file
// adds what it did not: the code re-shows on reopen, the join confirm gate (cancel / go through /
// empty project skips it), the video handshake over mp_send_signal, and the guest-Mac "preview"
// badge on the LoRA training dialog.
//
// NO-V3-UI: V3 has no camera toggle (it lived in v2's Participants rail), no clip menu AI
// actions (Build lyrics / Build flow were v2 clip-menu items; the lyrics commands are being
// removed) and no transform target picker (v2 GenDrawer). Their commands stay covered below by
// driving the bridge from a V3 boot.

type StoreHandle = {
  getState: () => { snapshot: { tracks?: unknown[] } | null; capabilities: Record<string, unknown> | null; exec: (c: string, a?: object) => Promise<unknown> };
  setState: (s: object) => void;
};

async function clearLocalTracks(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = (window as unknown as { __moshStore?: StoreHandle }).__moshStore;
    const snap = s?.getState().snapshot;
    if (snap) s?.setState({ snapshot: { ...snap, tracks: [] } });
  });
}

async function setCapabilities(page: Page, patch: Record<string, unknown>): Promise<void> {
  await page.evaluate((p) => {
    const s = (window as unknown as { __moshStore?: StoreHandle }).__moshStore;
    s?.setState({ capabilities: { ...(s.getState().capabilities ?? {}), ...p } });
  }, patch);
}

async function openInvite(page: Page) {
  await page.getByTestId("v3-mp-trigger").click();
  const modal = page.getByTestId("mp-launcher-modal");
  await expect(modal).toBeVisible();
  return modal;
}

test("Create shows a copyable room code, and reopening Invite re-shows the SAME code (host re-share path)", async ({ page }) => {
  await bootV3(page);
  const modal = await openInvite(page);
  await expect(modal.getByLabel("Room code to join")).toBeVisible();
  await modal.getByRole("button", { name: "Create session" }).click();
  const codeField = modal.getByLabel("Room code (share to invite)");
  const code = await codeField.inputValue();
  expect(code.length).toBeGreaterThan(0);
  await expect(modal.getByRole("button", { name: "Copy" })).toBeVisible();

  await modal.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("mp-launcher-modal")).toHaveCount(0);
  await expect(page.getByTestId("v3-mp-trigger")).toHaveText("Shared");
  await page.getByTestId("v3-mp-trigger").click();
  await expect(page.getByTestId("mp-launcher-modal").getByLabel("Room code (share to invite)")).toHaveValue(code);
});

test("Join with a code on a project that already has tracks is gated behind a confirm dialog", async ({ page }) => {
  await bootV3(page);
  const trackCount = await page.evaluate(() =>
    (window as unknown as { __moshStore?: StoreHandle }).__moshStore?.getState().snapshot?.tracks?.length ?? 0);
  expect(trackCount).toBeGreaterThan(0);
  const modal = await openInvite(page);
  await modal.getByLabel("Room code to join").fill("MOCK-ROOM-remote-1");
  await modal.getByRole("button", { name: "Join", exact: true }).click();

  const confirm = page.getByTestId("mp-join-confirm");
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(`${trackCount} track`);
  // cancel first, which must NOT join
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(modal.getByLabel("Room code (share to invite)")).toHaveCount(0);
  await expect(page.getByTestId("v3-mp-trigger")).toHaveText("Invite");

  // now go through with it
  await modal.getByRole("button", { name: "Join", exact: true }).click();
  await page.getByTestId("mp-join-confirm").getByRole("button", { name: "Join anyway" }).click();
  await expect(page.getByTestId("mp-join-confirm")).toHaveCount(0);
  await expect(modal.getByLabel("Room code (share to invite)")).toHaveValue("MOCK-ROOM-remote-1");
  await expectDispatched(page, "mp_join_session", { code: "MOCK-ROOM-remote-1" });
});

test("Join on an empty project does not prompt for confirmation", async ({ page }) => {
  await bootV3(page);
  await clearLocalTracks(page);
  const modal = await openInvite(page);
  await modal.getByLabel("Room code to join").fill("MOCK-ROOM-remote-2");
  await modal.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByTestId("mp-join-confirm")).toHaveCount(0);
  await expect(modal.getByLabel("Room code (share to invite)")).toHaveValue("MOCK-ROOM-remote-2");
});

// NO-V3-UI: V3 has no camera toggle. The handshake goes out through the same command the v2
// toggle used (useVideo's room sends { to, payload } via exec("mp_send_signal")), so this drives
// the command from the V3 store handle against the session's mock peer "bo".
test("mp_send_signal: a video offer addressed to the session peer goes through the command seam (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const modal = await openInvite(page);
  await modal.getByRole("button", { name: "Create session" }).click();
  await expect(modal.getByLabel("Room code (share to invite)")).toBeVisible();
  await modal.getByRole("button", { name: "Close" }).click();

  const res = await page.evaluate(() =>
    (window as unknown as { __moshStore: StoreHandle }).__moshStore.getState()
      .exec("mp_send_signal", { to: "bo", payload: { kind: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" } }));
  expect(res).toMatchObject({ ok: true });
  await expectDispatched(page, "mp_send_signal", {
    to: "bo",
    payload: expect.objectContaining({ kind: "offer", sdp: expect.stringMatching(/^v=0/) }),
  });
});

// Guest-Mac degradation, V3's surface: the LoRA training dialog is the one capability-gated
// control V3 kept (capabilities.trainingBackend drives the "preview" badge). The mock default
// backend is local_pmetal (a set-up Mac), so each test drives the posture explicitly.
async function openTraining(page: Page) {
  await page.getByTestId("v3-training-trigger").click();
  await expect(page.getByTestId("v3-training-modal")).toBeVisible();
  // an absence assertion below proves nothing unless the body has rendered
  await expect(page.getByTestId("training-tool-body")).toBeVisible();
}

test("the Training dialog shows NO preview badge on the default (set-up) Mac", async ({ page }) => {
  await bootV3(page);
  await openTraining(page);
  await expect(page.getByTestId("training-preview-badge")).toHaveCount(0);
});

test("the Training dialog labels itself preview under the fake backend, and drops the badge for a real one", async ({ page }) => {
  await bootV3(page);
  await openTraining(page);
  await setCapabilities(page, { trainingBackend: "fake" });
  await expect(page.getByTestId("training-preview-badge")).toBeVisible();
  await expect(page.getByTestId("training-preview-badge")).toHaveText("preview");
  await setCapabilities(page, { trainingBackend: "remote_http" });
  await expect(page.getByTestId("training-preview-badge")).toHaveCount(0);
});

// NO-V3-UI: "Build flow from this take" (clip menu) has no V3 control. Its command still has to
// finish cleanly against the mock and leave no stuck "building" state.
test("build_skeleton_from_clip completes and clears the building flag (NO-V3-UI)", async ({ page }) => {
  await bootV3(page);
  const clipId = await page.evaluate(async () => {
    const s = (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: { clips: { id: string; type: string }[] }[] }; exec: (c: string, a: object) => Promise<{ ok: boolean }> } } }).__moshStore;
    const clip = s.getState().snapshot.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave");
    if (!clip) return null;
    const r = await s.getState().exec("build_skeleton_from_clip", { clipId: clip.id });
    return r.ok ? clip.id : null;
  });
  expect(clipId).not.toBeNull();
  await expectDispatched(page, "build_skeleton_from_clip", { clipId: clipId! });
  // the store's skeleton_status handler clears the flag on "done" (regression guard)
  await expect.poll(() => page.evaluate((id) =>
    Boolean((window as unknown as { __moshStore: { getState: () => { buildingSkeleton: Record<string, boolean> } } }).__moshStore.getState().buildingSkeleton[id]), clipId!))
    .toBe(false);
});
