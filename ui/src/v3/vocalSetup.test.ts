import { describe, expect, it } from "vitest";
import type { CommandResult, Snapshot, Track } from "../types";
import { defaultChainTargets, looksLikeSpeakers, setInputMonitor, setupVocalLoop, switchVocalPreset, type VocalSetupIO } from "./vocalSetup";

const track = (id: string, over: Partial<Track> = {}): Track =>
  ({ id, index: 0, name: id, type: "audio", volumeDb: 0, pan: 0, mute: false, solo: false, clips: [], plugins: [], ...over }) as unknown as Track;
const effect = { index: 1, name: "EQ", type: "eq", enabled: true, external: false, isInstrument: false, params: [] };

describe("looksLikeSpeakers", () => {
  it.each(["MacBook Pro Speakers", "MacBook Air Speakers", "iMac Speakers", "Built-in Output", "Studio Display Speakers"])(
    "treats %s as a loudspeaker", (name) => expect(looksLikeSpeakers(name)).toBe(true));
  it.each(["External Headphones", "AirPods Pro", "Scarlett 2i2 USB", "BlackHole 2ch", "", null, undefined])(
    "does not flag %s", (name) => expect(looksLikeSpeakers(name)).toBe(false));
});

describe("defaultChainTargets", () => {
  it("puts the chain on both Lead and Takes when both are empty", () => {
    expect(defaultChainTargets([track("L"), track("T")], "L", "T").map((t) => t.id)).toEqual(["L", "T"]);
  });
  it("leaves a Lead that already has effects -- and its Takes -- alone", () => {
    expect(defaultChainTargets([track("L", { plugins: [effect] as Track["plugins"] }), track("T")], "L", "T")).toEqual([]);
  });
  it("skips a Takes lane that already has effects but still fills the Lead", () => {
    expect(defaultChainTargets([track("L"), track("T", { plugins: [effect] as Track["plugins"] })], "L", "T").map((t) => t.id))
      .toEqual(["L"]);
  });
  it("never targets a track a preset cannot apply to, or a missing one", () => {
    expect(defaultChainTargets([track("L", { frozen: true }), track("T")], "L", "T").map((t) => t.id)).toEqual(["T"]);
    expect(defaultChainTargets([track("T")], "L", "T")).toEqual([]);
  });
});

describe("setupVocalLoop (the Booth's and the Start page's shared recipe)", () => {
  type Call = { command: string; args?: Record<string, unknown> };
  const presets = { presets: [{ name: "mosh-clean-lead-v0", file: "/p/mosh-clean-lead-v0.json" }] };
  function io(over: {
    output?: string;
    setup?: CommandResult;
    tracks?: Track[];
    presetsData?: unknown;
    monitorOk?: boolean;
    applyFails?: string;
  } = {}) {
    const calls: Call[] = [];
    const tracks = over.tracks ?? [track("L"), track("T")];
    const snap = { tracks, audio: { outputDevice: over.output ?? "External Headphones" } } as unknown as Snapshot;
    const value: VocalSetupIO = {
      run: async (command, args) => {
        calls.push({ command, args });
        if (command === "loop_setup") return over.setup ?? { ok: true, command, data: { takesTrackId: "T", armed: true } };
        if (command === "apply_track_preset" && over.applyFails === args?.trackId) return { ok: false, command, error: "busy" };
        return { ok: true, command };
      },
      query: async (command, args) => {
        calls.push({ command, args });
        return { ok: true, command, data: over.presetsData ?? presets };
      },
      snapshot: () => snap,
      setMonitor: async (trackId, mode) => { calls.push({ command: "setMonitor", args: { trackId, mode } }); return over.monitorOk ?? true; },
    };
    return { io: value, calls, snap };
  }

  it("on headphones: loop_setup, then the chain on Lead and Takes, monitoring untouched", async () => {
    const { io: x, calls, snap } = io();
    const r = await setupVocalLoop(x, "L", snap);
    expect(calls.map((c) => c.command)).toEqual(["loop_setup", "list_presets", "apply_track_preset", "apply_track_preset"]);
    expect(calls.filter((c) => c.command === "apply_track_preset").map((c) => c.args?.trackId)).toEqual(["L", "T"]);
    expect(r).toMatchObject({ takesId: "T", armed: true });
    expect(r.notes).toEqual(["Added the Mosh Clean Lead v0 vocal chain; change it in Mix"]);
  });

  it("on speakers: turns Hear myself off BEFORE adding the chain, and says so", async () => {
    const { io: x, calls, snap } = io({ output: "MacBook Pro Speakers" });
    const r = await setupVocalLoop(x, "L", snap);
    expect(calls.map((c) => c.command).slice(0, 2)).toEqual(["loop_setup", "setMonitor"]);
    expect(calls[1].args).toEqual({ trackId: "T", mode: "off" });
    expect(r.notes[0]).toBe("Hear myself is off: plug in headphones first");
  });

  it("stops after a refused loop_setup and reports armed:false from the engine", async () => {
    const refused = io({ setup: { ok: false, command: "loop_setup", error: "no track" } });
    const r1 = await setupVocalLoop(refused.io, "L", refused.snap);
    expect(refused.calls.map((c) => c.command)).toEqual(["loop_setup"]);
    expect(r1.takesId).toBeNull();
    const denied = io({ setup: { ok: true, command: "loop_setup", data: { takesTrackId: "T", armed: false } } });
    expect((await setupVocalLoop(denied.io, "L", denied.snap)).armed).toBe(false);
  });

  it("a build without the bundled chain still stands, with no chain note", async () => {
    const { io: x, calls, snap } = io({ presetsData: { presets: [] } });
    const r = await setupVocalLoop(x, "L", snap);
    expect(calls.map((c) => c.command)).toEqual(["loop_setup", "list_presets"]);
    expect(r.notes).toEqual([]);
  });

  it("names the track a chain could not be added to", async () => {
    const { io: x, snap } = io({ applyFails: "T" });
    expect((await setupVocalLoop(x, "L", snap)).notes).toEqual(["Vocal chain not added to T: busy"]);
  });
});

describe("setInputMonitor", () => {
  it("reads applied, deferred and refused answers honestly", async () => {
    const answer = (data: Record<string, unknown> | undefined, ok = true) =>
      async () => ({ ok, command: "set_input_monitor", data, error: ok ? undefined : "nope" }) as CommandResult;
    expect(await setInputMonitor(answer({ applied: true }), "T", "off")).toEqual({ ok: true, deferred: false, reason: null });
    expect(await setInputMonitor(answer({ applied: false, deferred: true }), "T", "off")).toEqual({ ok: true, deferred: true, reason: null });
    expect(await setInputMonitor(answer({ applied: false, reason: "no input device" }), "T", "off"))
      .toEqual({ ok: false, deferred: false, reason: "no input device" });
    expect(await setInputMonitor(answer(undefined, false), "T", "off")).toEqual({ ok: false, deferred: false, reason: "nope" });
  });
});

describe("switchVocalPreset", () => {
  type Call = { command: string; args?: Record<string, unknown> };
  const CLEAN = "/p/mosh-clean-lead-v0.json";
  const TUNED = "/p/mosh-tuned-lead-v0.json";
  const tagged = (id: string, type: string, index: number, stage = index) =>
    ({ index, name: type, type, enabled: true, external: false, isInstrument: false, params: [], preset: { id, name: id, revision: 1, stage } });
  const plain = (type: string, index: number) =>
    ({ index, name: type, type, enabled: true, external: false, isInstrument: false, params: [] });
  const cleanAt = (...indices: number[]) => indices.map((i, s) => tagged("mosh.clean-lead", s === 0 ? "highpass" : "compressor", i, s));
  const tunedStages = () => [tagged("mosh.tuned-lead", "moshAutoTune", 0), tagged("mosh.tuned-lead", "eq", 1), tagged("mosh.tuned-lead", "compressor", 2)];

  /** A fake engine behind VocalSetupIO: remove_plugin re-indexes, apply_track_preset appends
   *  the chain at the end of the rack (Tuned has its AutoTune first), and the snapshot is live,
   *  as `io.run` refreshing after every ok command makes it in the page. */
  function fakeIo(over: { tracks: Track[]; refuse?: (call: Call, nth: number) => string | null; shipped?: string[] }) {
    const calls: Call[] = [];
    const tracks = JSON.parse(JSON.stringify(over.tracks)) as Track[];
    const counts = new Map<string, number>();
    const shipped = over.shipped ?? ["mosh-clean-lead-v0", "mosh-tuned-lead-v0"];
    const io: VocalSetupIO = {
      run: async (command, args = {}) => {
        calls.push({ command, args });
        const nth = (counts.get(command) ?? 0) + 1;
        counts.set(command, nth);
        const refused = over.refuse?.({ command, args }, nth);
        if (refused) return { ok: false, command, error: refused };
        const t = tracks.find((x) => x.id === args.trackId);
        if (command === "remove_plugin") {
          const at = (t?.plugins ?? []).findIndex((p) => p.index === args.index);
          if (!t || at < 0) return { ok: false, command, error: "plugin not found" };
          t.plugins!.splice(at, 1);
          t.plugins!.forEach((p, i) => { p.index = i; });
        }
        if (command === "apply_track_preset") {
          if (!t) return { ok: false, command, error: "no track" };
          const fresh = args.file === TUNED ? tunedStages() : cleanAt(0, 1);
          t.plugins = [...(t.plugins ?? []), ...fresh] as Track["plugins"];
          t.plugins!.forEach((p, i) => { p.index = i; });
        }
        return { ok: true, command };
      },
      query: async (command, args) => {
        calls.push({ command, args });
        const all = [{ name: "mosh-clean-lead-v0", file: CLEAN }, { name: "mosh-tuned-lead-v0", file: TUNED }];
        return { ok: true, command, data: { presets: all.filter((p) => shipped.includes(p.name)) } };
      },
      snapshot: () => ({ tracks }) as unknown as Snapshot,
      setMonitor: async () => true,
    };
    return { io, calls, tracks, names: () => calls.map((c) => c.command) };
  }
  const lane = (id: string, plugins: unknown[]) => track(id, { plugins: plugins as Track["plugins"] });

  it("Tuned with a key: one batch, each lane cleared highest-first, Tuned applied, Key then Scale on that lane's AutoTune", async () => {
    // Takes carries the producer's Gate first, so its AutoTune lands at index 1, not 0.
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", [plain("gate", 0), ...cleanAt(1, 2)])] });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned", key: { keyLabel: "F#/Gb", scale: "Major" } });
    expect(r).toEqual({ ok: true, error: null });
    expect(f.calls).toEqual([
      { command: "list_presets", args: { plugin: "track-chain" } },
      { command: "batch_begin", args: { name: "Tuned Lead" } },
      { command: "remove_plugin", args: { trackId: "L", index: 1 } },
      { command: "remove_plugin", args: { trackId: "L", index: 0 } },
      { command: "apply_track_preset", args: { trackId: "L", file: TUNED } },
      { command: "set_plugin_param", args: { trackId: "L", index: 0, paramIndex: 0, value: 6 / 11 } },
      { command: "set_plugin_param", args: { trackId: "L", index: 0, paramIndex: 1, value: 0.5 } },
      { command: "remove_plugin", args: { trackId: "T", index: 2 } },
      { command: "remove_plugin", args: { trackId: "T", index: 1 } },
      { command: "apply_track_preset", args: { trackId: "T", file: TUNED } },
      { command: "set_plugin_param", args: { trackId: "T", index: 1, paramIndex: 0, value: 6 / 11 } },
      { command: "set_plugin_param", args: { trackId: "T", index: 1, paramIndex: 1, value: 0.5 } },
      { command: "batch_end", args: {} },
    ]);
    expect(f.tracks[1]!.plugins!.map((p) => p.type)).toEqual(["gate", "moshAutoTune", "eq", "compressor"]);
  });

  it("a refused batch_begin touches nothing and says Moshi is busy", async () => {
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", cleanAt(0, 1))], refuse: (c) => (c.command === "batch_begin" ? "agent transaction t1 is open" : null) });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("middle of something");
    expect(f.names()).toEqual(["list_presets", "batch_begin"]);
  });

  it("a failure before anything landed ends the batch and does NOT undo (that would revert the previous edit)", async () => {
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", cleanAt(0, 1))], refuse: (c) => (c.command === "remove_plugin" ? "plugin is locked" : null) });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned" });
    expect(r).toEqual({ ok: false, error: "plugin is locked" });
    expect(f.names()).toEqual(["list_presets", "batch_begin", "remove_plugin", "batch_end"]);
    expect(f.names()).not.toContain("undo");
  });

  it("a failed apply after removals ends the batch, then undoes it exactly once", async () => {
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", cleanAt(0, 1))], refuse: (c) => (c.command === "apply_track_preset" ? "cannot apply a preset while recording" : null) });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned" });
    expect(r).toEqual({ ok: false, error: "cannot apply a preset while recording" });
    expect(f.names()).toEqual(["list_presets", "batch_begin", "remove_plugin", "remove_plugin", "apply_track_preset", "batch_end", "undo"]);
    expect(f.names().filter((c) => c === "undo")).toHaveLength(1);
  });

  it("a failure on the second lane after the first landed still undoes once, after batch_end", async () => {
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", cleanAt(0, 1))], refuse: (c, nth) => (c.command === "apply_track_preset" && nth === 2 ? "busy" : null) });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "clean" });
    expect(r.ok).toBe(false);
    expect(f.names().slice(-2)).toEqual(["batch_end", "undo"]);
    expect(f.names().filter((c) => c === "undo")).toHaveLength(1);
  });

  it("a build without the preset file says so and opens no batch", async () => {
    const f = fakeIo({ tracks: [lane("L", cleanAt(0, 1)), lane("T", cleanAt(0, 1))], shipped: ["mosh-clean-lead-v0"] });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("doesn't include");
    expect(f.names()).toEqual(["list_presets"]);
  });

  it("a stacked lane (six tuned stages, two AutoTunes) is fully cleared before the one chain goes on", async () => {
    const stacked = [...tunedStages(), ...tunedStages()].map((p, i) => ({ ...p, index: i }));
    const f = fakeIo({ tracks: [lane("L", stacked), lane("T", tunedStages())] });
    const r = await switchVocalPreset(f.io, { leadId: "L", takesId: "T", to: "tuned" });
    expect(r.ok).toBe(true);
    const lead = f.calls.slice(0, f.calls.findIndex((c) => c.command === "apply_track_preset") + 1);
    expect(lead.filter((c) => c.command === "remove_plugin").map((c) => c.args?.index)).toEqual([5, 4, 3, 2, 1, 0]);
    expect(lead[lead.length - 1]).toEqual({ command: "apply_track_preset", args: { trackId: "L", file: TUNED } });
    expect(f.tracks[0]!.plugins!.map((p) => p.type)).toEqual(["moshAutoTune", "eq", "compressor"]);
    expect(f.names()).not.toContain("set_plugin_param");
  });
});
