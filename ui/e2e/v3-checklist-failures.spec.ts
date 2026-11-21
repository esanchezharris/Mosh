import { test, expect, type Page } from "@playwright/test";
import { bootV3Start } from "./helpers";

// The first-run checklist's failure paths (StartChecklist.tsx), against the in-memory
// mock's fault knobs (bridge.mock.ts: ?mockFault=<comma list>, plus the older
// ?mockNoInput=1). Each test asserts what the rapper SEES and, where the fault reaches the
// session, what the mock's snapshot holds. The happy path lives in v3-checklist.spec.ts.
//
// Multiplayer (the song setup refusing a shared session) is out of reach in the mock:
// nothing there turns mp.active on, so it is not covered here.

type Snap = {
  session: { tempo: number };
  tracks: { id: string; name: string; armed?: boolean; monitor?: string;
    plugins?: { index: number; type: string; preset?: { id: string } }[] }[];
  loop?: { engaged: boolean; leadTrackId?: string; takesTrackId?: string; phoneConnected?: boolean };
};
const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => (window as unknown as { __moshStore: { getState: () => { snapshot: unknown } } }).__moshStore.getState().snapshot) as Promise<Snap>;
const leadOf = (s: Snap) => s.tracks.find((t) => t.name === "Lead vocal");
const openItem = async (page: Page, key: "voice" | "phone") => {
  await page.getByTestId(`v3-check-item-${key}`).click();
  await expect(page.getByTestId("v3-checklist")).toHaveAttribute("data-current", key);
};

// ── the microphone ──────────────────────────────────────────────────────────────────

test("mic-denied: Voice says Mosh isn't allowed, offers Retry, blocks Sounds right, and Skip still works", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-denied" });
  await openItem(page, "voice");

  const mic = page.getByTestId("v3-check-mic");
  await expect(mic).toContainText("isn't allowed to use the microphone");
  await expect(mic).toHaveClass(/warn/);
  await expect(page.getByTestId("v3-check-mic-retry")).toBeVisible();
  // A permission problem, not a device one: no Audio settings button.
  await expect(page.getByTestId("v3-check-audio-settings")).toHaveCount(0);

  const ok = page.getByTestId("v3-check-voice-ok");
  await expect(ok).toBeDisabled();
  await expect(ok).toHaveText("Fix the microphone first");
  // The engine refused the arm: nothing is armed in the session, the Takes lane included.
  expect((await snap(page)).tracks.filter((t) => t.armed).map((t) => t.name)).toEqual([]);

  // Retry re-reads the permission; still denied, so nothing changes.
  await page.getByTestId("v3-check-mic-retry").click();
  await expect(mic).toContainText("isn't allowed to use the microphone");
  await expect(ok).toBeDisabled();

  await page.getByTestId("v3-check-skip-voice").click();
  await expect(page.getByTestId("v3-check-item-voice")).toHaveAttribute("data-state", "skipped");
  await expect(page.getByTestId("v3-booth")).toHaveCount(0);
});

test("mic-restricted: this Mac doesn't allow the mic, and there is nothing to retry", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-restricted" });
  await openItem(page, "voice");
  await expect(page.getByTestId("v3-check-mic")).toContainText("This Mac doesn't allow microphone access");
  await expect(page.getByTestId("v3-check-mic-retry")).toHaveCount(0);
  await expect(page.getByTestId("v3-check-voice-ok")).toBeDisabled();
  await expect(page.getByTestId("v3-check-voice-ok")).toHaveText("Fix the microphone first");
});

test("mic-timeout: nobody answered macOS, Retry is offered", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-timeout" });
  await openItem(page, "voice");
  await expect(page.getByTestId("v3-check-mic")).toContainText("nobody answered");
  await expect(page.getByTestId("v3-check-mic-retry")).toBeVisible();
  await expect(page.getByTestId("v3-check-voice-ok")).toHaveText("Fix the microphone first");
});

test("?mockNoInput=1: no input device → no-mic copy with Audio settings, and Sounds right stays off", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", query: { mockNoInput: "1" } });
  await openItem(page, "voice");
  await expect(page.getByTestId("v3-check-mic")).toContainText("No microphone found");
  await expect(page.getByTestId("v3-check-audio-settings")).toBeVisible();
  await expect(page.getByTestId("v3-check-mic-retry")).toBeVisible();
  const ok = page.getByTestId("v3-check-voice-ok");
  await expect(ok).toBeDisabled();
  await expect(ok).toHaveText(/Fix the microphone first|Recording is unavailable/);
  // arm_track answered applied:false, so no track ever armed (the Takes lane included).
  expect((await snap(page)).tracks.filter((t) => t.armed).map((t) => t.name)).toEqual([]);
});

// ── the room ────────────────────────────────────────────────────────────────────────

test("speakers: the song opens with Hear myself off, the Headphones row names the device, and it warns without blocking", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "speakers" });
  // Turned off on the track itself the moment the song was made, not just in the UI.
  // (On the Takes lane under the Lead: that is the track holding the mic.)
  await expect.poll(async () => (await snap(page)).tracks.find((t) => t.name === "Lead vocal · Takes")?.monitor).toBe("off");
  await openItem(page, "voice");
  const row = page.getByTestId("v3-check-headphones");
  await expect(row).toHaveClass(/warn/);
  await expect(row).toContainText("Sound is coming out of MacBook Pro Speakers");
  const monitor = page.getByTestId("v3-check-monitor");
  await expect(monitor).toHaveText("Hear myself: Off");
  await expect(monitor).toHaveAttribute("aria-pressed", "false");
  // Speakers warn; they do not block: the mic is fine, so the rapper can still go.
  await expect(page.getByTestId("v3-check-voice-ok")).toHaveText("Sounds right");
});

// ── the tempo ───────────────────────────────────────────────────────────────────────

test("bpm-fail: Couldn't hear the tempo, the field still works, and 92 confirmed sets the session to 92", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "bpm-fail" });
  await page.getByTestId("v3-check-choose").click();
  const line = page.getByTestId("v3-check-tempo-line");
  await expect(line).toContainText("Couldn't hear the tempo");
  // The engine's raw refusal is not left on screen for the rapper.
  await expect(page.getByTestId("v3-check-note")).toHaveCount(0);
  const bpm = page.getByTestId("v3-check-bpm");
  await expect(bpm).toBeEnabled();
  await bpm.fill("92");
  const confirm = page.getByTestId("v3-check-bpm-confirm");
  await expect(confirm).toHaveText("Use 92 BPM");
  await confirm.click();
  await expect(page.getByTestId("v3-check-item-beat")).toHaveAttribute("data-state", "done");
  expect((await snap(page)).session.tempo).toBe(92);
});

test("bpm-half: a low-confidence half-tempo guess reads Not sure, and ×2 brings it to 88", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "bpm-half" });
  await page.getByTestId("v3-check-choose").click();
  const line = page.getByTestId("v3-check-tempo-line");
  await expect(line).toContainText("Not sure");
  await expect(line).toContainText("44");
  const bpm = page.getByTestId("v3-check-bpm");
  await expect(bpm).toHaveValue("44");
  await page.getByTestId("v3-check-bpm-double").click();
  await expect(bpm).toHaveValue("88");
  await page.getByTestId("v3-check-bpm-confirm").click();
  expect((await snap(page)).session.tempo).toBe(88);
});

// ── the phone ───────────────────────────────────────────────────────────────────────

test("pairing-fail: the failure names the port, and Skip leaves the workspace as it is", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "pairing-fail" });
  await openItem(page, "phone");
  await page.getByTestId("v3-check-show-code").click();
  const failed = page.getByTestId("v3-check-pair-failed");
  await expect(failed).toContainText("Couldn't start the phone link");
  await expect(failed).toContainText("47873");
  await expect(page.getByTestId("v3-check-qr")).toHaveCount(0);
  await page.getByTestId("v3-check-skip-phone").click();
  await expect(page.getByTestId("v3-check-item-phone")).toHaveAttribute("data-state", "skipped");
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
  await expect(page.getByTestId("v3-booth")).toHaveCount(0);
});

test("pairing-short: the code expires on screen, and New code mints a fresh token", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "pairing-short" });
  await openItem(page, "phone");
  await page.getByTestId("v3-check-show-code").click();
  const url = page.getByTestId("v3-check-pad-url");
  await expect(url).toContainText("/pad#token=");
  const first = (await url.textContent()) ?? "";
  // The mock's token lives 3 s; the checklist ticks once a second.
  await expect(page.getByTestId("v3-check-pair-expired")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("v3-check-pair-ttl")).toHaveCount(0);
  await page.getByTestId("v3-check-new-code").click();
  await expect(url).toContainText("/pad#token=");
  await expect(url).not.toHaveText(first);
});

test("phone-connect: the phone arrives, the checklist says what it controls, and nothing leaves the workspace", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "phone-connect" });
  await openItem(page, "phone");
  await page.getByTestId("v3-check-show-code").click();
  await expect(page.getByTestId("v3-check-qr")).toBeVisible();
  // The mock connects 2 s after the mint.
  await expect(page.getByTestId("v3-check-phone-connected")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("v3-check-phone-target")).toContainText("Record, Keep, Again and Hear on your phone work on Lead vocal");
  await expect(page.getByTestId("v3-check-item-phone")).toHaveAttribute("data-state", "done");
  const s = await snap(page);
  expect(s.loop?.phoneConnected).toBe(true);
  expect(s.loop?.leadTrackId).toBe(leadOf(s)?.id);
  // The old flow handed off to the Booth 1.5 s after the connect. Wait past that.
  await page.waitForTimeout(2_500);
  await expect(page.getByTestId("v3-booth")).toHaveCount(0);
  await expect(page.getByTestId("v3-arrangement")).toBeVisible();
});

// ── the vocal chain ─────────────────────────────────────────────────────────────────

test("lost-autotune: a Tuned Lead without its tuner asks for a fix, blocks Sounds right, and Clean Lead repairs it", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "lost-autotune" });
  await openItem(page, "voice");
  await expect(page.getByTestId("v3-check-fix-chain")).toBeVisible();
  await expect(page.getByTestId("v3-check-voice-ok")).toHaveText("Finish your voice");
  // The tuned repair is refused (the tuner still does not load) and rolled back.
  await page.getByTestId("v3-check-fix-chain").getByRole("button").click();
  await expect(page.getByTestId("v3-check-note")).toHaveText("The tuner didn't load. Try again.");
  await page.getByTestId("v3-check-clean").click();
  await expect(page.getByTestId("v3-check-clean")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("v3-check-fix-chain")).toHaveCount(0);
  await expect(page.getByTestId("v3-check-voice-ok")).toHaveText("Sounds right");
  const ids = (leadOf(await snap(page))?.plugins ?? []).filter((p) => p.preset).map((p) => p.preset!.id);
  expect(new Set(ids)).toEqual(new Set(["mosh.clean-lead"]));
});
