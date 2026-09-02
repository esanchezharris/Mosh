import { describe, expect, it } from "vitest";
import { DEFAULT_DRUM_LANES, pickDrumPalette, pickSynthPresets, type PaletteItem, type PresetMenu } from "./drumPalette";

// The fixture mirrors bridge.mock.ts's `list_palette` case (12 items: 2 kick,
// 2 snare, 2 clap, 1 hat, 1 openhat, 1 perc, 1 fx = 10 non-bass items for the 10
// pad lanes, + 2 bass/808 items with measured rootNote) — same shape, so a test
// against this fixture generalizes to the real mock.
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

describe("pickDrumPalette", () => {
  it("is deterministic: same items + seed ⇒ same pick", () => {
    const a = pickDrumPalette(PALETTE, { seed: 7 });
    const b = pickDrumPalette(PALETTE, { seed: 7 });
    expect(a).toEqual(b);
  });

  it("a different seed can change the pick (not hard-coded to index 0)", () => {
    const seeds = new Set<string>();
    for (let s = 0; s < 12; s++) seeds.add(JSON.stringify(pickDrumPalette(PALETTE, { seed: s })));
    expect(seeds.size).toBeGreaterThan(1);
  });

  it("fills all 10 lanes with 10 DISTINCT files", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 1 });
    expect(pick.pads).toHaveLength(10);
    const files = pick.pads.map((p) => p.file);
    expect(new Set(files).size).toBe(10);
    const notes = pick.pads.map((p) => p.note).sort((a, b) => a - b);
    expect(notes).toEqual(DEFAULT_DRUM_LANES.map((l) => l.note).slice().sort((a, b) => a - b));
  });

  it("the roll lane (no dedicated palette-v2 role) is filled from a leftover item", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 3 });
    const roll = pick.pads.find((p) => p.note === 44);
    expect(roll).toBeDefined();
    expect(roll!.file).toMatch(/\.wav$/);
  });

  it("clap2 carries the -6dB layer gain and hat/openhat share chokeGroup 1", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 5 });
    const clap2 = pick.pads.find((p) => p.note === 40)!;
    expect(clap2.gainDb).toBe(-6);
    const hat = pick.pads.find((p) => p.note === 42)!;
    const openhat = pick.pads.find((p) => p.note === 46)!;
    expect(hat.chokeGroup).toBe(1);
    expect(openhat.chokeGroup).toBe(1);
  });

  it("bass keyNote math: keyNote = rootNote + 36, nearest to 60 wins", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 0 });
    // rootNote 24 -> keyNote 60 (exact center); rootNote 33 -> keyNote 69.
    expect(pick.bass.rootNote).toBe(24);
    expect(pick.bass.keyNote).toBe(60);
    expect(pick.bass.file).toBe("/mock/palette/bass_1.wav");
  });

  it("picks the CLOSER-to-60 bass root when neither is exact", () => {
    const items: PaletteItem[] = [
      { path: "/a.wav", role: "bass", rootNote: 30 }, // keyNote 66, |66-60|=6
      { path: "/b.wav", role: "bass", rootNote: 20 }, // keyNote 56, |56-60|=4
    ];
    const pick = pickDrumPalette(items.concat(PALETTE.filter((i) => i.role !== "bass")), { seed: 0 });
    expect(pick.bass.file).toBe("/b.wav");
    expect(pick.bass.keyNote).toBe(56);
  });

  it("throws a clear error when no bass item has a measured rootNote", () => {
    const noBass = PALETTE.filter((i) => i.role !== "bass");
    expect(() => pickDrumPalette(noBass)).toThrow(/bass/i);
  });

  it("throws when the palette has no drum one-shots at all", () => {
    const onlyBass = PALETTE.filter((i) => i.role === "bass");
    expect(() => pickDrumPalette(onlyBass)).toThrow(/drum/i);
  });
});

describe("pickSynthPresets", () => {
  // Enough presets to cover every role's FIRST preference plus a couple of
  // contested "pad" claimants (chords_pad, drone, ambient all want pad/atmos).
  const MENU: PresetMenu = [
    { plugin: "vital", name: "Dark Lead", file: "/presets/vital/lead-dark.vital" },
    { plugin: "vital", name: "Trap Pluck", file: "/presets/vital/pluck-trap.vital" },
    { plugin: "vital", name: "Warm Pad", file: "/presets/vital/pad-warm.vital" },
    { plugin: "vital", name: "Airy Pad", file: "/presets/vital/pad-airy.vital" },
    { plugin: "vital", name: "Night Atmos", file: "/presets/vital/atmos-night.vital" },
    { plugin: "vital", name: "Keys 1", file: "/presets/vital/keys-rhodes.vital" },
    { plugin: "vital", name: "Arp Bell", file: "/presets/vital/arp-glass.vital" },
    { plugin: "vital", name: "Bell Hit", file: "/presets/vital/bell-hit.vital" },
    { plugin: "4osc", name: "mosh-bass", file: "/presets/4osc/mosh-bass.json" },
  ];

  it("is deterministic for the same menu + seed", () => {
    expect(pickSynthPresets(MENU, 42)).toEqual(pickSynthPresets(MENU, 42));
  });

  it("assigns all 7 roles, never repeating a file, and only from the vital plugin", () => {
    const picks = pickSynthPresets(MENU, 1);
    expect(picks).toHaveLength(7);
    const files = picks.map((p) => p.file);
    expect(new Set(files).size).toBe(7);
    expect(files.every((f) => f.endsWith(".vital"))).toBe(true);
    expect(new Set(picks.map((p) => p.role)).size).toBe(7);
  });

  it("role-short fallback: chords_pad/drone/ambient all want pad-ish presets but only 3 exist total (2 pad + 1 atmos) — every role still gets something", () => {
    const tight: PresetMenu = [
      { plugin: "vital", name: "Lead", file: "/presets/vital/lead-a.vital" },
      { plugin: "vital", name: "Pluck", file: "/presets/vital/pluck-a.vital" },
      { plugin: "vital", name: "Pad A", file: "/presets/vital/pad-a.vital" },
      { plugin: "vital", name: "Pad B", file: "/presets/vital/pad-b.vital" },
      { plugin: "vital", name: "Atmos A", file: "/presets/vital/atmos-a.vital" },
      { plugin: "vital", name: "Keys A", file: "/presets/vital/keys-a.vital" },
      { plugin: "vital", name: "Arp A", file: "/presets/vital/arp-a.vital" },
    ];
    const picks = pickSynthPresets(tight, 9);
    // 7 roles, 7 presets available total — every role gets a distinct file even
    // though chords_pad/drone/ambient all prefer pad/atmos (only 3 exist).
    expect(picks).toHaveLength(7);
    expect(new Set(picks.map((p) => p.file)).size).toBe(7);
  });

  it("a role whose whole chain AND the fallback are exhausted is simply absent (no throw)", () => {
    const scarce: PresetMenu = [{ plugin: "vital", name: "Only Lead", file: "/presets/vital/lead-only.vital" }];
    const picks = pickSynthPresets(scarce, 0);
    expect(picks).toHaveLength(1);
    expect(picks[0]!.role).toBe("lead");
  });
});
