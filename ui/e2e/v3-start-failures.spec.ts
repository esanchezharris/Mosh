import { test, expect, type Page } from "@playwright/test";
import { bootV3Start } from "./helpers";

// The V3 Start page's failure paths (StartPage.tsx), against the in-memory mock's fault
// knobs (bridge.mock.ts: ?mockFault=<comma list>, plus the older ?mockNoInput=1). Each
// test asserts what the singer SEES and, where the fault reaches the session, what the
// mock's snapshot holds. The happy path lives in v3-start.spec.ts.
//
// Multiplayer (the guided start refusing a shared session) is out of reach in the mock:
// nothing there turns mp.active on, so it is not covered here.

type Snap = {
  session: { tempo: number };
  tracks: { id: string; name: string; armed?: boolean; monitor?: string;
    clips: { id: string; type: string; start: number; length: number }[];
    plugins?: { index: number; type: string; preset?: { id: string } }[] }[];
  loop?: { engaged: boolean; leadTrackId?: string; takesTrackId?: string; phoneConnected?: boolean };
};
const snap = (page: Page): Promise<Snap> =>
  page.evaluate(() => (window as unknown as { __moshStore: { getState: () => { snapshot: unknown } } }).__moshStore.getState().snapshot) as Promise<Snap>;
const step = (page: Page) => page.getByTestId("v3-start");
const takesOf = (s: Snap) => s.tracks.find((t) => t.id === s.loop?.takesTrackId);
const leadOf = (s: Snap) => s.tracks.find((t) => t.id === s.loop?.leadTrackId);

/** bootV3Start with extra query knobs the shared helper does not carry (?mockNoInput). */
async function bootStartWith(page: Page, query: Record<string, string>): Promise<void> {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("mosh.e2e.seeded")) return;
    window.sessionStorage.setItem("mosh.e2e.seeded", "1");
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({
      version: 2, template: null, values: { colorway: "lime", startOnLaunch: true }, keyOverrides: {},
    }));
  });
  await page.goto(`/?${new URLSearchParams({ shell: "v3", ...query }).toString()}`);
  await expect(page.getByTestId("v3-shell")).toBeVisible();
  await expect(step(page)).toBeVisible();
}

async function startNewSong(page: Page) {
  await page.getByTestId("v3-start-new").click();
  await expect(step(page)).toHaveAttribute("data-step", "beat");
}

async function skipToVoice(page: Page) {
  await startNewSong(page);
  await page.getByTestId("v3-start-skip-beat").click();
  await expect(step(page)).toHaveAttribute("data-step", "voice");
}

/** Welcome → skip the beat → ready (needs a working mic) → the Phone step. */
async function reachPhone(page: Page) {
  await skipToVoice(page);
  await expect(page.getByTestId("v3-start-ready")).toHaveText("I'm ready");
  await page.getByTestId("v3-start-ready").click();
  await page.getByTestId("v3-start-add-phone").click();
  await expect(step(page)).toHaveAttribute("data-step", "phone");
}

// ── the microphone ──────────────────────────────────────────────────────────────────

test("mic-denied: Voice says Mosh isn't allowed, offers Retry, blocks I'm ready, and the Booth is still reachable", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-denied" });
  await skipToVoice(page);

  const mic = page.getByTestId("v3-start-mic");
  await expect(mic).toContainText("isn't allowed to use the microphone");
  await expect(mic).toHaveClass(/warn/);
  await expect(page.getByTestId("v3-start-mic-retry")).toBeVisible();
  // A permission problem, not a device one: no Audio settings button.
  await expect(page.getByTestId("v3-start-audio-settings")).toHaveCount(0);

  const ready = page.getByTestId("v3-start-ready");
  await expect(ready).toBeDisabled();
  await expect(ready).toHaveText("Fix the microphone first");

  // The engine refused the arm: the Takes lane is NOT armed in the session.
  let s = await snap(page);
  expect(s.loop?.engaged).toBe(true);
  expect(takesOf(s)).toBeDefined();
  expect(takesOf(s)?.armed).toBeFalsy();

  // Retry re-reads the permission; still denied, so nothing changes.
  await page.getByTestId("v3-start-mic-retry").click();
  await expect(mic).toContainText("isn't allowed to use the microphone");
  await expect(ready).toBeDisabled();
  s = await snap(page);
  expect(takesOf(s)).toBeDefined();
  expect(takesOf(s)?.armed).toBeFalsy();

  await page.getByTestId("v3-start-go-anyway").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
});

test("mic-restricted: this Mac doesn't allow the mic, and there is nothing to retry", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-restricted" });
  await skipToVoice(page);
  await expect(page.getByTestId("v3-start-mic")).toContainText("This Mac doesn't allow microphone access");
  await expect(page.getByTestId("v3-start-mic-retry")).toHaveCount(0);
  await expect(page.getByTestId("v3-start-ready")).toBeDisabled();
  await expect(page.getByTestId("v3-start-ready")).toHaveText("Fix the microphone first");
  { const takes = takesOf(await snap(page)); expect(takes).toBeDefined(); expect(takes?.armed).toBeFalsy(); }
});

test("mic-timeout: nobody answered macOS, Retry is offered", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "mic-timeout" });
  await skipToVoice(page);
  await expect(page.getByTestId("v3-start-mic")).toContainText("nobody answered");
  await expect(page.getByTestId("v3-start-mic-retry")).toBeVisible();
  await expect(page.getByTestId("v3-start-ready")).toBeDisabled();
  await expect(page.getByTestId("v3-start-ready")).toHaveText("Fix the microphone first");
});

test("?mockNoInput=1: no input device → no-mic copy with Audio settings, and I'm ready stays off", async ({ page }) => {
  await bootStartWith(page, { mockSeed: "fresh", mockNoInput: "1" });
  await skipToVoice(page);
  const mic = page.getByTestId("v3-start-mic");
  await expect(mic).toContainText("No microphone found");
  await expect(page.getByTestId("v3-start-audio-settings")).toBeVisible();
  await expect(page.getByTestId("v3-start-mic-retry")).toBeVisible();
  const ready = page.getByTestId("v3-start-ready");
  await expect(ready).toBeDisabled();
  await expect(ready).toHaveText(/Fix the microphone first|Recording is unavailable/);
  // arm_track answered applied:false, so the lane never armed.
  { const takes = takesOf(await snap(page)); expect(takes).toBeDefined(); expect(takes?.armed).toBeFalsy(); }
});

// ── the room ────────────────────────────────────────────────────────────────────────

// The mock publishes snapshot.audio as native does (MoshOps.cpp root "audio"), so the
// speakers fault reaches the page, setupVocalLoop and the speaker guard.
test("speakers: the Headphones row names the device, and Hear myself is Off", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "speakers" });
  await skipToVoice(page);
  const row = page.getByTestId("v3-start-headphones");
  await expect(row).toHaveClass(/warn/);
  await expect(row).toContainText("Sound is coming out of MacBook Pro Speakers");
  const monitor = page.getByTestId("v3-start-monitor");
  await expect(monitor).toHaveText("Hear myself: Off");
  await expect(monitor).toHaveAttribute("aria-pressed", "false");
  // The setup turned live monitoring off on the Takes lane itself, not just in the UI.
  expect(takesOf(await snap(page))?.monitor).toBe("off");
  // Speakers warn; they do not block: the mic is fine, so the singer can still go.
  await expect(page.getByTestId("v3-start-ready")).toHaveText("I'm ready");
});

// ── the tempo ───────────────────────────────────────────────────────────────────────

test("bpm-fail: Couldn't hear the tempo, the field still works, and 92 confirmed sets the session to 92", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "bpm-fail" });
  await startNewSong(page);
  await page.getByTestId("v3-start-choose").click();
  const line = page.getByTestId("v3-start-tempo-line");
  await expect(line).toContainText("Couldn't hear the tempo");
  // The engine's raw refusal is not left on screen for the singer.
  await expect(page.getByTestId("v3-start-note")).toHaveCount(0);

  const bpm = page.getByTestId("v3-start-bpm");
  await expect(bpm).toBeEnabled();
  await bpm.fill("92");
  const confirm = page.getByTestId("v3-start-bpm-confirm");
  await expect(confirm).toHaveText("Use 92 BPM");
  await confirm.click();
  await expect(page.getByTestId("v3-start-beat-next")).toBeVisible();
  await expect(line).toContainText("Your beat is at 92 BPM");
  expect((await snap(page)).session.tempo).toBe(92);
});

test("bpm-half: a low-confidence half-tempo guess reads Not sure, and ×2 brings it to 88", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "bpm-half" });
  await startNewSong(page);
  await page.getByTestId("v3-start-choose").click();
  const line = page.getByTestId("v3-start-tempo-line");
  await expect(line).toContainText("Not sure");
  await expect(line).toContainText("44");
  const bpm = page.getByTestId("v3-start-bpm");
  await expect(bpm).toHaveValue("44");
  await page.getByTestId("v3-start-bpm-double").click();
  await expect(bpm).toHaveValue("88");
  await page.getByTestId("v3-start-bpm-confirm").click();
  await expect(line).toContainText("Your beat is at 88 BPM");
  expect((await snap(page)).session.tempo).toBe(88);
});

// ── the phone ───────────────────────────────────────────────────────────────────────

test("pairing-fail: the failure names the port, and Skip still reaches the Booth", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "pairing-fail" });
  await reachPhone(page);
  await page.getByTestId("v3-start-show-code").click();
  const failed = page.getByTestId("v3-start-pair-failed");
  await expect(failed).toContainText("Couldn't start the phone link");
  await expect(failed).toContainText("47873");
  await expect(page.getByTestId("v3-start-qr")).toHaveCount(0);
  await page.getByTestId("v3-start-skip-phone").click();
  await expect(page.getByTestId("v3-booth")).toBeVisible();
});

test("pairing-short: the code expires on screen, and New code mints a fresh token", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "pairing-short" });
  await reachPhone(page);
  await page.getByTestId("v3-start-show-code").click();
  const url = page.getByTestId("v3-start-pad-url");
  await expect(url).toContainText("/pad#token=");
  const first = (await url.textContent()) ?? "";

  // The mock's token lives 3 s; the page ticks once a second.
  await expect(page.getByTestId("v3-start-pair-expired")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("v3-start-pair-ttl")).toHaveCount(0);

  await page.getByTestId("v3-start-new-code").click();
  await expect(url).toContainText("/pad#token=");
  await expect(url).not.toHaveText(first);
  const second = (await url.textContent()) ?? "";
  expect(second.split("#token=")[1]).not.toBe(first.split("#token=")[1]);
});

test("phone-connect: the phone arrives, the page says so, and hands off to the Booth on its own", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "phone-connect" });
  await reachPhone(page);
  await page.getByTestId("v3-start-show-code").click();
  await expect(page.getByTestId("v3-start-qr")).toBeVisible();
  // The mock connects 2 s after the mint; the page hands off 1.5 s after that.
  await expect(page.getByTestId("v3-start-phone-connected")).toBeVisible({ timeout: 5_000 });
  expect((await snap(page)).loop?.phoneConnected).toBe(true);
  await expect(page.getByTestId("v3-booth")).toBeVisible({ timeout: 5_000 });
});

// ── the vocal chain ─────────────────────────────────────────────────────────────────

test("lost-autotune, key left loose: the switch refuses and rolls back too, never announcing a tunerless Tuned Lead", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "lost-autotune" });
  await skipToVoice(page);
  await page.getByTestId("v3-start-tuned").click();
  await page.getByTestId("v3-start-tuned-apply").click();
  // switchVocalPreset checks for the tuner on every Tuned switch, key or not.
  await expect(page.getByTestId("v3-start-note")).toHaveText("The tuner didn't load. Try again.");
  await expect(page.getByTestId("v3-start-note")).not.toHaveText("Tuned Lead is on your voice.");
  await expect(page.getByTestId("v3-start-clean")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("v3-start-fix-chain")).toHaveCount(0);
  await expect(page.getByTestId("v3-start-ready")).toHaveText("I'm ready");
  const s = await snap(page);
  for (const t of [leadOf(s), takesOf(s)]) {
    expect(t).toBeDefined();
    const ids = (t?.plugins ?? []).filter((p) => p.preset).map((p) => p.preset!.id);
    expect(new Set(ids)).toEqual(new Set(["mosh.clean-lead"]));
  }
});

test("lost-autotune with a key: the switch refuses and rolls back to Clean Lead", async ({ page }) => {
  await bootV3Start(page, { seed: "fresh", fault: "lost-autotune" });
  await skipToVoice(page);
  await page.getByTestId("v3-start-tuned").click();
  await page.getByTestId("v3-start-key-root").selectOption("A");
  await page.getByTestId("v3-start-key-scale").selectOption("Minor");
  await page.getByTestId("v3-start-tuned-apply").click();
  await expect(page.getByTestId("v3-start-note")).toHaveText("The tuner didn't load. Try again.");
  await expect(page.getByTestId("v3-start-clean")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("v3-start-fix-chain")).toHaveCount(0);
  const s = await snap(page);
  for (const t of [leadOf(s), takesOf(s)]) {
    const ids = (t?.plugins ?? []).filter((p) => p.preset).map((p) => p.preset!.id);
    expect(new Set(ids)).toEqual(new Set(["mosh.clean-lead"]));
  }
});
