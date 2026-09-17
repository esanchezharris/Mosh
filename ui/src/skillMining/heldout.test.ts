import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { coverage, freezeLibrary, verifyFreeze } from "./heldout";
import { loadSkills } from "./validation";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sample = loadSkills(root)[0];
describe("frozen shape-coverage ceiling", () => {
  it("counts one row once and requires exactly two contiguous nonempty shapes", () => {
    const skill = (id: string, shape: string[]) => ({ ...sample, id, mining: { ...sample.mining, shape } });
    const library = [skill("ab", ["a", "b"]), skill("a", ["a"]), skill("c", ["c"]), skill("cc", ["c", "c"])];
    const result = coverage([
      { id: "one", shape: ["a", "b"] }, { id: "two", shape: ["a", "b", "c"] },
      { id: "repeat", shape: ["c", "c"] }, { id: "reverse", shape: ["b", "a"] },
      { id: "three", shape: ["a", "c", "a"] }, { id: "empty", shape: [] },
    ], library);
    expect(result.one).toBe(2);
    expect(result.twoAdditional).toBe(1);
    expect(result.atMostTwo).toBe(3);
    expect(result.outcomes.find(row => row.id === "two")?.skills).toEqual(["ab", "c"]);
    expect(coverage([{ id: "a", shape: ["a"] }], []).atMostTwo).toBe(0);
  });
  it("hashes metadata and validation rules and refuses modifications or additions", () => {
    const temp = mkdtempSync(join(tmpdir(), "mosh-skills-freeze-"));
    try {
      for (const folder of ["skills", "ui/src/skillMining", "service/skills", "src/moshops", "docs/skills", "ui/src/gepa", "ui/src/agent"])
        mkdirSync(join(temp, folder), { recursive: true });
      const files = ["skills/one.json", "ui/src/skillMining/rules.ts", "service/skills/schema.py", "src/moshops/MoshOps.cpp",
        "ui/src/gepa/metric.ts", "ui/src/bridge.mock.ts", "ui/src/agent/commands.ts", "ui/src/types.ts", "ui/package.json", "ui/package-lock.json",
        "docs/skills/measurements.json", "docs/skills/validation.json", "docs/skills/row-validation.jsonl",
        "docs/skills/setup-recovery.json", "docs/skills/corpus-audit.json", "docs/skills/shapes.json"];
      for (const file of files) writeFileSync(join(temp, file), "original\n");
      freezeLibrary(temp);
      const frozen = readFileSync(join(temp, "docs/skills/FREEZE.json"), "utf8");
      expect(verifyFreeze(temp)).toHaveLength(64);
      freezeLibrary(temp);
      expect(readFileSync(join(temp, "docs/skills/FREEZE.json"), "utf8")).toBe(frozen);
      writeFileSync(join(temp, "ui/src/skillMining/rules.ts"), "changed");
      expect(() => verifyFreeze(temp)).toThrow("changed");
      writeFileSync(join(temp, "ui/src/skillMining/rules.ts"), "original\n");
      writeFileSync(join(temp, "ui/src/agent/commands.ts"), "changed mock dependency");
      expect(() => verifyFreeze(temp)).toThrow("changed");
      writeFileSync(join(temp, "ui/src/agent/commands.ts"), "original\n");
      writeFileSync(join(temp, "skills/extra.json"), "extra");
      expect(() => verifyFreeze(temp)).toThrow("changed");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
