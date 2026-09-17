import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { skillSchema, MiningError, type Skill, type TrainingRow } from "./types";
import { readNativeContract, checkNativeCommand } from "./nativeContract";
import { fillGold, render } from "./render";
import { exactCommands } from "./comparison";
import type { ReplaySetup } from "./replay";
import { checkNativeSkill } from "./nativeSkill";

export type RowVerdict = {
  readonly rowId: string; readonly skillId: string; readonly renderedExactly: boolean;
  readonly status: "passed" | "failed" | "unverified"; readonly reasons: readonly string[];
};
export type SkillVerdict = {
  readonly id: string; readonly rows: number; readonly renderedExactly: number;
  readonly reproduced: number; readonly failed: number; readonly unverified: number;
  readonly passRate: number; readonly passes: boolean;
};
const rowVerdictSchema = z.object({ rowId: z.string(), skillId: z.string(), renderedExactly: z.boolean(),
  status: z.enum(["passed", "failed", "unverified"]), reasons: z.array(z.string()) });
export function readRowVerdicts(root: string): readonly RowVerdict[] {
  return readFileSync(join(root, "docs/skills/row-validation.jsonl"), "utf8").split("\n").filter(line => line.trim())
    .map(line => rowVerdictSchema.parse(JSON.parse(line)));
}
export function acceptedSkills(skills: readonly Skill[], verdicts: readonly SkillVerdict[], rows: readonly RowVerdict[]): readonly Skill[] {
  if (new Set(rows.map(row => row.rowId)).size !== rows.length || verdicts.length !== skills.length
    || new Set(verdicts.map(verdict => verdict.id)).size !== skills.length)
    throw new MiningError("Duplicate or inconsistent validation evidence");
  for (const skill of skills) {
    const matched = rows.filter(row => row.skillId === skill.id);
    const verdict = verdicts.find(item => item.id === skill.id);
    const computed = summarizeSkill(skill.id, matched);
    if (!verdict || Object.entries(computed).some(([key, value]) => Object.entries(verdict).find(([field]) => field === key)?.[1] !== value)
      || matched.length !== skill.mining.rows || JSON.stringify(matched.map(row => row.rowId)) !== JSON.stringify(skill.provenance))
      throw new MiningError(`Validation ledger disagrees with skill denominator/verdict: ${skill.id}`);
  }
  if (rows.length !== skills.reduce((sum, skill) => sum + skill.mining.rows, 0)) throw new MiningError("Unexpected rows outside the skill inventory");
  return skills.filter(skill => verdicts.some(verdict => verdict.id === skill.id && verdict.passes));
}
export function summarizeSkill(id: string, rows: readonly RowVerdict[]): SkillVerdict {
  const reproduced = rows.filter((r) => r.status === "passed").length;
  return { id, rows: rows.length, renderedExactly: rows.filter((r) => r.renderedExactly).length,
    reproduced, failed: rows.filter((r) => r.status === "failed").length,
    unverified: rows.filter((r) => r.status === "unverified").length,
    passRate: rows.length ? reproduced / rows.length : 0, passes: rows.length > 0 && reproduced * 100 >= rows.length * 95 };
}
export function loadSkills(root: string): readonly Skill[] {
  return readdirSync(join(root, "skills")).filter((file) => file.endsWith(".json")).sort()
    .map((file) => skillSchema.parse(JSON.parse(readFileSync(join(root, "skills", file), "utf8"))));
}
export async function validateLibrary(context: {
  readonly root: string; readonly skills: readonly Skill[]; readonly rows: readonly TrainingRow[];
  readonly setups: ReadonlyMap<string, ReplaySetup>;
}) {
  const native = readNativeContract(context.root);
  const byId = new Map(context.rows.map((row) => [row.id, row]));
  const results: RowVerdict[] = [];
  for (const skill of context.skills) {
    const group = context.rows.filter(row => JSON.stringify(row.commands.map(command => command.command)) === JSON.stringify(skill.mining.shape));
    const groupIds = group.map(row => row.id);
    const integrity = [...checkNativeSkill(skill)];
    const parsed = skillSchema.safeParse(skill);
    if (!parsed.success) integrity.push(`Invalid skill schema: ${parsed.error.message}`);
    if (JSON.stringify(groupIds) !== JSON.stringify(skill.provenance) || skill.mining.rows !== group.length)
      integrity.push("Provenance/count differs from the complete original shape group; full group denominator retained");
    for (const rowId of groupIds) {
      const row = byId.get(rowId);
      const reasons: string[] = [...integrity];
      let renderedExactly = false;
      if (!row) reasons.push("Provenance row is missing");
      else {
        reasons.push(...row.commands.flatMap((command) => checkNativeCommand(command, native)));
        try {
          const commands = render(skill, fillGold(skill, row.commands));
          reasons.push(...commands.flatMap((command) => checkNativeCommand(command, native)));
          renderedExactly = exactCommands(commands, row.commands);
          if (!renderedExactly) reasons.push("Ordered command names/argument presence/types/values differ from gold");
        } catch (error) {
          if (error instanceof Error) reasons.push(error.message);
          else throw error;
        }
        if (row.intent === "HUH" && row.commands.length) reasons.push("Corpus HUH intent contains executable commands");
      }
      let status: RowVerdict["status"] = "failed";
      if (!reasons.length && row) {
        const setup = context.setups.get(row.id);
        if (!setup) {
          status = "unverified";
          reasons.push("Original per-row setup/snapshot/history unavailable; shortened text prompt is insufficient evidence");
        } else {
          const { replaySkill } = await import("./replay");
          const replay = await replaySkill(skill, row.commands, setup);
          status = replay.status; reasons.push(...replay.reasons);
        }
      }
      results.push({ rowId, skillId: skill.id, renderedExactly, status, reasons });
    }
  }
  const skills = context.skills.map((skill) => summarizeSkill(skill.id, results.filter((r) => r.skillId === skill.id)));
  writeFileSync(join(context.root, "docs/skills/row-validation.jsonl"), results.map((row) => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(context.root, "docs/skills/validation.json"), JSON.stringify({ skills, totalRows: results.length }, null, 2) + "\n");
  return { skills, results };
}
