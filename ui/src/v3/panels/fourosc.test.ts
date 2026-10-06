import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStore } from "../../store";
import type { CommandResult, Plugin, PluginParam, PluginStateValue } from "../../types";
import { fourOscPanelDef } from "./FourOscPanel";
import { FOUR_OSC_STATE, fourOscParams, fourOscSetNorm } from "../../mock/fourosc";
import {
  DELAY_NOTES, ENV_PLOT, SECOND_Q, SPECS, TCO_ANALOG, TCO_DIGITAL, ampAdsr, attackAtX, baseCutoffHz, ctl, decayAtX, decayEnd,
  delayNote, envGeometry, envPeakNote, expAttack, expDecay, expRelease, filterChain, filterDb, filterSlopeOf, filterTypeOf,
  fmtCents, fmtPan, fmtPct100, fmtSignedPct, fmtSt, fourOscSummary, hasFullContract, hzToNote, isBlack, keyStrip, loadSection,
  noteName, noteToHz, paramFor, releaseAtX, releaseEnd, resonanceQ, saveSection, segTime, segWidth, stripRange, sustainAtY,
  velocityGain, voicesOf, waveOf,
} from "./fourosc";

/** A 4OSC as the engine (and the engine-accurate mock) sends it: 68 params and the settings. */
function synth(state: Record<string, string | number> = {}, params: Record<string, number> = {}): Plugin {
  const st: Record<string, PluginStateValue> = JSON.parse(JSON.stringify(FOUR_OSC_STATE));
  for (const [k, v] of Object.entries(state)) st[k] = { ...st[k], value: v };
  const ps = fourOscParams();
  for (const [id, norm] of Object.entries(params)) {
    const i = ps.findIndex((p) => p.id === id);
    ps[i] = { ...ps[i], ...fourOscSetNorm(i, norm)! };
  }
  return { index: 0, name: "4OSC", type: "4osc", enabled: true, external: false, builtin: true, isInstrument: true, params: ps, state: st };
}
/** Set a param by physical value through the spec (as a drag would). */
const withPhys = (p: Plugin, id: string, phys: number): Plugin => {
  const c = ctl(p, id);
  const norm = c.range.skew ? ((phys - c.range.min) / (c.range.max - c.range.min)) ** c.range.skew : (phys - c.range.min) / (c.range.max - c.range.min);
  return { ...p, params: p.params.map((x) => (x.index === c.index ? { ...x, value: norm } : x)) };
};

describe("parameter map (bound by engine id, never by name)", () => {
  it("has the engine's 68 parameters at their engine indices", () => {
    const specs = Object.entries(SPECS);
    expect(specs).toHaveLength(68);
    expect(new Set(specs.map(([, s]) => s.index)).size).toBe(68);
    expect(Math.min(...specs.map(([, s]) => s.index))).toBe(0);
    expect(Math.max(...specs.map(([, s]) => s.index))).toBe(67);
    // Pinned from FourOscPlugin's addParam order (research table A).
    expect(SPECS.tune1!.index).toBe(0);
    expect(SPECS.level1!.index).toBe(2);
    expect(SPECS.level4!.index).toBe(23);
    expect(SPECS.pulseWidth2!.index).toBe(10);
    expect(SPECS.pan4!.index).toBe(27);
    expect(SPECS.ampAttack!.index).toBe(40);
    expect(SPECS.ampVelocity!.index).toBe(44);
    expect(SPECS.filterFreq!.index).toBe(49);
    expect(SPECS.filterVelocity!.index).toBe(53);
    expect(SPECS.reverbMix!.index).toBe(58);
    expect(SPECS.delayMix!.index).toBe(61);
    expect(SPECS.chorusMix!.index).toBe(65);
    expect(SPECS.masterLevel!.index).toBe(67);
  });
  it("matches the engine-accurate mock's ids index for index", () => {
    for (const p of fourOscParams()) expect(SPECS[p.id!]!.index).toBe(p.index);
  });
  it("finds a parameter by id even when the names repeat, and refuses an index whose id disagrees", () => {
    const p = synth();
    // three params are named "Mix": the ids tell them apart
    expect(paramFor(p, "reverbMix")!.index).toBe(58);
    expect(paramFor(p, "delayMix")!.index).toBe(61);
    expect(paramFor(p, "chorusMix")!.index).toBe(65);
    // an engine without ids: by index
    const noIds = { ...p, params: p.params.map(({ id: _id, ...rest }) => rest as PluginParam) };
    expect(paramFor(noIds, "ampRelease")!.index).toBe(43);
    // a param sitting at the spec's index but with another id is not this one
    const moved = { ...p, params: p.params.filter((x) => x.id !== "masterLevel").map((x) => (x.index === 66 ? { ...x, index: 67 } : x)) };
    expect(paramFor(moved, "masterLevel")).toBeUndefined();
    // a name match alone binds nothing
    const named = { ...p, params: [{ index: 99, name: "Level 1", value: 1 }] };
    expect(paramFor(named, "level1")).toBeUndefined();
  });
  it("reads physical units through the skew (research pins at v = 0.5)", () => {
    const p = synth({}, { ampAttack: 0.5, level1: 0.5, masterLevel: 0.5, tune2: 0.5 + 7.4 / 72 });
    expect(ctl(p, "ampAttack").phys).toBeCloseTo(1.87597, 4);        // v^5, not 30 s
    expect(ctl(p, "level1").phys).toBeCloseTo(-15.910, 2);           // v^(1/4)
    expect(ctl(p, "masterLevel").phys).toBeCloseTo(-15.910, 2);
    expect(ctl(p, "tune2").phys).toBe(7);                           // whole semitones (step 1)
    // defaults: Filter Freq is MIDI note 69 (normalised 0.5108) = 440 Hz
    const d = synth();
    expect(ctl(d, "filterFreq").norm).toBeCloseTo(0.510823, 5);
    expect(noteToHz(ctl(d, "filterFreq").phys)).toBeCloseTo(440, 2);
    expect(ctl(d, "ampSustain").phys).toBeCloseTo(80, 4);
    expect(ctl(d, "ampRelease").phys).toBeCloseTo(0.1, 5);
  });
  it("marks a parameter the snapshot does not carry, and uses the spec's default for it", () => {
    const old = { ...synth(), params: synth().params.slice(0, 16) };
    const c = ctl(old, "ampAttack");
    expect(c.present).toBe(false);
    expect(c.index).toBe(40);
    expect(c.phys).toBeCloseTo(0.1, 5);
    expect(hasFullContract(old)).toBe(false);
    expect(hasFullContract(synth())).toBe(true);
    expect(hasFullContract({ ...synth(), state: undefined })).toBe(false);
  });
  it("reads the settings, falling back to what the engine plays for unknown values", () => {
    const p = synth({ waveShape2: "saw", voices2: 3, filterType: "bandpass", filterSlope: 24 });
    expect(waveOf(p, 1)).toBe("sine");
    expect(waveOf(p, 2)).toBe("saw");
    expect(waveOf(p, 3)).toBe("off");
    expect(voicesOf(p, 2)).toBe(3);
    expect(filterTypeOf(p)).toBe("bandpass");
    expect(filterSlopeOf(p)).toBe(24);
    const odd = synth({ waveShape1: "wobble", filterType: "ladder", filterSlope: 18 });
    expect(waveOf(odd, 1)).toBe("off");          // an unknown wave is silent in the engine
    expect(filterTypeOf(odd)).toBe("off");       // an unknown type runs no filter
    expect(filterSlopeOf(odd)).toBe(12);         // only exactly 24 adds the second section
  });
});

describe("amp envelope (tracktion ExpEnvelope, exact)", () => {
  /** The engine's own per-sample recursion in float32 (tracktion_Envelope.cpp). */
  function simulate(stage: "attack" | "decay" | "release", N: number, tco: number, level: number): number[] {
    const c = Math.fround(Math.exp(-Math.log((1 + tco) / tco) / N));
    const off = Math.fround(stage === "attack" ? (1 + tco) * (1 - c) : stage === "decay" ? (level - tco) * (1 - c) : -tco * (1 - c));
    let e = stage === "attack" ? 0 : stage === "decay" ? 1 : level;
    const out: number[] = [];
    for (let n = 0; n < N; n++) { e = Math.fround(off + Math.fround(e * c)); out.push(e); }
    return out;
  }
  it("pins the constants", () => {
    expect(TCO_ANALOG.attack).toBeCloseTo(Math.exp(-0.5), 7);
    expect(TCO_ANALOG.decay).toBeCloseTo(Math.exp(-5), 7);
    expect(TCO_ANALOG.release).toBeCloseTo(Math.exp(-5), 7);
    expect(TCO_DIGITAL.attack).toBeCloseTo(1.5849e-5, 9);
  });
  it("pins the closed form", () => {
    expect(expAttack(0.5, TCO_ANALOG.attack)).toBeCloseTo(0.61941, 4);
    expect(expAttack(0.25, TCO_ANALOG.attack)).toBeCloseTo(0.34723, 4);
    expect(expAttack(1, TCO_ANALOG.attack)).toBe(1);
    expect(expAttack(0.1, TCO_DIGITAL.attack)).toBeCloseTo(0.66888, 4);   // digital: nearly instant
    expect(decayEnd(0.8, TCO_ANALOG.decay)).toBeCloseTo(0.68382, 4);      // reaches 80 % at 68 % of Decay
    expect(decayEnd(0, TCO_ANALOG.decay)).toBeCloseTo(1, 9);              // Decay is the time to fall to 0
    expect(decayEnd(1, TCO_ANALOG.decay)).toBe(0);
    expect(releaseEnd(0.8, TCO_ANALOG.release)).toBeCloseTo(0.95577, 4);
    expect(releaseEnd(1, TCO_ANALOG.release)).toBeCloseTo(1, 9);
    expect(releaseEnd(0, TCO_ANALOG.release)).toBe(0);
    expect(expDecay(0.5, 0.8, TCO_ANALOG.decay)).toBeCloseTo(0.81018, 4);
    expect(expDecay(0.9, 0.8, TCO_ANALOG.decay)).toBe(0.8);              // held at sustain once reached
  });
  it("matches the engine's per-sample recursion", () => {
    const N = 4800;
    for (const [tco, label] of [[TCO_ANALOG.attack, "analog"], [TCO_DIGITAL.attack, "digital"]] as const) {
      const sim = simulate("attack", N, tco, 0);
      for (const n of [N / 8, N / 4, N / 2, N - 1]) expect(Math.abs(sim[n - 1]! - expAttack(n / N, tco)), label).toBeLessThan(2e-3);
    }
    const dec = simulate("decay", N, TCO_ANALOG.decay, 0.5);
    for (const n of [N / 8, N / 4, N / 2]) expect(Math.abs(dec[n - 1]! - expDecay(n / N, 0.5, TCO_ANALOG.decay))).toBeLessThan(2e-3);
    const crossD = dec.findIndex((e) => e <= 0.5);
    expect(Math.abs(crossD / N - decayEnd(0.5, TCO_ANALOG.decay))).toBeLessThan(1e-3);
    const rel = simulate("release", N, TCO_ANALOG.release, 0.8);
    for (const n of [N / 8, N / 4, N / 2]) expect(Math.abs(rel[n - 1]! - expRelease(n / N, 0.8, TCO_ANALOG.release))).toBeLessThan(2e-3);
    const crossR = rel.findIndex((e) => e <= 0);
    expect(Math.abs(crossR / N - releaseEnd(0.8, TCO_ANALOG.release))).toBeLessThan(1e-3);
  });
  it("lays stages out by the log of their time, and inverts a drag back to the setting", () => {
    expect(segWidth(0.001)).toBe(ENV_PLOT.segMin);
    expect(segWidth(60)).toBe(ENV_PLOT.segMax);
    expect(segWidth(0.1)).toBeCloseTo(35.044, 2);
    for (const t of [0.001, 0.0123, 0.1, 1.87597, 60]) expect(segTime(segWidth(t))).toBeCloseTo(t, 6);
    const env = { attack: 0.0123, decay: 0.316, sustain: 0.8, release: 1.5 };
    const g = envGeometry(env, true);
    expect(g.nodes.attack.y).toBe(g.yTop);
    expect(attackAtX(g.nodes.attack.x)).toBeCloseTo(env.attack, 6);
    expect(decayAtX(g.nodes.decay.x, g.xA)).toBeCloseTo(env.decay, 6);
    expect(sustainAtY(g.nodes.decay.y)).toBeCloseTo(0.8, 9);
    expect(releaseAtX(g.nodes.release.x)).toBeCloseTo(env.release, 6);
    // the key-up line does not move with the settings (a release drag stays under the pointer)
    expect(envGeometry({ ...env, attack: 30, decay: 30 }, true).xOff).toBe(g.xOff);
    expect(g.xR).toBeLessThanOrEqual(ENV_PLOT.w);
  });
  it("draws the curve through the exact values", () => {
    const env = { attack: 1, decay: 1, sustain: 0.5, release: 1 };
    const g = envGeometry(env, true, ENV_PLOT, 400);
    const pts = g.d.split(/[ML]/).filter(Boolean).map((s) => s.trim().split(" ").map(Number) as [number, number]);
    const yOf = (e: number) => g.yBot - e * (g.yBot - g.yTop);
    // halfway through the attack (closest drawn sample)
    const mid = pts.filter(([x]) => x > g.x0 && x <= g.xA).reduce((a, b) => (Math.abs(b[0] - (g.x0 + g.xA) / 2) < Math.abs(a[0] - (g.x0 + g.xA) / 2) ? b : a));
    const u = (mid[0] - g.x0) / (g.xA - g.x0);
    expect(mid[1]).toBeCloseTo(yOf(expAttack(u, TCO_ANALOG.attack)), 1);
    // the plateau is at the sustain level, the release ends at the baseline
    expect(pts.find(([x]) => Math.abs(x - g.xOff) < 1e-6)![1]).toBeCloseTo(yOf(0.5), 6);
    expect(pts[pts.length - 1]![1]).toBe(g.yBot);
  });
  it("reads the amp settings off the snapshot", () => {
    const p = withPhys(withPhys(synth(), "ampAttack", 0.25), "ampSustain", 40);
    const a = ampAdsr(p);
    expect(a.attack).toBeCloseTo(0.25, 4);
    expect(a.sustain).toBeCloseTo(0.4, 5);
    expect(a.release).toBeCloseTo(0.1, 5);
  });
  it("velocity: at 100 % a half-velocity note is -20 dB; at 0 % every note is full", () => {
    expect(velocityGain(0.5, 100)).toBeCloseTo(0.1, 9);
    expect(velocityGain(1, 100)).toBeCloseTo(1, 9);
    expect(velocityGain(0.5, 0)).toBeCloseTo(1, 9);
    expect(velocityGain(0.5, 50)).toBeCloseTo(0.33541, 4);
  });
});

describe("filter (FourOscVoice, exact JUCE biquads)", () => {
  const fs = 48000;
  it("maps resonance to Q as the voice does", () => {
    expect(resonanceQ(0)).toBeCloseTo(0.707107, 6);
    expect(resonanceQ(0.5)).toBeCloseTo(0.710624, 5);            // the default 0.5 %
    expect(resonanceQ(100)).toBeCloseTo(70.7107, 3);
    expect(SECOND_Q).toBeCloseTo(0.707107, 6);
  });
  it("pins the response at the cutoff for each type and slope", () => {
    const q = resonanceQ(0.5);
    expect(filterDb("lowpass", 12, fs, 1000, q, 1000)).toBeCloseTo(-2.9672, 3);          // 20·log10(Q)
    expect(filterDb("lowpass", 24, fs, 1000, q, 1000)).toBeCloseTo(-2.9672 - 3.0103, 3); // + the Q 0.7071 section
    expect(filterDb("highpass", 12, fs, 1000, q, 1000)).toBeCloseTo(-2.9672, 3);
    expect(filterDb("bandpass", 12, fs, 1000, q, 1000)).toBeCloseTo(0, 6);              // unity peak
    expect(filterDb("bandpass", 24, fs, 1000, q, 1000)).toBeCloseTo(0, 6);
    expect(filterDb("notch", 12, fs, 1000, q, 1000)).toBeLessThan(-100);
    expect(filterDb("lowpass", 12, fs, 1000, resonanceQ(100), 1000)).toBeCloseTo(36.99, 1);   // a 70.7 Q peak
    expect(filterDb("off", 24, fs, 1000, q, 50)).toBe(0);
    expect(filterChain("off", 12, fs, 1000, q)).toHaveLength(0);
    expect(filterChain("lowpass", 24, fs, 1000, q)).toHaveLength(2);
    // the slope: an octave above a low-pass cutoff, 24 dB/oct is about twice as deep
    const one = filterDb("lowpass", 12, fs, 500, resonanceQ(0), 4000), two = filterDb("lowpass", 24, fs, 500, resonanceQ(0), 4000);
    expect(one).toBeCloseTo(-36.1, 0);
    expect(two).toBeCloseTo(2 * one, 0);
  });
  it("turns Filter Freq (a note number) into the clamped base cutoff", () => {
    expect(noteToHz(69)).toBe(440);
    expect(hzToNote(880)).toBeCloseTo(81, 9);
    expect(baseCutoffHz(135.076232, 48000)).toBeCloseTo(20000, 1);
    expect(baseCutoffHz(135.076232, 32000)).toBe(16000);           // min(20 kHz, fs/2)
    expect(baseCutoffHz(0, 48000)).toBeCloseTo(8.1758, 3);
    expect(baseCutoffHz(-5, 48000)).toBe(8);
    // mosh-bass's Filter Freq 0.38 (the filter is off in every Mosh 4OSC, but this is where it sits)
    expect(noteToHz(ctl(synth({}, { filterFreq: 0.38 }), "filterFreq").phys)).toBeCloseTo(158.55, 1);
    expect(envPeakNote(60, 0.5)).toBe(128.5);                   // env · Amount · 137 semitones
  });
});

describe("summary (≤ 16 characters)", () => {
  it("names the waves that sound and the filter", () => {
    expect(fourOscSummary(synth())).toBe("sine · no filter");
    const lp = withPhys(synth({ waveShape1: "saw", waveShape2: "square", filterType: "lowpass" }), "filterFreq", hzToNote(1200));
    expect(fourOscSummary(lp)).toBe("saw+sq LP 1.2k");
    const hp = withPhys(synth({ filterType: "highpass" }), "filterFreq", hzToNote(180));
    expect(fourOscSummary(hp)).toBe("sine HP 180 Hz");
    expect(fourOscSummary(synth({ waveShape1: "off" }))).toBe("all oscs off");
    const four = synth({ waveShape1: "saw", waveShape2: "square", waveShape3: "triangle", waveShape4: "noise", filterType: "notch" });
    for (const s of [fourOscSummary(four), fourOscSummary(synth({ waveShape2: "triangle", waveShape3: "noise" }))]) expect(s.length).toBeLessThanOrEqual(16);
    expect(fourOscSummary(four)).toBe("4 oscs Notch 440");
    expect(fourOscSummary({ ...synth(), params: synth().params.slice(0, 16), state: undefined })).toBe("4OSC");
  });
});

describe("formatting", () => {
  it("prints physical units compactly", () => {
    expect(fmtSt(7)).toBe("+7 st");
    expect(fmtSt(-0.2)).toBe("0 st");
    expect(fmtSt(-12)).toBe("-12 st");
    expect(fmtCents(12.4)).toBe("+12 ct");
    expect(fmtPan(0)).toBe("C");
    expect(fmtPan(-0.3)).toBe("L 30");
    expect(fmtPan(1)).toBe("R 100");
    expect(fmtPct100(0.5)).toBe("0.5%");
    expect(fmtPct100(80)).toBe("80%");
    expect(fmtSignedPct(70)).toBe("+70%");
    expect(fmtSignedPct(-0.2)).toBe("0%");
  });
});

describe("delay note values (state delayBeats)", () => {
  it("covers the engine's 1/16..4 beat range, shortest first", () => {
    expect(DELAY_NOTES[0]!.beats).toBe(0.0625);
    expect(DELAY_NOTES[DELAY_NOTES.length - 1]!.beats).toBe(4);
    for (let i = 1; i < DELAY_NOTES.length; i++) expect(DELAY_NOTES[i]!.beats).toBeGreaterThan(DELAY_NOTES[i - 1]!.beats);
    expect(delayNote(1)).toBe("1/4");
    expect(delayNote(0.75)).toBe("1/8.");
    expect(delayNote(1 / 3)).toBe("1/8T");
    expect(delayNote(0.9)).toBeNull();
  });
});

describe("key strip", () => {
  it("is a piano's 88 keys, widened for a note outside them", () => {
    const keys = keyStrip(21, 108, 260);
    expect(keys).toHaveLength(88);
    expect(keys.filter((k) => !k.black)).toHaveLength(52);
    expect(keys[0]!.x).toBe(0);
    const c4 = keys.find((k) => k.note === 60)!, cs4 = keys.find((k) => k.note === 61)!;
    expect(c4.black).toBe(false);
    expect(cs4.black).toBe(true);
    expect(cs4.x + cs4.w / 2).toBeCloseTo(c4.x + c4.w, 9);       // centred on the C|D line
    expect(stripRange([])).toEqual([21, 108]);
    expect(stripRange([12, 60])).toEqual([12, 108]);
    expect(stripRange([110])).toEqual([21, 110]);                 // D8, a white key: the end is it
    expect(stripRange([109])).toEqual([21, 110]);                 // C#8, black: the end widens to the next white
    expect(stripRange([13])).toEqual([12, 108]);                  // C#0: the start widens to C0
    expect(isBlack(stripRange([118])[1])).toBe(false);
    expect(noteName(60)).toBe("C4");
    expect(noteName(21)).toBe("A0");
  });
});

describe("section memory (view state)", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it("remembers the section per plugin and survives bad storage", () => {
    const s = mem();
    expect(loadSection("1001", s)).toBeNull();
    saveSection("1001", "amp", s);
    saveSection("1002", "fx", s);
    expect(loadSection("1001", s)).toBe("amp");
    expect(loadSection("1002", s)).toBe("fx");
    s.m.set("mosh.v3.fourOscSection", "{not json");
    expect(loadSection("1001", s)).toBeNull();
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(loadSection("1001", throwing)).toBeNull();
    expect(() => saveSection("1001", "osc", throwing)).not.toThrow();
    s.m.set("mosh.v3.fourOscSection", JSON.stringify({ x: "nope" }));
    expect(loadSection("x", s)).toBeNull();
  });
  it("keeps at most 200 plugins", () => {
    const s = mem();
    for (let i = 0; i < 210; i++) saveSection(`id${i}`, "filter", s);
    const map = JSON.parse(s.m.get("mosh.v3.fourOscSection")!);
    expect(Object.keys(map)).toHaveLength(200);
    expect(loadSection("id0", s)).toBeNull();
    expect(loadSection("id209", s)).toBe("filter");
  });
});

// ── the panel itself (rendered): what shows, what each control sends ────────────────────

describe("FourOscPanel (rendered)", () => {
  let host: HTMLDivElement;
  let root: Root;
  const sent: { kind: "param" | "state"; key: string | number; value: number | string; gesture?: string }[] = [];
  const render = (plugin: Plugin) => act(() => root.render(React.createElement(fourOscPanelDef.Panel, {
    plugin, trackId: "t1", sampleRate: 48000,
    setParam: (i, v, o) => sent.push({ kind: "param", key: i, value: v, gesture: o?.gesture }),
    setState: (k, v, o) => sent.push({ kind: "state", key: k, value: v, gesture: o?.gesture }),
  })));
  const q = (sel: string) => host.querySelector<HTMLElement>(sel);
  const tid = (id: string) => q(`[data-testid="${id}"]`);

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    sent.length = 0;
    try { localStorage.removeItem("mosh.v3.fourOscSection"); } catch { /* none */ }
    // The preset menu asks for the library on mount; an answer that never comes keeps it
    // out of these tests (and out of act() warnings).
    useStore.setState({ exec: vi.fn((): Promise<CommandResult> => new Promise(() => {})) });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); });

  it("opens on the oscillators: one chip per sounding oscillator, its level bound by id", () => {
    render(synth({}, { level1: 0.85 }));
    expect(q('[data-testid="pp-fourosc"]')!.getAttribute("data-section")).toBe("osc");
    expect(host.querySelectorAll(".pp-fo-chip")).toHaveLength(1);
    const lv = host.querySelector('[role="slider"][aria-label="Level 1"]')!;
    expect(lv.getAttribute("aria-valuetext")).toBe("-4.0 dB");              // mosh-bass's 0.85 through the skew
    expect(tid("pp-fo-add")).not.toBeNull();
    // one voice, a sine: tune, fine and pan; no width (square only), no detune/spread (unison only)
    for (const id of ["pp-fo-tune", "pp-fo-fine", "pp-fo-pan"]) expect(tid(id), id).not.toBeNull();
    for (const id of ["pp-fo-pw", "pp-fo-detune", "pp-fo-spread"]) expect(tid(id), id).toBeNull();
  });

  it("shows width only for a square and detune/spread only with unison voices (pan only without)", () => {
    render(synth({ waveShape1: "square", voices1: 3 }));
    for (const id of ["pp-fo-pw", "pp-fo-detune", "pp-fo-spread"]) expect(tid(id), id).not.toBeNull();
    expect(tid("pp-fo-pan")).toBeNull();
  });

  it("binds by id even when the snapshot lists the parameters in another order", () => {
    const p = synth({}, { level1: 0.5 });
    render({ ...p, params: [...p.params].reverse() });
    expect(host.querySelector('[aria-label="Level 1"]')!.getAttribute("aria-valuetext")).toBe("-15.9 dB");
  });

  it("'+' turns the next oscillator on with the chosen wave (one set_plugin_state)", () => {
    render(synth());
    const add = tid("pp-fo-add") as unknown as HTMLSelectElement;
    act(() => { add.value = "saw"; add.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(sent).toEqual([{ kind: "state", key: "waveShape2", value: "saw", gesture: undefined }]);
  });

  it("a level read-out sends set_plugin_param on its own index, one gesture per key burst", () => {
    render(synth());
    const lv = host.querySelector<HTMLElement>('[aria-label="Level 1"]')!;
    act(() => { lv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    act(() => { lv.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
    expect(sent.map((s) => s.key)).toEqual([2, 2]);
    expect(sent[0]!.value).toBeCloseTo(0.99, 9);
    expect(sent[1]!.value).toBeCloseTo(0.98, 9);
    expect(sent[0]!.gesture).toBeTruthy();
    expect(sent[1]!.gesture).toBe(sent[0]!.gesture);
  });

  it("filter off: a flat line that says so, its controls hidden; on: the base cutoff and its values", () => {
    render(synth());
    act(() => tid("pp-fo-section-filter")!.click());
    expect(tid("pp-fo-filter-off")).not.toBeNull();
    for (const id of ["pp-fo-cutoff", "pp-fo-res", "pp-fo-fnode", "pp-fo-slope-24"]) expect(tid(id), id).toBeNull();
    render(synth({ filterType: "lowpass" }));
    expect(tid("pp-fo-filter-off")).toBeNull();
    expect(tid("pp-fo-cutoff")!.textContent).toBe("440 Hz");
    expect(tid("pp-fo-fnode")).not.toBeNull();
    act(() => tid("pp-fo-slope-24")!.click());
    expect(sent).toEqual([{ kind: "state", key: "filterSlope", value: 24, gesture: undefined }]);
  });

  it("effects: the knobs of an effect show only while it is on", () => {
    render(synth());
    act(() => tid("pp-fo-section-fx")!.click());
    act(() => tid("pp-fo-fx-delay")!.click());
    expect(tid("pp-fo-fx-off")).not.toBeNull();
    expect(tid("pp-fo-mix")).toBeNull();
    act(() => tid("pp-fo-fx-power")!.click());
    expect(sent).toEqual([{ kind: "state", key: "delayOn", value: "on", gesture: undefined }]);
    render(synth({ delayOn: "on", delayBeats: 0.75 }));
    expect(tid("pp-fo-mix")).not.toBeNull();
    expect((tid("pp-fo-delay-time") as unknown as HTMLSelectElement).value).toBe("1/8.");
  });

  it("the modulation section exists only when the session has routes", () => {
    render(synth());
    expect(tid("pp-fo-section-mod")).toBeNull();
    render({ ...synth(), modRoutes: [{ paramIndex: 49, id: "filterFreq", source: "lfo1", depth: 0.25 }] });
    act(() => tid("pp-fo-section-mod")!.click());
    expect(tid("pp-fo-mod")!.textContent).toContain("LFO 1");
    expect(tid("pp-fo-mod")!.textContent).toContain("Cutoff");
    expect(tid("pp-fo-mod")!.textContent).toContain("+25%");
  });

  it("an older engine (16 params, no settings) keeps the plain rows and says why", () => {
    render({ ...synth(), params: synth().params.slice(0, 16), state: undefined });
    expect(tid("pp-fo-legacy")).not.toBeNull();
    expect(host.querySelectorAll('[data-testid="v3-plugin-param"]').length).toBeGreaterThan(0);
    expect(fourOscPanelDef.ownsPresets).toBe(true);
  });
});
