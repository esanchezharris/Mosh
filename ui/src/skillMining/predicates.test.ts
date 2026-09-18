import { describe, expect, it } from "vitest";
import { replaySkill, snapshotsMatch } from "./replay";
import { skillSchema } from "./types";
import type { Skill } from "./types";

const tempo = (): Skill => ({
  schemaVersion: 1, id: "synthetic-tempo", name: "Synthetic tempo", description: "Unit fixture", examples: ["a", "b", "c", "d", "e"], slots: [],
  template: { commands: [{ command: "set_tempo", args: { bpm: 93 } }] }, preconditions: [],
  postconditions: [{ type: "command_effect", command: "set_tempo", step: 1 }], provenance: ["synthetic"], triggers: [],
  mining: { rank: 1, shape: ["set_tempo"], rows: 1, bindings: [], undo: "per_mutation" },
});
const targeted = (): Skill => ({
  ...tempo(), slots: [{ name: "trackId", type: "string", required: true, description: "Track", source: "user", default: null,
    input: { kind: "choice_snapshot", question: "Track", selector: "tracks[].id", defaultPolicy: "required", nativeSource: { file: "native.cpp", line: 1 } } }],
  template: { commands: [{ command: "rename_track", args: { trackId: "{trackId}", name: "Renamed" } }] },
  preconditions: [{ type: "snapshot_choice", slot: "trackId", selector: "tracks[].id" }],
  postconditions: [{ type: "command_effect", step: 1, command: "rename_track" }],
  mining: { ...tempo().mining, shape: ["rename_track"], bindings: [{ slot: "trackId", step: 1, arg: "trackId" }] },
});

describe("closed predicate contracts", () => {
  it("accepts a complete matching predicate contract", () => {
    expect(skillSchema.safeParse(targeted()).success).toBe(true);
  });
  it.each<{ name: string; mutate: (skill: Skill) => void }>([
    { name: "omitted postcondition", mutate: skill => { skill.postconditions = []; } },
    { name: "mismatched command", mutate: skill => { skill.postconditions = [{ type: "command_effect", step: 1, command: "save" }]; } },
    { name: "duplicate step", mutate: skill => { skill.postconditions.push(skill.postconditions[0]); } },
    { name: "out of range step", mutate: skill => { skill.postconditions = [{ type: "command_effect", step: 2, command: "rename_track" }]; } },
    { name: "precondition in postconditions", mutate: skill => { skill.postconditions = [{ type: "snapshot_choice", slot: "trackId", selector: "tracks[].id" }]; } },
    { name: "postcondition in preconditions", mutate: skill => { skill.preconditions = [{ type: "command_effect", step: 1, command: "rename_track" }]; } },
    { name: "omitted snapshot precondition", mutate: skill => { skill.preconditions = []; } },
    { name: "duplicate snapshot precondition", mutate: skill => { skill.preconditions.push(skill.preconditions[0]); } },
    { name: "unknown predicate slot", mutate: skill => { skill.preconditions = [{ type: "snapshot_choice", slot: "missing", selector: "tracks[].id" }]; } },
    { name: "mismatched selector", mutate: skill => { skill.preconditions = [{ type: "snapshot_choice", slot: "trackId", selector: "sections[].id" }]; } },
    { name: "unknown selector", mutate: skill => { skill.slots[0].input.selector = "tracks[].guessedId"; skill.preconditions = [{ type: "snapshot_choice", slot: "trackId", selector: "tracks[].guessedId" }]; } },
    { name: "missing slot selector", mutate: skill => { delete skill.slots[0].input.selector; } },
    { name: "unknown template slot", mutate: skill => { skill.template.commands[0].args.trackId = "{missing}"; } },
    { name: "unknown binding slot", mutate: skill => { skill.mining.bindings[0].slot = "missing"; } },
  ])("rejects $name", ({ mutate }) => {
    const candidate = targeted();
    mutate(candidate);
    expect(skillSchema.safeParse(candidate).success).toBe(false);
  });
  it("rejects self and future result bindings while allowing earlier data fields", () => {
    const candidate = tempo();
    candidate.template.commands = [{ command: "create_section", args: { name: "Verse" } }, { command: "rename_section", args: { sectionId: "{step1.result.sectionId}", name: "Chorus" } }];
    candidate.postconditions = [{ type: "command_effect", step: 1, command: "create_section" }, { type: "command_effect", step: 2, command: "rename_section" }];
    expect(skillSchema.safeParse(candidate).success).toBe(true);
    candidate.template.commands[1].args.sectionId = "{step2.result.sectionId}";
    expect(skillSchema.safeParse(candidate).success).toBe(false);
    candidate.template.commands[1].args.sectionId = "{step3.result.sectionId}";
    expect(skillSchema.safeParse(candidate).success).toBe(false);
  });
  it("requires every step even when another step has a valid predicate", () => {
    const candidate = tempo();
    candidate.template.commands.push({ command: "save", args: {} });
    expect(skillSchema.safeParse(candidate).success).toBe(false);
  });
});

describe("declared predicates through real mock replay", () => {
  it("rejects malformed predicates before a replay can pass", async () => {
    const candidate = tempo();
    candidate.postconditions = [{ type: "command_effect", step: 1, command: "save" }];
    expect((await replaySkill(candidate, candidate.template.commands, { startCommands: [], originalIdBindings: {} })).status).toBe("failed");
  });
  it("reports an explicit postcondition failure when the real mock applies a different value", async () => {
    const candidate = tempo();
    candidate.template.commands[0].args.bpm = 1;
    const result = await replaySkill(candidate, candidate.template.commands, { startCommands: [], originalIdBindings: {} });
    expect(result.status).toBe("failed");
    expect(result.reasons.some(reason => reason.includes("Postcondition step 1"))).toBe(true);
  });
  it("compares independent setup-bound replay snapshots", async () => {
    const candidate = targeted();
    expect(await replaySkill(candidate, [{ command: "rename_track", args: { trackId: "original-track", name: "Renamed" } }], {
      startCommands: [{ command: "create_track", args: { name: "Initial" }, bind: "target" }], originalIdBindings: { "original-track": "target" },
    })).toEqual({ status: "passed", reasons: [] });
  });
  it("normalizes actual section creation result IDs across independent resets", async () => {
    const candidate = tempo();
    candidate.template.commands = [{ command: "create_section", args: { name: "Verse", startBeat: 0, endBeat: 16 } }];
    candidate.postconditions = [{ type: "command_effect", step: 1, command: "create_section" }];
    candidate.mining.shape = ["create_section"];
    expect(await replaySkill(candidate, candidate.template.commands, { startCommands: [], originalIdBindings: {} })).toEqual({ status: "passed", reasons: [] });
  });
});

describe("snapshot comparison identity boundaries", () => {
  it("accepts only IDs justified by explicit bindings", () => {
    const expected = { snapshot: { tracks: [{ id: "11", name: "Voice" }] }, ids: new Map([["11", "setup:target"]]) };
    const actual = { snapshot: { tracks: [{ id: "28", name: "Voice" }] }, ids: new Map([["28", "setup:target"]]) };
    expect(snapshotsMatch(expected, actual)).toBe(true);
    expect(snapshotsMatch({ ...expected, ids: new Map() }, actual)).toBe(false);
  });
  it("does not erase a content mismatch that happens to equal an ID", () => {
    const expected = { snapshot: { tracks: [{ id: "11", name: "11" }] }, ids: new Map([["11", "setup:target"]]) };
    const actual = { snapshot: { tracks: [{ id: "28", name: "28" }] }, ids: new Map([["28", "setup:target"]]) };
    expect(snapshotsMatch(expected, actual)).toBe(false);
  });
  it("does not normalize an undocumented plugin catalogue identity", () => {
    const expected = { snapshot: { tracks: [{ id: "11", plugins: [{ catalogId: "11" }] }] }, ids: new Map([["11", "setup:target"]]) };
    const actual = { snapshot: { tracks: [{ id: "28", plugins: [{ catalogId: "28" }] }] }, ids: new Map([["28", "setup:target"]]) };
    expect(snapshotsMatch(expected, actual)).toBe(false);
  });
});
