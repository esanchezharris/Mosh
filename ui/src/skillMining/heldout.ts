import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hash, INPUT_HASHES, heldoutShapes, frozenSelection } from "./corpus";
import { MiningError, type ShapeRow, type Skill } from "./types";
import type { Inputs } from "./inventory";
import { acceptedSkills, readRowVerdicts, type SkillVerdict } from "./validation";

const freezeSchema = z.object({ files: z.record(z.string(), z.string()), sha256: z.string() });
function treeFiles(root: string, directory: string): readonly string[] {
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? treeFiles(root, file) : /\.(ts|tsx|json)$/.test(file) ? [file] : [];
  });
}
function frozenFiles(root: string): Readonly<Record<string, string>> {
  const files = [
    ...readdirSync(join(root, "skills")).filter((p) => p.endsWith(".json")).map((p) => `skills/${p}`),
    ...treeFiles(root, "ui/src"),
    ...readdirSync(join(root, "service/skills")).filter((p) => p.endsWith(".py")).map((p) => `service/skills/${p}`),
    ...readdirSync(join(root, "src/moshops")).filter((p) => /\.(cpp|h)$/.test(p)).map((p) => `src/moshops/${p}`),
    "ui/package.json", "ui/package-lock.json",
    "docs/skills/measurements.json", "docs/skills/validation.json", "docs/skills/row-validation.jsonl",
    "docs/skills/setup-recovery.json", "docs/skills/corpus-audit.json", "docs/skills/shapes.json",
  ].sort();
  return Object.fromEntries(files.map((file) => [file, hash(readFileSync(join(root, file)))]));
}
export function freezeLibrary(root: string): void {
  const file = join(root, "docs/skills/FREEZE.json");
  if (existsSync(file)) { verifyFreeze(root); return; }
  const files = frozenFiles(root);
  writeFileSync(file, JSON.stringify({ files, sha256: hash(JSON.stringify(files)) }, null, 2) + "\n");
}
export function verifyFreeze(root: string): string {
  const frozen = freezeSchema.parse(JSON.parse(readFileSync(join(root, "docs/skills/FREEZE.json"), "utf8")));
  const current = frozenFiles(root);
  if (hash(JSON.stringify(frozen.files)) !== frozen.sha256 || JSON.stringify(frozen.files) !== JSON.stringify(current))
    throw new MiningError("Frozen library/rules/evidence changed; held-out read refused");
  return frozen.sha256;
}
export function coverage(rows: readonly ShapeRow[], skills: readonly Skill[]) {
  const keys = new Map(skills.map((s) => [JSON.stringify(s.mining.shape), s.id]));
  const outcomes = rows.map((row) => {
    const one = keys.get(JSON.stringify(row.shape));
    if (one) return { id: row.id, skills: [one], shape: row.shape };
    for (let split = 1; split < row.shape.length; split++) {
      const first = keys.get(JSON.stringify(row.shape.slice(0, split)));
      const second = keys.get(JSON.stringify(row.shape.slice(split)));
      if (first && second) return { id: row.id, skills: [first, second], shape: row.shape };
    }
    return { id: row.id, skills: [], shape: row.shape };
  });
  const one = outcomes.filter((r) => r.skills.length === 1).length;
  const twoAdditional = outcomes.filter((r) => r.skills.length === 2).length;
  return { rows: rows.length, one, twoAdditional, atMostTwo: one + twoAdditional, outcomes };
}
export function readHeldout(inputs: Inputs, skills: readonly Skill[], verdicts: readonly SkillVerdict[]) {
  const before = verifyFreeze(inputs.root);
  const validated = acceptedSkills(skills, verdicts, readRowVerdicts(inputs.root));
  const evalA = heldoutShapes(inputs.evalA, INPUT_HASHES.evalA);
  const frozen300 = frozenSelection(heldoutShapes(inputs.frozen300, INPUT_HASHES.frozen300));
  const results = {
    interpretation: "Exact shape-coverage ceilings only. Held-out gold arguments are absent; behavioral expressibility and router accuracy are unverified.",
    freezeBefore: before,
    candidates: { evalA: coverage(evalA, skills), frozen300: coverage(frozen300, skills) },
    validated: { evalA: coverage(evalA, validated), frozen300: coverage(frozen300, validated) },
    freezeAfter: verifyFreeze(inputs.root),
  };
  writeFileSync(join(inputs.root, "docs/skills/heldout.json"), JSON.stringify(results, null, 2) + "\n");
  return results;
}
