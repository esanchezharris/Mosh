import { describe, expect, it } from "vitest";
import { checkPreconditions, fillGold, render, renderStep, selectOptions } from "./render";
import type { Filled, Json, Skill, Slot } from "./types";

const slot = (name: string, type: Slot["type"] = "number", required = true): Slot => ({
  name, type, required, description: name, source: "user", default: null,
  input: { kind: "number", question: name, defaultPolicy: required ? "required" : "omit", nativeSource: { file: "native.cpp", line: 1 } },
});
const skill = (slots: Slot[]): Skill => ({
  schemaVersion: 1, id: "test", name: "Test", description: "Test", examples: [], slots,
  template: { commands: [{ command: "set_tempo", args: { bpm: "{bpm}", optional: "{optional}" } }] },
  preconditions: [], postconditions: [{ type: "command_effect", step: 1, command: "set_tempo" }], provenance: ["row"], triggers: [],
  mining: { rank: 1, shape: ["set_tempo"], rows: 1, bindings: [{ slot: "bpm", step: 1, arg: "bpm" }, { slot: "optional", step: 1, arg: "optional" }], undo: "per_mutation" },
});

describe("offline typed rendering", () => {
  it("preserves numeric values and optional omission when filled from gold", () => {
    const input = skill([slot("bpm"), slot("optional", "number", false)]);
    const actual = render(input, fillGold(input, [{ command: "set_tempo", args: { bpm: 93 } }]));
    expect(actual).toEqual([{ command: "set_tempo", args: { bpm: 93 } }]);
  });
  it.each<Filled>([{}, { bpm: null }, { bpm: "93" }, { bpm: "NEEDS_OWNER_VALUE" }])("blocks invalid required owner input %j", filled => {
    const input = skill([slot("bpm"), slot("optional", "number", false)]);
    expect(() => render(input, filled)).toThrow();
  });
  it("blocks a missing required slot belonging to a later command before the first step", () => {
    const input = skill([slot("later")]);
    expect(() => renderStep({ command: "save", args: {} }, { skill: input, filled: {}, results: [] })).toThrow();
  });
  it("does not silently substitute a constant owner's default", () => {
    const input = skill([{ ...slot("bpm"), default: 120 }]);
    expect(() => render(input, {})).toThrow();
  });
  it.each([0, 11, 1.5, "2", 4])("enforces range integer and closed typed choices for %j", value => {
    const choice = slot("bpm");
    choice.input = { ...choice.input, kind: "choice_static", min: 1, max: 10, integer: true, options: [{ value: 2, description: "two" }] };
    expect(() => render(skill([choice, slot("optional", "number", false)]), { bpm: value })).toThrow();
  });
  it("resolves successful previous result data and preserves its type", () => {
    const input = skill([]);
    const actual = renderStep({ command: "remove_clip", args: { clipId: "{step1.result.clipId}" } }, { skill: input, filled: {}, results: [{ ok: true, command: "add_midi_clip", data: { clipId: "c1" } }] });
    expect(actual.args.clipId).toBe("c1");
  });
  it.each<{ results: Json[] }>([{ results: [] }, { results: [{ ok: false, data: { clipId: "c1" } }] }, { results: [{ ok: true, clipId: "wrong-level" }] }])("rejects unresolved and failed result references %j", ({ results }) => {
    expect(() => renderStep({ command: "remove_clip", args: { clipId: "{step1.result.clipId}" } }, { skill: skill([]), filled: {}, results })).toThrow();
  });
  it("rejects future result references despite a successful prior result", () => {
    expect(() => renderStep({ command: "remove_clip", args: { clipId: "{step2.result.clipId}" } }, { skill: skill([]), filled: {}, results: [{ ok: true, data: { clipId: "c1" } }] })).toThrow();
  });
  it("rejects an unresolved owner token in a literal command value", () => {
    expect(() => renderStep({ command: "set_tempo", args: { bpm: "NEEDS_OWNER_VALUE" } }, { skill: skill([]), filled: {}, results: [] })).toThrow();
  });
  it("rejects unknown slot names in both inputs and templates", () => {
    expect(() => renderStep({ command: "save", args: { path: "{unknown}" } }, { skill: skill([]), filled: {}, results: [] })).toThrow();
    expect(() => renderStep({ command: "save", args: {} }, { skill: skill([]), filled: { unknown: "x" }, results: [] })).toThrow();
  });
  it("rejects owner sentinels nested in structured inputs", () => {
    expect(() => renderStep({ command: "add_note", args: { notes: "{notes}" } }, { skill: skill([slot("notes", "list<note>")]), filled: { notes: [{ pitch: "NEEDS_OWNER_VALUE" }] }, results: [] })).toThrow();
  });
});

const snapshot = { tracks: [{ id: "t1", clips: [{ id: "c1", notes: [{ i: 0 }, { i: 1 }] }], plugins: [{ index: 0 }] }, { id: "t2", clips: [{ id: "c2", notes: [{ i: 2 }] }], plugins: [{ index: 3 }] }], sections: [{ id: "s1" }] };
describe("native snapshot selectors", () => {
  it.each([
    ["tracks[].id", {}, ["t1", "t2"]],
    ["tracks[].clips[].id", { trackId: "t1" }, ["c1"]],
    ["tracks[].plugins[].index", { step1_trackId: "t2" }, [3]],
    ["tracks[].clips[].notes[].i", { clipId: "c1" }, [0, 1]],
    ["sections[].id", {}, ["s1"]],
  ])("selects native values from %s with scope", (selector, filled, expected) => {
    expect(selectOptions(selector, snapshot, filled)).toEqual(expected);
  });
  it("requires an explicit catalogue for drum kits", () => {
    expect(() => selectOptions("list_drum_kits:data.kits[].id", snapshot)).toThrow();
    expect(selectOptions("list_drum_kits:data.kits[].id", { list_drum_kits: { ok: true, data: { kits: [{ id: "kit1" }] } } })).toEqual(["kit1"]);
  });
  it("rejects invalid addresses in scoped preconditions", () => {
    const input = skill([slot("step1_trackId", "string"), slot("step1_clipId", "string")]);
    input.preconditions = [{ type: "snapshot_choice", slot: "step1_clipId", selector: "tracks[].clips[].id" }];
    expect(checkPreconditions(input, snapshot, { step1_trackId: "t1", step1_clipId: "c2" })).toHaveLength(1);
  });
});
