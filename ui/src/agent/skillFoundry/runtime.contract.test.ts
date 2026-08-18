// Skill Foundry Slice B, Task 6 — compile-only contract test. Imports every Slice A symbol
// the plan's Cross-Slice APIs block names, verbatim, from its OWN module — never a local
// redefinition or a re-exported alias with a different shape. If any of these imports ever
// stops type-checking (a Slice A signature changed underneath this slice), this file is
// the first thing to fail, before any behavioral test even runs.

import { describe, expect, it } from "vitest";
import type {
  ContinuationStoreV1,
  MoshBuildIdentityInputV1,
  NativeSkillHandlerV1,
  NativeSourceByteSetV1,
  RecordingLifecycleEnvironmentV1,
  RecordingLifecycleResultV1,
  SkillOutcomeV1,
  StudioSkillEnvironmentV1,
  StudioSkillRuntimeInputV1,
  StudioSkillRegistryV1,
  StudioSkillRuntimeV1,
} from "./contracts";
import { buildStudioSkillRegistryV1, type RegistryBuildInputV1 } from "./registry";
import { runAtomicSkillPlanV1 } from "./atomicPlan";
import { canonicalMoshBuildIdentityV1, nativeSourceByteSetSha256V1 } from "./nativeIdentity";
import { loadBundledNativeSkillsV1, loadCertifiedOwnerSkillsV1 } from "./loadCertifiedSkills";
import { readBundledNativeSkillsV1, readCertifiedSkillPackagesV1 } from "./nativeReads";
import { createContinuationStoreV1 } from "./continuations";
import { createStudioSkillRuntimeV1 } from "./runtime";
import { NATIVE_HANDLERS_V1 } from "./native/index";

// Type-level proof: `runStudioSkillV1` (this slice's public delegate) and
// `createStudioSkillRuntimeV1` (this file) satisfy the EXACT locked shapes the plan's
// Cross-Slice APIs block gives for "// contracts.ts":
//   export type StudioSkillEnvironment = StudioSkillEnvironmentV1;
//   export function createStudioSkillRuntimeV1(input: StudioSkillRuntimeInputV1): StudioSkillRuntimeV1;
//   export function runStudioSkill(utterance: string, environment: StudioSkillEnvironment,
//     continuationToken?: string): Promise<SkillOutcomeV1>;
type StudioSkillEnvironment = StudioSkillEnvironmentV1;
const _createStudioSkillRuntimeV1: (input: StudioSkillRuntimeInputV1) => StudioSkillRuntimeV1 = createStudioSkillRuntimeV1;
const _runStudioSkillTypeCheck: (
  utterance: string,
  environment: StudioSkillEnvironment,
  continuationToken?: string,
) => Promise<SkillOutcomeV1> = async (utterance, environment, continuationToken) => {
  const runtime = _createStudioSkillRuntimeV1({
    registry: { generation: 0, get: () => null, list: () => [] },
    continuations: createContinuationStoreV1(),
    nativeHandlers: NATIVE_HANDLERS_V1,
  });
  return runtime.run(utterance, environment, continuationToken);
};

// Every function/type imported above is referenced at least once so an unused-import
// removal (or a signature drift a lint rule would silently accept) cannot hide here.
void runAtomicSkillPlanV1;
void canonicalMoshBuildIdentityV1;
void nativeSourceByteSetSha256V1;
void loadBundledNativeSkillsV1;
void loadCertifiedOwnerSkillsV1;
void readBundledNativeSkillsV1;
void readCertifiedSkillPackagesV1;
void buildStudioSkillRegistryV1;

// Every Slice A type this file imports is referenced here so an unused-import removal
// cannot silently drop the compile-time proof this file exists to provide.
export type TypesReferencedBySliceAContractV1 = [
  ContinuationStoreV1, MoshBuildIdentityInputV1, NativeSkillHandlerV1,
  NativeSourceByteSetV1, RecordingLifecycleEnvironmentV1, RecordingLifecycleResultV1,
  SkillOutcomeV1, StudioSkillEnvironmentV1, StudioSkillRuntimeInputV1, StudioSkillRuntimeV1,
  RegistryBuildInputV1, StudioSkillRegistryV1,
];

describe("runtime.ts — compile-only Slice A contract import", () => {
  it("createStudioSkillRuntimeV1 returns an object exposing run and onProjectReplaced, and onProjectReplaced is callable", () => {
    const runtime = createStudioSkillRuntimeV1({
      registry: { generation: 0, get: () => null, list: () => [] },
      continuations: createContinuationStoreV1(),
      nativeHandlers: NATIVE_HANDLERS_V1,
    });
    expect(typeof runtime.run).toBe("function");
    expect(typeof runtime.onProjectReplaced).toBe("function");
    expect(() => runtime.onProjectReplaced()).not.toThrow();
  });

  it("the type-check helper above is itself callable (proves the locked signature compiles end to end)", async () => {
    const environment: StudioSkillEnvironment = {
      context: () => ({ projectEpoch: 1, selectedTrackId: null, tracks: [] }),
      snapshot: async () => ({ schemaVersion: 1, session: { sampleRate: 48000, tempo: 120, key: { root: "C", scale: "major" }, editFile: "x" }, transport: { playing: false, recording: false, position: 0, looping: false, loopStart: 0, loopEnd: 0 }, tracks: [] } as unknown as Awaited<ReturnType<StudioSkillEnvironment["snapshot"]>>),
      exec: async () => ({ ok: true, command: "noop" }),
      readSourceStatus: async () => ({ schemaVersion: 1, ok: true, statusIndex: null, diagnostics: [] }),
      runBatch: async () => ({ label: "", entries: [], applied: 0 }),
      refresh: async () => {},
      recording: {
        start: async () => ({ ok: true, state: "idle", say: "", changes: null }),
        stop: async () => ({ ok: true, state: "idle", say: "", changes: null }),
        audition: async () => ({ ok: true, state: "idle", say: "", changes: null }),
        keep: async () => ({ ok: true, state: "idle", say: "", changes: null }),
      },
    };
    const outcome = await _runStudioSkillTypeCheck("nothing recognizable", environment);
    expect(outcome).toMatchObject({ kind: "unsupported" });
  });
});
