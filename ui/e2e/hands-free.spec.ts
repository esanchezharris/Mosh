import { test, expect, type Page } from "@playwright/test";
import { boot, newProject, tracks, addAudioTrack } from "./helpers";

// Hands-free always-on voice, driven end-to-end against the dev mock. A controllable
// fake `window.webkitSpeechRecognition` (installed BEFORE the app loads) lets the test
// push finalized transcripts at will, so the whole path is exercised — toggle →
// continuous recognizer → matchFastPath → performer/transport command — with no mic,
// no native build. The three guarantees under test: known phrases ACT hands-free,
// unknown speech is DROPPED (never the brain), and turning the toggle OFF releases
// the mic (aborts the recognizer).

// A minimal, controllable Web Speech stand-in. Each start() makes that instance the
// "current" one; window.__mockSR lets the test feed it finals and read lifecycle.
async function installMockSpeech(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { current: null as null | { onresult: ((e: unknown) => void) | null }, aborts: 0, started: 0 };
    class MockSR {
      continuous = false; interimResults = false; lang = "";
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      onstart: (() => void) | null = null;
      start() { state.started++; state.current = this; this.onstart?.(); }
      stop() { if (state.current === this) state.current = null; this.onend?.(); }
      abort() { state.aborts++; if (state.current === this) state.current = null; this.onend?.(); }
    }
    // Override BOTH names — headless Chromium ships a native window.SpeechRecognition,
    // which getCtor() prefers over webkitSpeechRecognition.
    (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSR;
    (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = MockSR;
    (window as unknown as { __mockSR: unknown }).__mockSR = {
      emitFinal(text: string) {
        const r = state.current;
        if (!r?.onresult) return false;
        r.onresult({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: text } } } });
        return true;
      },
      get aborts() { return state.aborts; },
      get started() { return state.started; },
      get hasCurrent() { return state.current !== null; },
    };
  });
}

const emitFinal = (page: Page, text: string) =>
  page.evaluate((t) => (window as unknown as { __mockSR: { emitFinal: (s: string) => boolean } }).__mockSR.emitFinal(t), text);
const mockState = (page: Page) =>
  page.evaluate(() => {
    const m = (window as unknown as { __mockSR: { aborts: number; started: number; hasCurrent: boolean } }).__mockSR;
    return { aborts: m.aborts, started: m.started, hasCurrent: m.hasCurrent };
  });

// The Moshi cap row sits fully BELOW the detail-panel resize divider — the creature
// mount flex-shrinks so the centered column fits the dock with no top/bottom overflow
// (mosh.css .moshi-mount). So a plain center-click lands on the 👂 toggle; no position
// workaround needed (a regression here would have the divider intercept the click).
const capClick = (page: Page) =>
  page.getByTestId("moshi-handsfree").click();

async function turnHandsFreeOn(page: Page): Promise<void> {
  const btn = page.getByTestId("moshi-handsfree");
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await capClick(page);
  await expect(btn).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("handsfree-status")).toHaveText("hands-free on");
  // the continuous recognizer is now hot
  await expect.poll(async () => (await mockState(page)).hasCurrent).toBe(true);
}

test("known command phrases act hands-free (no button held)", async ({ page }) => {
  await installMockSpeech(page);
  await boot(page);
  await turnHandsFreeOn(page);

  const transport = page.getByTestId("transport");
  await expect(transport).toHaveAttribute("data-playing", "false");

  // "play it" → set_transport toggle → playing, with no button held.
  await emitFinal(page, "play it");
  await expect(transport).toHaveAttribute("data-playing", "true");

  // "stop" (idle mode) → set_transport stop → playing false. Proves a SECOND distinct
  // phrase routes through the matcher and acts hands-free.
  await emitFinal(page, "stop");
  await expect(transport).toHaveAttribute("data-playing", "false");
});

test("unknown speech is dropped — no command, never the brain", async ({ page }) => {
  let brainCalls = 0;
  await page.route("**/api/brain/chat", async (route) => {
    brainCalls++;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ content: "{}" }) });
  });
  await installMockSpeech(page);
  await boot(page);
  await newProject(page);
  await addAudioTrack(page);
  await expect(tracks(page)).toHaveCount(1);

  await turnHandsFreeOn(page);

  // An open-ended ask that matchFastPath returns null for: it must NOT act, and must
  // NOT fall through to the LLM brain (the always-hot-mic safety guarantee).
  await emitFinal(page, "make the bass warmer and add a ton of reverb please");
  await page.waitForTimeout(300); // give any (errant) async dispatch time to land

  await expect(tracks(page)).toHaveCount(1); // unchanged
  await expect(page.getByTestId("transport")).toHaveAttribute("data-playing", "false");
  await expect(page.getByTestId("error")).toHaveCount(0);
  expect(brainCalls).toBe(0);
});

test("turning hands-free OFF releases the mic (aborts the recognizer)", async ({ page }) => {
  await installMockSpeech(page);
  await boot(page);
  await turnHandsFreeOn(page);
  expect((await mockState(page)).started).toBeGreaterThanOrEqual(1);

  const btn = page.getByTestId("moshi-handsfree");
  await capClick(page);
  await expect(btn).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("handsfree-status")).toHaveText("");
  // the continuous recognizer was aborted and is no longer current → mic is cold
  await expect.poll(async () => (await mockState(page)).aborts).toBeGreaterThanOrEqual(1);
  expect((await mockState(page)).hasCurrent).toBe(false);
});

// Seed a single setting override into localStorage before the app boots (the SettingsPanel
// would otherwise be the only way to flip it) — used to exercise the fallback path.
async function bootWithSetting(page: Page, key: string, value: boolean): Promise<void> {
  await page.addInitScript(([k, v]) => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 1, template: null, values: { [k]: v, uiShell: "classic" } }));
  }, [key, value] as [string, boolean]);
  await page.goto("/");
  await expect(page.getByTestId("app")).toBeVisible();
  await expect(page.getByTestId("arrangement")).toBeVisible();
}

test("fallback: 'pause hands-free while recording' releases the mic during a take, resumes after", async ({ page }) => {
  await installMockSpeech(page);
  await bootWithSetting(page, "handsFreePauseOnRecord", true);
  await turnHandsFreeOn(page);

  const before = (await mockState(page)).aborts;
  // Start a take → with the fallback ON, hands-free pauses (the recognizer aborts).
  await page.getByTestId("transport-record").click();
  await expect(page.getByTestId("transport")).toHaveAttribute("data-recording", "true");
  await expect.poll(async () => (await mockState(page)).hasCurrent).toBe(false);
  expect((await mockState(page)).aborts).toBeGreaterThan(before);

  // End the take → hands-free resumes (a fresh recognizer goes hot again).
  await page.getByTestId("transport-stop").click();
  await expect(page.getByTestId("transport")).toHaveAttribute("data-recording", "false");
  await expect.poll(async () => (await mockState(page)).hasCurrent).toBe(true);
});
