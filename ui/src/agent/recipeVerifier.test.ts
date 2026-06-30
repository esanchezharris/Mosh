import { describe, it, expect } from "vitest";
import { verifyRecipe, recipeFromSnapshot, type Recipe, type VNote, type VTrack } from "./recipeVerifier";

// helpers to build control recipes in F minor, 2 bars (8 beats)
const nf = (pitch: number, start: number, length = 0.25, velocity = 100): VNote => ({ pitch, start, length, velocity });
const KEY = { tonic: "F", mode: "minor" };
// F minor in-key pitch classes: {F,G,Ab,Bb,C,Db,Eb} = {5,7,8,10,0,1,3}
const BASS_INKEY = [29, 31, 32, 36, 29, 31, 32, 36]; // F1 G1 Ab1 C2 … all in [21,55], in key
const MEL_INKEY = [65, 67, 68, 70, 65, 67, 68, 70]; // F4 G4 Ab4 Bb4 … all in [48,100], in key
const OUT_OF_KEY = [62, 64, 66, 69, 71, 62, 64, 66]; // D E F# A B … pcs {2,4,6,9,11} all OUT of F minor
const OUT_OF_KEY_BASS = [38, 40, 42, 45, 38, 40, 42, 45]; // D2 E2 F#2 A2 … out of key, still in the bass register [21,55]

const drumsGreat = (): VTrack => ({
  name: "Drums", role: "drums", notes: [
    ...[0, 0.75, 2.5, 4, 4.75, 6.5].map((s) => nf(36, s)),       // kick — anchors beat 1 of each bar
    ...[1, 3, 5, 7].map((s) => nf(38, s)),                        // snare — backbeat
    ...Array.from({ length: 16 }, (_, i) => nf(42, i * 0.5, 0.2, 70)), // hats — 8ths
  ],
});
const bassTrack = (pitches: number[]): VTrack => ({ name: "808", role: "bass", notes: pitches.map((p, i) => nf(p, i, 1)) });
const melTrack = (pitches: number[]): VTrack => ({ name: "Lead", role: "melody", notes: pitches.map((p, i) => nf(p, i, 0.9)) });

const great = (): Recipe => ({ tempo: 140, key: KEY, bars: 2, tracks: [drumsGreat(), bassTrack(BASS_INKEY), melTrack(MEL_INKEY)] });

// degradations — each targets ONE dimension
const empty = (): Recipe => ({ tempo: 140, key: KEY, bars: 2, tracks: [{ name: "Drums", role: "drums", notes: [] }, { name: "808", role: "bass", notes: [] }, { name: "Lead", role: "melody", notes: [] }] });
const offkey = (): Recipe => ({ ...great(), tracks: [drumsGreat(), bassTrack(OUT_OF_KEY_BASS), melTrack(OUT_OF_KEY)] });
const offgrid = (): Recipe => ({ ...great(), tracks: [{ name: "Drums", role: "drums", notes: drumsGreat().notes.map((n) => nf(n.pitch, n.start + 0.13, n.length, n.velocity)) }, bassTrack(BASS_INKEY).notes ? { name: "808", role: "bass", notes: BASS_INKEY.map((p, i) => nf(p, i + 0.13, 1)) } : bassTrack(BASS_INKEY), { name: "Lead", role: "melody", notes: MEL_INKEY.map((p, i) => nf(p, i + 0.13, 0.9)) }] });
const wrongreg = (): Recipe => ({ ...great(), tracks: [drumsGreat(), { name: "808", role: "bass", notes: MEL_INKEY.map((p, i) => nf(p, i, 1)) }, { name: "Lead", role: "melody", notes: BASS_INKEY.map((p, i) => nf(p, i, 0.9)) }] });
const monotone = (): Recipe => ({ ...great(), tracks: [drumsGreat(), bassTrack(Array(8).fill(29)), melTrack(Array(8).fill(65))] });
const nodrums = (): Recipe => ({ ...great(), tracks: [bassTrack(BASS_INKEY), melTrack(MEL_INKEY)] });
const random = (): Recipe => ({
  tempo: 140, key: KEY, bars: 2, tracks: [
    { name: "Drums", role: "drums", notes: [7, 99, 13, 120, 3, 64].map((p, i) => nf(p, i * 0.31 + 0.07)) },
    { name: "808", role: "bass", notes: [62, 11, 100, 73, 6].map((p, i) => nf(p, i * 0.41 + 0.13, 1)) },
    { name: "Lead", role: "melody", notes: [2, 127, 40, 90, 17].map((p, i) => nf(p, i * 0.29 + 0.19, 0.9)) },
  ],
});

describe("verifyRecipe — discrimination battery", () => {
  const G = verifyRecipe(great());

  it("a competent beat scores high", () => {
    expect(G.total).toBeGreaterThan(0.85);
    expect(G.reasons).toHaveLength(0);
  });

  it("ranks the competent beat strictly above every degradation", () => {
    for (const [name, mk] of Object.entries({ empty, offkey, offgrid, wrongreg, monotone, nodrums, random })) {
      const v = verifyRecipe(mk());
      expect(v.total, `great(${G.total.toFixed(3)}) should beat ${name}(${v.total.toFixed(3)})`).toBeLessThan(G.total);
    }
  });

  it("off-key tanks ONLY the key dimension", () => {
    const v = verifyRecipe(offkey());
    expect(v.dims.key).toBeLessThan(0.4);
    expect(v.dims.drums).toBeCloseTo(G.dims.drums, 5); // drums unaffected
    expect(v.reasons.some((r) => r.includes("out of F minor"))).toBe(true);
  });

  it("off-grid tanks the grid dimension", () => {
    const v = verifyRecipe(offgrid());
    expect(v.dims.grid).toBeLessThan(0.4);
    expect(v.dims.key).toBeCloseTo(G.dims.key, 5); // pitches still in key
  });

  it("wrong-register tanks the register dimension", () => {
    const v = verifyRecipe(wrongreg());
    expect(v.dims.register).toBeLessThan(0.6);
    expect(v.dims.register).toBeLessThan(G.dims.register);
  });

  it("monotone tanks density (pitch variety)", () => {
    const v = verifyRecipe(monotone());
    expect(v.dims.density).toBeLessThan(G.dims.density);
  });

  it("no-drums tanks parts AND drums", () => {
    const v = verifyRecipe(nodrums());
    expect(v.dims.drums).toBe(0);
    expect(v.dims.parts).toBeLessThan(G.dims.parts);
  });

  it("empty clips tank parts/density/hygiene", () => {
    const v = verifyRecipe(empty());
    expect(v.dims.parts).toBe(0);
    expect(v.total).toBeLessThan(0.2);
  });

  it("random is low across drums, key, grid", () => {
    const v = verifyRecipe(random());
    expect(v.dims.key).toBeLessThan(0.6);
    expect(v.dims.grid).toBeLessThan(0.6);
    expect(v.total).toBeLessThan(0.55);
  });
});

describe("recipeFromSnapshot", () => {
  it("extracts roles/notes from a mock snapshot (drum-type, low=bass, mid=melody)", () => {
    const snap = {
      session: { tempo: 140, key: { tonic: "F", mode: "minor" } },
      tracks: [
        { name: "Drums", type: "drum", clips: [{ notes: [nf(36, 0), nf(38, 1)] }] },
        { name: "808", type: "audio", clips: [{ notes: [nf(29, 0, 1)] }] },
        { name: "Lead", type: "audio", clips: [{ notes: [nf(65, 0, 1)] }] },
      ],
    };
    const r = recipeFromSnapshot(snap);
    expect(r.tracks.map((t) => t.role)).toEqual(["drums", "bass", "melody"]);
    expect(r.key.tonic).toBe("F");
    expect(r.tracks[0].notes).toHaveLength(2);
  });
});
