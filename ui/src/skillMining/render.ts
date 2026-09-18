import { array, MiningError, record, unreachable } from "./types";
import type { Command, Filled, Json, Skill, Slot } from "./types";

const own = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const same = (a: Json, b: Json): boolean => JSON.stringify(a) === JSON.stringify(b);
function containsOwnerValue(value: Json): boolean {
  if (typeof value === "string") return value.includes("NEEDS_OWNER_VALUE");
  return value !== null && typeof value === "object" && Object.values(value).some(containsOwnerValue);
}
function typed(slot: Slot, value: Json): boolean {
  switch (slot.type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "list<string>": return Array.isArray(value) && value.every(item => typeof item === "string");
    case "list<number>": return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item));
    case "list<note>": return Array.isArray(value) && value.every(item => {
      const note = record(item);
      return [note.pitch, note.start, note.length, note.velocity].every(field => typeof field === "number" && Number.isFinite(field));
    });
    case "list<param>": return Array.isArray(value) && value.every(item => {
      const param = record(item);
      return typeof param.index === "number" && typeof param.value === "number" && Number.isFinite(param.value);
    });
    default: return unreachable(slot.type);
  }
}
function validateFilled(skill: Skill, filled: Filled): void {
  const names = new Set(skill.slots.map(slot => slot.name));
  if (names.size !== skill.slots.length) throw new MiningError("Duplicate slot names");
  for (const name of Object.keys(filled)) if (!names.has(name)) throw new MiningError(`Unknown slot: ${name}`);
  for (const slot of skill.slots) {
    if (!own(filled, slot.name)) {
      if (slot.required) throw new MiningError(`Missing required slot: ${slot.name}`);
      continue;
    }
    const value = filled[slot.name];
    if (containsOwnerValue(value) || !typed(slot, value)) throw new MiningError(`Invalid ${slot.type} value for ${slot.name}`);
    if (slot.input.kind === "choice_static" && !slot.input.options?.some(option => same(option.value, value)))
      throw new MiningError(`Value outside closed choices for ${slot.name}`);
    if (typeof value === "number" && ((slot.input.min !== undefined && value < slot.input.min)
      || (slot.input.max !== undefined && value > slot.input.max) || (slot.input.integer && !Number.isInteger(value))))
      throw new MiningError(`Value outside numeric constraints for ${slot.name}`);
  }
}
export function fillGold(skill: Skill, commands: readonly Command[]): Filled {
  if (commands.length !== skill.template.commands.length || commands.some((command, index) => command.command !== skill.template.commands[index]?.command))
    throw new MiningError("Gold command shape does not match skill");
  const filled: Record<string, Json> = {};
  for (const binding of skill.mining.bindings) {
    if (!skill.slots.some(slot => slot.name === binding.slot)) throw new MiningError(`Unknown binding slot: ${binding.slot}`);
    const command = commands[binding.step - 1];
    if (!command) throw new MiningError(`Missing gold step: ${binding.step}`);
    if (!own(command.args, binding.arg)) continue;
    const value = command.args[binding.arg];
    if (own(filled, binding.slot) && !same(filled[binding.slot], value)) throw new MiningError(`Conflicting binding: ${binding.slot}`);
    filled[binding.slot] = value;
  }
  validateFilled(skill, filled);
  return filled;
}
type RenderContext = { readonly skill: Skill; readonly filled: Filled; readonly results: readonly Json[] };
function substitute(value: Json, context: RenderContext): Json | undefined {
  if (containsOwnerValue(value)) throw new MiningError("Unresolved owner value");
  if (Array.isArray(value)) return value.map(item => {
    const resolved = substitute(item, context);
    if (resolved === undefined) throw new MiningError("An omitted slot cannot be an array element");
    return resolved;
  });
  if (value !== null && typeof value === "object") {
    const output: Record<string, Json> = {};
    for (const [key, item] of Object.entries(value)) {
      const resolved = substitute(item, context);
      if (resolved !== undefined) output[key] = resolved;
    }
    return output;
  }
  if (typeof value !== "string") return value;
  const resultRef = /^\{step([1-9]\d*)\.result\.([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\}$/.exec(value);
  if (resultRef) {
    const result = record(context.results[Number(resultRef[1]) - 1]);
    if (result.ok !== true) throw new MiningError(`Missing or unsuccessful previous result: ${value}`);
    let resolved: Json | undefined = result.data;
    for (const part of resultRef[2].split(".")) {
      const object = record(resolved);
      resolved = own(object, part) ? object[part] : undefined;
    }
    if (resolved === undefined || containsOwnerValue(resolved)) throw new MiningError(`Unresolved result reference: ${value}`);
    return resolved;
  }
  const slotRef = /^\{([A-Za-z_]\w*)\}$/.exec(value);
  if (slotRef) {
    const slot = context.skill.slots.find(item => item.name === slotRef[1]);
    if (!slot) throw new MiningError(`Unknown slot reference: ${value}`);
    return own(context.filled, slot.name) ? context.filled[slot.name] : undefined;
  }
  if (/[{}]/.test(value)) throw new MiningError(`Unresolved or embedded template reference: ${value}`);
  return value;
}
export function renderStep(command: Command, context: RenderContext): Command {
  validateFilled(context.skill, context.filled);
  if (/[{}]|NEEDS_OWNER_VALUE/.test(command.command)) throw new MiningError("Unresolved command name");
  return { command: command.command, args: record(substitute(command.args, context)) };
}
export function render(skill: Skill, filled: Filled): readonly Command[] {
  validateFilled(skill, filled);
  return skill.template.commands.map(command => renderStep(command, { skill, filled, results: [] }));
}
function scope(filled: Filled, name: string): Json | undefined {
  if (own(filled, name)) return filled[name];
  const values = Object.entries(filled).filter(([key]) => key.endsWith(`_${name}`)).map(([, value]) => value);
  const unique = values.filter((value, index) => values.findIndex(other => same(value, other)) === index);
  if (unique.length > 1) throw new MiningError(`Ambiguous ${name} scope`);
  return unique[0];
}
export function selectOptions(selector: string, snapshot: Json, filled: Filled = {}): readonly Json[] {
  const root = record(snapshot);
  if (selector === "list_drum_kits:data.kits[].id") {
    const catalogue = record(root.list_drum_kits);
    if (catalogue.ok !== true || !Array.isArray(record(catalogue.data).kits)) throw new MiningError("Explicit list_drum_kits result catalogue required");
    return array(record(catalogue.data).kits).flatMap(item => own(record(item), "id") ? [record(item).id] : []);
  }
  if (selector === "sections[].id") return array(root.sections).flatMap(item => own(record(item), "id") ? [record(item).id] : []);
  const trackId = selector === "tracks[].id" ? undefined : scope(filled, "trackId");
  const tracks = array(root.tracks).map(record).filter(track => trackId === undefined || track.id === trackId);
  if (selector === "tracks[].id") return tracks.flatMap(track => own(track, "id") ? [track.id] : []);
  if (selector === "tracks[].plugins[].index") return tracks.flatMap(track => array(track.plugins).map(record).flatMap(plugin => own(plugin, "index") ? [plugin.index] : []));
  const clipId = selector === "tracks[].clips[].id" ? undefined : scope(filled, "clipId");
  const clips = tracks.flatMap(track => array(track.clips).map(record)).filter(clip => clipId === undefined || clip.id === clipId);
  if (selector === "tracks[].clips[].id") return clips.flatMap(clip => own(clip, "id") ? [clip.id] : []);
  if (selector === "tracks[].clips[].notes[].i") return clips.flatMap(clip => array(clip.notes).map(record).flatMap(note => own(note, "i") ? [note.i] : []));
  throw new MiningError(`Unsupported snapshot selector: ${selector}`);
}
export function checkPreconditions(skill: Skill, snapshot: Json, filled: Filled): readonly string[] {
  const failures: string[] = [];
  try { validateFilled(skill, filled); } catch (error) {
    if (!(error instanceof MiningError)) throw error;
    return [error.message];
  }
  for (const predicate of skill.preconditions) {
    switch (predicate.type) {
      case "command_effect": failures.push("command_effect cannot be evaluated as a precondition"); break;
      case "snapshot_choice": {
        if (!skill.slots.some(slot => slot.name === predicate.slot)) { failures.push(`Unknown precondition slot: ${predicate.slot}`); break; }
        if (!own(filled, predicate.slot)) continue;
        const prefix = /^(step\d+_)/.exec(predicate.slot)?.[1];
        const scoped: Record<string, Json> = {};
        for (const [key, value] of Object.entries(filled)) {
          if (!/^step\d+_/.test(key)) scoped[key] = value;
          else if (prefix && key.startsWith(prefix)) scoped[key.slice(prefix.length)] = value;
        }
        try {
          if (!selectOptions(predicate.selector, snapshot, scoped).some(option => same(option, filled[predicate.slot])))
            failures.push(`Slot ${predicate.slot} is not present in ${predicate.selector}`);
        } catch (error) {
          if (!(error instanceof MiningError)) throw error;
          failures.push(error.message);
        }
        break;
      }
      default: unreachable(predicate);
    }
  }
  return failures;
}
