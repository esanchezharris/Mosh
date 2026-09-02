// W2.5 — the produce-lane preflight, driven against the REAL store+bridge.mock
// seam (the taskExec.test.ts idiom): create_track/set_tempo/set_key/create_section/
// load_plugin/load_preset all go through the mock's actual validation, so this
// proves the command SHAPES the preflight sends, not just its own bookkeeping.

import { describe, it, expect, beforeEach } from "vitest";
import { createTaskExecutor } from "./taskExec";
import { runProduceTemplate, type ProduceExec } from "./produceTemplate";
import { useStore } from "../../store";
import { __resetMockForTests } from "../../bridge.mock";
import type { PaletteItem, PresetMenu } from "./drumPalette";
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
});
