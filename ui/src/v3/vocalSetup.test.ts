import { describe, expect, it } from "vitest";
import type { CommandResult, Snapshot, Track } from "../types";
import { defaultChainTargets, looksLikeSpeakers, setInputMonitor, setupVocalLoop, type VocalSetupIO } from "./vocalSetup";

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
