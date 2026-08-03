// Drift guard for BUILTIN_TYPES — the builtin `type` vocabulary that is now
// INLINE in the agent catalog (and therefore in the shipped system prompt).
//
// The engine's list is a compiled-in C++ table (kBuiltins in
// src/moshops/MoshOpsInternal.h). Hardcoding a copy of it in TypeScript is exactly the
// kind of "kept in lockstep" comment this repo has been bitten by, so this test
// does not trust the comment: it PARSES the C++ table and compares. If someone
// adds a builtin to the engine, the prompt list goes stale and this test fails.
//
// Same reason bridge.mock.ts's BUILTINS is checked here: its header already
// records a real incident where the mock accepted "eq" while native rejected it,
// so an agent that followed the real vocabulary failed only in dev/e2e.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { BUILTIN_TYPES, AGENT_COMMANDS, commandCatalogPrompt } from "./commands";
import { mockExecute } from "../bridge.mock";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOSHOPS_HEADER = resolve(HERE, "../../../src/moshops/MoshOpsInternal.h");

/** Pull the `type` field out of every kBuiltins row in the C++ source. */
function nativeBuiltinTypes(): string[] {
  const src = readFileSync(MOSHOPS_HEADER, "utf8");
  const table = /inline const BuiltinSpec kBuiltins\[\] = \{(.*?)\n {4}\};/s.exec(src);
  if (!table) throw new Error(`could not locate kBuiltins table in ${MOSHOPS_HEADER} — parser drifted`);
  const types = [...table[1]!.matchAll(/\{\s*"([^"]+)"\s*,/g)].map((m) => m[1]!);
  if (types.length === 0) throw new Error("parsed zero kBuiltins rows — parser drifted");
  return types;
}

describe("BUILTIN_TYPES vs the engine's kBuiltins table", () => {
  it("parses a non-trivial table out of the C++ (the guard is not vacuous)", () => {
    const native = nativeBuiltinTypes();
    expect(native.length).toBeGreaterThanOrEqual(13);
    expect(native).toContain("4bandEq");
  });

  it("matches the native list exactly, in order", () => {
    expect([...BUILTIN_TYPES]).toEqual(nativeBuiltinTypes());
  });

  it('includes "4bandEq" and NOT the "eq" the models reach for', () => {
    expect(BUILTIN_TYPES).toContain("4bandEq");
    expect(BUILTIN_TYPES).not.toContain("eq");
  });
});

describe("the vocabulary actually reaches the system prompt", () => {
  const prompt = commandCatalogPrompt();

  it("renders every builtin type into the catalog text", () => {
    for (const t of BUILTIN_TYPES) expect(prompt).toContain(t);
  });

  it("the load_builtin desc carries the exact joined list — a plain string that cannot silently drift on add OR remove", () => {
    // Plain string (not a template literal) so service/skills/moshops_catalog.py
    // can keep parsing this file statically; this assertion is what makes the
    // hand-inlining safe.
    const loadBuiltin = AGENT_COMMANDS.find((c) => c.command === "load_builtin")!;
    expect(loadBuiltin.desc).toContain(BUILTIN_TYPES.join(", "));
  });

  it("names 4bandEq on the master-bus command's line too, and no longer sends the model to list_builtins for types", () => {
    const line = prompt.split("\n").find((l) => l.startsWith("- load_master_builtin("))!;
    expect(line).toBeDefined();
    expect(line).toContain("4bandEq");
    expect(line).toContain("compressor");

    const loadBuiltin = AGENT_COMMANDS.find((c) => c.command === "load_builtin")!;
    expect(loadBuiltin.desc).not.toContain("from list_builtins");
  });
});

describe("the dev mock speaks the same vocabulary", () => {
  it("mock list_builtins returns exactly the native type names", async () => {
    const res = await mockExecute<{ ok: boolean; data: { plugins: Array<{ type: string }> } }>({
      command: "list_builtins",
      args: {},
    });
    const mockTypes = res.data.plugins.map((p) => p.type);
    expect([...mockTypes].sort()).toEqual([...BUILTIN_TYPES].sort());
  });
});
