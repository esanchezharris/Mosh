// Task 4 — the durable guard that the three certified-skill native reads
// (read_certified_skill_packages / read_skill_source_status / read_certified_native_skills)
// stay OUTSIDE the MoshOps command surface, on BOTH sides of the bridge:
//
//   TS side  — nativeReads.ts's V1 wrappers call the three dedicated bridge.ts functions
//              directly (never executeCommand), and none of the three native-function
//              names appears in the agent command catalog (AGENT_COMMANDS/
//              AGENT_COMMAND_MAP) or its deliberate-exclusion ledger (UI_ONLY_COMMANDS) —
//              they were never MoshOps commands to begin with, so neither list is their
//              home (see commandClassification.ts's own header on what that ledger is for).
//   native side — none of the three names appears anywhere in src/moshops/*.cpp (the
//              MoshOps::execute() dispatch table and its per-family cmd* implementations),
//              and in src/webview/WebBridge.cpp each is its OWN top-level
//              `.withNativeFunction` registration using the threaded-relay pattern
//              (juce::Thread::launch + MessageManager::callAsync straight into
//              CertifiedSkillLoader::), with none of the three names appearing inside the
//              execute_command handler's own body (which is the ONLY place in that file
//              that touches `commandHandler`).
//
// This is a text-level guard over real repo files (same technique as
// skillCatalogBoundary.test.ts's cross-check of commands.ts against
// service/skills/library.jsonl) — it cannot verify the C++ actually COMPILES (this task's
// native build is deferred this session), only that the source text keeps the seam the
// plan requires.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // ui/src/agent/skillFoundry
const REPO = resolve(here, "../../../..");

const NATIVE_READ_NAMES = [
  "read_certified_skill_packages",
  "read_skill_source_status",
  "read_certified_native_skills",
] as const;

// ── native-source-side checks (plain text, no compiler) ─────────────────────────────

describe("native reads never enter the MoshOps command surface (src/moshops/*.cpp)", () => {
  const moshopsDir = resolve(REPO, "src/moshops");
  const moshopsFiles = readdirSync(moshopsDir).filter((f) => f.endsWith(".cpp") || f.endsWith(".h"));

  it("scans a non-empty set of moshops source files (guards against a silently-empty glob)", () => {
    expect(moshopsFiles.length).toBeGreaterThanOrEqual(10);
  });

  for (const name of NATIVE_READ_NAMES) {
    it(`"${name}" appears nowhere under src/moshops/`, () => {
      const hits = moshopsFiles.filter((f) =>
        readFileSync(resolve(moshopsDir, f), "utf8").includes(`"${name}"`),
      );
      expect(hits).toEqual([]);
    });
  }
});

describe("WebBridge.cpp: each native read is its own top-level, threaded, non-commandHandler registration", () => {
  const webBridgeSource = readFileSync(resolve(REPO, "src/webview/WebBridge.cpp"), "utf8");

  /** The exact text of ONE `.withNativeFunction` registration for `name`, from its
   *  `juce::Identifier ("name")` marker up to the NEXT `.withNativeFunction (` call (or,
   *  for the last registration in the chain, up to buildOptions()'s own closing —
   *  emitEvent's definition immediately follows it). */
  function nativeFunctionBlock(name: string): string {
    const marker = `juce::Identifier ("${name}")`;
    const start = webBridgeSource.indexOf(marker);
    expect(start, `${name} registration not found in WebBridge.cpp`).toBeGreaterThan(-1);
    const nextCall = webBridgeSource.indexOf(".withNativeFunction (", start + marker.length);
    const fallbackEnd = webBridgeSource.indexOf("void WebBridge::emitEvent", start);
    const end = nextCall !== -1 ? nextCall : fallbackEnd;
    expect(end, `could not bound the end of ${name}'s registration`).toBeGreaterThan(start);
    return webBridgeSource.slice(start, end);
  }

  /** execute_command's own handler body, bounded the same way — this is the ONLY block in
   *  the whole file that is allowed to reference `commandHandler`. */
  function executeCommandBlock(): string {
    const marker = `juce::Identifier ("execute_command")`;
    const start = webBridgeSource.indexOf(marker);
    expect(start).toBeGreaterThan(-1);
    const nextCall = webBridgeSource.indexOf(".withNativeFunction (", start + marker.length);
    expect(nextCall).toBeGreaterThan(start);
    return webBridgeSource.slice(start, nextCall);
  }

  it("execute_command's handler body mentions none of the three native read names", () => {
    const body = executeCommandBlock();
    for (const name of NATIVE_READ_NAMES) expect(body).not.toContain(name);
  });

  for (const name of NATIVE_READ_NAMES) {
    it(`"${name}" is a threaded relay straight into CertifiedSkillLoader, never commandHandler`, () => {
      const block = nativeFunctionBlock(name);
      expect(block).toContain("juce::Thread::launch");
      expect(block).toContain("juce::MessageManager::callAsync");
      expect(block).toContain("CertifiedSkillLoader::");
      expect(block).not.toContain("commandHandler");
      expect(block).not.toContain("asyncCommandHandler");
    });
  }
});

// ── TS-side checks ────────────────────────────────────────────────────────────────

describe("the agent command catalog never carries a native read name", () => {
  it("none of the three names is an AGENT_COMMANDS entry", async () => {
    const { AGENT_COMMAND_MAP } = await import("../commands");
    for (const name of NATIVE_READ_NAMES) expect(AGENT_COMMAND_MAP.has(name)).toBe(false);
  });

  it("none of the three names is a UI_ONLY_COMMANDS entry either — they were never MoshOps commands to exclude", async () => {
    const { UI_ONLY_COMMANDS } = await import("../commandClassification");
    for (const name of NATIVE_READ_NAMES) expect(name in UI_ONLY_COMMANDS).toBe(false);
  });
});

describe("nativeReads.ts wrappers call the dedicated bridge functions, never executeCommand", () => {
  const bridgeSpies = vi.hoisted(() => ({
    readCertifiedSkillPackages: vi.fn(async () => ({ schemaVersion: 1, ok: true, packages: [] })),
    readSkillSourceStatus: vi.fn(async () => ({ schemaVersion: 1, ok: true, statusIndex: null })),
    readCertifiedNativeSkills: vi.fn(async () => ({ schemaVersion: 1, ok: true, packages: [] })),
    executeCommand: vi.fn(async () => ({ ok: true })),
  }));

  vi.mock("../../bridge", async () => {
    const actual = await vi.importActual<typeof import("../../bridge")>("../../bridge");
    return { ...actual, ...bridgeSpies };
  });

  beforeEach(() => {
    for (const spy of Object.values(bridgeSpies)) spy.mockClear();
  });

  it("readCertifiedSkillPackagesV1 calls ONLY readCertifiedSkillPackages", async () => {
    const { readCertifiedSkillPackagesV1 } = await import("./nativeReads");
    await readCertifiedSkillPackagesV1();
    expect(bridgeSpies.readCertifiedSkillPackages).toHaveBeenCalledTimes(1);
    expect(bridgeSpies.readSkillSourceStatus).not.toHaveBeenCalled();
    expect(bridgeSpies.readCertifiedNativeSkills).not.toHaveBeenCalled();
    expect(bridgeSpies.executeCommand).not.toHaveBeenCalled();
  });

  it("readSkillSourceStatusV1 calls ONLY readSkillSourceStatus", async () => {
    const { readSkillSourceStatusV1 } = await import("./nativeReads");
    await readSkillSourceStatusV1();
    expect(bridgeSpies.readSkillSourceStatus).toHaveBeenCalledTimes(1);
    expect(bridgeSpies.readCertifiedSkillPackages).not.toHaveBeenCalled();
    expect(bridgeSpies.readCertifiedNativeSkills).not.toHaveBeenCalled();
    expect(bridgeSpies.executeCommand).not.toHaveBeenCalled();
  });

  it("readBundledNativeSkillsV1 calls ONLY readCertifiedNativeSkills", async () => {
    const { readBundledNativeSkillsV1 } = await import("./nativeReads");
    await readBundledNativeSkillsV1();
    expect(bridgeSpies.readCertifiedNativeSkills).toHaveBeenCalledTimes(1);
    expect(bridgeSpies.readCertifiedSkillPackages).not.toHaveBeenCalled();
    expect(bridgeSpies.readSkillSourceStatus).not.toHaveBeenCalled();
    expect(bridgeSpies.executeCommand).not.toHaveBeenCalled();
  });
});
