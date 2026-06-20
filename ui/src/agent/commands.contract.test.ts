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
//                or wrapped — if (name == "cmd") return wrapper (name, args, cmdHandler (args));
//                (some ops route the handler through a wrapper, e.g. an MP structural
//                 broadcast — parseDispatch picks the inner cmdXxx(args) either way)
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

// command name → handler function (from the dispatch table). The handler is the
// cmdXxx(args) call — either bare after `return`, or nested inside a wrapper such as
// `return wrapper (name, args, cmdXxx (args));`. `[^;]*?` stays within the single
// dispatch statement (each ends with `;`) and the non-greedy match lands on the inner
// cmdXxx(args) regardless of any wrapper.
export function parseDispatch(cpp: string): Map<string, string> {
  const d = new Map<string, string>();
  for (const m of cpp.matchAll(/if \(name == "([a-z0-9_]+)"\)\s*return [^;]*?(cmd[A-Za-z0-9]+)\s*\(args\)/g))
    d.set(m[1], m[2]);
  return d;
}

const dispatch = parseDispatch(src);

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

  it("parseDispatch resolves the handler for BOTH bare and wrapper-nested dispatch", () => {
    // The old `return (cmd...)` regex only matched a handler IMMEDIATELY after `return`,
    // so a dispatch that routes the handler through a wrapper — e.g. a structural
    // broadcast — silently dropped out of the table and every arg check for it failed
    // with a spurious "no dispatch entry". This guards the wrapper form.
    const snippet = [
      '    if (name == "set_track_volume")  return cmdSetTrackVolume (args);',
      '    if (name == "set_tempo")         return broadcastStructuralIfActive (name, args, cmdSetTempo (args));',
    ].join("\n");
    const d = parseDispatch(snippet);
    expect(d.get("set_track_volume")).toBe("cmdSetTrackVolume"); // bare form
    expect(d.get("set_tempo")).toBe("cmdSetTempo");              // wrapper-nested (red on the old regex)
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
