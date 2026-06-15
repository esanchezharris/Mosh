import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_COMMANDS, validateCommand, describeCommand, type ArgSpec, type ArgType } from "./commands";

const sample = (t: ArgType): string | number | boolean => (t === "number" ? 1 : t === "boolean" ? true : "x");

/** Fill every arg with a well-typed value, optionally skipping one (to test rejection). */
function fullArgs(args: ArgSpec[], skip?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of args) {
    if (a.name === skip) continue;
    out[a.name] = sample(a.type);
  }
  return out;
}

describe("validateCommand — every catalog command's happy path validates", () => {
  for (const c of AGENT_COMMANDS) {
    it(c.command, () => {
      expect(validateCommand(c.command, fullArgs(c.args))).toBeNull();
    });
  }
});

describe("validateCommand — rejections", () => {
  it("rejects an unknown command", () => {
    expect(validateCommand("definitely_not_real", {})).toMatch(/not an allowed command/);
  });

  it("rejects a wrong-typed arg", () => {
    expect(validateCommand("set_tempo", { bpm: "fast" })).toMatch(/must be a number/);
  });

  for (const c of AGENT_COMMANDS) {
    const req = c.args.find((a) => a.required);
    if (!req) continue;
    it(`${c.command} rejects missing required "${req.name}"`, () => {
      expect(validateCommand(c.command, fullArgs(c.args, req.name))).toMatch(/missing required/);
    });
  }
});

describe("describeCommand — every command yields a non-empty changelog line", () => {
  for (const c of AGENT_COMMANDS) {
    it(c.command, () => {
      expect(describeCommand(c.command, fullArgs(c.args)).length).toBeGreaterThan(0);
    });
  }
});

// The regression guard for the arg-contract class of bug: every arg name the
// brain is told it may send MUST be one the C++ handler actually reads — else the
// command silently no-ops against the real engine (as set_transport `playing` did
// before this fix). Parses MoshOps.cpp and diffs the catalog against the source of
// truth, so a future catalog edit that drifts from the backend fails CI, not a user.
describe("catalog ↔ backend arg contract (MoshOps.cpp)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const cpp = readFileSync(`${root}src/moshops/MoshOps.cpp`, "utf8");

  // command name -> handler fn (from the dispatch table)
  const dispatch = new Map<string, string>();
  for (const m of cpp.matchAll(/if \(name == "([^"]+)"\)\s*return (cmd\w+)\s*\(/g)) dispatch.set(m[1], m[2]);

  // handler fn -> set of arg names it reads via getProperty("...")
  const reads = new Map<string, Set<string>>();
  const parts = cpp.split(/juce::var MoshOps::(cmd\w+)\s*\(/);
  for (let i = 1; i < parts.length - 1; i += 2) {
    const set = new Set<string>();
    for (const m of parts[i + 1].matchAll(/getProperty\s*\(\s*"([^"]+)"/g)) set.add(m[1]);
    reads.set(parts[i], set);
  }

  it("resolves every catalog command to a dispatched handler", () => {
    const missing = AGENT_COMMANDS.filter((c) => !dispatch.has(c.command)).map((c) => c.command);
    expect(missing).toEqual([]);
  });

  it("every catalog arg name is read by its backend handler", () => {
    const violations: string[] = [];
    for (const c of AGENT_COMMANDS) {
      const fn = dispatch.get(c.command);
      if (!fn) continue;
      const backend = reads.get(fn) ?? new Set<string>();
      for (const a of c.args) if (!backend.has(a.name)) violations.push(`${c.command}.${a.name} → ${fn} never reads it`);
    }
    expect(violations).toEqual([]);
  });
});
