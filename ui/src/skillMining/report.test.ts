import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { jsonSchema, MiningError, record } from "./types";
import { reportData } from "./reportData";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temporary: string[] = [];
function evidenceCopy(): string {
  const target = mkdtempSync(join(tmpdir(), "mosh-report-integrity-"));
  temporary.push(target);
  mkdirSync(join(target, "docs/skills"), { recursive: true });
  for (const file of ["measurements.json", "shapes.json", "validation.json", "row-validation.jsonl"])
    cpSync(join(root, "docs/skills", file), join(target, "docs/skills", file));
  symlinkSync(join(root, "skills"), join(target, "skills"), "dir");
  return target;
}
function artifact(target: string, name: string) {
  return record(jsonSchema.parse(JSON.parse(readFileSync(join(target, "docs/skills", name), "utf8"))));
}
afterEach(() => { for (const target of temporary.splice(0)) rmSync(target, { recursive: true, force: true }); });

describe("report evidence integrity", () => {
  it("loads the complete original denominator when held-out evidence is absent", () => {
    const target = evidenceCopy();
    const data = reportData(target);
    expect(data.rows.length).toBe(data.measurements.selected.rows);
    expect(data.heldout).toBeUndefined();
  });

  it.each(["passes", "passRate"] as const)("rejects a tampered %s despite unchanged row counts", field => {
    const target = evidenceCopy();
    const validation = artifact(target, "validation.json");
    if (!Array.isArray(validation.skills)) throw new MiningError("Fixture verdicts missing");
    const first = record(validation.skills[0]);
    first[field] = field === "passes" ? true : 0.99;
    writeFileSync(join(target, "docs/skills/validation.json"), JSON.stringify(validation));
    expect(() => reportData(target)).toThrow(MiningError);
  });

  it("rejects a shortened measured selected denominator", () => {
    const target = evidenceCopy();
    const measurements = artifact(target, "measurements.json");
    const selected = record(measurements.selected);
    if (typeof selected.rows !== "number") throw new MiningError("Fixture denominator missing");
    selected.rows -= 1;
    writeFileSync(join(target, "docs/skills/measurements.json"), JSON.stringify(measurements));
    expect(() => reportData(target)).toThrow(MiningError);
  });

  it("rejects replaced provenance row IDs despite unchanged skill statistics", () => {
    const target = evidenceCopy();
    const file = join(target, "docs/skills/row-validation.jsonl");
    const rows = readFileSync(file, "utf8").trim().split("\n").map(line => record(jsonSchema.parse(JSON.parse(line))));
    const first = rows[0];
    if (!first) throw new MiningError("Fixture rows missing");
    first.rowId = "sha256:foreign#L1";
    writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
    expect(() => reportData(target)).toThrow(MiningError);
  });
});
