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

  // A new track from the add affordance. Since TRK-KIND this is a MENU toggle, not a
  // one-click add: it opens a panel behind a full-viewport scrim. Opening and walking
  // away leaves that scrim over the whole app, which silently blocked every later click
  // (and emitted no create_track at all). Pick a kind — audio, because the native replay
  // stands unknown clips in with test tones and would not survive MIDI.
  await page.getByTestId("v2-track-add").click();
  await page.getByTestId("v2-track-add-audio").click();
  await expect(page.getByTestId("v2-track-add")).toHaveAttribute("aria-expanded", "false");

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
  // Name the commands each gesture MUST have produced. Length alone let the add-track
  // gesture degrade into "open a menu and emit nothing" while the count still cleared
  // its floor from the other steps — the replay lane then had no track creation to
  // replay and nobody noticed.
  const emitted = new Set((trace as { command: string }[]).map((t) => t.command));
  // set_clip_loop and set_master_volume were added here by #464, which independently found
  // the same TRK-KIND menu bug main had already fixed. Its fix was redundant; these two
  // names were not — the flow drives both gestures, so without them a silent stop in
  // either one shrinks the replay artifact (and the native proof built from it) with
  // nothing going red. That is the exact failure mode this loop exists to catch.
  for (const required of ["create_track", "set_clip_fade", "set_clip_gain", "create_bus",
    "set_clip_loop", "set_master_volume"])
    expect([...emitted], `gesture emitted no ${required}`).toContain(required);

  mkdirSync(ART_DIR, { recursive: true });
  writeFileSync(join(ART_DIR, "canonical-flow.json"), JSON.stringify(trace, null, 1));
});
