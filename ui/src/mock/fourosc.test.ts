// The mock's 4OSC must be the engine's 4OSC (instrument-panels contract §1b/§1c): these pin
// the table against Tracktion's FourOscPlugin (names, ids, ranges, defaults, read-outs) and
// the embedded presets against the real files, so a panel built on the mock is built on
// the engine's numbers.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  FOUR_OSC_PARAMS, FOUR_OSC_PRESETS, FOUR_OSC_STATE, applyFourOscPreset, fourOscFrom0to1, fourOscParams, type FourOscPresetFile,
  fourOscSetNorm, fourOscTo0to1, roundToInt,
} from "./fourosc";
import { physOf } from "../v3/panels/params";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/mock
const PRESET_DIR = resolve(here, "../../../resources/presets/4osc");

describe("4OSC parameter table (Tracktion FourOscPlugin)", () => {
  const params = fourOscParams();

  it("has all 68 parameters in constructor order, unique ids, the engine's names", () => {
    expect(params).toHaveLength(68);
    expect(params.map((p) => p.index)).toEqual(Array.from({ length: 68 }, (_, i) => i));
    expect(new Set(params.map((p) => p.id)).size).toBe(68);
    expect(params.slice(0, 7).map((p) => p.name)).toEqual(["Tune 1", "Fine Tune 1", "Level 1", "Pulse Width 1", "Detune 1", "Spread 1", "Pan 1"]);
    expect(params.slice(21, 28).map((p) => p.id)).toEqual(["tune4", "fineTune4", "level4", "pulseWidth4", "detune4", "spread4", "pan4"]);
    expect(params.slice(28, 32).map((p) => p.name)).toEqual(["Rate 1", "Depth 1", "Rate 2", "Depth 2"]);
    expect(params.slice(32, 40).map((p) => p.name)).toEqual([
      "Mod Attack 1", "Mod Decay 1", "Mod Sustain 1", "Mod Release 1", "Mod Attack 2", "Mod Decay 2", "Mod Sustain 2", "Mod Release 2"]);
    expect(params.slice(40, 54).map((p) => p.id)).toEqual([
      "ampAttack", "ampDecay", "ampSustain", "ampRelease", "ampVelocity",
      "filterAttack", "filterDecay", "filterSustain", "filterRelease", "filterFreq", "filterResonance", "filterAmount", "filterKey", "filterVelocity"]);
    expect(params.slice(54).map((p) => p.name)).toEqual([
      "Distortion", "Size", "Damping", "Width", "Mix", "Feedback", "Crossfeed", "Mix", "Speed", "Depth", "Width", "Mix", "Legato", "Level"]);
    expect(params.slice(54).map((p) => p.id)).toEqual([
      "distortion", "reverbSize", "reverbDamping", "reverbWidth", "reverbMix", "delayFeedback", "delayCrossfeed", "delayMix",
      "chorusSpeed", "chorusDepth", "chorusWidth", "chorusMix", "legato", "masterLevel"]);
  });

  it("sends min/max on every parameter, skew only where it is not 1, step only for Tune", () => {
    for (const p of params) { expect(typeof p.min).toBe("number"); expect(typeof p.max).toBe("number"); }
    const skewed = params.filter((p) => p.skew !== undefined);
    expect(skewed.map((p) => p.id)).toEqual([
      "level1", "level2", "level3", "level4", "lfoRate1", "lfoRate2",
      "modAttack1", "modDecay1", "modRelease1", "modAttack2", "modDecay2", "modRelease2",
      "ampAttack", "ampDecay", "ampRelease", "filterAttack", "filterDecay", "filterRelease",
      "delayFeedback", "delayCrossfeed", "masterLevel"]);
    expect(params[40]).toMatchObject({ min: Math.fround(0.001), max: 60, skew: Math.fround(0.2) });   // ampAttack
    expect(params[2]).toMatchObject({ min: -100, max: 0, skew: 4 });                                // Level 1
    expect(params[28]!.skew).toBe(Math.fround(0.3));                                                // LFO rate
    expect(params[49]!.max).toBe(Math.fround(135.076232));                                           // filterFreq, a note number
    expect(params.filter((p) => p.step !== undefined).map((p) => [p.id, p.step])).toEqual([["tune1", 1], ["tune2", 1], ["tune3", 1], ["tune4", 1]]);
    expect(params.some((p) => p.symmetricSkew)).toBe(false);
  });

  it("starts at the engine's defaults: normalised values and Tracktion's read-outs", () => {
    const byId = Object.fromEntries(params.map((p) => [p.id, p]));
    const shows = (id: string) => byId[id]!.display;
    expect(shows("tune1")).toBe("0st");
    expect(shows("fineTune1")).toBe("0.000");            // cents, but the engine prints no unit
    expect(shows("level1")).toBe("0.000dB");
    expect(shows("pulseWidth1")).toBe("50%");
    expect(shows("detune1")).toBe("0%");
    expect(shows("spread1")).toBe("0.000%");
    expect(shows("pan1")).toBe("0R");
    expect(shows("lfoRate1")).toBe("1.000Hz");
    expect(shows("lfoDepth2")).toBe("100%");
    expect(shows("modAttack1")).toBe("100ms");
    expect(shows("modSustain2")).toBe("80.0%");
    expect(shows("ampAttack")).toBe("100ms");
    expect(shows("ampSustain")).toBe("80.0%");
    expect(shows("ampVelocity")).toBe("100.0%");
    expect(shows("filterFreq")).toBe("440Hz");
    expect(shows("filterResonance")).toBe("0.500%");
    expect(shows("filterAmount")).toBe("0%");
    expect(shows("filterKey")).toBe("0.000%");
    expect(shows("delayFeedback")).toBe("-10.00dB");
    expect(shows("delayCrossfeed")).toBe("-100.0dB");
    expect(shows("chorusSpeed")).toBe("1.000Hz");
    expect(shows("chorusDepth")).toBe("3.00ms");
    expect(shows("chorusWidth")).toBe("50%");
    expect(shows("legato")).toBe("0.000ms");
    expect(shows("masterLevel")).toBe("0.000");           // dB, but no unit
    expect(byId.ampAttack!.value).toBeCloseTo(0.27765, 5);
    expect(byId.modAttack1!.value).toBeCloseTo(0.27821, 5);
    expect(byId.lfoRate1!.value).toBeCloseTo(0.15499, 5);          // (1/500)^0.3
    expect(byId.filterFreq!.value).toBeCloseTo(69 / 135.076232, 6);
    expect(byId.delayFeedback!.value).toBeCloseTo(0.6561, 6);
    expect(byId.chorusDepth!.value).toBeCloseTo(2.9 / 19.9, 6);
    expect(byId.level1!.value).toBe(1);
    expect(byId.tune1!.value).toBe(0.5);
  });

  it("the UI's skew-aware physOf reads the mock's entries back in the engine's units", () => {
    const byId = Object.fromEntries(params.map((p) => [p.id, p]));
    const none = { min: 0, max: 1 };
    expect(physOf(byId.ampAttack, none)).toBeCloseTo(0.1, 6);
    expect(physOf(byId.delayFeedback, none)).toBeCloseTo(-10, 4);
    expect(physOf(byId.filterFreq, none)).toBeCloseTo(69, 4);
    expect(physOf(byId.lfoRate1, none)).toBeCloseTo(1, 4);
    expect(physOf(fourOscSetNorm(40, 0.5)!, none)).toBeCloseTo(1.87597, 4);    // amp time at v = 0.5
    expect(physOf(fourOscSetNorm(2, 0.5)!, none)).toBeCloseTo(-15.910, 3);     // level at v = 0.5
    expect(fourOscSetNorm(40, 0.5)!.display).toBe("1.88s");
    expect(fourOscSetNorm(2, 0.5)!.display).toBe("-15.9dB");      // above 10: one decimal
  });

  it("maps like JUCE NormalisableRange<float> both ways, and set_plugin_param clamps", () => {
    const amp = FOUR_OSC_PARAMS[40]!;
    for (const v of [0, 0.1, 0.2777, 0.5, 0.9, 1]) expect(fourOscTo0to1(amp, fourOscFrom0to1(amp, v))).toBeCloseTo(v, 6);
    expect(fourOscFrom0to1(amp, 0)).toBe(amp.min);
    expect(fourOscSetNorm(40, 7)!.value).toBe(1);
    expect(fourOscSetNorm(40, -3)!.value).toBe(0);
    expect(fourOscSetNorm(99, 0.5)).toBeNull();
    // Tune is not snapped by the engine; the read-out rounds (and the voice rounds too)
    expect(fourOscSetNorm(0, 0.5 + 0.4 / 72)).toMatchObject({ value: expect.closeTo(0.5 + 0.4 / 72, 6), display: "0st" });
    expect(fourOscSetNorm(0, 0.5 + 0.6 / 72)!.display).toBe("1st");
  });

  it("formats like Tracktion's text functions (juce::roundToInt ties to even)", () => {
    expect([0.5, 1.5, 2.5, -0.5, -1.5, 3.4999].map(roundToInt)).toEqual([0, 2, 2, -0, -2, 3]);
    expect(fourOscSetNorm(40, 1)!.display).toBe("60.00s");
    expect(fourOscSetNorm(6, 0.25)!.display).toBe("50L");        // pan -0.5
    expect(fourOscSetNorm(6, 0.75)!.display).toBe("50R");
    expect(fourOscSetNorm(66, 0.5)!.display).toBe("250ms");      // legato: above 100 an integer, then the label
    expect(fourOscSetNorm(1, 0.6)!.display).toBe("20.0");        // fine tune +20 cents: one decimal above 10, no unit
    expect(fourOscSetNorm(5, 0.51)!.display).toBe("2.00%");      // spread: two decimals between 1 and 10
    expect(fourOscSetNorm(5, 0.505)!.display).toBe("1.000%");    // …and 1 itself (float 0.99999…) is not above 1
  });
});

describe("4OSC state and presets", () => {
  it("offers exactly the contract's settings with the engine's defaults", () => {
    expect(Object.keys(FOUR_OSC_STATE)).toEqual([
      "waveShape1", "waveShape2", "waveShape3", "waveShape4", "voices1", "voices2", "voices3", "voices4",
      "filterType", "filterSlope", "distortionOn", "reverbOn", "delayOn", "chorusOn", "delayBeats", "voiceMode", "ampAnalog"]);
    expect(FOUR_OSC_STATE.waveShape1).toEqual({ value: "sine", choices: ["off", "sine", "square", "saw", "triangle", "noise"] });
    expect(FOUR_OSC_STATE.waveShape3!.value).toBe("off");
    expect(FOUR_OSC_STATE.voices2).toEqual({ value: 1, min: 1, max: 8, step: 1 });
    expect(FOUR_OSC_STATE.filterType).toEqual({ value: "off", choices: ["off", "lowpass", "highpass", "bandpass", "notch"] });
    expect(FOUR_OSC_STATE.filterSlope).toEqual({ value: 12, min: 12, max: 24, step: 12, unit: "dB/oct" });
    expect(FOUR_OSC_STATE.delayBeats).toEqual({ value: 1, min: 0.0625, max: 4, unit: "beats" });
    expect(FOUR_OSC_STATE.voiceMode).toEqual({ value: "poly", choices: ["mono", "legato", "poly"] });
    expect(FOUR_OSC_STATE.ampAnalog).toEqual({ value: "on", choices: ["off", "on"] });
    expect(FOUR_OSC_STATE.chorusOn).toEqual({ value: "off", choices: ["off", "on"] });
  });

  it("the embedded presets are the bundled files, key for key (a drift guard)", () => {
    for (const name of ["mosh-bass", "mosh-keys", "mosh-lead", "mosh-pad", "mosh-pluck"]) {
      const file = JSON.parse(readFileSync(resolve(PRESET_DIR, `${name}.json`), "utf8")) as FourOscPresetFile;
      expect(FOUR_OSC_PRESETS[name]).toEqual({ state: file.state, params: file.params });
      expect(Object.keys(FOUR_OSC_PRESETS[name]!.params!)).toEqual(Object.keys(file.params!));
    }
  });

  it("each bundled file's _physical says what its normalized params are (through the 4OSC's own ranges)", () => {
    for (const name of ["mosh-bass", "mosh-keys", "mosh-lead", "mosh-pad", "mosh-pluck"]) {
      const file = JSON.parse(readFileSync(resolve(PRESET_DIR, `${name}.json`), "utf8")) as
        { params: Record<string, number>; _physical: Record<string, { value: number; unit: string }> };
      expect(Object.keys(file._physical)).toEqual(Object.keys(file.params));
      for (const [param, norm] of Object.entries(file.params)) {
        const spec = FOUR_OSC_PARAMS.find((s) => s.name === param)!;
        expect(spec, `${name}: ${param}`).toBeDefined();
        const phys = fourOscFrom0to1(spec, norm);
        const want = file._physical[param]!;
        // Filter Freq is a MIDI note in the engine; the file states Hz. Amount is -1..1.
        const got = spec.id === "filterFreq" ? 440 * 2 ** ((phys - 69) / 12) : phys;
        const tol = Math.max(0.02 * Math.abs(want.value), want.unit === "s" ? 0.002 : 0.02);
        expect(Math.abs(got - want.value), `${name}: ${param} ${got} vs ${want.value} ${want.unit}`).toBeLessThanOrEqual(tol);
      }
    }
  });

  it("applies settings and params as a whole patch, reporting what matched nothing", () => {
    const counts = Object.fromEntries(Object.entries(FOUR_OSC_PRESETS).map(([n, p]) => {
      const r = applyFourOscPreset(fourOscParams(), undefined, p);
      if ("error" in r) throw new Error(r.error);
      return [n, [r.applied, r.settingsApplied, r.unknown]];
    }));
    expect(counts).toEqual({
      "mosh-bass": [14, 5, []], "mosh-keys": [9, 4, []], "mosh-lead": [10, 6, []], "mosh-pad": [10, 5, []], "mosh-pluck": [13, 3, []],
    });
    const bass = applyFourOscPreset(fourOscParams(), undefined, FOUR_OSC_PRESETS["mosh-bass"]!);
    if ("error" in bass) throw new Error(bass.error);
    expect(bass.nextState.waveShape1!.value).toBe("saw");
    expect(bass.nextState.waveShape2!.value).toBe("square");
    expect(bass.nextState.voices1!.value).toBe(2);
    expect(bass.nextState.filterType!.value).toBe("lowpass");
    expect(bass.nextState.filterSlope!.value).toBe(24);
    // lead over bass: bass's Filter Amount (not named by lead) and its 24 dB/oct go back to default
    const lead = applyFourOscPreset(bass.next, bass.nextState, FOUR_OSC_PRESETS["mosh-lead"]!);
    if ("error" in lead) throw new Error(lead.error);
    expect(lead.next[51]!.value).toBe(fourOscParams()[51]!.value);
    expect(lead.nextState.filterSlope!.value).toBe(12);
    expect(lead.nextState.voices2!.value).toBe(3);
    expect(lead.reset).toBeGreaterThan(0);
    // the loaded patch again: nothing changes
    const again = applyFourOscPreset(lead.next, lead.nextState, FOUR_OSC_PRESETS["mosh-lead"]!);
    expect("error" in again ? again.error : again.changed).toBe(false);
    // "Level 1" is the oscillator's level (index 2), never the master "Level" (67)
    const r = applyFourOscPreset(fourOscParams(), undefined, { params: { "level 1": 0.5, MIX: 0.4 } });
    if ("error" in r) throw new Error(r.error);
    expect(r.next[2]!.value).toBeCloseTo(0.5, 6);
    expect(r.next[67]!.value).toBe(1);
    expect(r.next[58]!.value).toBeCloseTo(0.4, 6);      // the FIRST "Mix" is the reverb's
    expect(r.next[61]!.value).toBe(0);
  });

  it("refuses the old numbered waveShapes and any bad setting, as the engine does", () => {
    const refuse = (preset: FourOscPresetFile) => {
      const r = applyFourOscPreset(fourOscParams(), undefined, preset);
      return "error" in r ? r.error : "applied";
    };
    expect(refuse({ waveShapes: [3, 3, 0, 0], params: { "Level 1": 0.8 } })).toMatch(/waveShapes/);
    expect(refuse({ state: { filterType: "comb" }, params: { "Level 1": 0.8 } })).toMatch(/filterType: bad value for filterType: must be one of off, lowpass/);
    expect(refuse({ state: { lfoBeat1: 0 } })).toMatch(/unknown 4OSC setting in "state": lfoBeat1/);
    expect(refuse({ state: { voices1: "3" } })).toMatch(/must be a finite number/);
    expect(refuse({ params: { Nope: 0.5 } })).toMatch(/matched no 4OSC parameters or settings \(unknown: Nope\)/);
    // a step-12 slope snaps like set_plugin_state (18 -> 24); voices clamp to 1..8
    const ok = applyFourOscPreset(fourOscParams(), undefined, { state: { filterSlope: 18, voices1: 12 } });
    if ("error" in ok) throw new Error(ok.error);
    expect(ok.nextState.filterSlope!.value).toBe(24);
    expect(ok.nextState.voices1!.value).toBe(8);
  });
});
