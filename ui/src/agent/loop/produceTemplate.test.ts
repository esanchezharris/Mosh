// W2.5 — the produce-lane preflight, driven against the REAL store+bridge.mock
// seam (the taskExec.test.ts idiom): create_track/set_tempo/set_key/create_section/
// load_plugin/load_preset all go through the mock's actual validation, so this
// proves the command SHAPES the preflight sends, not just its own bookkeeping.

import { describe, it, expect, beforeEach } from "vitest";
import { createTaskExecutor } from "./taskExec";
import { runProduceTemplate, type ProduceExec } from "./produceTemplate";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { KitMatchFile, PaletteItem, PresetMenu } from "./drumPalette";
import type { Snapshot } from "../../types";

function snap(): Snapshot {
  const s = useStore.getState().snapshot;
  if (!s) throw new Error("store has no snapshot");
  return s;
}

// Mirrors bridge.mock.ts's `list_palette` fixture exactly (W2.2) — 10 non-bass
// items for the 10 pad lanes + 2 measured bass/808 roots.
const PALETTE: PaletteItem[] = [
  { path: "/mock/palette/kick_1.wav", role: "kick" },
  { path: "/mock/palette/kick_2.wav", role: "kick" },
  { path: "/mock/palette/snare_1.wav", role: "snare" },
  { path: "/mock/palette/snare_2.wav", role: "snare" },
  { path: "/mock/palette/clap_1.wav", role: "clap" },
  { path: "/mock/palette/clap_2.wav", role: "clap" },
  { path: "/mock/palette/hat_1.wav", role: "hat" },
  { path: "/mock/palette/openhat_1.wav", role: "openhat" },
  { path: "/mock/palette/perc_1.wav", role: "perc" },
  { path: "/mock/palette/fx_1.wav", role: "fx" },
  { path: "/mock/palette/bass_1.wav", role: "bass", rootNote: 24 },
  { path: "/mock/palette/bass_2.wav", role: "bass", rootNote: 33 },
];

// Enough Vital presets to cover all 7 synth roles' first preference.
const PRESETS: PresetMenu = [
  { plugin: "vital", name: "Dark Lead", file: "/presets/vital/lead-dark.vital" },
  { plugin: "vital", name: "Trap Pluck", file: "/presets/vital/pluck-trap.vital" },
  { plugin: "vital", name: "Warm Pad", file: "/presets/vital/pad-warm.vital" },
  { plugin: "vital", name: "Airy Pad", file: "/presets/vital/pad-airy.vital" },
  { plugin: "vital", name: "Night Atmos", file: "/presets/vital/atmos-night.vital" },
  { plugin: "vital", name: "Rhodes", file: "/presets/vital/keys-rhodes.vital" },
  { plugin: "vital", name: "Glass Arp", file: "/presets/vital/arp-glass.vital" },
  { plugin: "vital", name: "Bell Hit", file: "/presets/vital/bell-hit.vital" },
];

describe("runProduceTemplate — the deterministic produce-lane preflight", () => {
  beforeEach(async () => {
    __resetMockForTests();
    await useStore.getState().refresh();
  });

  it("builds 9 tracks (1 drums + 1 bass/808 + 7 synths), 10 drum pads, and a loaded Vital preset on every synth", async () => {
    const tracksBefore = snap().tracks.length;
    const t = createTaskExecutor("produce", { utterance: "produce a dark jerk trap beat at 148 in D minor" });
    const template = await runProduceTemplate("produce a dark jerk trap beat at 148 in D minor", {
      exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 3,
    });
    await t.close();

    expect(template.bpm).toBe(148);
    expect(template.key).toEqual({ tonic: "D", mode: "minor" });
    expect(template.drums.pads).toHaveLength(10);
    expect(new Set(template.drums.pads.map((p) => p.file)).size).toBe(10);
    expect(template.synths).toHaveLength(7);
    expect(template.synths.every((s) => !s.presetError)).toBe(true);
    expect(new Set(template.synths.map((s) => s.trackId)).size).toBe(7);

    const s = snap();
    expect(s.tracks.length - tracksBefore).toBe(9);
    const drumsTrack = s.tracks.find((x) => x.id === template.drums.trackId)!;
    expect(drumsTrack.type).toBe("drum");
    expect(s.tracks.some((x) => x.id === template.bass.trackId)).toBe(true);
    for (const synth of template.synths) {
      const track = s.tracks.find((x) => x.id === synth.trackId)!;
      expect(track.plugins?.some((p) => p.isInstrument && /vital/i.test(p.name))).toBe(true);
      expect(track.name).toContain("·"); // renamed to "<Role> · <preset>"
    }
    // one undo unit covers the WHOLE preflight (One mutation path invariant)
    const undone = await useStore.getState().exec("undo");
    expect(undone.ok).toBe(true);
    await useStore.getState().refresh();
    expect(snap().tracks.length).toBe(tracksBefore);
  });

  it("the 808 is assigned in MELODIC mode at keyNote = rootNote + 36 (plays pitched, not a one-shot pad)", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const t = createTaskExecutor("produce", { utterance: "produce me a beat" });
    const spy: ProduceExec = async (command, args) => {
      calls.push({ command, args });
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce me a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 0 });
    await t.close();

    const assignBass = calls.find((c) => c.command === "assign_sample" && c.args?.trackId === template.bass.trackId)!;
    expect(assignBass.args?.mode).toBe("melodic");
    expect(assignBass.args?.note).toBe(template.bass.keyNote);
    // palette-v2 bass roots 17-34 -> keyNote 53-70 (the reference 808 register)
    expect(template.bass.keyNote).toBeGreaterThanOrEqual(53);
    expect(template.bass.keyNote).toBeLessThanOrEqual(70);
    // and drum pads are assigned WITHOUT mode (defaults to "drum" — a one-shot)
    const assignDrum = calls.find((c) => c.command === "assign_sample" && c.args?.trackId === template.drums.trackId)!;
    expect(assignDrum.args?.mode).toBeUndefined();
  });

  it("defaults to 148 BPM / D minor when the ask names neither", async () => {
    const t = createTaskExecutor("produce", {});
    const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS });
    await t.close();
    expect(template.bpm).toBe(148);
    expect(template.key).toEqual({ tonic: "D", mode: "minor" });
  });

  it("parses an explicit tempo and key from the ask", async () => {
    const t = createTaskExecutor("produce", {});
    const template = await runProduceTemplate("produce a dark beat at 162 bpm in F# minor", { exec: t.execRaw, palette: PALETTE, presets: PRESETS });
    await t.close();
    expect(template.bpm).toBe(162);
    expect(template.key).toEqual({ tonic: "F#", mode: "minor" });
  });

  it("retries load_plugin on a transient 'instance not available' error, then succeeds (retry path)", async () => {
    const t = createTaskExecutor("produce", {});
    let firstTrackId: string | null = null;
    let flakyAttempts = 0;
    const flaky: ProduceExec = async (command, args) => {
      if (command === "load_plugin") {
        const trackId = args?.trackId as string;
        firstTrackId ??= trackId;
        if (trackId === firstTrackId) {
          flakyAttempts++;
          if (flakyAttempts < 3) return { ok: false, error: "instance not available" };
        }
      }
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", {
      exec: flaky, palette: PALETTE, presets: PRESETS, retryDelayMs: 0,
    });
    await t.close();
    expect(flakyAttempts).toBe(3); // 2 failures + 1 success, never more (no over-retry)
    expect(template.synths).toHaveLength(7);
    expect(template.synths.every((s) => !s.presetError)).toBe(true);
  });

  it("gives up after 3 attempts and records a presetError WITHOUT aborting the rest of the preflight", async () => {
    const t = createTaskExecutor("produce", {});
    const alwaysFlaky: ProduceExec = async (command, args) => {
      if (command === "load_plugin") return { ok: false, error: "instance not available" };
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", {
      exec: alwaysFlaky, palette: PALETTE, presets: PRESETS, retryDelayMs: 0,
    });
    await t.close();
    expect(template.synths).toHaveLength(7);
    expect(template.synths.every((s) => !!s.presetError)).toBe(true);
    // drums + 808 are untouched by the synth-loading failure
    expect(template.drums.pads).toHaveLength(10);
    expect(template.bass.file).toBeTruthy();
  });

  it("round 3 (R3.3): applies the revised fixed gain map via set_track_volume and records it on template.mix.gainsDb", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const t = createTaskExecutor("produce", { utterance: "produce a beat" });
    const spy: ProduceExec = async (command, args) => {
      calls.push({ command, args });
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 2 });
    await t.close();

    const volumeCalls = calls.filter((c) => c.command === "set_track_volume");
    expect(volumeCalls.find((c) => c.args?.trackId === template.drums.trackId)?.args?.db).toBe(0);
    expect(volumeCalls.find((c) => c.args?.trackId === template.bass.trackId)?.args?.db).toBe(3);
    const dbFor = (role: string) => volumeCalls.find((c) => c.args?.trackId === template.synths.find((s) => s.role === role)!.trackId)?.args?.db;
    expect(dbFor("chords_pad")).toBe(-13);
    expect(dbFor("drone")).toBe(-14);
    expect(dbFor("ambient")).toBe(-16);
    expect(dbFor("lead")).toBe(-10);
    expect(dbFor("counter")).toBe(-12);
    expect(dbFor("stab")).toBe(-10);
    expect(dbFor("arp")).toBe(-16);
    expect(template.mix.gainsDb).toEqual({
      drums: 0, "808": 3, chords_pad: -13, drone: -14, ambient: -16, lead: -10, counter: -12, stab: -10, arp: -16,
    });
    expect(template.seed).toBe(2);
  });

  // bridge.mock.ts's BUILTINS carries both "highpass" and "softclip" today (the
  // concurrent native slice, plan R3.3, landed on this worktree) — so the
  // fallback/error-recording paths below are proven with a CONTROLLED spy
  // rather than the shared mock, whose catalog isn't this file's to depend on
  // staying exactly as-is. A separate pair of tests proves the real mock's
  // happy path too, so both the logic and the current integration are covered.
  it("master chain: falls back to compressor when load_master_builtin('softclip') errors, recorded not thrown", async () => {
    const t = createTaskExecutor("produce", {});
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const spy: ProduceExec = async (command, args) => {
      calls.push({ command, args });
      if (command === "load_master_builtin" && args?.type === "softclip") return { ok: false, error: "unknown builtin" };
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 2 });
    await t.close();
    const masterCalls = calls.filter((c) => c.command === "load_master_builtin");
    expect(masterCalls.map((c) => c.args?.type)).toEqual(["softclip", "compressor"]);
    expect(template.mix.master).toEqual({
      chain: [
        { type: "softclip", ok: false, error: "unknown builtin" },
        { type: "compressor", ok: true },
      ],
    });
  });

  it("master chain: softclip succeeding never falls through to compressor", async () => {
    const t = createTaskExecutor("produce", {});
    const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 2 });
    await t.close();
    // The real mock's BUILTINS entry for "softclip" succeeds today.
    expect(template.mix.master.chain).toEqual([{ type: "softclip", ok: true }]);
  });

  it("every synth track gets a highpass attempt (drums/808 never appear in mix.highpass); a load_builtin error is recorded not thrown", async () => {
    const t = createTaskExecutor("produce", {});
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const spy: ProduceExec = async (command, args) => {
      calls.push({ command, args });
      if (command === "load_builtin" && args?.type === "highpass") return { ok: false, error: "unknown builtin" };
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 4 });
    await t.close();
    expect(Object.keys(template.mix.highpass).sort()).toEqual(
      ["ambient", "arp", "chords_pad", "counter", "drone", "lead", "stab"].sort(),
    );
    // Every attempt fails via the spy above, recorded honestly (not thrown),
    // and no set_plugin_param is even attempted since load itself failed.
    for (const role of Object.keys(template.mix.highpass) as Array<keyof typeof template.mix.highpass>) {
      const hp = template.mix.highpass[role]!;
      expect(hp.loaded).toBe(false);
      expect(hp.loadError).toBe("unknown builtin");
      expect(hp.paramSet).toBe("skipped");
    }
    // requested Hz per role — chords_pad 160, drone 120, arp/lead/counter/stab
    // 200, ambient falls back to the 180 Hz native default (no listed target).
    expect(template.mix.highpass.chords_pad?.requestedHz).toBe(160);
    expect(template.mix.highpass.drone?.requestedHz).toBe(120);
    expect(template.mix.highpass.arp?.requestedHz).toBe(200);
    expect(template.mix.highpass.lead?.requestedHz).toBe(200);
    expect(template.mix.highpass.counter?.requestedHz).toBe(200);
    expect(template.mix.highpass.stab?.requestedHz).toBe(200);
    expect(template.mix.highpass.ambient?.requestedHz).toBe(180);
  });

  it("highpass load succeeding against the real mock records loaded:true but paramSet stays 'skipped' (the Hz normalization curve is still unmeasured)", async () => {
    const t = createTaskExecutor("produce", {});
    const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 4 });
    await t.close();
    for (const role of Object.keys(template.mix.highpass) as Array<keyof typeof template.mix.highpass>) {
      const hp = template.mix.highpass[role]!;
      expect(hp.loaded).toBe(true);
      expect(hp.paramSet).toBe("skipped"); // never calls set_plugin_param today
    }
  });

  it("round 3 (R3.3): highpass is attempted with {trackId, type:'highpass'} on every synth trackId, in role order, and never on the drums/808 tracks", async () => {
    const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    const t = createTaskExecutor("produce", { utterance: "produce a beat" });
    const spy: ProduceExec = async (command, args) => {
      calls.push({ command, args });
      return t.execRaw(command, args);
    };
    const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 4 });
    await t.close();
    const highpassCalls = calls.filter((c) => c.command === "load_builtin" && c.args?.type === "highpass");
    expect(highpassCalls).toHaveLength(7);
    const synthTrackIds = new Set(template.synths.map((s) => s.trackId));
    for (const c of highpassCalls) expect(synthTrackIds.has(c.args?.trackId as string)).toBe(true);
    expect(highpassCalls.some((c) => c.args?.trackId === template.drums.trackId)).toBe(false);
    expect(highpassCalls.some((c) => c.args?.trackId === template.bass.trackId)).toBe(false);
  });

  it("round 3 (R3.3): the master VST3 step (God Particle) only appears under MOSH_PRODUCE_MASTER_VST3=1 AND a matching list_plugins name, after the softclip step", async () => {
    const t = createTaskExecutor("produce", { utterance: "produce a beat" });
    // The real mock's VST3 catalog has no "The God Particle" entry (it's an
    // owner-machine-only plugin, plan R3.3) — intercept both list_plugins AND
    // load_master_plugin so this test proves the GATING logic without
    // depending on the shared mock's plugin catalog.
    const spy: ProduceExec = async (command, args) => {
      if (command === "list_plugins") return { ok: true, data: { plugins: [{ name: "The God Particle" }, { name: "Vital" }] } };
      if (command === "load_master_plugin" && args?.pluginId === "The God Particle") return { ok: true };
      return t.execRaw(command, args);
    };
    const prev = process.env.MOSH_PRODUCE_MASTER_VST3;
    process.env.MOSH_PRODUCE_MASTER_VST3 = "1";
    try {
      const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 0 });
      expect(template.mix.master.chain.map((s) => s.type)).toEqual(["softclip", "vst3:The God Particle"]);
      expect(template.mix.master.chain[1]!.ok).toBe(true);
    } finally {
      await t.close();
      if (prev === undefined) delete process.env.MOSH_PRODUCE_MASTER_VST3;
      else process.env.MOSH_PRODUCE_MASTER_VST3 = prev;
    }
  });

  it("round 3 (R3.3): the master VST3 step never appears when the env flag is unset, even if list_plugins would have matched", async () => {
    const t = createTaskExecutor("produce", { utterance: "produce a beat" });
    const spy: ProduceExec = async (command, args) => {
      if (command === "list_plugins") return { ok: true, data: { plugins: [{ name: "The God Particle" }] } };
      return t.execRaw(command, args);
    };
    const prev = process.env.MOSH_PRODUCE_MASTER_VST3;
    delete process.env.MOSH_PRODUCE_MASTER_VST3;
    try {
      const template = await runProduceTemplate("produce a beat", { exec: spy, palette: PALETTE, presets: PRESETS, seed: 0 });
      expect(template.mix.master.chain.map((s) => s.type)).toEqual(["softclip"]);
    } finally {
      await t.close();
      if (prev !== undefined) process.env.MOSH_PRODUCE_MASTER_VST3 = prev;
    }
  });

  it("round 3 (R3.3): the master VST3 step never appears when the flag is set but no God Particle plugin is in the catalog", async () => {
    const t = createTaskExecutor("produce", { utterance: "produce a beat" });
    const prev = process.env.MOSH_PRODUCE_MASTER_VST3;
    process.env.MOSH_PRODUCE_MASTER_VST3 = "1";
    try {
      const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 0 });
      expect(template.mix.master.chain.map((s) => s.type)).toEqual(["softclip"]);
    } finally {
      await t.close();
      if (prev === undefined) delete process.env.MOSH_PRODUCE_MASTER_VST3;
      else process.env.MOSH_PRODUCE_MASTER_VST3 = prev;
    }
  });

  it("round 2 note 6: the pad gain map (kick -2, hat/openhat -6, clap2 -8) is recorded on template.mix.padGainsDb keyed by MIDI note", async () => {
    const t = createTaskExecutor("produce", {});
    const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 1 });
    await t.close();
    expect(template.mix.padGainsDb[36]).toBe(-2); // kick
    expect(template.mix.padGainsDb[42]).toBe(-6); // hat
    expect(template.mix.padGainsDb[46]).toBe(-6); // openhat
    expect(template.mix.padGainsDb[40]).toBe(-8); // clap2
  });

  it("a synth role with no matching Vital preset is recorded, not thrown", async () => {
    const t = createTaskExecutor("produce", {});
    const scarcePresets: PresetMenu = [{ plugin: "vital", name: "Only Lead", file: "/presets/vital/lead-only.vital" }];
    const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: scarcePresets });
    await t.close();
    expect(template.synths).toHaveLength(7);
    const lead = template.synths.find((s) => s.role === "lead")!;
    expect(lead.preset).toBe("Only Lead");
    const others = template.synths.filter((s) => s.role !== "lead");
    expect(others.every((s) => s.presetError)).toBe(true);
  });

  describe("round 3 (R3.2): kit-matched drum picking", () => {
    const KIT_MATCH: KitMatchFile = {
      lanes: {
        kick: { ownerFile: "/lab/kick.wav", role: "kick", paletteFile: "/mock/palette/kick_2.wav", cosine: 0.94 },
        hat: { ownerFile: "/lab/hat.wav", role: "hat", paletteFile: "/mock/palette/hat_1.wav", cosine: 0.91 },
        // snare has no entry — falls back to the seeded pick.
        clap: { ownerFile: "/lab/clap.wav", role: "clap", paletteFile: "/mock/palette/clap_9999.wav", cosine: 0.5 }, // not in PALETTE
      },
    };

    it("template.json.drums.pads[].matchCosine is set for lanes the kitmatch manifest actually resolved", async () => {
      const t = createTaskExecutor("produce", {});
      const template = await runProduceTemplate("produce a beat", {
        exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 5, kitMatch: { file: "/lab-manifests/kitmatch-15drtt-jerk-r0.json", data: KIT_MATCH },
      });
      await t.close();
      const kick = template.drums.pads.find((p) => p.note === 36)!;
      expect(kick.file).toBe("/mock/palette/kick_2.wav");
      expect(kick.matchCosine).toBe(0.94);
      const hat = template.drums.pads.find((p) => p.note === 42)!;
      expect(hat.matchCosine).toBe(0.91);
      // clap's kitmatch paletteFile isn't in PALETTE — falls back, no matchCosine.
      const clap = template.drums.pads.find((p) => p.note === 39)!;
      expect(clap.matchCosine).toBeUndefined();
    });

    it("template.json.kitMatch = {file, lanesMatched} records the manifest path and how many lanes it actually resolved", async () => {
      const t = createTaskExecutor("produce", {});
      const template = await runProduceTemplate("produce a beat", {
        exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 5, kitMatch: { file: "/lab-manifests/kitmatch-15drtt-jerk-r0.json", data: KIT_MATCH },
      });
      await t.close();
      // kick + hat resolved; snare has no entry, clap's file isn't in PALETTE.
      expect(template.kitMatch).toEqual({ file: "/lab-manifests/kitmatch-15drtt-jerk-r0.json", lanesMatched: 2 });
    });

    it("template.kitMatch is omitted entirely when deps.kitMatch is omitted (pre-round-3 behavior)", async () => {
      const t = createTaskExecutor("produce", {});
      const template = await runProduceTemplate("produce a beat", { exec: t.execRaw, palette: PALETTE, presets: PRESETS, seed: 5 });
      await t.close();
      expect(template.kitMatch).toBeUndefined();
      expect(template.drums.pads.every((p) => p.matchCosine === undefined)).toBe(true);
    });
  });
});
