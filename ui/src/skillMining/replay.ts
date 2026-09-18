import { __resetMockForTests, mockExecute, mockSnapshot } from "../bridge.mock";
import { runBound } from "../gepa/metric";
import type { BoundCommand } from "../import/emit";
import type { CommandResult, Snapshot } from "../types";
import { checkPreconditions, fillGold, renderStep } from "./render";
import { checkEffect } from "./effects";
import { commandSchema, jsonSchema, skillSchema, record, type Command, type Skill, type Json, MiningError } from "./types";
import { exactCommands } from "./comparison";

export type ReplaySetup = {
  readonly startCommands: readonly BoundCommand[];
  readonly originalIdBindings: Readonly<Record<string, string>>;
};
export type ReplayResult = { readonly status: "passed" | "failed" | "unverified"; readonly reasons: readonly string[] };
type SnapshotWitness = { readonly snapshot: Json; readonly ids: ReadonlyMap<string, string> };
// These are native creation result DATA fields, not IDs inferred from snapshot order.
// Sources: MoshOps.Tracks.cpp, MoshOps.Clips.cpp, MoshOps.Notes.cpp, MoshOps.cpp.
const creationIds: Readonly<Record<string, readonly string[]>> = {
  create_track: ["trackId"], add_midi_clip: ["clipId", "trackId"], add_test_tone_clip: ["clipId", "trackId"],
  duplicate_clip: ["newClipId"], split_clip: ["newClipId"], create_section: ["sectionId"], create_annotation: ["annotationId"],
};
function normalized(value: Json, ids: ReadonlyMap<string, string>, path: readonly string[] = []): Json {
  if (typeof value === "string") {
    const key = path[path.length - 1], parent = path[path.length - 2];
    const entityId = key === "id" && ["tracks", "clips", "sections", "annotations"].includes(parent);
    const reference = ["trackId", "clipId", "sectionId", "annotationId", "parentId", "trackIds", "clipIds"].includes(key);
    return (entityId || reference) ? ids.get(value) ?? value : value;
  }
  if (Array.isArray(value)) return value.map(item => normalized(item, ids, path));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key], ids, [...path, key])]));
}
export function snapshotsMatch(expected: SnapshotWitness, actual: SnapshotWitness): boolean {
  return JSON.stringify(normalized(expected.snapshot, expected.ids)) === JSON.stringify(normalized(actual.snapshot, actual.ids));
}
function remapCommands(commands: readonly Command[], ids: ReadonlyMap<string, string>): readonly Command[] {
  return commands.map((command) => ({ command: command.command, args: Object.fromEntries(Object.entries(command.args).map(([key, value]) =>
    [key, typeof value === "string" && ids.has(value) && /Id$/.test(key) ? ids.get(value) ?? value : value])) }));
}
function canonicalCommands(commands: readonly Command[], ids: ReadonlyMap<string, string>): readonly Command[] {
  return commands.map(command => ({ command: command.command, args: record(normalized(command.args, ids)) }));
}
export async function replaySkill(input: Skill, gold: readonly Command[], setup: ReplaySetup): Promise<ReplayResult> {
  const parsed = skillSchema.safeParse(input);
  if (!parsed.success) return { status: "failed", reasons: parsed.error.issues.map(issue => `Skill predicate contract: ${issue.path.join(".")}: ${issue.message}`) };
  const skill = parsed.data;
  const play = async (candidate: boolean) => {
    __resetMockForTests();
    const boot = await mockExecute<CommandResult>({ command: "new_project", args: {} });
    if (!boot.ok) throw new MiningError(`Mock new_project failed: ${boot.error}`);
    const env = new Map<string, string>();
    const seeded = await runBound([...setup.startCommands], env);
    if (seeded.applied !== seeded.total) throw new MiningError(`Original setup failed: ${seeded.errors.join("; ")}`);
    const ids = new Map<string, string>(), canonicalIds = new Map<string, string>();
    for (const [variable, current] of env) {
      if (canonicalIds.has(current)) throw new MiningError(`Ambiguous setup identity binding for ${variable}`);
      canonicalIds.set(current, `setup:${variable}`);
    }
    for (const [originalId, variable] of Object.entries(setup.originalIdBindings)) {
      const current = env.get(variable);
      if (!current) throw new MiningError(`Unresolved original setup binding: ${originalId} -> ${variable}`);
      ids.set(originalId, current);
    }
    const mapped = remapCommands(gold, ids);
    const filled = fillGold(skill, mapped);
    let before = jsonSchema.parse(JSON.parse(JSON.stringify(await mockSnapshot<Snapshot>())));
    const snapshots: Json[] = [before];
    const preconditions = checkPreconditions(skill, before, filled);
    if (preconditions.length) throw new MiningError(`Precondition: ${preconditions.join("; ")}`);
    const results: Json[] = [], commands: Command[] = [], effects: ReplayResult[] = [];
    for (const [index, template] of skill.template.commands.entries()) {
      const command = candidate ? renderStep(template, { skill, filled, results }) : commandSchema.parse(mapped[index]);
      const result = await mockExecute<CommandResult>(command);
      const resultJson = jsonSchema.parse(JSON.parse(JSON.stringify(result)));
      results.push(resultJson); commands.push(command);
      if (!result.ok) throw new MiningError(`${command.command} failed: ${result.error}`);
      for (const field of creationIds[command.command] ?? []) {
        const identity = record(record(resultJson).data)[field];
        if (typeof identity === "string" && !canonicalIds.has(identity)) canonicalIds.set(identity, `step:${index + 1}:${field}`);
      }
      const after = jsonSchema.parse(JSON.parse(JSON.stringify(await mockSnapshot<Snapshot>())));
      const predicate = skill.postconditions.find(item => item.type === "command_effect" && item.step === index + 1);
      if (!predicate || predicate.type !== "command_effect" || predicate.command !== command.command)
        throw new MiningError(`Missing matching declared postcondition for step ${index + 1}`);
      const effect = checkEffect({ command: predicate.command, args: command.args }, before, after);
      effects.push({ status: effect.status, reasons: [`Postcondition step ${predicate.step} (${predicate.command}): ${effect.reason}`] });
      snapshots.push(after); before = after;
    }
    return { commands, snapshots, ids: canonicalIds, effects };
  };
  try {
    const expected = await play(false);
    const actual = await play(true);
    if (!exactCommands(canonicalCommands(actual.commands, actual.ids), canonicalCommands(expected.commands, expected.ids)))
      return { status: "failed", reasons: ["Rendered command trajectory differs from gold after explicit ID binding"] };
    const effects = [...expected.effects, ...actual.effects];
    if (effects.some(effect => effect.status === "failed")) return { status: "failed", reasons: effects.filter(effect => effect.status === "failed").flatMap(effect => effect.reasons) };
    for (const [step, snapshot] of expected.snapshots.entries()) {
      const actualSnapshot = actual.snapshots[step];
      if (actualSnapshot === undefined || !snapshotsMatch({ snapshot, ids: expected.ids }, { snapshot: actualSnapshot, ids: actual.ids }))
        return { status: "failed", reasons: [`Independent replay snapshots differ at step ${step} after explicit ID normalization`] };
    }
    if (effects.some(effect => effect.status === "unverified")) return { status: "unverified", reasons: effects.filter(effect => effect.status === "unverified").flatMap(effect => effect.reasons) };
    return { status: "passed", reasons: [] };
  } catch (error) {
    if (error instanceof Error) return { status: "failed", reasons: [error.message] };
    throw error;
  } finally { __resetMockForTests(); }
}
