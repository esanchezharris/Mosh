import { COMMAND_FACTS } from "./nativeFacts";
import type { Skill } from "./types";

export function checkNativeSkill(skill: Skill): readonly string[] {
  const errors: string[] = [];
  const mismatch = (path: string, actual: unknown, expected: unknown): void => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) errors.push(`${path}: differs from native-source facts`);
  };
  for (const command of skill.template.commands) for (const [arg, value] of Object.entries(command.args)) {
    const fact = COMMAND_FACTS[command.command]?.args[arg];
    const path = `${command.command}.${arg}`;
    if (!fact) { errors.push(`${path}: no offline native argument facts`); continue; }
    const reference = typeof value === "string" ? /^\{([A-Za-z_]\w*)\}$/.exec(value)?.[1] : undefined;
    if (!reference) {
      if (fact.selector || fact.taste) errors.push(`${path}: snapshot identity or judgment cannot be baked into a template`);
      if (fact.options && !fact.options.some(option => option.value === value)) errors.push(`${path}: constant outside native choices`);
      if (typeof value === "number" && ((fact.min !== undefined && value < fact.min) || (fact.max !== undefined && value > fact.max)
        || (fact.integer && !Number.isInteger(value)))) errors.push(`${path}: constant outside native numeric constraints`);
      continue;
    }
    const slot = skill.slots.find(item => item.name === reference);
    if (!slot) { errors.push(`${path}: unknown slot ${reference}`); continue; }
    for (const field of ["selector", "min", "max", "integer", "unit"] as const) mismatch(`${path}.${field}`, slot.input[field], fact[field]);
    mismatch(`${path}.source`, slot.input.nativeSource, fact.source);
    const kind = fact.selector ? "choice_snapshot" : slot.type === "boolean" ? "flag" : fact.options ? "choice_static" : slot.type === "number" ? "number" : "text";
    mismatch(`${path}.kind`, slot.input.kind, kind);
    mismatch(`${path}.options`, slot.input.options, kind === "choice_static" ? fact.options : undefined);
    if (fact.unit) mismatch(`${path}.type`, slot.type, "number");
    const owner = fact.taste === true && slot.type === "number";
    mismatch(`${path}.defaultPolicy`, slot.input.defaultPolicy, owner ? "owner" : slot.required ? "required" : "omit");
    mismatch(`${path}.default`, slot.default, owner ? "NEEDS_OWNER_VALUE" : !slot.required && fact.default !== undefined ? fact.default : null);
  }
  return errors;
}
