import { describe, it, expect, beforeEach } from "vitest";
import { mockExecute, mockSnapshot, __resetMockForTests } from "./bridge.mock";
import type { Snapshot, CommandResult } from "./types";

// Phase 2 — re-imagining a MIDI/drum clip mutes the MIDI and plays a HIDDEN render beneath it (on a
// dedicated, snapshot-EXCLUDED track), surfaced to the UI only as `reimagineActive` (marker + Reset);
// no accept step, no visible hidden clip. Reset un-mutes + clears it. Exercises the dev mock the
// WebView/e2e run against.

const exec = (command: string, args: Record<string, unknown> = {}) =>
  mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();

describe("mock MIDI re-imagine — hidden audio beneath the muted MIDI (Phase 2)", () => {
  beforeEach(() => __resetMockForTests());

  it("render mutes the MIDI and sets reimagineActive (no visible hidden clip); reset reverses", async () => {
    const s = await snap();
    const midi = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "midi");
    expect(midi).toBeTruthy();
    const clipId = midi!.id;
    const trackOf = (snapshot: Snapshot) => snapshot.tracks.find((t) => t.clips.some((c) => c.id === clipId))!;
    const visibleTracks = (snapshot: Snapshot) => snapshot.tracks.length;
    const before = visibleTracks(s);

    expect((await exec("create_render_layer", { clipId, adapter: "fake", mode: "reimagine" })).ok).toBe(true);
    expect((await exec("render_layer", { clipId })).ok).toBe(true);

    let after = await snap();
    let mc = after.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    expect(mc.mute).toBe(true);                                   // source MIDI muted
    expect(mc.renderLayer?.reimagineActive).toBe(true);          // marker + Reset available
    expect(trackOf(after).clips.some((c) => c.hidden)).toBe(false); // no hidden clip exposed to the UI
    expect(visibleTracks(after)).toBe(before);                   // no extra visible track

    // Reset un-mutes the MIDI and clears the marker.
    expect((await exec("reset_render_layer", { clipId })).ok).toBe(true);
    after = await snap();
    mc = after.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!;
    expect(mc.mute).toBe(false);
    expect(mc.renderLayer?.reimagineActive).toBe(false);
    expect(mc.renderLayer?.status).toBe("dirty");
  });

  it("a WAVE clip still auto-applies in place (no muting, no marker)", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    const clipId = wave.id;
    await exec("create_render_layer", { clipId, adapter: "fake", mode: "reimagine" });
    await exec("render_layer", { clipId });
    const rl = (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.renderLayer;
    expect(rl?.appliedInPlace).toBe(true);
    expect(rl?.reimagineActive).toBeFalsy();                      // wave uses in-place, not the beneath model
  });

  it("Live (render-ahead) arms + disarms on a WAVE clip (Lane A)", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    const clipId = wave.id;
    await exec("create_render_layer", { clipId, adapter: "fake", mode: "reimagine" });
    const rlOf = async () => (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)?.renderLayer;

    expect((await rlOf())?.liveArmed).toBeFalsy();                // not armed by default
    expect((await exec("render_ahead_arm", { clipId })).ok).toBe(true);
    let rl2 = await rlOf();
    expect(rl2?.liveArmed).toBe(true);                           // armed → Live is on
    expect(rl2?.appliedInPlace).toBe(true);                      // the clip fills in place

    expect((await exec("render_ahead_arm", { clipId, armed: false })).ok).toBe(true);
    expect((await rlOf())?.liveArmed).toBe(false);              // disarm clears it
  });

  it("Live rejects a MIDI clip (wave-only in v1)", async () => {
    const midi = (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.type === "midi")!;
    await exec("create_render_layer", { clipId: midi.id, adapter: "fake", mode: "reimagine" });
    const r = await exec("render_ahead_arm", { clipId: midi.id });
    expect(r.ok).toBe(false);
  });
});
