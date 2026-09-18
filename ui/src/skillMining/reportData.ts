import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { jsonSchema, MiningError } from "./types";
import { loadSkills, summarizeSkill } from "./validation";
import { selectedGroups } from "./corpus";
import { verifyFreeze } from "./heldout";

const count = z.number().int().nonnegative();
const summarySchema = z.object({ rows: count, distinctShapes: count, thresholds: z.record(z.string(), count) });
const measurementSchema = z.object({
  baseSha: z.string(), inputHashes: z.record(z.string(), z.string()), training: summarySchema,
  evalA: summarySchema.extend({ shapeInTraining: count }), frozen300: summarySchema.extend({ shapeInTraining: count }),
  frozenSourceRows: count, frozenSelectionIdsSha256: z.string(), selected: z.object({ skills: count, rows: count }),
  emptyRows: count, huhWithCommands: z.array(z.string()),
});
const groupSchema = z.object({ shape: z.array(z.string()), rows: z.array(z.string()) });
const shapeSchema = z.object({ train: z.array(groupSchema), evalA: z.array(groupSchema), frozen300: z.array(groupSchema) });
const verdictSchema = z.object({
  id: z.string(), rows: count, renderedExactly: count, reproduced: count, failed: count, unverified: count,
  passRate: z.number().min(0).max(1), passes: z.boolean(),
});
const validationSchema = z.object({ skills: z.array(verdictSchema), totalRows: count });
const rowSchema = z.object({
  rowId: z.string(), skillId: z.string(), renderedExactly: z.boolean(),
  status: z.enum(["passed", "failed", "unverified"]), reasons: z.array(z.string()),
});
const coverageSchema = z.object({ rows: count, one: count, twoAdditional: count, atMostTwo: count })
  .refine(coverage => coverage.atMostTwo === coverage.one + coverage.twoAdditional && coverage.atMostTwo <= coverage.rows,
    "Held-out coverage must preserve its complete denominator and additive counts");
const datasetCoverageSchema = z.object({ evalA: coverageSchema, frozen300: coverageSchema });
const heldoutSchema = z.object({
  interpretation: z.string(), freezeBefore: z.string(), freezeAfter: z.string(),
  candidates: datasetCoverageSchema, validated: datasetCoverageSchema,
});

function readArtifact(root: string, file: string): unknown {
  return JSON.parse(readFileSync(join(root, "docs/skills", file), "utf8"));
}
function optionalArtifact(root: string, file: string) {
  return existsSync(join(root, "docs/skills", file)) ? jsonSchema.parse(readArtifact(root, file)) : undefined;
}
export function reportData(root: string) {
  const measurements = measurementSchema.parse(readArtifact(root, "measurements.json"));
  const shapes = shapeSchema.parse(readArtifact(root, "shapes.json"));
  const validation = validationSchema.parse(readArtifact(root, "validation.json"));
  const rows = readFileSync(join(root, "docs/skills/row-validation.jsonl"), "utf8").split(/\r?\n/)
    .filter(line => line.trim()).map(line => rowSchema.parse(JSON.parse(line)));
  const skills = [...loadSkills(root)].sort((a, b) => a.mining.rank - b.mining.rank);
  const selected = selectedGroups(shapes.train);
  const selectedRows = selected.reduce((sum, group) => sum + group.rows.length, 0);
  if (new Set(rows.map(row => row.rowId)).size !== rows.length || rows.length !== validation.totalRows)
    throw new MiningError("Report validation rows are duplicated or do not match their denominator");
  const trainingIds = shapes.train.flatMap(group => group.rows);
  if (trainingIds.length !== measurements.training.rows || new Set(trainingIds).size !== trainingIds.length)
    throw new MiningError("Report shape inventory does not match the training denominator");
  if (skills.length !== selected.length || skills.length !== measurements.selected.skills || validation.skills.length !== skills.length
    || selectedRows !== measurements.selected.rows || rows.length !== selectedRows)
    throw new MiningError("Report skill inventory does not match measured and validated skill counts");
  for (const [index, skill] of skills.entries()) {
    const group = selected[index];
    if (!group || skill.mining.rank !== index + 1 || skill.mining.rows !== group.rows.length
      || !isDeepStrictEqual(skill.mining.shape, group.shape) || !isDeepStrictEqual(skill.provenance, group.rows))
      throw new MiningError(`Report skill differs from its complete original ranked shape: ${skill.id}`);
    const matching = rows.filter(row => row.skillId === skill.id);
    if (!isDeepStrictEqual(matching.map(row => row.rowId), group.rows)
      || !isDeepStrictEqual(validation.skills[index], summarizeSkill(skill.id, matching)))
      throw new MiningError(`Report evidence is inconsistent for ${skill.id}`);
  }
  const heldoutFile = join(root, "docs/skills/heldout.json");
  const heldout = existsSync(heldoutFile) ? heldoutSchema.parse(readArtifact(root, "heldout.json")) : undefined;
  if (heldout) {
    const currentFreeze = verifyFreeze(root);
    if (heldout.freezeBefore !== heldout.freezeAfter || heldout.freezeBefore !== currentFreeze)
      throw new MiningError("Report held-out evidence does not match the current verified freeze");
    for (const dataset of ["evalA", "frozen300"] as const) {
      const candidate = heldout.candidates[dataset];
      const validated = heldout.validated[dataset];
      if (candidate.rows !== measurements[dataset].rows || validated.rows !== candidate.rows
        || validated.one > candidate.one || validated.atMostTwo > candidate.atMostTwo)
        throw new MiningError(`Report held-out counts are inconsistent for ${dataset}`);
    }
  }
  return {
    measurements, shapes, validation, rows, skills, heldout,
    setup: optionalArtifact(root, "setup-recovery.json"), gates: optionalArtifact(root, "gates.json"),
    audit: optionalArtifact(root, "corpus-audit.json"),
  };
}
export type ReportData = ReturnType<typeof reportData>;
export const percentage = (part: number, total: number): string => total ? (100 * part / total).toFixed(2) + "%" : "0.00%";
export const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
export const shapeName = (shape: readonly string[]): string => shape.length ? shape.join(" → ") : "∅ (no commands)";
