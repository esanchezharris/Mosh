import { z } from "zod";

export const primitiveSchema = z.union([z.string(), z.number().finite(), z.boolean()]);
export const jsonSchema = z.json();
export type Json = z.infer<typeof jsonSchema>;
export type Primitive = z.infer<typeof primitiveSchema>;
export const commandSchema = z.object({
  command: z.string(), args: z.record(z.string(), jsonSchema),
});
export type Command = z.infer<typeof commandSchema>;
export const sourceSchema = z.object({ file: z.string(), line: z.number().int().positive() });
const selectors = new Set<string>([
  "tracks[].id", "tracks[].clips[].id", "sections[].id", "tracks[].plugins[].index",
  "tracks[].clips[].notes[].i", "list_drum_kits:data.kits[].id",
]);
const selectorSchema = z.string().refine(value => selectors.has(value), "Unknown native snapshot selector");
export const slotSchema = z.object({
  name: z.string(), type: z.enum(["string", "number", "boolean", "list<note>", "list<string>", "list<number>", "list<param>"]),
  required: z.boolean(), description: z.string(), source: z.literal("user"),
  default: primitiveSchema.nullable(),
  input: z.object({
    kind: z.enum(["choice_static", "choice_snapshot", "set", "flag", "number", "text"]),
    question: z.string(), presenceQuestion: z.string().optional(),
    selector: selectorSchema.optional(),
    options: z.array(z.object({ value: primitiveSchema, description: z.string() })).optional(),
    unit: z.string().optional(), min: z.number().optional(), max: z.number().optional(),
    integer: z.boolean().optional(),
    defaultPolicy: z.enum(["owner", "omit", "native", "required"]),
    statistics: z.object({ min: z.number(), median: z.number(), max: z.number() }).optional(),
    nativeSource: sourceSchema, notes: z.string().optional(),
  }),
});
export type Slot = z.infer<typeof slotSchema>;
export const predicateSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot_choice"), slot: z.string(), selector: selectorSchema }).strict(),
  z.object({ type: z.literal("command_effect"), step: z.number().int().positive(), command: z.string() }).strict(),
]);
export const skillSchema = z.object({
  schemaVersion: z.literal(1), id: z.string(), name: z.string(), description: z.string(),
  examples: z.array(z.string()).min(5).max(10),
  slots: z.array(slotSchema), template: z.object({ commands: z.array(commandSchema).min(1) }),
  preconditions: z.array(predicateSchema), postconditions: z.array(predicateSchema).min(1),
  provenance: z.array(z.string()).min(1), triggers: z.array(z.string()),
  mining: z.object({
    rank: z.number().int().positive(), shape: z.array(z.string()).min(1), rows: z.number().int().positive(),
    bindings: z.array(z.object({ slot: z.string(), step: z.number().int().positive(), arg: z.string() })),
    undo: z.enum(["per_mutation", "none", "history"]),
  }),
}).superRefine((skill, context) => {
  const issue = (path: (string | number)[], message: string): void => context.addIssue({ code: "custom", path, message });
  const slots = new Map(skill.slots.map(slot => [slot.name, slot]));
  if (slots.size !== skill.slots.length) issue(["slots"], "Duplicate slot names");
  for (const [index, slot] of skill.slots.entries()) {
    if (slot.input.kind === "choice_snapshot" && !slot.input.selector) issue(["slots", index, "input", "selector"], "Snapshot choice requires its native selector");
    if (slot.input.kind !== "choice_snapshot" && slot.input.selector) issue(["slots", index, "input", "selector"], "Only snapshot choices may declare a selector");
  }
  const coveredSlots = new Set<string>();
  for (const [index, predicate] of skill.preconditions.entries()) {
    const path = ["preconditions", index];
    if (predicate.type !== "snapshot_choice") { issue(path, "Preconditions must be snapshot_choice predicates"); continue; }
    const slot = slots.get(predicate.slot);
    if (!slot || slot.input.kind !== "choice_snapshot" || predicate.selector !== slot.input.selector)
      issue(path, "Snapshot predicate must name a declared snapshot slot with its exact selector");
    if (coveredSlots.has(predicate.slot)) issue(path, "Duplicate snapshot precondition");
    coveredSlots.add(predicate.slot);
  }
  for (const slot of skill.slots) if (slot.input.kind === "choice_snapshot" && !coveredSlots.has(slot.name))
    issue(["preconditions"], `Missing snapshot precondition for ${slot.name}`);
  const coveredSteps = new Set<number>();
  for (const [index, predicate] of skill.postconditions.entries()) {
    const path = ["postconditions", index];
    if (predicate.type !== "command_effect") { issue(path, "Postconditions must be command_effect predicates"); continue; }
    if (skill.template.commands[predicate.step - 1]?.command !== predicate.command)
      issue(path, "Postcondition must name its exact in-range template command");
    if (coveredSteps.has(predicate.step)) issue(path, "Duplicate command postcondition");
    coveredSteps.add(predicate.step);
  }
  for (let step = 1; step <= skill.template.commands.length; step++) if (!coveredSteps.has(step))
    issue(["postconditions"], `Missing command postcondition for step ${step}`);
  for (const [index, binding] of skill.mining.bindings.entries()) {
    if (!slots.has(binding.slot)) issue(["mining", "bindings", index], "Unknown binding slot");
    if (!skill.template.commands[binding.step - 1]) issue(["mining", "bindings", index], "Binding step is out of range");
  }
  const inspect = (value: Json, step: number): void => {
    if (typeof value === "string") {
      const ref = /^\{([A-Za-z_]\w*)\}$/.exec(value);
      if (ref && !slots.has(ref[1])) issue(["template", "commands", step - 1], `Unknown template slot ${ref[1]}`);
      const result = /^\{step([1-9]\d*)\.result\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}$/.exec(value);
      if (result && Number(result[1]) >= step) issue(["template", "commands", step - 1], "Result reference must name an earlier step");
    } else if (value !== null && typeof value === "object") {
      for (const child of Object.values(value)) inspect(child, step);
    }
  };
  skill.template.commands.forEach((command, index) => inspect(command.args, index + 1));
});
export type Skill = z.infer<typeof skillSchema>;
export type Filled = Readonly<Record<string, Json>>;
export type TrainingRow = {
  readonly id: string; readonly line: number; readonly utterance: string;
  readonly system: string; readonly intent: string; readonly commands: readonly Command[];
};
export type ShapeRow = { readonly id: string; readonly shape: readonly string[] };
export type ShapeGroup = {
  readonly shape: readonly string[]; readonly rows: readonly string[];
};
export class MiningError extends Error {
  constructor(message: string) { super(message); this.name = "MiningError"; }
}
export function unreachable(value: never): never { throw new MiningError(`Unexpected variant: ${String(value)}`); }
export function record(value: Json | undefined): Record<string, Json> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function array(value: Json | undefined): Json[] { return Array.isArray(value) ? value : []; }
