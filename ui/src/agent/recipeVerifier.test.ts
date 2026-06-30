import { describe, it, expect } from "vitest";
import { verifyRecipe, recipeFromSnapshot, type Recipe, type VNote, type VTrack, type VPad } from "./recipeVerifier";
import fooling from "./__fixtures__/foolingRecipes.json";

const nf = (pitch: number, start: number, length = 0.25, velocity = 100): VNote => ({ pitch, start, length, velocity });
const KEY = { tonic: "F", mode: "minor" };
// F minor in-key absolute pitch classes: {F,G,Ab,Bb,C,Db,Eb} = {5,7,8,10,0,1,3}
const INKEY = new Set([0, 1, 3, 5, 7, 8, 10]);

// ── a genuinely musical 2-bar beat: velocity dynamics + bar-2 development + contour ──
const drumsGreat = (): VTrack => ({
  name: "Drums", role: "drums", notes: [
    nf(36, 0, 0.25, 112), nf(36, 0.75, 0.25, 88), nf(36, 2.5, 0.25, 100),    // kicks (varied, syncopated, ≤6/bar)
    nf(36, 4, 0.25, 112), nf(36, 4.75, 0.25, 88), nf(36, 6.5, 0.25, 104),
    nf(38, 1, 0.25, 106), nf(38, 3, 0.25, 100), nf(38, 5, 0.25, 106), nf(38, 7, 0.25, 98), // snare backbeat (no kick collision)
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((s, i) => nf(42, s, 0.2, i % 2 ? 62 : 80)),     // hats 8ths, accented
    ...[4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5].map((s, i) => nf(42, s, 0.2, i % 2 ? 60 : 82)),
  ],
});
const bassGreat = (): VTrack => ({
  name: "808", role: "bass", notes: [
    nf(29, 0, 1, 108), nf(32, 1, 1, 88), nf(31, 2, 1, 96), nf(36, 3, 0.5, 100),     // bar 1
    nf(29, 4, 1, 104), nf(36, 5, 1, 90), nf(32, 6, 1, 100), nf(31, 7, 0.5, 86),     // bar 2 develops (pitch order changes)
  ],
});
const melGreat = (): VTrack => ({
  name: "Lead", role: "melody", notes: [
    nf(65, 0, 0.5, 95), nf(68, 0.5, 0.5, 82), nf(67, 1, 1, 92), nf(70, 2, 1, 100), nf(68, 3, 0.5, 88),   // bar 1
    nf(72, 4, 0.5, 98), nf(70, 4.5, 0.5, 86), nf(68, 5, 1, 92), nf(65, 6, 1, 100), nf(67, 7, 0.5, 80),   // bar 2 (descending answer)
  ],
});
const great = (): Recipe => ({ tempo: 140, key: KEY, bars: 2, tracks: [drumsGreat(), bassGreat(), melGreat()] });

// degradation transforms (keep everything musical EXCEPT the targeted dimension)
const mapPitch = (t: VTrack, fn: (p: number) => number): VTrack => ({ ...t, notes: t.notes.map((n) => ({ ...n, pitch: fn(n.pitch) })) });
const shiftStart = (t: VTrack, dt: number): VTrack => ({ ...t, notes: t.notes.map((n) => ({ ...n, start: n.start + dt })) });
const constPitch = (t: VTrack, p: number): VTrack => ({ ...t, notes: t.notes.map((n) => ({ ...n, pitch: p })) });
const outOfKey = (p: number): number => { for (const d of [1, 2, 4, 6]) if (!INKEY.has(((p + d) % 12 + 12) % 12)) return p + d; return p + 1; };

const empty = (): Recipe => ({ ...great(), tracks: [{ name: "Drums", role: "drums", notes: [] }, { name: "808", role: "bass", notes: [] }, { name: "Lead", role: "melody", notes: [] }] });
const offkey = (): Recipe => ({ ...great(), tracks: [drumsGreat(), mapPitch(bassGreat(), outOfKey), mapPitch(melGreat(), outOfKey)] });
const offgrid = (): Recipe => ({ ...great(), tracks: [shiftStart(drumsGreat(), 0.13), shiftStart(bassGreat(), 0.13), shiftStart(melGreat(), 0.13)] });
const wrongreg = (): Recipe => ({ ...great(), tracks: [drumsGreat(), { name: "808", role: "bass", notes: melGreat().notes }, { name: "Lead", role: "melody", notes: bassGreat().notes }] });
const monotone = (): Recipe => ({ ...great(), tracks: [drumsGreat(), constPitch(bassGreat(), 29), constPitch(melGreat(), 65)] });
const nodrums = (): Recipe => ({ ...great(), tracks: [bassGreat(), melGreat()] });
const random = (): Recipe => ({
  tempo: 140, key: KEY, bars: 2, tracks: [
    { name: "Drums", role: "drums", notes: [7, 99, 13, 120, 3, 64].map((p, i) => nf(p, i * 0.31 + 0.07)) },
    { name: "808", role: "bass", notes: [62, 11, 100, 73, 6].map((p, i) => nf(p, i * 0.41 + 0.13, 1)) },
    { name: "Lead", role: "melody", notes: [2, 127, 40, 90, 17].map((p, i) => nf(p, i * 0.29 + 0.19, 0.9)) },
  ],
});

describe("verifyRecipe — discrimination battery", () => {
  const G = verifyRecipe(great());

  it("a genuinely musical beat (dynamics + development + contour) scores high", () => {
    // a great-MIDI beat with NO declared sounds is still an outline → the realness gate holds
    // it at ~0.82 (neutral 0.7) rather than 1.0; the musical dims themselves are maxed.
    expect(G.total).toBeGreaterThan(0.8);
    expect(G.dims.dynamics).toBeGreaterThan(0.8);
    expect(G.dims.variation).toBeGreaterThan(0.8);
    expect(G.dims.contour).toBeGreaterThan(0.8);
  });

  it("PRODUCTION: a real beat scores high, the SAME beat on stock sounds is crushed (realness gate)", () => {
    const realPads = [{ note: 36, realness: "real" as const }, { note: 38, realness: "real" as const }, { note: 42, realness: "real" as const }];
    const stockPads = [{ note: 36, realness: "stock" as const }, { note: 38, realness: "stock" as const }, { note: 42, realness: "stock" as const }];
    const withProd = (pads: VPad[], instReal: boolean): Recipe => {
      const r = great();
      r.productionObserved = true;
      r.tracks[0].production = { volumeDb: -3, pads };
      r.tracks[1].production = { volumeDb: -5, instrument: { name: instReal ? "808" : "4osc", realness: instReal ? "real" : "default" } };
      r.tracks[2].production = { volumeDb: -9, instrument: { name: instReal ? "Serum" : "4osc", realness: instReal ? "real" : "default" } };
      return r;
    };
    const real = verifyRecipe(withProd(realPads, true));
    const stock = verifyRecipe(withProd(stockPads, false));
    expect(real.total).toBeGreaterThan(0.85);
    expect(stock.total).toBeLessThan(0.6);
    expect(real.total - stock.total).toBeGreaterThan(0.3);
    expect(real.dims.realness).toBeGreaterThan(0.9);
    expect(stock.dims.realness).toBeLessThan(0.1);
  });

  it("ranks the musical beat strictly above every degradation", () => {
    for (const [name, mk] of Object.entries({ empty, offkey, offgrid, wrongreg, monotone, nodrums, random })) {
      const v = verifyRecipe(mk());
      expect(v.total, `great(${G.total.toFixed(3)}) should beat ${name}(${v.total.toFixed(3)})`).toBeLessThan(G.total);
    }
  });

  it("off-key tanks the key dimension, drums unaffected", () => {
    const v = verifyRecipe(offkey());
    expect(v.dims.key).toBeLessThan(0.4);
    expect(v.dims.drums).toBeCloseTo(G.dims.drums, 5);
  });
  it("off-grid tanks the grid dimension", () => { expect(verifyRecipe(offgrid()).dims.grid).toBeLessThan(0.4); });
  it("wrong-register tanks the register dimension", () => { expect(verifyRecipe(wrongreg()).dims.register).toBeLessThan(0.6); });
  it("monotone tanks contour AND variation", () => {
    const v = verifyRecipe(monotone());
    expect(v.dims.contour).toBeLessThan(0.5);
    expect(v.dims.variation).toBeLessThan(0.5);
  });
  it("no-drums tanks parts and drums", () => { const v = verifyRecipe(nodrums()); expect(v.dims.drums).toBe(0); expect(v.dims.parts).toBeLessThan(G.dims.parts); });
  it("empty tanks the total", () => { expect(verifyRecipe(empty()).total).toBeLessThan(0.2); });
  it("random is low overall", () => { expect(verifyRecipe(random()).total).toBeLessThan(0.55); });
});

describe("verifyRecipe — Goodhart hardening (red-team regression)", () => {
  const cands = (fooling as { candidates: { name: string; lens?: string; recipe: Recipe }[] }).candidates;

  it("loads the 24 red-team exploits", () => { expect(cands.length).toBe(24); });

  it("NO red-team exploit scores ≥ 0.7 (v1 scored all ≥ 0.8)", () => {
    const survivors = cands.map((c) => ({ name: c.name, total: verifyRecipe(c.recipe).total })).filter((x) => x.total >= 0.7);
    expect(survivors, `surviving exploits: ${JSON.stringify(survivors)}`).toHaveLength(0);
  });

  it("the egregious exploits (machine-gun / clone / cluster / drone) are crushed below 0.55", () => {
    const egregious = cands.filter((c) => /machine|clone|wall|cluster|drone|metronome|stamp|loop/i.test(c.name));
    for (const c of egregious) expect(verifyRecipe(c.recipe).total, `${c.name}`).toBeLessThan(0.55);
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
  });
});
