// FS-B2a — the drift guard on the engine-owned transactionSafe registry.
//
// src/moshops/TransactionSafe.h claims that every command it admits is (1) inside a
// beginTxn transaction, (2) undoable, (3) synchronous, and (4) not a sub-program that
// re-enters execute(). Those are claims ABOUT MoshOps.cpp, and a written reason ages —
// nine of the sixteen UI_REACH_GAPS entries turned out to describe an assumption rather
// than the tree. So this test re-derives all four from the C++ at test time and fails on
// any entry whose claim has rotted. Same idiom as commands.contract.test.ts, same reason.
//
// It also pins the two MIRRORS of that registry: bridge.mock.ts's MOCK_TXN_SAFE (so the
// dev/e2e backend cannot admit something the engine refuses, which would make every mock
// test a lie about the engine) and skillTransaction.ts's SKILL_TRANSACTABILITY verdicts.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_CATALOG } from "./skills";
import { SKILL_TRANSACTABILITY, expandSkillTemplate } from "./skillTransaction";
import { UI_ONLY_COMMANDS } from "./commandClassification";
import { AGENT_COMMAND_MAP } from "./commands";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent
const read = (rel: string) => readFileSync(resolve(here, rel), "utf8");

const txnSafeH = read("../../../src/moshops/TransactionSafe.h");
// GLOB, not a single file. MoshOps.cpp is being split into per-area translation units
// (MoshOps.Lyrics.cpp, MoshOps.Notes.cpp, …), and a handler that moves out of MoshOps.cpp
// would read as "not found" here — which is indistinguishable from a handler that was
// deleted. That is exactly how this guard failed when the Lyrics TU landed: three real,
// present handlers reported missing. Concatenate every MoshOps*.cpp so the guard tracks
// the COMMAND SET rather than one filename. Same fix, same reason, as the glob-aware
// lock-scope extractor in tests/test_multiplayer_lock_manager.cpp.
const moshOpsDir = resolve(here, "../../../src/moshops");
const moshOps = readdirSync(moshOpsDir)
  .filter((f) => f.startsWith("MoshOps") && f.endsWith(".cpp"))
  .sort()
  .map((f) => readFileSync(resolve(moshOpsDir, f), "utf8"))
  .join("\n");
const bridgeMock = read("../bridge.mock.ts");

/** Parse a `std::set<juce::String>` literal body by its variable name. */
function parseCppSet(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  if (at < 0) return [];
  const open = source.indexOf("{", at);
  const close = source.indexOf("};", open);
  if (open < 0 || close < 0) return [];
  return [...source.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

/** Parse a `new Set([...])` literal body by its variable name. */
function parseTsSet(source: string, marker: string): string[] {
  const at = source.indexOf(marker);
  if (at < 0) return [];
  const open = source.indexOf("([", at);
  const close = source.indexOf("]);", open);
  if (open < 0 || close < 0) return [];
  return [...source.slice(open, close).matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);
}

const registry = parseCppSet(txnSafeH, "inline const std::set<juce::String>& registry()");
const readsDuringTxn = parseCppSet(txnSafeH, "inline const std::set<juce::String>& readOnlyDuringTransaction()");
const mockSafe = parseTsSet(bridgeMock, "const MOCK_TXN_SAFE = new Set");
const mockReads = parseTsSet(bridgeMock, "const MOCK_TXN_READS = new Set");

/** command name → handler function, from MoshOps.cpp's dispatch table. */
const dispatch = new Map<string, string>();
for (const m of moshOps.matchAll(
  /if \(name == "([a-z0-9_]+)"\)\s*return [^;]*?(cmd[A-Za-z0-9]+)\s*\(args\)/g,
))
  dispatch.set(m[1], m[2]);

/** A handler's source span: its signature to the next handler's signature. */
function handlerBody(handler: string): string | null {
  const sig = moshOps.indexOf(`juce::var MoshOps::${handler} (`);
  if (sig < 0) return null;
  const next = moshOps.indexOf("\njuce::var MoshOps::", sig + 1);
  return moshOps.slice(sig, next < 0 ? undefined : next);
}

describe("FS-B2a transactionSafe registry ⇄ MoshOps.cpp", () => {
  it("parsed a real registry (guards against a silently-empty probe)", () => {
    // If any of these collapse, every assertion below becomes vacuous.
    expect(registry.length).toBeGreaterThanOrEqual(40);
    expect(readsDuringTxn.length).toBeGreaterThanOrEqual(10);
    expect(dispatch.size).toBeGreaterThanOrEqual(190);
    expect(registry).toContain("set_track_volume");
    expect(readsDuringTxn).toContain("batch_status");
  });

  it("has no duplicate entries", () => {
    expect(new Set(registry).size).toBe(registry.length);
    expect(new Set(readsDuringTxn).size).toBe(readsDuringTxn.length);
  });

  it("every registry entry actually dispatches in MoshOps.cpp", () => {
    const missing = registry.filter((c) => !dispatch.has(c));
    expect(missing, `registry names command(s) with no dispatch entry: ${missing.join(", ")}`).toEqual([]);
  });

  // ── the four admission criteria, re-derived ──
  for (const command of registry) {
    it(`${command}: is transaction-safe by the criteria TransactionSafe.h claims`, () => {
      const handler = dispatch.get(command);
      expect(handler, `${command} has no dispatch entry`).toBeTruthy();
      if (!handler) return;
      const body = handlerBody(handler);
      expect(body, `${handler}() not found`).toBeTruthy();
      if (!body) return;

      // (1) joins the open UndoManager transaction
      expect(
        /\bbeginTxn \(/.test(body),
        `${command}: ${handler}() never calls beginTxn, so its mutation does not join the ` +
          `agent transaction and a rollback would not revert it`,
      ).toBe(true);

      // (2) claims undoability
      const undoableFlags = new Set(
        [...body.matchAll(/logLine \("[a-z0-9_]+", [^;]*?, (true|false)\);/gs)].map((m) => m[1]),
      );
      expect(
        undoableFlags.has("true") && !undoableFlags.has("false"),
        `${command}: ${handler}() logs undoable=${[...undoableFlags].join("/") || "nothing"} — ` +
          `only an unambiguously undoable command may be in the registry`,
      ).toBe(true);

      // (3) synchronous
      const asyncMarker = body.match(/std::thread|callAsync|jobManager\.|Thread::launch|trainingJobManager/);
      expect(
        asyncMarker,
        `${command}: ${handler}() contains "${asyncMarker?.[0]}" — an effect that can land ` +
          `after the transaction closes cannot be rolled back`,
      ).toBeNull();

      // (4) not a sub-program
      expect(
        /\bexecute \(var/.test(body),
        `${command}: ${handler}() re-enters execute() to author its own commands, which a ` +
          `manifest cannot enumerate in advance`,
      ).toBe(false);
    });
  }

  it("the read-only-during-transaction list mutates nothing", () => {
    // A "read" that calls beginTxn would slip a mutation past the exclusion window.
    const mutating = readsDuringTxn.filter((command) => {
      const handler = dispatch.get(command);
      if (!handler) return false;   // e.g. batch_status itself, checked separately below
      const body = handlerBody(handler);
      return body !== null && /\bbeginTxn \(/.test(body);
    });
    expect(mutating, `declared read-only but calls beginTxn: ${mutating.join(", ")}`).toEqual([]);
  });

  it("registry and read-only lists are disjoint", () => {
    const both = registry.filter((c) => readsDuringTxn.includes(c));
    expect(both, `a command cannot be both a manifest step and a bypassing read: ${both.join(", ")}`).toEqual([]);
  });
});

describe("FS-B2a — the mock mirrors the engine registry exactly", () => {
  it("MOCK_TXN_SAFE equals the C++ registry", () => {
    // A divergence would make every mock-backed harness test a claim about a registry the
    // engine does not have.
    expect([...mockSafe].sort()).toEqual([...registry].sort());
  });

  it("MOCK_TXN_READS equals the C++ read-only list", () => {
    expect([...mockReads].sort()).toEqual([...readsDuringTxn].sort());
  });
});

describe("FS-B2a — SKILL_TRANSACTABILITY matches what the registry will admit", () => {
  it("every catalogued skill has a verdict", () => {
    const missing = SKILL_CATALOG.map((s) => s.name).filter((n) => !(n in SKILL_TRANSACTABILITY));
    expect(missing, `no transactability verdict for: ${missing.join(", ")}`).toEqual([]);
  });

  it("no verdict describes a skill that does not exist", () => {
    const known = new Set(SKILL_CATALOG.map((s) => s.name));
    const strays = Object.keys(SKILL_TRANSACTABILITY).filter((n) => !known.has(n));
    expect(strays, `verdict for an unknown skill: ${strays.join(", ")}`).toEqual([]);
  });

  for (const skill of SKILL_CATALOG) {
    it(`${skill.name}: its verdict is what the registry actually says`, () => {
      // Expand with every slot filled, so an if_present branch's commands are included —
      // a skill is transactable only if EVERY branch it can take is admissible.
      const slots: Record<string, string | number | boolean> = {};
      for (const slot of skill.slots) {
        if (slot.type === "number") slots[slot.name] = slot.min ?? 0;
        else if (slot.type === "boolean") slots[slot.name] = true;
        else slots[slot.name] = slot.enum?.[0] ?? "x";
      }
      const commands = expandSkillTemplate(skill.template, slots).map((c) => c.command);
      expect(commands.length, `${skill.name} expanded to nothing`).toBeGreaterThan(0);

      const blocking = commands.filter((c) => !registry.includes(c));
      const verdict = SKILL_TRANSACTABILITY[skill.name];

      if (verdict === true) {
        expect(
          blocking,
          `${skill.name} is declared transactable but the engine registry does not admit: ${blocking.join(", ")}`,
        ).toEqual([]);
      } else {
        expect(
          blocking.length,
          `${skill.name} is declared UNtransactable ("${verdict}") but every one of its ` +
            `commands is in the registry — the verdict is stale`,
        ).toBeGreaterThan(0);
        // The written reason must name the actual blocking command, or it describes an
        // assumption rather than the tree.
        expect(
          blocking.some((c) => String(verdict).includes(c)),
          `${skill.name}'s reason does not name any of its blocking commands (${blocking.join(", ")})`,
        ).toBe(true);
      }
    });
  }
});

describe("FS-B2a — the two new commands are registered in all three places", () => {
  it("batch_status and batch_rollback dispatch in MoshOps.cpp", () => {
    expect(dispatch.has("batch_status")).toBe(true);
    expect(dispatch.has("batch_rollback")).toBe(true);
  });

  it("…are classified UI-only, never agent-callable", () => {
    // Agent-internal plumbing: the model must never manage transactions, and being outside
    // AGENT_COMMANDS is also why uiReachability.test.ts does not apply and UI_REACH_GAPS
    // stays at 0.
    for (const command of ["batch_status", "batch_rollback"]) {
      expect(command in UI_ONLY_COMMANDS, `${command} is not in UI_ONLY_COMMANDS`).toBe(true);
      expect(AGENT_COMMAND_MAP.has(command), `${command} must not be agent-callable`).toBe(false);
      expect(UI_ONLY_COMMANDS[command].length).toBeGreaterThan(25);
    }
  });

  it("…and the LockManager scope decision exists (the third registration)", () => {
    // The Catch2 side (test_multiplayer_lock_manager.cpp) asserts the actual Scope; this is
    // the cheap-gate-visible half, since a native-only run misses the vitest and vice versa.
    const lockManager = read("../../../src/multiplayer/LockManager.cpp");
    const unguarded = parseCppSet(lockManager, "static const std::set<juce::String> unguarded");
    expect(unguarded).toContain("batch_status");
    expect(unguarded).toContain("batch_rollback");
  });
});
