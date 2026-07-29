// DURABLE cross-catalog boundary guard (TS half).
//
// Mosh has two skill catalogs. They are NOT duplicates of each other and are
// deliberately not merged — see docs/first-stranger-program/SKILL_CATALOG_BOUNDARY.md:
//
//   • ui/src/agent/skills.ts  — 8 hand-written, EXECUTABLE workflow DAGs with
//     numeric bounds and TS predicate pre/postconditions, run in-app through
//     runAgentBatch.
//   • service/skills/library.jsonl — 36 MINED, provenance-backed micro-skills
//     used by the offline deterministic router. Never hand-authored; never
//     executed in-app.
//
// The one thing they share is the MoshOps command surface, and that IS
// single-sourced: service/skills/moshops_catalog.py PARSES ui/src/agent/commands.ts
// rather than restating it. This file guards that seam from the authoritative
// side, and it must live here rather than in pytest because the cheap gate's
// Python suite is PATH-SCOPED to service/ and relay/ — a ui/-only PR that
// renames a command argument would never run service/skills/contract_test.py.
//
// The Python half (parser fidelity + library-vs-catalog validity, re-checked
// from that side) is service/skills/contract_test.py.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AGENT_COMMANDS, AGENT_COMMAND_MAP } from "./commands";
import { SKILL_CATALOG } from "./skills";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const REPO = resolve(here, "../../..");
const LIBRARY_PATH = resolve(REPO, "service/skills/library.jsonl");

type MinedArgs = Readonly<Record<string, unknown>>;
type MinedCommand = { readonly command: string; readonly args: MinedArgs };
type MinedSlot = { readonly name: string; readonly type: string; readonly required: boolean };
type MinedSkill = {
  readonly name: string;
  readonly description: string;
  readonly slots: readonly MinedSlot[];
  readonly template: { readonly commands: readonly MinedCommand[] };
};

const MINED: readonly MinedSkill[] = readFileSync(LIBRARY_PATH, "utf8")
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line) as MinedSkill);

const minedCommands = (): { skill: string; call: MinedCommand }[] =>
  MINED.flatMap((skill) => skill.template.commands.map((call) => ({ skill: skill.name, call })));

/** A mined arg value like "{db}" or "{item.value}" is a router placeholder, not a literal. */
const isPlaceholder = (v: unknown): boolean =>
  typeof v === "string" && v.startsWith("{") && v.endsWith("}");

describe("mined library ⇄ agent command catalog", () => {
  it("mines a non-empty library (guards against silently reading an empty file)", () => {
    expect(MINED.length).toBeGreaterThanOrEqual(30);
    expect(minedCommands().length).toBeGreaterThanOrEqual(30);
  });

  it("every mined template command exists in AGENT_COMMAND_MAP", () => {
    const missing = minedCommands()
      .filter(({ call }) => !AGENT_COMMAND_MAP.has(call.command))
      .map(({ skill, call }) => `${skill} → ${call.command}`);
    expect(missing).toEqual([]);
  });

  it("every mined argument is declared by the command it is passed to", () => {
    const unknown: string[] = [];
    for (const { skill, call } of minedCommands()) {
      const spec = AGENT_COMMAND_MAP.get(call.command);
      if (!spec) continue; // reported above
      const declared = new Set(spec.args.map((a) => a.name));
      for (const arg of Object.keys(call.args))
        if (!declared.has(arg)) unknown.push(`${skill} → ${call.command}.${arg}`);
    }
    expect(unknown).toEqual([]);
  });

  it("every mined call binds every required argument of its command", () => {
    const unbound: string[] = [];
    for (const { skill, call } of minedCommands()) {
      const spec = AGENT_COMMAND_MAP.get(call.command);
      if (!spec) continue;
      for (const arg of spec.args)
        if (arg.required !== false && !(arg.name in call.args))
          unbound.push(`${skill} → ${call.command} missing "${arg.name}"`);
    }
    expect(unbound).toEqual([]);
  });

  it("every mined LITERAL argument matches the declared primitive type", () => {
    const wrong: string[] = [];
    let checked = 0;
    for (const { skill, call } of minedCommands()) {
      const spec = AGENT_COMMAND_MAP.get(call.command);
      if (!spec) continue;
      const byName = new Map(spec.args.map((a) => [a.name, a]));
      for (const [arg, value] of Object.entries(call.args)) {
        const declared = byName.get(arg);
        if (!declared || isPlaceholder(value)) continue;
        checked += 1;
        if (typeof value !== declared.type)
          wrong.push(`${skill} → ${call.command}.${arg} is ${typeof value}, want ${declared.type}`);
      }
    }
    expect(checked).toBeGreaterThan(0); // a zero-literal library would make this vacuous
    expect(wrong).toEqual([]);
  });
});

describe("the two catalogs stay separate artifacts", () => {
  it("skill-name namespaces are disjoint", () => {
    // A collision means someone began hand-merging the catalogs. They are
    // different KINDS of thing (executable workflow DAG vs mined retrieval
    // entry); the same name on both sides would make "which one runs?"
    // ambiguous for every future consumer.
    const ts = new Set(SKILL_CATALOG.map((s) => s.name));
    const normalized = MINED.map((s) => ({ raw: s.name, key: s.name.replace(/-/g, "_") }));
    const collisions = normalized.filter((s) => ts.has(s.key) || ts.has(s.raw)).map((s) => s.raw);
    expect(collisions).toEqual([]);
  });

  it("both catalogs are actually populated (a missing side would make the above vacuous)", () => {
    expect(SKILL_CATALOG.length).toBeGreaterThanOrEqual(8);
    expect(MINED.length).toBeGreaterThanOrEqual(30);
  });
});

// ── the single-source projection ────────────────────────────────────────────
//
// service/skills/moshops_catalog.py parses commands.ts. A parser can be lossy
// without failing, so "it's generated, not copied" is only true while the
// projection is FAITHFUL. This asserts field-for-field equality against the
// real AGENT_COMMANDS. It caught an escape-unaware desc regex that silently
// truncated 2 of 124 command descriptions.

type ProjectedArg = { name: string; type: string; required: boolean; desc: string | null };
type ProjectedCommand = { command: string; desc: string; args: ProjectedArg[] };

const PY_DUMP = `
import json, sys
sys.path.insert(0, "service/skills")
import moshops_catalog as mc
print(json.dumps([
    {
        "command": spec.command,
        "desc": spec.desc,
        "args": [
            {"name": a.name, "type": a.type, "required": a.required, "desc": a.desc}
            for a in spec.args
        ],
    }
    for spec in mc.load_catalog().values()
]))
`;

function projectedCatalog(): ProjectedCommand[] {
  let raw: string;
  try {
    raw = execFileSync("python3", ["-c", PY_DUMP], { cwd: REPO, encoding: "utf8" });
  } catch (err) {
    // Deliberately a failure, not a skip: a skipped parity check looks exactly
    // like a passing one, and python3 is required by the gate that runs this.
    throw new Error(
      `could not run service/skills/moshops_catalog.py to check catalog parity: ${String(err)}`,
    );
  }
  return JSON.parse(raw) as ProjectedCommand[];
}

const byName = <T extends { command: string }>(rows: readonly T[]): Record<string, T> =>
  Object.fromEntries(rows.map((r) => [r.command, r]));

describe("service/skills/moshops_catalog.py is a faithful projection of commands.ts", () => {
  const projected = projectedCatalog();

  const expected: ProjectedCommand[] = AGENT_COMMANDS.map((c) => ({
    command: c.command,
    desc: c.desc,
    args: c.args.map((a) => ({
      name: a.name,
      type: a.type,
      required: a.required !== false,
      desc: a.desc ?? null,
    })),
  }));

  it("projects the same commands, in the same order", () => {
    expect(projected.map((c) => c.command)).toEqual(expected.map((c) => c.command));
  });

  it("projects every command's description without truncation", () => {
    const tsDesc = Object.fromEntries(expected.map((c) => [c.command, c.desc]));
    const pyDesc = Object.fromEntries(projected.map((c) => [c.command, c.desc]));
    expect(pyDesc).toEqual(tsDesc);
  });

  it("projects every argument name, type, requiredness, and description", () => {
    const tsArgs = Object.fromEntries(expected.map((c) => [c.command, c.args]));
    const pyArgs = Object.fromEntries(projected.map((c) => [c.command, c.args]));
    expect(pyArgs).toEqual(tsArgs);
  });

  it("projects the whole catalog, field for field", () => {
    expect(byName(projected)).toEqual(byName(expected));
  });

  it("projects a catalog large enough that the comparison is not vacuous", () => {
    expect(projected.length).toBe(AGENT_COMMANDS.length);
    expect(projected.length).toBeGreaterThanOrEqual(100);
  });
});
