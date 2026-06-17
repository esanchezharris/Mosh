// DURABLE catalog ⇄ backend contract guard.
//
// Parses the C++ command seam (src/moshops/MoshOps.cpp) and asserts that EVERY
// argument the agent catalog (AGENT_COMMANDS) declares is actually read by the
// command's handler. This catches the whole class of "voiced command silently
// no-ops because the catalog declares an arg key the backend never reads" bugs
// (e.g. set_transport `playing` vs `action`) across all ~50 commands — not just
// the ones with a hand-written behavioural test.
//
// How it works (MoshOps.cpp shape, verified):
//   • dispatch:  if (name == "cmd") return cmdHandler (args);
//   • arg reads: args.getProperty ("key", …) / args.hasProperty ("key")
//                (no args["key"] style anywhere in the file)

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { AGENT_COMMANDS } from "./commands";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const CPP_PATH = resolve(here, "../../../src/moshops/MoshOps.cpp");
const src = readFileSync(CPP_PATH, "utf8");

// command name → handler function (from the dispatch table)
const dispatch = new Map<string, string>();
for (const m of src.matchAll(/if \(name == "([a-z0-9_]+)"\)\s*return (cmd[A-Za-z0-9]+)/g))
  dispatch.set(m[1], m[2]);

// Slice a handler's source span: from its definition to the next function
// definition (or EOF). This can only ever ATTRIBUTE EXTRA keys (a false pass),
// never drop a real read — so the guard never fails spuriously on brace/string
// edge cases.
function handlerArgKeys(handler: string): Set<string> | null {
  const sig = src.indexOf(`MoshOps::${handler} (`);
  if (sig < 0) return null;
  const next = src.indexOf("\njuce::var MoshOps::", sig + 1);
  const body = src.slice(sig, next < 0 ? undefined : next);
  const keys = new Set<string>();
  for (const m of body.matchAll(/args\.(?:getProperty|hasProperty) ?\("([a-zA-Z0-9_]+)"/g))
    keys.add(m[1]);
  return keys;
}

describe("agent catalog ⇄ MoshOps.cpp argument contract", () => {
  it("found the dispatch table", () => {
    // Sanity: if this drops to ~0 the regex/file moved and every test below is meaningless.
    expect(dispatch.size).toBeGreaterThan(50);
  });

  for (const cmd of AGENT_COMMANDS) {
    it(`${cmd.command}: every declared arg is read by its backend handler`, () => {
      const handler = dispatch.get(cmd.command);
      expect(handler, `"${cmd.command}" has no dispatch entry in MoshOps.cpp`).toBeTruthy();

      const keys = handlerArgKeys(handler!);
      expect(keys, `handler ${handler}() not found in MoshOps.cpp`).toBeTruthy();

      for (const arg of cmd.args)
        expect(
          keys!.has(arg.name),
          `${cmd.command}: catalog arg "${arg.name}" is never read by ${handler}() — ` +
            `catalog/seam drift (handler reads: ${[...keys!].join(", ") || "nothing"})`,
        ).toBe(true);
    });
  }
});
