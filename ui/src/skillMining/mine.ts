import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { COMMAND_FACTS, type ArgumentFact } from "./nativeFacts";
import { skillSchema, primitiveSchema, MiningError, type Slot, type Skill, type TrainingRow, type ShapeGroup, type Command, type Primitive } from "./types";

function statistics(values: readonly Primitive[]) {
  const numbers = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (!numbers.length) return undefined;
  const middle = Math.floor(numbers.length / 2);
  return { min: numbers[0], median: numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2,
    max: numbers[numbers.length - 1] };
}
function slotDefinition(name: string, values: readonly Primitive[], fact: ArgumentFact, optional: boolean): Slot {
  const kinds = new Set(values.map((v) => typeof v));
  const type = fact.unit ? "number" : typeof values[0] === "boolean" ? "boolean" : typeof values[0] === "number" ? "number" : "string";
  if (kinds.size !== 1) throw new MiningError(`Mixed primitive types for ${name}: ${[...kinds].join(",")}`);
  const kind = fact.selector ? "choice_snapshot" : type === "boolean" ? "flag" :
    fact.options ? "choice_static" : type === "number" ? "number" : "text";
  const ownerValue = fact.taste === true && type === "number";
  return {
    name, type, required: !optional, description: fact.question, source: "user",
    default: ownerValue ? "NEEDS_OWNER_VALUE" : optional && fact.default !== undefined ? fact.default : null,
    input: {
      kind, question: fact.question,
      ...(optional ? { presenceQuestion: `Did the user say anything about this: ${fact.question}` } : {}),
      ...(fact.selector ? { selector: fact.selector } : {}),
      ...(kind === "choice_static" ? { options: fact.options?.map((o) => ({ ...o })) } : {}),
      ...(fact.unit ? { unit: fact.unit } : {}),
      ...(fact.min !== undefined ? { min: fact.min } : {}),
      ...(fact.max !== undefined ? { max: fact.max } : {}),
      ...(fact.integer !== undefined ? { integer: fact.integer } : {}),
      defaultPolicy: ownerValue ? "owner" : optional ? "omit" : "required",
      ...(type === "number" ? { statistics: statistics(values) } : {}),
      nativeSource: fact.source,
      notes: [fact.notes, optional ? "Absence omits the argument; any documented native default is informational, never injected." : undefined].filter(Boolean).join(" "),
    },
  };
}
export function mineSkill(group: ShapeGroup, rows: readonly TrainingRow[], rank: number): Skill {
  const first = group.shape[0];
  const facts = COMMAND_FACTS[first];
  if (!facts) throw new MiningError(`No native facts for ${first}`);
  const slots: Slot[] = [];
  const bindings: Skill["mining"]["bindings"] = [];
  const shared = new Map<string, string>();
  const commands: Command[] = group.shape.map((command, stepIndex) => {
    const commandFacts = COMMAND_FACTS[command];
    if (!commandFacts) throw new MiningError(`No native facts for ${command}`);
    const argKeys = [...new Set(rows.flatMap((row) => Object.keys(row.commands[stepIndex].args)))].sort();
    const args: Command["args"] = {};
    for (const arg of argKeys) {
      const fact = commandFacts.args[arg];
      if (!fact) throw new MiningError(`Missing native argument evidence: ${command}.${arg}`);
      const column = rows.map((row) => row.commands[stepIndex].args[arg]);
      const values = column.filter((v) => v !== undefined && v !== null).map((v) => primitiveSchema.parse(v));
      if (!values.length) throw new MiningError(`No typed values observed for ${command}.${arg}`);
      const optional = column.some((v) => v === undefined);
      const distinct = new Set(values.map((v) => JSON.stringify(v)));
      if (!optional && !column.includes(null) && distinct.size === 1 && !fact.selector && !fact.taste) {
        args[arg] = values[0]; continue;
      }
      const signature = JSON.stringify([arg, column, fact.selector ?? null, fact.taste ?? false]);
      let name = shared.get(signature);
      if (!name) {
        name = `step${stepIndex + 1}_${arg}`;
        slots.push(slotDefinition(name, values, fact, optional)); shared.set(signature, name);
      }
      bindings.push({ slot: name, step: stepIndex + 1, arg });
      args[arg] = `{${name}}`;
    }
    return { command, args };
  });
  const examples = [...new Set(rows.map((row) => row.utterance))].slice(0, 10);
  const suffix = group.shape.length > 1 ? `-${group.shape.length}` : "";
  return skillSchema.parse({
    schemaVersion: 1, id: `sft-${String(rank).padStart(2, "0")}-${first.replace(/_/g, "-")}${suffix}`,
    name: `${first.replace(/_/g, "-")}${suffix}`,
    description: group.shape.length > 1 ? "Put an eight-note musical idea into an existing MIDI clip. Supply the pitches, rhythm, and strength of each note explicitly." : facts.description,
    examples, slots, template: { commands },
    preconditions: slots.filter((slot) => slot.input.selector).map((slot) => ({
      type: "snapshot_choice", slot: slot.name, selector: slot.input.selector,
    })),
    postconditions: commands.map((command, i) => ({ type: "command_effect", step: i + 1, command: command.command })),
    provenance: rows.map((row) => row.id), triggers: [],
    mining: { rank, shape: [...group.shape], rows: rows.length, bindings, undo: facts.undo },
  });
}
export function writeSkills(root: string, groups: readonly ShapeGroup[], rows: readonly TrainingRow[]): readonly Skill[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const skills = groups.map((group, index) => mineSkill(group, group.rows.map((id) => {
    const row = byId.get(id);
    if (!row) throw new MiningError(`Unknown provenance ${id}`);
    return row;
  }), index + 1));
  mkdirSync(join(root, "skills"), { recursive: true });
  for (const skill of skills) writeFileSync(join(root, "skills", `${skill.id}.json`), JSON.stringify(skill, null, 2) + "\n");
  return skills;
}
