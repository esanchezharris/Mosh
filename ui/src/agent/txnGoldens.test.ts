// FS-B2a — pins the committed run-script goldens to the TypeScript expansion.
//
// The goldens under tests/golden/txn/ are what verify.py replays against a real engine. If
// the planner changes and the goldens do not, the real-engine gate would keep proving an
// expansion the harness no longer produces — the exact "golden baseline that matches nothing"
// shape this repo has already been bitten by. So the test regenerates and compares.
//
// To regenerate deliberately: MOSH_UPDATE_TXN_GOLDENS=1 npx vitest run src/agent/txnGoldens

import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planSkillTransaction } from "./skillTransaction";
import { renderTxnGoldenText, type GoldenShape } from "./txnGoldens";
import { ADD_VOCAL_WITH_LYRICS_SKILL, SET_TRACK_LEVEL_SKILL, type SkillDefinition } from "./skills";

const here = dirname(fileURLToPath(import.meta.url));
const goldenDir = resolve(here, "../../../tests/golden/txn");

/** Fixed ids: a golden must be byte-stable across runs. */
function fixedIds(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${String(n++).padStart(2, "0")}`;
}

const CASES: readonly {
  readonly file: string;
  readonly skill: SkillDefinition;
  readonly slots: Record<string, string | number | boolean>;
  readonly shape: GoldenShape;
}[] = [
  {
    file: "set_track_level-commit.jsonl",
    skill: SET_TRACK_LEVEL_SKILL,
    // "${T1}" is run-script's capture reference — the fixture's create_track supplies the
    // real engine-assigned id, so the golden never hard-codes one.
    slots: { trackId: "${T1}", db: -7.5, mute: true },
    shape: "commit",
  },
  {
    file: "set_track_level-rollback.jsonl",
    skill: SET_TRACK_LEVEL_SKILL,
    slots: { trackId: "${T1}", db: -12, mute: true },
    shape: "rollback",
  },
  {
    file: "set_track_level-replay.jsonl",
    skill: SET_TRACK_LEVEL_SKILL,
    slots: { trackId: "${T1}", db: -9, mute: true },
    shape: "replay",
  },
  {
    // The MULTI-command shape, so the real-engine gate is not proven only on two steps.
    //
    // NOT host_plugin, even though it is the natural 3-command skill: its first step is
    // load_plugin, which needs a scanned third-party VST3 and therefore is not portable to a
    // headless run or a clean CI machine. add_vocal_with_lyrics expands to four lyric-sheet
    // ValueTree writes — all registry-safe, all synchronous, all available everywhere. (The
    // three-command PLUGIN shape is still proven against the real engine, in --selftest's
    // TXN-3CMD section, which can use load_builtin.)
    file: "add_vocal_with_lyrics-commit.jsonl",
    skill: ADD_VOCAL_WITH_LYRICS_SKILL,
    slots: { trackId: "${T1}", seedText: "on my own ___ tonight", role: "hook", topic: "heartbreak", mood: "defiant" },
    shape: "commit",
  },
  {
    file: "add_vocal_with_lyrics-rollback.jsonl",
    skill: ADD_VOCAL_WITH_LYRICS_SKILL,
    slots: { trackId: "${T1}", seedText: "a second verse", role: "verse", topic: "leaving", mood: "calm" },
    shape: "rollback",
  },
];

describe("FS-B2a run-script goldens", () => {
  for (const c of CASES) {
    it(`${c.file} matches the current planner expansion`, () => {
      const plan = planSkillTransaction(c.skill, c.slots, fixedIds(c.file.replace(/\W+/g, "-")));
      const rendered = renderTxnGoldenText(plan, c.shape);
      const path = resolve(goldenDir, c.file);

      if (process.env.MOSH_UPDATE_TXN_GOLDENS === "1") {
        writeFileSync(path, rendered);
        return;
      }

      expect(existsSync(path), `${c.file} is missing — regenerate with MOSH_UPDATE_TXN_GOLDENS=1`).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(rendered);
    });
  }

  it("every golden is a valid run-script and carries transaction metadata on its steps", () => {
    for (const c of CASES) {
      const lines = readFileSync(resolve(goldenDir, c.file), "utf8").trim().split("\n");
      expect(lines.length).toBeGreaterThan(4);
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);

      // The boundary commands are present and in order.
      const names = parsed.map((p) => String(p.command));
      expect(names[0]).toBe("create_track");
      expect(names).toContain("batch_begin");
      expect(names).toContain("batch_status");
      expect(names[names.length - 1]).toBe("batch_status");
      expect(names).toContain(c.shape === "rollback" ? "batch_rollback" : "batch_end");

      // Every non-boundary, non-fixture line carries transaction metadata — a step without
      // it would be refused by the engine as an untagged mutation, and the gate would then
      // be proving the refusal instead of the contract.
      for (const line of parsed) {
        const name = String(line.command);
        if (name.startsWith("batch_") || name === "create_track") continue;
        expect(line.transaction, `${c.file}: ${name} has no transaction metadata`).toBeTruthy();
        const meta = line.transaction as Record<string, unknown>;
        expect(typeof meta.transactionId).toBe("string");
        expect(typeof meta.requestId).toBe("string");
        expect(typeof meta.index).toBe("number");
      }
    }
  });

  it("the replay golden really sends one requestId twice (or it proves nothing)", () => {
    const lines = readFileSync(resolve(goldenDir, "set_track_level-replay.jsonl"), "utf8").trim().split("\n");
    const requestIds = lines
      .map((l) => JSON.parse(l) as { transaction?: { requestId?: string } })
      .map((p) => p.transaction?.requestId)
      .filter((id): id is string => typeof id === "string");
    const duplicated = requestIds.filter((id, i) => requestIds.indexOf(id) !== i);
    expect(duplicated.length, "the replay golden has no duplicated requestId").toBe(1);
  });

  it("the rollback golden really targets a bad id on its LAST step (or nothing fails)", () => {
    const lines = readFileSync(resolve(goldenDir, "set_track_level-rollback.jsonl"), "utf8").trim().split("\n");
    const parsed = lines.map((l) => JSON.parse(l) as { command: string; args?: Record<string, unknown> });
    const bad = parsed.filter((p) => p.args?.trackId === "no-such-track-id");
    expect(bad.length).toBe(1);
    // …and at least one earlier step targets the REAL captured track, so a rollback has
    // something applied to revert.
    expect(parsed.some((p) => p.args?.trackId === "${T1}")).toBe(true);
  });
});
