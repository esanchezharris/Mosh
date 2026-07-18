import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// DAW-parity P5 replay lane, capture half: drive a canonical arrangement flow through the
// REAL v2 UI (mouse on the real components) and dump the commands those gestures emitted
// (the mock's dev-only __moshCmdTrace: command + args + result ids). The native lane then
// replays the dump through `Mosh --run-script` (scripts/daw-conformance/replay_e2e_log.py,
// which rebinds mock ids → engine ids), converting UI gestures into native proof with no
// WebView automation. Keep this flow to WAVE-clip + mixer ops (the replay script stands in
// unknown clips with test tones — MIDI ops would not survive that stand-in).

const ART_DIR = join(dirname(fileURLToPath(import.meta.url)), ".replay-artifacts");

async function bootV2(page: Page): Promise<void> {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem("mosh.settings", JSON.stringify({ version: 2, template: null, values: { theme: "dark" }, keyOverrides: {} }));
  });
  await page.goto("/?shell=v2");
  await expect(page.getByTestId("v2-shell")).toBeVisible();
  await expect(page.getByTestId("v2-timeline")).toBeVisible();
}

test("canonical arrangement flow → command trace artifact", async ({ page }) => {
  await bootV2(page);

  // Clip edits on the seeded wave clip (fades + gain + loop region).
  const wave = page.locator(".v2-clip.wave").first();
  await wave.click();
  await page.getByTestId("v2-insp-tab-clip").click();
  await page.getByTestId("v2-clip-fadein").fill("0.25");
  await page.getByTestId("v2-clip-fadeout").fill("0.5");
  await page.getByTestId("v2-clip-gain").fill("-3");
  await page.getByTestId("v2-clip-loop").click();
  await page.getByTestId("v2-clip-loop-length").fill("1");

  // A new track from the add affordance.
  await page.getByTestId("v2-track-add").click();

  // Mixer: master fader + a bus with a send.
  await page.getByTestId("v2-master-volume").fill("-4");
  await page.getByTestId("v2-insp-tab-mix").click();
  await page.getByTestId("v2-add-bus").click();

  const trace = await page.evaluate(() =>
    (window as unknown as { __moshCmdTrace?: unknown[] }).__moshCmdTrace ?? []);
  expect(trace.length).toBeGreaterThanOrEqual(6);
  // Every traced command must have succeeded in the mock — a failing gesture is a spec
  // bug, not a replay candidate.
  for (const t of trace as { command: string; ok: boolean }[])
    expect(t.ok, `mock rejected ${t.command}`).toBe(true);

  mkdirSync(ART_DIR, { recursive: true });
  writeFileSync(join(ART_DIR, "canonical-flow.json"), JSON.stringify(trace, null, 1));
});
