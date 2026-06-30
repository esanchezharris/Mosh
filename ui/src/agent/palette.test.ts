import { describe, it, expect } from "vitest";
import { makePalette, type PaletteManifest } from "./palette";
import { planTrackProduction, monophonicize, type Note } from "./beatBuilder";
import { beatSpecById } from "./beatSpecs";

const MANIFEST: PaletteManifest = {
  items: [
    { path: "/a/kick1.wav", role_guess: "kick" },
    { path: "/a/kick2.wav", role_guess: "kick" },
    { path: "/a/snare1.wav", role_guess: "snare" },
    { path: "/a/hat1.wav", role_guess: "hat" },
    { path: "/a/808_C.wav", role_guess: "808", root_note: 36, char: ["sub", "dark"] },
    { path: "/a/808_G.wav", role_guess: "808", root_note: 31 },
  ],
};

describe("makePalette", () => {
  it("indexes by role and reports sizes", () => {
    const p = makePalette(MANIFEST);
    expect(p.has("kick")).toBe(true);
    expect(p.size("kick")).toBe(2);
    expect(p.size("808")).toBe(2);
    expect(p.has("clap")).toBe(false);
    expect(p.pick("clap", 0)).toBeNull();
  });

  it("pick is deterministic for a given (role, seed)", () => {
    const p = makePalette(MANIFEST);
    expect(p.pick("kick", 7)!.path).toBe(p.pick("kick", 7)!.path);
    expect(p.pick("808", 1)!.role).toBe("808");
  });

  it("candidates returns up to n distinct items", () => {
    const p = makePalette(MANIFEST);
    const c = p.candidates("kick", 5, 0);
    expect(c.length).toBe(2); // only 2 kicks exist
    expect(new Set(c.map((x) => x.path)).size).toBe(2);
  });
});

describe("planTrackProduction", () => {
  const p = makePalette(MANIFEST);
  const spec = beatSpecById("dark_trap")!;

  it("drum track → a real pad per triggered GM note", () => {
    const drums = spec.tracks.find((t) => t.kind === "drum")!;
    const plan = planTrackProduction(drums, p, 0);
    expect(plan.kind).toBe("drum");
    if (plan.kind === "drum") {
      const notes = plan.pads.map((x) => x.note).sort((a, b) => a - b);
      expect(notes).toEqual([36, 38, 42]); // kick/snare/hat pads, all backed by a real one-shot
      expect(plan.pads.every((x) => x.path.startsWith("/a/"))).toBe(true);
    }
  });

  it("bass track → a melodic 808 with a root note", () => {
    const bass = spec.tracks.find((t) => t.slots.some((s) => s.id === "bass"))!;
    const plan = planTrackProduction(bass, p, 0);
    expect(plan.kind).toBe("melodic808");
    if (plan.kind === "melodic808") {
      expect([31, 36]).toContain(plan.note); // one of the 808 root notes
      expect(plan.path).toMatch(/808/);
    }
  });

  it("melody/lead track → none (4OSC default)", () => {
    const lead = spec.tracks.find((t) => t.slots.some((s) => s.id === "melody"))!;
    expect(planTrackProduction(lead, p, 0).kind).toBe("none");
  });

  it("empty palette role → none (graceful, no crash)", () => {
    const empty = makePalette({ items: [] });
    expect(planTrackProduction(spec.tracks[0], empty, 0).kind).toBe("none");
  });
});

describe("monophonicize", () => {
  it("trims notes so none overlaps the next note-on (mono 808)", () => {
    const notes: Note[] = [
      { pitch: 36, start: 0, length: 2.0, velocity: 100 }, // overlaps the next at start 1
      { pitch: 38, start: 1, length: 2.0, velocity: 100 }, // overlaps the next at start 2
      { pitch: 40, start: 2, length: 1.0, velocity: 100 }, // last — unchanged
    ];
    const out = monophonicize(notes, 0.02);
    expect(out[0].length).toBeCloseTo(0.98, 5); // 1 - 0.02 gap
    expect(out[1].length).toBeCloseTo(0.98, 5);
    expect(out[2].length).toBe(1.0);
    // no note now rings into the next
    for (let i = 0; i < out.length - 1; i++) {
      expect(out[i].start + out[i].length).toBeLessThanOrEqual(out[i + 1].start);
    }
  });
});
