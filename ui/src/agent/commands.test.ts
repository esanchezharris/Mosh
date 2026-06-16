import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AGENT_COMMANDS, validateCommand, describeCommand, resolvePluginId, commandNeedsConfirm, coerceArgs, type ArgSpec, type ArgType } from "./commands";

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

describe("resolvePluginId — fuzzy name → real id, never a wrong guess", () => {
  const plugins = [
    { id: "vst3:OTT", name: "OTT" },
    { id: "vst3:Vital", name: "Vital" },
    { id: "vst3:VitalFX", name: "Vital FX" },
    { id: "au:ProQ3", name: "Pro-Q 3" },
  ];
  it("exact match, case/punctuation-insensitive", () => {
    expect(resolvePluginId("ott", plugins)).toEqual({ id: "vst3:OTT" });
    expect(resolvePluginId("pro q 3", plugins)).toEqual({ id: "au:ProQ3" });
  });
  it("fuzzy contains prefers the most specific (shortest) name", () => {
    expect(resolvePluginId("vita", plugins)).toEqual({ id: "vst3:Vital" });
  });
  it("errors (does not guess) when nothing matches", () => {
    const r = resolvePluginId("nonexistent-thing", plugins);
    expect("error" in r).toBe(true);
  });
  it("errors on an empty query", () => {
    expect("error" in resolvePluginId("", plugins)).toBe(true);
  });
});

describe("coerceArgs — numeric ids become strings so the validator accepts them", () => {
  it("stringifies a number passed for a string arg (trackId)", () => {
    const a = coerceArgs("set_track_mute", { trackId: 1010, mute: true });
    expect(a.trackId).toBe("1010");
    expect(validateCommand("set_track_mute", a)).toBeNull();
  });
  it("leaves number args (bpm) untouched", () => {
    expect(coerceArgs("set_tempo", { bpm: 90 }).bpm).toBe(90);
  });
  it("is a no-op for unknown commands", () => {
    expect(coerceArgs("nope", { x: 1 })).toEqual({ x: 1 });
  });
});

describe("commandNeedsConfirm — only destructive variants are gated", () => {
  it("export_audio with a file (overwrite) needs confirm", () => {
    expect(commandNeedsConfirm("export_audio", { file: "mix.wav" })).toBe(true);
  });
  it("export_audio without a file (safe timestamped) does not", () => {
    expect(commandNeedsConfirm("export_audio", {})).toBe(false);
  });
  it("a plain edit never confirms", () => {
    expect(commandNeedsConfirm("create_track", { name: "x" })).toBe(false);
    expect(commandNeedsConfirm("remove_track", { trackId: "t1" })).toBe(false);
  });
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
