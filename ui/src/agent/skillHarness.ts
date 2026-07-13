import type { Snapshot } from "../types";
import { validateCommand } from "./commands";
import type { AgentCommandCall, ChangeSet } from "./executor";
import { checkSkillChangeSet } from "./skillHarnessResult";
import {
  validateSkillSlots,
  type SkillCheck,
  type SkillDefinition,
  type SkillPrimitive,
  type SkillSlotValues,
  type SkillTemplateNode,
  type SkillValue,
} from "./skills";

export type SkillHarnessDeps = {
  readonly snapshot: () => Promise<Snapshot>;
  readonly runBatch: (label: string, calls: readonly AgentCommandCall[]) => Promise<ChangeSet>;
  readonly rollbackBatch: () => Promise<boolean>;
};

export type SkillFailureStage =
  | "validation"
  | "precondition"
  | "template"
  | "execution"
  | "postcondition";

export type SkillRunResult =
  | {
      readonly ok: true;
      readonly skill: string;
      readonly slots: SkillSlotValues;
      readonly calls: readonly AgentCommandCall[];
      readonly changes: ChangeSet;
    }
  | {
      readonly ok: false;
      readonly skill: string;
      readonly stage: SkillFailureStage;
      readonly reason: string;
      readonly rolledBack: boolean;
    };

const owns = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function resolveValue(value: SkillValue, slots: SkillSlotValues): SkillPrimitive {
  if (typeof value !== "object") return value;
  if (!owns(slots, value.slot)) throw new Error(`template references unfilled slot "${value.slot}"`);
  return slots[value.slot];
}

/** Expand the bounded declarative template without executing it. */
export function expandSkillTemplate(
  template: readonly SkillTemplateNode[],
  slots: SkillSlotValues,
): AgentCommandCall[] {
  const calls: AgentCommandCall[] = [];
  const walk = (nodes: readonly SkillTemplateNode[]) => {
    for (const node of nodes) {
      if (node.kind === "if_present") {
        if (owns(slots, node.slot)) walk(node.then);
        continue;
      }

      const args: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(node.args)) args[name] = resolveValue(value, slots);
      calls.push({ command: node.command, args });
    }
  };
  walk(template);
  return calls;
}

async function failedAfterMutation(
  skill: string,
  stage: "execution" | "postcondition",
  reason: string,
  applied: number,
  deps: SkillHarnessDeps,
): Promise<SkillRunResult> {
  if (applied <= 0) return { ok: false, skill, stage, reason, rolledBack: false };
  try {
    const rolledBack = await deps.rollbackBatch();
    return {
      ok: false,
      skill,
      stage,
      reason: rolledBack ? reason : `${reason} Rollback was not confirmed.`,
      rolledBack,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      skill,
      stage,
      reason: `${reason} Rollback failed: ${detail}`,
      rolledBack: false,
    };
  }
}

/** Validate, execute through the existing MoshOps batch seam, and assert the skill contract. */
export async function runSkill(
  skill: SkillDefinition,
  rawSlots: unknown,
  deps: SkillHarnessDeps,
): Promise<SkillRunResult> {
  const validated = validateSkillSlots(skill, rawSlots);
  if (!validated.ok)
    return { ok: false, skill: skill.name, stage: "validation", reason: validated.reason, rolledBack: false };

  let before: Snapshot;
  try {
    before = await deps.snapshot();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      skill: skill.name,
      stage: "precondition",
      reason: `Could not read session state: ${detail}`,
      rolledBack: false,
    };
  }

  let precondition: SkillCheck;
  try {
    precondition = skill.precondition(before, validated.slots);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      skill: skill.name,
      stage: "precondition",
      reason: `Precondition failed: ${detail}`,
      rolledBack: false,
    };
  }
  if (!precondition.ok)
    return {
      ok: false,
      skill: skill.name,
      stage: "precondition",
      reason: precondition.reason,
      rolledBack: false,
    };

  let calls: AgentCommandCall[];
  try {
    calls = expandSkillTemplate(skill.template, validated.slots);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, skill: skill.name, stage: "template", reason: detail, rolledBack: false };
  }
  if (calls.length === 0)
    return {
      ok: false,
      skill: skill.name,
      stage: "template",
      reason: `${skill.name}: template produced no commands`,
      rolledBack: false,
    };

  for (const call of calls) {
    const error = validateCommand(call.command, call.args ?? {});
    if (error)
      return { ok: false, skill: skill.name, stage: "template", reason: error, rolledBack: false };
  }

  let changes: ChangeSet;
  try {
    changes = await deps.runBatch(skill.name, calls);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      skill: skill.name,
      stage: "execution",
      reason: `Execution transport failed: ${detail}. Mutation state is unknown; automatic rollback was not attempted.`,
      rolledBack: false,
    };
  }

  const checkedChanges = checkSkillChangeSet(skill.name, calls, changes);
  if (!checkedChanges.ok)
    return failedAfterMutation(
      skill.name,
      "execution",
      checkedChanges.reason,
      checkedChanges.reportedApplied,
      deps,
    );

  let after: Snapshot;
  try {
    after = await deps.snapshot();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failedAfterMutation(
      skill.name,
      "postcondition",
      `Could not read the resulting session state: ${detail}`,
      changes.applied,
      deps,
    );
  }

  let postcondition: SkillCheck;
  try {
    postcondition = skill.postcondition(before, after, validated.slots, changes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return failedAfterMutation(
      skill.name,
      "postcondition",
      `Postcondition failed: ${detail}`,
      changes.applied,
      deps,
    );
  }
  if (!postcondition.ok)
    return failedAfterMutation(
      skill.name,
      "postcondition",
      postcondition.reason,
      changes.applied,
      deps,
    );

  return {
    ok: true,
    skill: skill.name,
    slots: validated.slots,
    calls,
    changes,
  };
}
