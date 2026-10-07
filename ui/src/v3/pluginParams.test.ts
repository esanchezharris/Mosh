import { describe, it, expect } from "vitest";
import { choiceIndex, choiceValue, inspectorParams, isChoice, pluginHint, showsEveryParam } from "./pluginParams";
import { builtinPlugin } from "../mock/builtins";
import type { Plugin, PluginParam } from "../types";

const autotune = (): Plugin => builtinPlugin("moshAutoTune", 2)!;
const names = (ps: PluginParam[]) => ps.map((p) => p.name);

describe("choiceIndex / choiceValue", () => {
  it("round-trips every choice of a twelve-note key menu", () => {
    for (let i = 0; i < 12; i++) expect(choiceIndex(choiceValue(i, 12), 12)).toBe(i);
    expect(choiceValue(7, 12)).toBeCloseTo(7 / 11, 10);
    expect(choiceValue(1, 3)).toBe(0.5);
  });

  it("reads an in-between value as the nearest choice", () => {
    expect(choiceIndex(0.8, 12)).toBe(9);    // 8.8 -> A
    expect(choiceIndex(0.49, 3)).toBe(1);
    expect(choiceIndex(0.24, 3)).toBe(0);
  });

  it("stays inside the menu for values and indices that are not", () => {
    expect(choiceIndex(-1, 12)).toBe(0);
    expect(choiceIndex(9, 12)).toBe(11);
    expect(choiceIndex(Number.NaN, 12)).toBe(0);
    expect(choiceValue(99, 12)).toBe(1);
    expect(choiceValue(-3, 12)).toBe(0);
    expect(choiceIndex(0.7, 1)).toBe(0);
    expect(choiceValue(0, 1)).toBe(0);
  });
});

describe("inspectorParams", () => {
  it("shows all nine AutoTune controls, key and scale first, glide beside retune speed", () => {
    expect(names(inspectorParams(autotune()))).toEqual(
      ["Key", "Scale", "Retune speed", "Glide", "Amount", "Range", "Mix", "Output", "Look-ahead"]);
    expect(showsEveryParam(autotune())).toBe(true);
  });

  it("still shows a parameter the layout does not know about, last", () => {
    const p = autotune();
    p.params.push({ index: 9, name: "Formant", value: 0.5 });
    expect(names(inspectorParams(p)).at(-1)).toBe("Formant");
    expect(inspectorParams(p)).toHaveLength(10);
  });

  it("keeps other built-ins to their first four controls unless a preset inserted them", () => {
    const comp = builtinPlugin("compressor", 1)!;
    expect(inspectorParams(comp)).toHaveLength(4);
    expect(showsEveryParam(comp)).toBe(false);
    comp.preset = { id: "mosh.clean-lead", name: "Mosh Clean Lead v0", revision: 0, stage: 1 };
    expect(inspectorParams(comp)).toHaveLength(comp.params.length);
    expect(showsEveryParam(comp)).toBe(true);
  });
});

describe("isChoice", () => {
  it("is true only for a parameter that names at least two choices", () => {
    const [key, , retune] = autotune().params;
    expect(isChoice(key)).toBe(true);
    expect(isChoice(retune)).toBe(false);
    expect(isChoice({ index: 0, name: "X", value: 0, choices: ["only"] })).toBe(false);
  });
});

describe("pluginHint", () => {
  it("explains that Key does nothing on the chromatic scale, and stops once a scale is chosen", () => {
    const p = autotune();
    expect(pluginHint(p)).toMatch(/Key has no effect/);
    p.params[1].value = choiceValue(1, 3);   // Major
    expect(pluginHint(p)).toBeNull();
    p.params[1].value = choiceValue(2, 3);   // Minor
    expect(pluginHint(p)).toBeNull();
  });

  it("says nothing for other plugins", () => {
    expect(pluginHint(builtinPlugin("compressor", 1)!)).toBeNull();
  });
});
