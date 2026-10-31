// The Start page's backend, in the dev/e2e mock: the fresh-install seed, the ?mockFault
// knobs, the vocal template, loop_setup's arming, the two bundled track-chain presets, the
// fixture beat and fresh pairing tokens. URL knobs are read once at module load, so each
// knob test re-imports the module under its own location.search (the portfolio test's
// pattern).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetMockForTests, mockExecute, mockSnapshot, mockRemoteStartPairing, mockPickFiles,
  mockMicrophonePermissionStatus, mockRequestMicrophonePermission, mockOnEvent } from "./bridge.mock";
import type { CommandResult, Plugin, Snapshot } from "./types";

type MockModule = typeof import("./bridge.mock");

const run = (command: string, args: Record<string, unknown> = {}) => mockExecute<CommandResult>({ command, args });
const snap = () => mockSnapshot<Snapshot>();
const CLEAN = "/presets/track-chain/mosh-clean-lead-v0.json";
const TUNED = "/presets/track-chain/mosh-tuned-lead-v0.json";
const DENIED = "Microphone access is off for Mosh. Enable it in System Settings > Privacy & Security > Microphone, then arm the track again.";
const RESTRICTED = "Microphone access is not available on this Mac.";
const TIMEOUT = "The microphone permission request did not finish. Playback remains available; arm the track again to retry.";

/** The mock module as a page loaded with `search` would see it. */
async function withSearch(search: string): Promise<MockModule> {
  vi.resetModules();
  window.history.replaceState({}, "", `/${search}`);
  const mod = await import("./bridge.mock");
  mod.__resetMockForTests();
  return mod;
}
const runIn = (mod: MockModule, command: string, args: Record<string, unknown> = {}) =>
  mod.mockExecute<CommandResult>({ command, args });

async function rack(trackId: string): Promise<Plugin[]> {
  return (await snap()).tracks.find((t) => t.id === trackId)!.plugins ?? [];
}

describe("URL knobs (module re-imported per location)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    window.history.replaceState({}, "", "/");
  });

  it("?mockSeed=fresh is a first launch: no tracks, 120 BPM, no loop, empty Recent, headphones", async () => {
    const mod = await withSearch("?mockSeed=fresh");
    const s = await mod.mockSnapshot<Snapshot>();
    expect(s.tracks).toEqual([]);
    expect(s.session.tempo).toBe(120);
    expect(s.session.recentProjects).toEqual([]);
    expect(s.session.editFile).toBe("");
    expect(s.loop).toMatchObject({ engaged: false, phase: "setup_required", contributions: [] });
    expect(s.transport.looping).toBe(false);
    const devices = (await runIn(mod, "list_audio_devices")).data as { current: { outputDevice: string; inputDevice: string } };
    expect(devices.current.outputDevice).toBe("External Headphones");
    expect(devices.current.inputDevice).toBe("MacBook Pro Microphone");
    // not asked yet; asking grants
    expect(mod.mockMicrophonePermissionStatus()).toEqual({ status: "not-determined" });
    expect(mod.mockRequestMicrophonePermission()).toEqual({ status: "granted" });
    expect(mod.mockMicrophonePermissionStatus()).toEqual({ status: "granted" });
  });

  it("?mockFault=speakers keeps the speakers even under the fresh seed", async () => {
    const mod = await withSearch("?mockSeed=fresh&mockFault=speakers");
    const devices = (await runIn(mod, "list_audio_devices")).data as { current: { outputDevice: string } };
    expect(devices.current.outputDevice).toBe("MacBook Pro Speakers");
  });

  it("the default seed keeps its speakers and a granted mic", async () => {
    const mod = await withSearch("");
    const devices = (await runIn(mod, "list_audio_devices")).data as { current: { outputDevice: string } };
    expect(devices.current.outputDevice).toBe("MacBook Pro Speakers");
    expect(mod.mockMicrophonePermissionStatus()).toEqual({ status: "granted" });
    expect((await mod.mockSnapshot<Snapshot>()).tracks).toHaveLength(3);
  });

  for (const [fault, status, error] of [
    ["mic-denied", "denied", DENIED],
    ["mic-restricted", "restricted", RESTRICTED],
    ["mic-timeout", "timed-out", TIMEOUT],
  ] as const) {
    it(`?mockFault=${fault}: the permission reads ${status} and every arm is refused with the engine's string`, async () => {
      const mod = await withSearch(`?mockFault=${fault}`);
      expect(mod.mockMicrophonePermissionStatus()).toEqual({ status, error });
      expect(mod.mockRequestMicrophonePermission()).toEqual({ status, error });
      const trackId = (await mod.mockSnapshot<Snapshot>()).tracks[2]!.id;
      const armed = await runIn(mod, "arm_track", { trackId, armed: true });
      expect(armed).toMatchObject({ ok: false, error });
      expect((await runIn(mod, "arm_track", { trackId, armed: false })).ok).toBe(true);   // disarming is fine
      // the vocal template and loop_setup arm through the same rule
      const tpl = (await runIn(mod, "new_project", { template: "vocal" })).data as { vocalTrackId: string };
      expect((await mod.mockSnapshot<Snapshot>()).tracks.find((t) => t.id === tpl.vocalTrackId)!.armed).toBeFalsy();
      const setup = await runIn(mod, "loop_setup", { trackId: tpl.vocalTrackId });
      expect(setup.ok).toBe(true);
      const d = setup.data as { takesTrackId: string; armed: boolean };
      expect(d.armed).toBe(false);
      expect((await mod.mockSnapshot<Snapshot>()).tracks.find((t) => t.id === d.takesTrackId)!.armed).toBeFalsy();
    });
  }

  it("?mockNoInput=1 leaves loop_setup's Takes unarmed and says so", async () => {
    const mod = await withSearch("?mockNoInput=1");
    const lead = (await mod.mockSnapshot<Snapshot>()).tracks[2]!.id;
    const d = (await runIn(mod, "loop_setup", { trackId: lead })).data as { takesTrackId: string; armed: boolean };
    expect(d.armed).toBe(false);
    expect((await mod.mockSnapshot<Snapshot>()).tracks.find((t) => t.id === d.takesTrackId)!.armed).toBeFalsy();
  });

  it("?mockFault=bpm-fail refuses like the engine; bpm-half answers half the tempo, unsure", async () => {
    let mod = await withSearch("?mockFault=bpm-fail");
    let backing = (await runIn(mod, "new_project", { template: "vocal" })).data as { backingTrackId: string };
    let clip = (await runIn(mod, "import_clip", { file: "/mock/beats/night-drive.wav", trackId: backing.backingTrackId, startSeconds: 0 })).data as { clipId: string };
    expect(await runIn(mod, "detect_clip_bpm", { clipId: clip.clipId }))
      .toMatchObject({ ok: false, error: "cannot estimate BPM (unreadable or no pulse)" });

    mod = await withSearch("?mockFault=bpm-half");
    backing = (await runIn(mod, "new_project", { template: "vocal" })).data as { backingTrackId: string };
    clip = (await runIn(mod, "import_clip", { file: "/mock/beats/night-drive.wav", trackId: backing.backingTrackId, startSeconds: 0 })).data as { clipId: string };
    expect((await runIn(mod, "detect_clip_bpm", { clipId: clip.clipId })).data).toMatchObject({ bpm: 44, confidence: 0.2 });
  });

  it("?mockFault=pairing-fail fails the start like native, and the store surfaces it in lastError", async () => {
    const mod = await withSearch("?mockFault=pairing-fail");
    const r = mod.mockRemoteStartPairing();
    expect(r).toEqual({ ok: false, error: "could not start remote companion server (port 47873 already in use)" });
    const { useStore } = await import("./store");
    await useStore.getState().startRemotePairing();
    expect(useStore.getState().lastError).toBe("could not start remote companion server (port 47873 already in use)");
  });

  it("?mockFault=pairing-short mints a token that expires in 3 s", async () => {
    const mod = await withSearch("?mockFault=pairing-short");
    const before = Date.now();
    const r = mod.mockRemoteStartPairing();
    expect(r.ok).toBe(true);
    const expires = r.data!.pairing!.expiresAtMs;
    expect(expires - before).toBeGreaterThanOrEqual(3000);
    expect(expires - before).toBeLessThan(3500);
  });

  it("?mockFault=phone-connect: 2 s after a mint the phone is connected for good, and the UI hears about it", async () => {
    vi.useFakeTimers();
    const mod = await withSearch("?mockFault=phone-connect");
    const events: string[] = [];
    mod.mockOnEvent("mosh_event", (e) => { events.push((e as { type: string }).type); });
    expect((await mod.mockSnapshot<Snapshot>()).loop?.phoneConnected).toBe(false);
    mod.mockRemoteStartPairing();
    vi.advanceTimersByTime(1999);
    expect((await mod.mockSnapshot<Snapshot>()).loop?.phoneConnected).toBe(false);
    expect(events).not.toContain("loop");
    vi.advanceTimersByTime(1);
    expect((await mod.mockSnapshot<Snapshot>()).loop?.phoneConnected).toBe(true);
    expect(events).toContain("snapshot_invalidated");
    expect(events).toContain("loop");
    mod.mockRemoteStartPairing();                 // a re-mint never takes it back
    vi.advanceTimersByTime(5000);
    expect((await mod.mockSnapshot<Snapshot>()).loop?.phoneConnected).toBe(true);
  });

  it("?mockFault=lost-autotune drops the tuned chain's AutoTune, as a pre-#794 relaunch did", async () => {
    const mod = await withSearch("?mockFault=lost-autotune");
    const trackId = ((await runIn(mod, "create_track", { name: "Lead" })).data as { trackId: string }).trackId;
    expect((await runIn(mod, "apply_track_preset", { trackId, file: TUNED })).ok).toBe(true);
    const rows = (await mod.mockSnapshot<Snapshot>()).tracks.find((t) => t.id === trackId)!.plugins!;
    expect(rows.map((p) => p.type)).toEqual(["highpass", "compressor"]);
    expect(rows.every((p) => p.preset?.id === "mosh.tuned-lead")).toBe(true);
    // the clean chain is untouched by the fault
    expect((await runIn(mod, "apply_track_preset", { trackId, file: CLEAN })).ok).toBe(true);
  });
});

describe("the Start page's commands (default seed)", () => {
  beforeEach(() => __resetMockForTests());
  afterEach(() => __resetMockForTests());

  it("microphone permission: granted by default, through the exported entry points", () => {
    expect(mockMicrophonePermissionStatus()).toEqual({ status: "granted" });
    expect(mockRequestMicrophonePermission()).toEqual({ status: "granted" });
  });

  it("new_project {template:'vocal'} mirrors TPL-001", async () => {
    const r = await run("new_project", { template: " Vocal " });
    expect(r.ok).toBe(true);
    const d = r.data as { template: string; backingTrackId: string; vocalTrackId: string; loopEnd: number; editFile: string };
    expect(d.template).toBe("vocal");
    expect(d.editFile).toMatch(/^\/mock\/untitled-/);
    const s = await snap();
    expect(s.tracks.map((t) => [t.name, t.type])).toEqual([["Backing", "audio"], ["Vocal", "audio"]]);
    expect(s.tracks[0]!.id).toBe(d.backingTrackId);
    const vocal = s.tracks.find((t) => t.id === d.vocalTrackId)!;
    expect(vocal.armed).toBe(true);
    expect(vocal.monitor).toBe("automatic");
    expect(s.tracks.find((t) => t.id === d.backingTrackId)!.armed).toBeFalsy();
    expect(s.session.countInBars).toBe(1);
    expect(s.session.project?.countInBars).toBe(1);
    expect(d.loopEnd).toBeCloseTo((16 * 60) / s.session.tempo, 9);
    expect(s.transport).toMatchObject({ looping: true, loopStart: 0 });
    expect(s.transport.loopEnd).toBeCloseTo(d.loopEnd, 9);

    const unknown = await run("new_project", { template: "rap" });
    expect((unknown.data as { templateError?: string }).templateError).toBe("unknown template: rap (known: vocal)");
  });

  it("loop_setup arms Takes, disarms the Lead and reports armed; again on a re-run", async () => {
    const tpl = (await run("new_project", { template: "vocal" })).data as { vocalTrackId: string };
    const r = await run("loop_setup", { trackId: tpl.vocalTrackId });
    expect(r.ok).toBe(true);
    const d = r.data as { takesTrackId: string; leadTrackId: string; created: boolean; armed: boolean };
    expect(d).toMatchObject({ created: true, leadTrackId: tpl.vocalTrackId, armed: true });
    let s = await snap();
    expect(s.tracks.find((t) => t.id === d.takesTrackId)!.armed).toBe(true);
    expect(s.tracks.find((t) => t.id === tpl.vocalTrackId)!.armed).toBe(false);
    expect(s.loop).toMatchObject({ engaged: true, leadTrackId: tpl.vocalTrackId, takesTrackId: d.takesTrackId });

    await run("arm_track", { trackId: d.takesTrackId, armed: false });
    const again = await run("loop_setup", { trackId: tpl.vocalTrackId });
    expect(again.data).toMatchObject({ created: false, armed: true });
    s = await snap();
    expect(s.tracks.find((t) => t.id === d.takesTrackId)!.armed).toBe(true);
  });

  it("set_key is not an undo step (native logs it undoable:false)", async () => {
    await run("set_tempo", { bpm: 100 });                    // an undoable edit to fall back to
    expect((await run("set_key", { tonic: "D", mode: "major" })).ok).toBe(true);
    expect((await snap()).session.key).toEqual({ tonic: "D", mode: "major" });
    await run("undo");
    const s = await snap();
    expect(s.session.tempo).toBe(120);                        // undo reached the tempo…
    expect(s.session.key).toEqual({ tonic: "D", mode: "major" }); // …and left the key alone
    const log = (await run("get_command_log")).data as { entries?: { command: string; undoable: boolean }[] } | { command: string; undoable: boolean }[];
    const entries = Array.isArray(log) ? log : (log.entries ?? []);
    const line = entries.find((e) => e.command === "set_key");
    if (line) expect(line.undoable).toBe(false);
  });

  it("lists both bundled track-chain presets", async () => {
    const listed = (await run("list_presets", { plugin: "track-chain" })).data as { presets: { name: string; file: string; plugin: string; source: string }[] };
    expect(listed.presets).toEqual([
      { plugin: "track-chain", name: "mosh-clean-lead-v0", file: CLEAN, source: "bundled" },
      { plugin: "track-chain", name: "mosh-tuned-lead-v0", file: TUNED, source: "bundled" },
    ]);
  });

  it("the tuned preset inserts AutoTune ahead of the clean chain, with Key and Scale as choices", async () => {
    const trackId = ((await run("create_track", { name: "Lead" })).data as { trackId: string }).trackId;
    const r = await run("apply_track_preset", { trackId, file: TUNED });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ presetId: "mosh.tuned-lead", name: "Mosh Tuned Lead v0", changed: true, replaced: false });
    expect((r.data as { stages: { processor: string }[] }).stages.map((x) => x.processor))
      .toEqual(["moshAutoTune", "lowpass", "compressor"]);
    const rows = await rack(trackId);
    expect(rows.map((p) => p.type)).toEqual(["moshAutoTune", "highpass", "compressor"]);
    expect(rows.map((p) => p.preset)).toEqual([0, 1, 2].map((stage) =>
      ({ id: "mosh.tuned-lead", name: "Mosh Tuned Lead v0", revision: 0, stage })));
    expect(rows.map((p) => p.index)).toEqual([0, 1, 2]);
    const tuner = rows[0]!;
    expect(tuner.params[0]).toMatchObject({ index: 0, name: "Key", choices: ["C", "C#/Db", "D", "D#/Eb", "E", "F", "F#/Gb", "G", "G#/Ab", "A", "A#/Bb", "B"] });
    expect(tuner.params[1]).toMatchObject({ index: 1, name: "Scale", choices: ["Chromatic", "Major", "Minor"] });
    expect(tuner.params[2]!.display).toBe("40 ms");

    // a choice param stores the normalized value of its state
    await run("set_plugin_param", { trackId, index: 0, paramIndex: 0, value: 2 / 11 });
    await run("set_plugin_param", { trackId, index: 0, paramIndex: 1, value: 0.5 });
    const after = (await rack(trackId))[0]!;
    expect(after.params[0]!.value).toBeCloseTo(2 / 11, 9);
    expect(after.params[0]!.display).toBe("D");
    expect(after.params[1]!.value).toBeCloseTo(0.5, 9);
    expect(after.params[1]!.display).toBe("Major");
  });

  it("the /mock/ path names the tuned preset too", async () => {
    const trackId = ((await run("create_track", { name: "Lead" })).data as { trackId: string }).trackId;
    const r = await run("apply_track_preset", { trackId, file: "/mock/presets/track-chain/mosh-tuned-lead-v0.json" });
    expect(r.data).toMatchObject({ presetId: "mosh.tuned-lead" });
  });

  it("re-applying the same id replaces its group; switching Clean→Tuned is remove + add, re-indexed", async () => {
    const trackId = ((await run("create_track", { name: "Lead" })).data as { trackId: string }).trackId;
    await run("apply_track_preset", { trackId, file: TUNED });
    await run("set_plugin_param", { trackId, index: 0, paramIndex: 2, value: 0.9 });
    const again = await run("apply_track_preset", { trackId, file: TUNED });
    expect(again.data).toMatchObject({ changed: true, replaced: true });
    expect((await rack(trackId)).map((p) => p.type)).toEqual(["moshAutoTune", "highpass", "compressor"]);   // not six

    // a different id is ADDED (the caller removes the other group first)
    await run("apply_track_preset", { trackId, file: CLEAN });
    expect((await rack(trackId)).map((p) => p.preset?.id)).toEqual([
      "mosh.tuned-lead", "mosh.tuned-lead", "mosh.tuned-lead", "mosh.clean-lead", "mosh.clean-lead"]);

    // the Start page's switch: remove the tuned stages from the top, one by one
    expect((await run("batch_begin")).ok).toBe(true);
    for (let i = 0; i < 3; i++) {
      const tuned = (await rack(trackId)).filter((p) => p.preset?.id === "mosh.tuned-lead");
      expect((await run("remove_plugin", { trackId, index: tuned[tuned.length - 1]!.index })).ok).toBe(true);
    }
    expect((await run("batch_end")).ok).toBe(true);
    const left = await rack(trackId);
    expect(left.map((p) => p.type)).toEqual(["highpass", "compressor"]);
    expect(left.map((p) => p.index)).toEqual([0, 1]);
    expect(left.every((p) => p.preset?.id === "mosh.clean-lead")).toBe(true);
  });

  it("apply_track_preset refuses while recording", async () => {
    const tpl = (await run("new_project", { template: "vocal" })).data as { vocalTrackId: string };
    await run("set_transport", { action: "record" });
    expect((await snap()).transport.recording).toBe(true);
    const r = await run("apply_track_preset", { trackId: tpl.vocalTrackId, file: TUNED });
    expect(r).toMatchObject({ ok: false, error: "cannot apply a preset while recording -- stop recording first" });
    await run("stop_recording", { discardRecordings: true });
  });

  it("pick_files: a beat title answers the fixture beat, whose name carries no tempo", () => {
    expect(mockPickFiles({ title: "Choose a Beat" })).toEqual({ ok: true, files: ["/mock/beats/night-drive.wav"] });
    expect(mockPickFiles({ title: "Open project" })).toEqual({ ok: true, files: ["/mock/sessions/protools-tonight.mosh"] });
    expect(mockPickFiles({ title: "Something else" })).toEqual({ ok: false, files: [] });
    expect(/\d+\s?bpm/i.test("/mock/beats/night-drive.wav")).toBe(false);
  });

  it("import_clip of the fixture beat lands 8 bars at 88 BPM on the named track; detect hears 88", async () => {
    const tpl = (await run("new_project", { template: "vocal" })).data as { backingTrackId: string; vocalTrackId: string };
    const r = await run("import_clip", { file: "/mock/beats/night-drive.wav", trackId: tpl.backingTrackId, startSeconds: 0 });
    expect(r.ok).toBe(true);
    const d = r.data as { clipId: string; trackId: string; file: string };
    expect(d).toMatchObject({ trackId: tpl.backingTrackId, file: "/mock/beats/night-drive.wav" });
    const clip = (await snap()).tracks.find((t) => t.id === tpl.backingTrackId)!.clips.find((c) => c.id === d.clipId)!;
    expect(clip.start).toBe(0);
    expect(clip.length).toBeCloseTo((8 * 4 * 60) / 88, 9);
    expect(clip.sourceBpm).toBeUndefined();                       // never from the name, never in the snapshot
    expect((await run("detect_clip_bpm", { clipId: d.clipId })).data).toMatchObject({ bpm: 88, confidence: 0.8 });

    // the tempo survives an undo/redo of the clip
    await run("undo");
    expect((await snap()).tracks.some((t) => t.clips.some((c) => c.id === d.clipId))).toBe(false);
    await run("redo");
    expect((await run("detect_clip_bpm", { clipId: d.clipId })).data).toMatchObject({ bpm: 88 });

    // replacing the beat: remove_clip, and a gone clip answers native's "no clip"
    expect((await run("remove_clip", { clipId: d.clipId })).ok).toBe(true);
    expect(await run("remove_clip", { clipId: d.clipId })).toMatchObject({ ok: false, error: "no clip" });
  });

  it("an unresolved trackId falls back to the first audio track, exactly like native", async () => {
    const tpl = (await run("new_project", { template: "vocal" })).data as { backingTrackId: string };
    const r = await run("import_clip", { file: "/mock/beats/night-drive.wav", trackId: "gone", startSeconds: 0 });
    expect((r.data as { trackId: string }).trackId).toBe(tpl.backingTrackId);
  });

  it("an import into an empty session creates the track, in the same undo step", async () => {
    await run("new_project");
    expect((await snap()).tracks).toHaveLength(0);
    const r = await run("import_clip", { file: "/mock/beats/night-drive.wav", startSeconds: 0 });
    expect(r.ok).toBe(true);
    expect((await snap()).tracks).toHaveLength(1);
    await run("undo");
    expect((await snap()).tracks).toHaveLength(0);
  });

  it("import_clip_data honours trackId and returns {clipId, trackId, file}; a tempo in the name is what detect hears", async () => {
    const tpl = (await run("new_project", { template: "vocal" })).data as { backingTrackId: string; vocalTrackId: string };
    const r = await run("import_clip_data", { name: "late night 92bpm.wav", dataBase64: "UklGRg==", trackId: tpl.backingTrackId, start: 0 });
    expect(r.ok).toBe(true);
    const d = r.data as { clipId: string; trackId: string; file: string };
    expect(d.trackId).toBe(tpl.backingTrackId);
    expect(d.file).toMatch(/late night 92bpm\.wav$/);
    expect((await run("detect_clip_bpm", { clipId: d.clipId })).data).toMatchObject({ bpm: 92 });
    // no tempo in the name: the old 120 stub
    const plain = (await run("import_clip_data", { name: "drop.wav", dataBase64: "UklGRg==", trackId: tpl.backingTrackId, start: 0 })).data as { clipId: string };
    expect((await run("detect_clip_bpm", { clipId: plain.clipId })).data).toMatchObject({ bpm: 120 });
    // …and with no bytes it is still the graceful no-op AL-017 allowlists
    expect(await run("import_clip_data", {})).toMatchObject({ ok: true });
  });

  it("every pairing mint is a fresh token that lives five minutes", () => {
    const before = Date.now();
    const a = mockRemoteStartPairing().data!.pairing!;
    const b = mockRemoteStartPairing().data!.pairing!;
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(b.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).not.toBe(b.token);
    expect(b.padUrl).toContain(`#token=${b.token}`);
    expect(a.expiresAtMs - before).toBeGreaterThanOrEqual(5 * 60 * 1000);
    expect(a.expiresAtMs - before).toBeLessThan(5 * 60 * 1000 + 1000);
  });

  it("without phone-connect the phone never shows as connected", async () => {
    vi.useFakeTimers();
    try {
      const seen: string[] = [];
      const off = mockOnEvent("mosh_event", (e) => { seen.push((e as { type: string }).type); });
      mockRemoteStartPairing();
      vi.advanceTimersByTime(10_000);
      off();
      expect((await snap()).loop?.phoneConnected).toBe(false);
      expect(seen).not.toContain("loop");
    } finally {
      vi.useRealTimers();
    }
  });
});
