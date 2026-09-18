import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { acceptedSkills, loadSkills, summarizeSkill, validateLibrary, type RowVerdict } from "./validation";
import { replaySkill } from "./replay";
import { exactCommands } from "./comparison";
import { fillGold, render } from "./render";
import { mineSkill } from "./mine";
import type { TrainingRow } from "./types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const skill = loadSkills(root).find((s) => s.mining.shape.join() === "set_tempo");
if (!skill) throw new Error("Tempo skill required for validation tests");
describe("strict reproduction evidence", () => {
  it("keeps missing evidence in the 95% denominator", () => {
    const row = (status: RowVerdict["status"]): RowVerdict => ({ rowId: "x", skillId: "s", renderedExactly: true, status, reasons: [] });
    const passing = Array.from({ length: 95 }, () => row("passed"));
    expect(summarizeSkill("s", [...passing, ...Array.from({ length: 5 }, () => row("unverified"))]).passes).toBe(true);
    expect(summarizeSkill("s", [...passing, ...Array.from({ length: 6 }, () => row("unverified"))]).passes).toBe(false);
    expect(summarizeSkill("s", [row("unverified")]).passRate).toBe(0);
    expect(summarizeSkill("s", []).passes).toBe(false);
  });
  it("compares ordered command arguments exactly, distinguishing omissions, null, types, and repetitions", () => {
    const gold = [{ command: "x", args: { a: 1, b: true } }];
    expect(exactCommands(gold, [{ command: "x", args: { b: true, a: 1 } }])).toBe(true);
    expect(exactCommands(gold, [{ command: "x", args: { a: "1", b: true } }])).toBe(false);
    expect(exactCommands([{ command: "x", args: {} }], [{ command: "x", args: { a: null } }])).toBe(false);
    expect(exactCommands(gold, [...gold, ...gold])).toBe(false);
  });
  it("runs the real r4 mock substrate on an explicitly synthetic unit fixture", async () => {
    const gold = [{ command: "set_tempo", args: { bpm: 93 } }];
    expect(await replaySkill(skill, gold, { startCommands: [], originalIdBindings: {} })).toEqual({ status: "passed", reasons: [] });
    const wrong = { ...skill, template: { commands: [{ command: "set_tempo", args: { bpm: 94 } }] } };
    expect((await replaySkill(wrong, gold, { startCommands: [], originalIdBindings: {} })).status).toBe("failed");
  });
  it("records a renderable row without original setup as unverified", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mosh-skills-validation-"));
    try {
      mkdirSync(join(temp, "docs/skills"), { recursive: true });
      const row: TrainingRow = { id: "synthetic-unit", line: 1, system: "short summary", utterance: "Set tempo to 93", intent: "ACK_GOT_IT", commands: [{ command: "set_tempo", args: { bpm: 93 } }] };
      const sample = { ...skill, provenance: [row.id], mining: { ...skill.mining, rows: 1 } };
      const { symlinkSync } = await import("node:fs");
      symlinkSync(join(root, "src"), join(temp, "src"));
      const result = await validateLibrary({ root: temp, skills: [sample], rows: [row], setups: new Map() });
      expect(result.results[0].renderedExactly).toBe(true);
      expect(result.results[0].status).toBe("unverified");
      expect(result.skills[0].passes).toBe(false);
      const second = { ...row, id: "synthetic-unit-2" };
      const cropped = await validateLibrary({ root: temp, skills: [sample], rows: [row, second], setups: new Map() });
      expect(cropped.results).toHaveLength(2);
      expect(cropped.skills[0].rows).toBe(2);
      expect(cropped.results.every(item => item.status === "failed" && item.reasons.some(reason => reason.includes("full group denominator")))).toBe(true);
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
  it("mines constants, preserves optional omission, and rejects explicit null without dropping its row", () => {
    const rows = Array.from({ length: 6 }, (_, i): TrainingRow => ({ id: `sample${i}`, line: i + 1, system: "", utterance: `Skeleton variant ${i}`, intent: "ACK_GOT_IT",
      commands: [{ command: "build_skeleton_from_clip", args: i === 0 ? { clipId: "17" } : i === 1 ? { clipId: "17", wait: null } : { clipId: "17", wait: true } }] }));
    const mined = mineSkill({ shape: ["build_skeleton_from_clip"], rows: rows.map((r) => r.id) }, rows, 1);
    expect(mined.provenance).toHaveLength(6);
    expect(render(mined, fillGold(mined, rows[0].commands))).toEqual(rows[0].commands);
    expect(() => fillGold(mined, rows[1].commands)).toThrow();
    expect(mined.slots.some((s) => s.input.kind === "choice_snapshot")).toBe(true);
  });
  it("does not admit stale passing flags into the validated held-out subset", () => {
    const sample = { ...skill, provenance: ["synthetic"], mining: { ...skill.mining, rows: 1 } };
    const rows: RowVerdict[] = [{ rowId: "synthetic", skillId: skill.id, renderedExactly: true, status: "unverified", reasons: ["Missing setup"] }];
    const verdict = summarizeSkill(skill.id, rows);
    expect(acceptedSkills([sample], [verdict], rows)).toEqual([]);
    expect(() => acceptedSkills([sample], [{ ...verdict, passes: true }], rows)).toThrow("ledger disagrees");
  });
});
