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

  it("round-2 pad gain map: kick -2dB, hat/openhat -6dB, clap2 -8dB layer gain, hat/openhat share chokeGroup 1", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 5 });
    const kick = pick.pads.find((p) => p.note === 36)!;
    expect(kick.gainDb).toBe(-2);
    const clap2 = pick.pads.find((p) => p.note === 40)!;
    expect(clap2.gainDb).toBe(-8);
    const hat = pick.pads.find((p) => p.note === 42)!;
    const openhat = pick.pads.find((p) => p.note === 46)!;
    expect(hat.gainDb).toBe(-6);
    expect(openhat.gainDb).toBe(-6);
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

  it("round-2 note 6: picks the HIGHEST subEnergyDb bass item when the manifest carries it, even when that's NOT the nearest-to-60 root", () => {
    const items: PaletteItem[] = [
      { path: "/near.wav", role: "bass", rootNote: 24, subEnergyDb: -18 }, // keyNote 60 (exact center) but thin
      { path: "/far-but-loud.wav", role: "bass", rootNote: 30, subEnergyDb: -6 }, // keyNote 66, further off-center but the fattest 808
    ];
    const pick = pickDrumPalette(items.concat(PALETTE.filter((i) => i.role !== "bass")), { seed: 0 });
    expect(pick.bass.file).toBe("/far-but-loud.wav");
    expect(pick.bass.keyNote).toBe(66);
  });

  it("falls back to the nearest-root rule when NO bass candidate carries subEnergyDb (pre-round-2 manifests)", () => {
    const pick = pickDrumPalette(PALETTE, { seed: 0 });
    // Unchanged from the pre-round-2 behavior: rootNote 24 -> keyNote 60 wins.
    expect(pick.bass.file).toBe("/mock/palette/bass_1.wav");
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

  // Round 2 correction note 2 — "there's a synth part that's exactly the same
  // through all runs" / "no variation in the synth sounds across runs": the
  // constant seed (runProduceTemplate defaulted to seed 0, and the driver
  // never varied it) was the root cause, so a wide-enough menu really does
  // rotate once the caller passes distinct seeds.
  describe("round-2 seed rotation (note 2)", () => {
    // >= 6 presets per role, so every role's own bucket alone has room to move.
    const wide: PresetMenu = [
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Lead ${s}`, file: `/presets/vital/lead-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Pad ${s}`, file: `/presets/vital/pad-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Atmos ${s}`, file: `/presets/vital/atmos-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Pluck ${s}`, file: `/presets/vital/pluck-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Keys ${s}`, file: `/presets/vital/keys-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Arp ${s}`, file: `/presets/vital/arp-${s}.vital` })),
      ...["a", "b", "c", "d", "e", "f", "g"].map((s) => ({ plugin: "vital", name: `Bell ${s}`, file: `/presets/vital/bell-${s}.vital` })),
    ];

    it("seeds 1..5 yield at least 3 distinct preset sets", () => {
      const sets = [1, 2, 3, 4, 5].map((seed) => JSON.stringify(pickSynthPresets(wide, seed).map((p) => p.file).sort()));
      expect(new Set(sets).size).toBeGreaterThanOrEqual(3);
    });

    it("never repeats a preset file within a single run's picks", () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const files = pickSynthPresets(wide, seed).map((p) => p.file);
        expect(new Set(files).size).toBe(files.length);
      }
    });

    it("prefers a non-SQ/SEQ/ARP-tagged filename for every role except arp", () => {
      const tagged: PresetMenu = [
        { plugin: "vital", name: "Trap Pluck SQ", file: "/presets/vital/pluck-trap-sq-1.vital" },
        { plugin: "vital", name: "Trap Pluck Clean", file: "/presets/vital/pluck-trap-clean.vital" },
        { plugin: "vital", name: "Lead A", file: "/presets/vital/lead-a.vital" },
        { plugin: "vital", name: "Pad A", file: "/presets/vital/pad-a.vital" },
        { plugin: "vital", name: "Atmos A", file: "/presets/vital/atmos-a.vital" },
        { plugin: "vital", name: "Keys A", file: "/presets/vital/keys-a.vital" },
        { plugin: "vital", name: "Arp Broken Wings SQ", file: "/presets/vital/arp-broken-wings-sq-1.vital" },
      ];
      // Across every seed, "counter" (preference chain: pluck, keys) never lands
      // on the -sq- pluck while the clean alternative is available — the filter
      // removes it from the pool entirely rather than merely de-weighting it.
      for (const seed of [0, 1, 2, 3, 4]) {
        const counter = pickSynthPresets(tagged, seed).find((p) => p.role === "counter");
        expect(counter?.file).toBe("/presets/vital/pluck-trap-clean.vital");
      }
      const arp = pickSynthPresets(tagged, 0).find((p) => p.role === "arp");
      expect(arp?.file).toBe("/presets/vital/arp-broken-wings-sq-1.vital"); // arp is exempt from the filter
    });

    it("a role whose only candidates are all SQ/SEQ/ARP-tagged still gets one (soft preference, not a hard block)", () => {
      const onlyTagged: PresetMenu = [{ plugin: "vital", name: "Only Lead SQ", file: "/presets/vital/lead-sq-1.vital" }];
      const picks = pickSynthPresets(onlyTagged, 0);
      expect(picks).toHaveLength(1);
      expect(picks[0]!.file).toBe("/presets/vital/lead-sq-1.vital");
    });
  });
});
