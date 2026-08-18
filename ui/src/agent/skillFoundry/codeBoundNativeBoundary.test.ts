// Skill Foundry Slice B — owner decision, CODE-BOUND SEEDING. The durable, text-level guard
// (same technique nativeBridgeBoundary.test.ts uses for the certified-skill native reads)
// that `adaptCodeBoundNativeSkillV1` (nativeAdapter.ts) can NEVER be reached with a payload
// that was parsed from disk, a network response, or any other runtime-supplied bytes.
//
// The function's own header explains WHY this must hold (its whole legitimacy is a trust
// root — the app's own code signature — that is specific to the compiled-in
// `NATIVE_PAYLOADS_V1` constant); this file makes that claim CHECKABLE rather than a comment
// someone could silently violate later. It cannot verify runtime behavior (a source-text scan
// cannot prove `NATIVE_PAYLOADS_V1` itself was never reassigned to disk-sourced data — that is
// what `export const` + no setter already prevents at the type/module level), only that the
// PRODUCTION call graph never grows a second call site.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent/skillFoundry
const SRC = resolve(here, "..", "..");

const CALL_PATTERN = "adaptCodeBoundNativeSkillV1(";

/** Every .ts/.tsx file under ui/src, as repo-relative-to-SRC paths (walk pattern shared with
 *  reachability.test.ts / nativeBridgeBoundary.test.ts's own file scans). */
function allSourceFiles(): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

function productionSourceFiles(): readonly string[] {
  return allSourceFiles().filter((file) => !/\.test\.tsx?$/.test(file));
}

describe("adaptCodeBoundNativeSkillV1 is reachable from exactly one production call site", () => {
  it("scans a non-empty set of production source files (guards against a silently-empty walk)", () => {
    expect(productionSourceFiles().length).toBeGreaterThan(50);
  });

  it("appears in exactly nativeAdapter.ts (its own definition) and runtime.ts (its only call site)", () => {
    const hits = productionSourceFiles()
      .filter((file) => readFileSync(file, "utf8").includes(CALL_PATTERN))
      .map((file) => file.slice(SRC.length + 1))
      .sort();
    expect(hits).toEqual(["agent/skillFoundry/nativeAdapter.ts", "agent/skillFoundry/runtime.ts"]);
  });

  it("nativeAdapter.ts's only occurrence is the exported function's own definition, not a second call", () => {
    const source = readFileSync(resolve(SRC, "agent/skillFoundry/nativeAdapter.ts"), "utf8");
    const occurrences = source.split(CALL_PATTERN).length - 1;
    expect(occurrences).toBe(1);
    expect(source).toContain(`export function ${CALL_PATTERN}`);
  });

  it("runtime.ts's call site is bound directly to NATIVE_PAYLOADS_V1, inside a zero-parameter seeding function", () => {
    const source = readFileSync(resolve(SRC, "agent/skillFoundry/runtime.ts"), "utf8");

    // Exactly one call in runtime.ts.
    const occurrences = source.split(CALL_PATTERN).length - 1;
    expect(occurrences).toBe(1);

    // The enclosing function takes NO parameters — nothing outside this module can hand it
    // a payload to adapt; the only payloads it can ever process are read directly off the
    // `NATIVE_PAYLOADS_V1` import.
    const fnStart = source.indexOf("function buildCodeBoundNativeSkillCandidatesV1(");
    expect(fnStart).toBeGreaterThan(-1);
    expect(source.slice(fnStart, fnStart + "function buildCodeBoundNativeSkillCandidatesV1(): {".length))
      .toBe("function buildCodeBoundNativeSkillCandidatesV1(): {");

    // Bound the function body to its matching close (next top-level `\n}\n` after the open).
    const bodyStart = source.indexOf("{", fnStart);
    const bodyEnd = source.indexOf("\n}\n", bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = source.slice(fnStart, bodyEnd);

    // The call is inside an iteration over NATIVE_PAYLOADS_V1, not over any other value.
    expect(body).toContain("for (const payload of NATIVE_PAYLOADS_V1)");
    expect(body).toContain(CALL_PATTERN);
    expect(body.indexOf("for (const payload of NATIVE_PAYLOADS_V1)")).toBeLessThan(body.indexOf(CALL_PATTERN));
  });

  it("nothing under ui/src references adaptCodeBoundNativeSkillV1 outside nativeAdapter.ts/runtime.ts and their own tests", () => {
    const hits = allSourceFiles()
      .filter((file) => readFileSync(file, "utf8").includes("adaptCodeBoundNativeSkillV1"))
      .map((file) => file.slice(SRC.length + 1))
      .sort();
    const allowed = new Set([
      "agent/skillFoundry/nativeAdapter.ts",
      "agent/skillFoundry/runtime.ts",
      "agent/skillFoundry/adapters.test.ts",
      "agent/skillFoundry/codeBoundNativeBoundary.test.ts",
      // Comment-only mention (documentation of WHY this test file no longer needs to mock
      // the runtime) — not a call site.
      "ui/AgentComposer.namedPlugin.test.ts",
    ]);
    for (const hit of hits) expect(allowed.has(hit), `unexpected reference to adaptCodeBoundNativeSkillV1 in ${hit}`).toBe(true);
  });
});
