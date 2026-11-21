import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootV3, commandTrace } from "./helpers";

// DAW-parity P5 replay lane, capture half, on the V3 shell (ported from replay-capture.spec.ts,
// which drove v2). Dumps the commands a canonical arrangement flow emitted (the mock's dev-only
// __moshCmdTrace: command + args + result ids) to .replay-artifacts/canonical-flow.json; the native
// lane replays it through `Mosh --run-script` (scripts/daw-conformance/replay_e2e_log.py, which
// rebinds mock ids to engine ids). Keep the flow to WAVE-clip + mixer ops: the replay stands
// unknown clips in with test tones, so MIDI ops would not survive it.
//
// V3 has UI for the bus (the inspector's + Bus). It has NO UI for clip fades, clip gain, clip
// loop, the master fader, or a bare "add audio track" (V3 adds tracks only through the Start
// template / beat / drum flows). Those are NO-V3-UI: they go through the store's exec, the same
// seam every V3 control uses, so the trace shape the replay consumes is unchanged.

const ART_DIR = join(dirname(fileURLToPath(import.meta.url)), ".replay-artifacts");

type Exec = (c: string, a?: object) => Promise<{ ok: boolean }>;
const run = (page: Page, command: string, args: object) =>
  page.evaluate(async ([c, a]) => {
    const s = (window as unknown as { __moshStore: { getState: () => { exec: Exec } } }).__moshStore;
    return (await s.getState().exec(c as string, a as object)).ok;
  }, [command, args] as const);

test("canonical arrangement flow -> command trace artifact", async ({ page }) => {
  await bootV3(page);

  // Clip edits on the seeded wave clip (fades + gain + loop region).
  const clipId = await page.evaluate(() => {
    const s = (window as unknown as { __moshStore: { getState: () => { snapshot: { tracks: { clips: { id: string; type: string }[] }[] } } } }).__moshStore;
    return s.getState().snapshot.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")?.id ?? null;
  });
  expect(clipId, "the seeded session has a wave clip").not.toBeNull();
  expect(await run(page, "set_clip_fade", { clipId, fadeInSec: 0.25, fadeOutSec: 0.5 })).toBe(true);
  expect(await run(page, "set_clip_gain", { clipId, gainDb: -3 })).toBe(true);
  expect(await run(page, "set_clip_loop", { clipId, enabled: true, start: 0, length: 1 })).toBe(true);

  // A new audio track (the native replay stands wave clips in with tones; MIDI would not survive).
  expect(await run(page, "create_track", { name: "Replay audio", type: "audio" })).toBe(true);

  // Mixer: master fader, plus a bus from the inspector's real + Bus button.
  expect(await run(page, "set_master_volume", { db: -4 })).toBe(true);
  const track = page.locator('[data-testid="v3-track"]').first();
  await track.getByRole("button", { name: /^Select track/ }).click();
  await page.getByTestId("v3-inspector").getByTestId("v3-add-bus").click();
  await expect(page.getByTestId("v3-inspector").getByTestId("v3-send")).toHaveCount(1);

  const trace = await commandTrace(page);
  expect(trace.length).toBeGreaterThanOrEqual(6);
  // Every traced command must have succeeded in the mock: a failing gesture is a spec bug, not a
  // replay candidate.
  for (const t of trace) expect(t.ok, `mock rejected ${t.command}`).toBe(true);
  // Name the commands the flow MUST have produced: a silent stop in any one would shrink the
  // replay artifact (and the native proof built from it) with nothing going red.
  const emitted = new Set(trace.map((t) => t.command));
  for (const required of ["create_track", "set_clip_fade", "set_clip_gain", "create_bus",
    "set_clip_loop", "set_master_volume"])
    expect([...emitted], `flow emitted no ${required}`).toContain(required);

  const full = await page.evaluate(() =>
    (window as unknown as { __moshCmdTrace?: unknown[] }).__moshCmdTrace ?? []);
  mkdirSync(ART_DIR, { recursive: true });
  writeFileSync(join(ART_DIR, "canonical-flow.json"), JSON.stringify(full, null, 1));
});
