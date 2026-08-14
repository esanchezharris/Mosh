# Moshi Skill Foundry Slice A: Contract and Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the fail-closed Skill Foundry foundation: typed contracts, bounded validation, safe package reads, unified registry adapters, single-use continuations, and an atomic declarative executor that acts only through the existing MoshOps transaction seam.

**Architecture:** Native C++ performs bounded, fixed-root, read-only filesystem admission and returns exact UTF-8 package bytes through non-MoshOps bridge functions. TypeScript owns schemas, SHA-256 binding, source/release validation, collision-free registry construction, declarative preflight, and transaction orchestration; the engine remains authoritative for transaction admission and rollback. Slice A exposes interfaces for later runtime, authoring, and certification slices without enabling routing, installation, or a new producer journey.

**Tech Stack:** TypeScript 5.6, Vitest 2, JUCE 8/C++20, Catch2, Web Crypto SHA-256, existing MoshOps identified transactions.

**Spec:** `docs/superpowers/specs/2026-08-14-moshi-skill-foundry-design.md`

## Global Constraints

- Mosh is the only runtime and certification target; Ableton is reference-only and no component may require it.
- Every mutation remains behind the existing MoshOps command, transaction, event, undo, and JSONL seams.
- Snapshot and event changes remain additive; existing consumers stay valid.
- Local skills are declarative JSON and cannot contain executable code; only audited native TypeScript handlers may express lifecycle behavior unavailable to the declarative language.
- Owner-local v1 manifests must use `execution.mode: "atomic"` and the fixed owner-local catalog; `lifecycle` and `best_effort` remain native-only.
- `execution.confirmation` is review-bound behavior: `always` and ambiguity-triggered confirmation must complete through a typed, stale-checked continuation before `batch_begin`; cancellation and unconfirmed work mutate nothing.
- No arbitrary scripts, JavaScript, shell commands, network calls, filesystem paths, interpolation, URL fetches, or environment expansion may enter a manifest.
- `service/skills/library.jsonl` remains offline evidence and is never scanned by the packaged app.
- Owner packages load only at app startup; there is no runtime install/write tool, watcher, or hot reload.
- `$MOSH_AGENT_DIR` defaults to `$HOME/Library/Mosh/agent`; an override must be absolute and owner-owned, and the root plus `skills/certified` must be neither symlinks nor group/world writable.
- Tests override installed roots and never read the owner's real skills or drafts.
- Manifest prose is bounded untrusted JSON, never instruction text; packaged builds retain zero raw-command or developer-loop fallback.
- Skill IDs match `[a-z0-9]+(?:-[a-z0-9]+)*`, are at most 64 ASCII characters, and versions are SemVer without build metadata.
- Exact stored UTF-8 bytes determine artifact hashes; canonical JSON is used only for derived catalog fingerprints.
- Untrusted artifact failures return discriminated results and never throw across startup/runtime boundaries.

---

## Slice Boundary and File Map

This plan does not wire four-core routing (Slice B), the Live composer (C), `teach-moshi` writers/source intake (D), or certification/QA candidate loading/owner proof (E).

Create focused modules under `ui/src/agent/skillFoundry/`:

| File | Responsibility |
| --- | --- |
| `contracts.ts`, `limits.ts`, `hash.ts` | V1 wire types, exact caps, exact-byte/canonical hashes. |
| `catalogs.ts`, `validate.ts` | Closed primitive catalogs and non-throwing artifact parsers. |
| `packageValidation.ts` | Manifest/report/approval/release/source/compatibility chain. |
| `registry.ts`, `nativeAdapter.ts`, `declarativeAdapter.ts` | Identity policy, atomic registry construction, origin adapters. |
| `nativeIdentity.ts` | Canonical native source-byte-set and build-identity validation. |
| `nativeReads.ts` | Typed wrappers for the three non-MoshOps native reads; no registry adaptation. |
| `continuations.ts` | Bounded, single-use in-memory choices. |
| `atomicPlan.ts` | Trusted identified-transaction runner extracted from `skillHarness.ts`. |
| `primitives.ts`, `declarativeExecutor.ts` | Closed preflight/postconditions and seven-phase atomic execution. |
| `loadCertifiedSkills.ts` | Startup parsing, quarantine, active-only owner candidates. |

Create `src/agent/CertifiedSkillLoader.{h,cpp}`, `tests/test_certified_skill_loader.cpp`, and `ui/scripts/verifySkillIdentityUniverse.mts`. Modify `CMakeLists.txt`, `tests/CMakeLists.txt`, `src/webview/WebBridge.cpp`, `src/moshops/MoshOpsInternal.h`, `ui/package.json`, `ui/src/types.ts`, `ui/src/bridge.ts`, and `ui/src/agent/skillHarness{,.test}.ts` only as named below. Tests are colocated `*.test.ts`.

## Cross-Slice APIs

Use these names exactly:

```ts
// contracts.ts
export type ParseIssueV1 = { readonly code:string; readonly path:string; readonly message:string };
export type ParseResult<T> = { readonly ok:true; readonly value:T }
  | { readonly ok:false; readonly issues:readonly ParseIssueV1[] };
export type RecordingLifecycleEnvironmentV1 = {
  readonly start:(bar?:number) => Promise<RecordingLifecycleResultV1>;
  readonly stop:() => Promise<RecordingLifecycleResultV1>;
  readonly audition:(delta:-1|1) => Promise<RecordingLifecycleResultV1>;
  readonly keep:() => Promise<RecordingLifecycleResultV1>;
};
export type StudioSkillEnvironmentV1 = {
  readonly context: () => StudioContext;
  readonly snapshot: () => Promise<Snapshot>;
  readonly exec: (command:string, args:Record<string,unknown>, transaction?:TxnMeta) => Promise<BridgeResult>;
  readonly readSourceStatus: () => Promise<SkillSourceStatusReadV1>;
  readonly runBatch: (label:string, calls:readonly AgentCommandCall[]) => Promise<ChangeSet>;
  readonly refresh: () => Promise<void>;
  readonly recording: RecordingLifecycleEnvironmentV1;
  readonly newId?: () => string;
  readonly nowMs?: () => number;
};
export type StudioSkillRuntimeInputV1 = {
  readonly registry:StudioSkillRegistryV1;
  readonly continuations:ContinuationStoreV1;
  readonly nativeHandlers:Readonly<Record<NativeSkillPayloadV1["handlerKey"],NativeSkillHandlerV1>>;
  readonly now?:() => number;
};
export type StudioSkillRuntimeV1 = {
  readonly run:(utterance:string, environment:StudioSkillEnvironmentV1, continuationToken?:string) => Promise<SkillOutcomeV1>;
  readonly onProjectReplaced:() => void;
};
export interface ContinuationStoreV1 {
  issue(payload:ContinuationPayloadV1):ContinuationIssueResultV1;
  take(token:string, nowMs:number):ContinuationTakeResultV1;
  clear():void;
}
```

```ts
// catalogs.ts
export const NATIVE_SKILL_IDS_V1: readonly NativeSkillPayloadV1["id"][];
export const OWNER_PRIMITIVES_V1: OwnerPrimitiveCatalogV1;
export const OWNER_PREDICATES_V1: OwnerPredicateCatalogV1;
export async function catalogFingerprintV1(): Promise<CatalogFingerprintV1>;
// nativeIdentity.ts
export async function nativeSourceByteSetSha256V1(input:NativeSourceByteSetV1): Promise<string>;
export function canonicalMoshBuildIdentityV1(input:MoshBuildIdentityInputV1): ParseResult<string>;
// packageValidation.ts
export async function validateCertifiedSkillPackageV1(input:CertifiedSkillPackageBytesV1, context:SkillCompatibilityContextV1): Promise<PackageValidationResultV1>;
export async function validateNativeArtifactGraphV1(input:NativeArtifactGraphInputV1, context:SkillCompatibilityContextV1): Promise<NativeArtifactGraphValidationResultV1>;
export function validateSourceStatusForInvocationV1(input:SourceStatusCheckInputV1): SourceStatusCheckResultV1;
// registry.ts
export async function buildStudioSkillRegistryV1(input:RegistryBuildInputV1): Promise<RegistryBuildResultV1>;
export function validateRegistryCandidateV1(candidate:RegistryCandidateV1, occupied:RegistryIdentitySetV1): RegistryCandidateValidationV1;
export function validateReleaseIdentityUniverseV1(input:ReleaseIdentityUniverseInputV1): ReleaseIdentityUniverseResultV1;

// nativeReads.ts
export function readCertifiedSkillPackagesV1(): Promise<CertifiedSkillLoadV1>;
export function readSkillSourceStatusV1(): Promise<SkillSourceStatusReadV1>;
export function readBundledNativeSkillsV1(): Promise<CertifiedNativeSkillLoadV1>;
```

```ts
// atomicPlan.ts
export type AtomicSkillGuardPhaseV1 = "before_begin" | "before_commit";
export type AtomicSkillPlanV1 = {
  readonly skill:string; readonly version:string;
  readonly slots:Readonly<Record<string,SlotValueV1>>;
  readonly before:Snapshot; readonly transaction:SkillTransactionPlan;
  readonly verifyPostcondition:(before:Snapshot, after:Snapshot, changes:SkillExecutionSummary) => SkillCheck | Promise<SkillCheck>;
};
export type AtomicSkillGuardContextV1 = {
  readonly skill:string; readonly version:string; readonly transactionId:string;
  readonly before:Snapshot; readonly after?:Snapshot;
};
export type AtomicSkillPlanDepsV1 = {
  readonly snapshot:() => Promise<Snapshot>; readonly exec:SkillHarnessDeps["exec"];
  readonly guard:(phase:AtomicSkillGuardPhaseV1, context:AtomicSkillGuardContextV1) => Promise<SkillCheck>;
};
export function runAtomicSkillPlanV1(plan:AtomicSkillPlanV1, deps:AtomicSkillPlanDepsV1): Promise<SkillRunResult>;
```

Slice B owns `skillFoundry/runtime.ts` and `createStudioSkillRuntimeV1(input: StudioSkillRuntimeInputV1): StudioSkillRuntimeV1`.

---

### Task 1: Freeze Contracts, Limits, and Hash Semantics

**Files:**
- Create: `ui/src/agent/skillFoundry/contracts.ts`
- Create: `ui/src/agent/skillFoundry/limits.ts`
- Create: `ui/src/agent/skillFoundry/hash.ts`
- Test: `ui/src/agent/skillFoundry/contracts.test.ts`

**Interfaces:**
- Consumes: existing `Snapshot`, `ChangeSet`, `TxnMeta`, `BridgeResult`, and skill harness result/check types.
- Produces: every `*V1` schema in spec Sections 6.2, 7.2, 8.1-8.6, 10.3; `SKILL_LIMITS_V1`, `FOUNDRY_LIMITS_V1`; `utf8Bytes`, `sha256Bytes`, `canonicalJsonBytes`.

- [ ] **Step 1: Write the failing constants/hash tests**

```ts
expect(SKILL_LIMITS_V1).toMatchObject({ maxLoadedLocalSkills:64, manifestBytes:65536,
  certificationBytes:262144, approvalBytes:16384, releaseBytes:4096,
  startupPackageBytes:8388608, activationEntries:64, sourceStatusEntries:256,
  choices:5, continuations:16, continuationTtlMs:600000, continuationInvalidAttempts:3 });
expect(await sha256Bytes(utf8Bytes("a\n"))).toBe("87428fc522803d31065e7bce3cf03fe475096631e5e07bbd7a0fde60c4cf25c7");
expect(new TextDecoder().decode(canonicalJsonBytes({z:1,a:[true,"é"]}))).toBe('{"a":[true,"é"],"z":1}');
```

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/contracts.test.ts`

Expected: FAIL because all three modules are absent.

The hash literal above is the **verified** digest — `printf 'a\n' | shasum -a 256` reproduces it exactly. If `sha256Bytes` disagrees, the implementation is wrong; **never** paste your own output back into the assertion to reach GREEN. That assertion is the only thing pinning exact-byte hashing, and the whole slice's integrity chain rests on it. (An earlier revision of this plan carried a 63-character literal that diverged at character 49 — a paste-back would have turned this test into a tautology.)

- [ ] **Step 3: Define exact contracts and quotas**

Copy field-for-field types for `SourceStatusV1`, `SkillManifestV1`, `SkillReleaseV1`, `SkillActivationIndexV1`, `SourceRefV1`, `SkillArtifactRefV1`, `CertificationReportV1`, `SkillApprovalV1`, `NativeSkillPayloadV1`, `NativeSkillBundleEntryV1`, `NativeReleaseVerificationV1`, `SkillSlotV1`, `ValueRefV1`, `SkillStepV1`, `PredicateV1`, `SkillOutcomeV1`, `SkillChoiceV1`, `RecordingLifecycleResultV1`, `RecordingLifecycleEnvironmentV1`, `NativeSkillHandlerV1`, `StudioSkillRegistryV1`, `NativeSourceByteSetV1`, `MoshBuildIdentityInputV1`, `AbletonReferenceV1`, and `ManualEvidenceV1`. `SkillManifestV1.execution.confirmation` remains the required union `"never"|"on_ambiguity"|"always"`; it is neither defaulted nor normalized before exact-byte review hashing. This task also freezes two types the spec never names but that later slices consume across separate worktrees — `ResolvedTargetIdentityV1` (Task 6/8 guard comparisons) and `CatalogFingerprintV1` (`catalogs.ts`, `SkillCompatibilityContextV1`) — defined explicitly below rather than left to an implementer to guess. Use this exact outcome-code union:

```ts
export type SkillReasonCodeV1 = "no_match"|"ambiguous_skill"|"missing_slot"|"invalid_slot"|
  "missing_target"|"ambiguous_target"|"stale_context"|"observation_failed"|
  "manifest_stale"|"command_failed"|"rollback_failed"|"postcondition_failed"|
  "missing_primitive"|"provider_unavailable"|"timeout"|"unsupported_intent";
```

Define native-read wire types with exact bytes:

```ts
export type CertifiedSkillFileV1 = { readonly name:string; readonly bytes:number; readonly sha256:string; readonly utf8:string };
export type CertifiedSkillPackageBytesV1 = { readonly directoryName:string; readonly skillIdFromDirectory:string; readonly versionFromDirectory:string; readonly files:{ readonly skill:CertifiedSkillFileV1; readonly certification:CertifiedSkillFileV1; readonly approval:CertifiedSkillFileV1; readonly release:CertifiedSkillFileV1 } };
export type CertifiedSkillLoadV1 = { readonly schemaVersion:1; readonly ok:boolean; readonly activeIndex:CertifiedSkillFileV1|null; readonly sourceStatusIndex:CertifiedSkillFileV1|null; readonly packages:readonly CertifiedSkillPackageBytesV1[]; readonly diagnostics:readonly CertifiedSkillLoadDiagnosticV1[]; readonly totalBytes:number };
export type SkillSourceStatusReadV1 = { readonly schemaVersion:1; readonly ok:boolean; readonly statusIndex:CertifiedSkillFileV1|null; readonly diagnostics:readonly CertifiedSkillLoadDiagnosticV1[] };
export type CertifiedNativeSkillLoadV1 = { readonly schemaVersion:1; readonly ok:boolean; readonly build:{readonly appVersion:string;readonly gitCommit:string;readonly gitState:"clean"|"dirty"|"unknown";readonly moshBuildIdentity:string}; readonly resourceIndex:CertifiedSkillFileV1|null; readonly packages:readonly CertifiedNativeSkillPackageBytesV1[]; readonly diagnostics:readonly CertifiedSkillLoadDiagnosticV1[]; readonly totalBytes:number };
```

Use these exact identity inputs; validators accept noncanonical strings so they can return typed failures rather than hiding them behind TypeScript:

```ts
export type NativeSourceByteSetV1 = { readonly schemaVersion:1; readonly files:readonly {readonly path:string;readonly bytes:Uint8Array}[] };
export type MoshBuildIdentityInputV1 = { readonly appVersion:string; readonly gitCommit:string; readonly gitState:"clean"|"dirty"|"unknown"; readonly target:string; readonly configuration:string; readonly architecture:string };
export type ContinuationChoiceValueV1 = { readonly id:string; readonly label:string; readonly value:SlotValueV1 };
```

Define the target-staleness identity captured at resolution time (Task 8's preflight) and compared by both continuation guards (Task 6/8), and the catalog fingerprint that fills `SkillManifestV1.compatibility`'s three fields verbatim:

```ts
export type ResolvedTargetKindV1 = "track"|"clip"|"plugin"|"take";
export type ResolvedTargetIdentityV1 = {
  readonly kind:ResolvedTargetKindV1;
  readonly id:string;
  readonly name:string;
  readonly catalogId?:string;
};
export type CatalogFingerprintV1 = {
  readonly schemaVersion:1;
  readonly commandCatalogSha256:string;
  readonly predicateCatalogVersion:number;
  readonly resolverCatalogVersion:number;
};
```

Guards compare a captured `ResolvedTargetIdentityV1` against a freshly resolved target by exact structural equality — every field, including an absent `catalogId` — before proceeding through `before_begin`/`before_commit`; any difference is `stale_context`. `kind` covers every primitive/predicate target shape Task 2's closed catalog can resolve (`selected_track`, `track_by_unique_name`, and `plugin_by_name` resolve `"track"`/`"plugin"`; `"clip"`/`"take"` are reserved for later slices' resolvers so the union does not need to grow when they land); `id` is the resolved entity's stable snapshot ID; `name` and the optional `catalogId` (set only for `"plugin"`, per Task 2 Step 3's `PluginHost::idFor`) are the identity-bearing fields whose drift means the same ID now points at a different real thing.

`CatalogFingerprintV1` pins the three closed catalogs a manifest's `compatibility` block is checked against, matching `SkillManifestV1.compatibility.{commandCatalogSha256,predicateCatalogVersion,resolverCatalogVersion}` exactly: `commandCatalogSha256` is `sha256Bytes(canonicalJsonBytes(...))` over the closed `OWNER_PRIMITIVES_V1.observations` and `OWNER_PRIMITIVES_V1.mutations` descriptors (Task 2), keyed by primitive name — the same `canonicalJsonBytes`/`sha256Bytes` primitives this task defines, no second canonicalization path; `predicateCatalogVersion` is a hand-bumped integer constant pinned to the exact key set of `OWNER_PREDICATES_V1`; `resolverCatalogVersion` is a hand-bumped integer constant pinned to the exact key set of `OWNER_PRIMITIVES_V1.resolvers`. Task 2's `catalogFingerprintV1()` returns exactly this shape once those catalogs exist to fingerprint.

`SkillCompatibilityContextV1` carries exact `appVersion`, `gitCommit`, `gitState`, `moshBuildIdentity`, `CatalogFingerprintV1`, and the canonical source-set SHA keyed by native handler; do not create a second compatibility context in an adapter.

- [ ] **Step 4: Implement hashing and pass tests**

`sha256Bytes` uses `crypto.subtle.digest("SHA-256", bytes)`. `canonicalJsonBytes` recursively sorts object keys, preserves array order, and rejects undefined/functions/symbols/non-finite numbers/cycles. Artifact bytes are never canonicalized.

Run: `cd ui && npm test -- --run src/agent/skillFoundry/contracts.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/agent/skillFoundry/{contracts,limits,hash,contracts.test}.ts
git commit -m "feat(agent): define skill foundry v1 contracts"
```

---

### Task 2: Close the Primitive Catalog and Validate Manifests

**Files:**
- Create: `ui/src/agent/skillFoundry/catalogs.ts`
- Create: `ui/src/agent/skillFoundry/validate.ts`
- Test: `ui/src/agent/skillFoundry/catalogs.test.ts`
- Test: `ui/src/agent/skillFoundry/validate.test.ts`
- Modify: `src/moshops/MoshOpsInternal.h:219-229`
- Modify: `ui/src/types.ts:368-380`

**Interfaces:**
- Consumes: Task 1 contracts/limits/hash, `PluginHost::idFor`, and current snapshot types.
- Produces: locked catalog exports and non-throwing `parse*V1(raw): ParseResult<T>` functions, including `parseNativeSkillPayloadV1`, `parseNativeSkillBundleEntryV1`, and `parseNativeReleaseVerificationV1`.

- [ ] **Step 1: Write RED catalogs/parser tests**

```ts
expect(Object.keys(OWNER_PRIMITIVES_V1.observations)).toEqual(["current_snapshot","list_plugins"]);
expect(Object.keys(OWNER_PRIMITIVES_V1.resolvers)).toEqual(["selected_track","track_by_unique_name","plugin_by_name"]);
expect(Object.keys(OWNER_PRIMITIVES_V1.mutations)).toEqual(["set_track_volume","set_track_mute","set_track_solo","load_plugin"]);
expect(Object.keys(OWNER_PREDICATES_V1)).toEqual(["not_recording","project_epoch_unchanged","selected_track_is","track_exists","track_volume_equals","track_mute_equals","track_solo_equals","plugin_instance_added_once"]);
```

Create `validOwnerManifest()` and table-drive invalid namespace, SemVer build metadata, unknown fields, non-atomic mode, unknown primitive/predicate, optional referenced slot, unsafe ID literal, non-finite bounds, `maxMutations` 0/33, `timeoutMs` 99/120001, and `maxChoices` 0/6.

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/catalogs.test.ts src/agent/skillFoundry/validate.test.ts`

Expected: FAIL because catalogs/parsers are absent.

- [ ] **Step 3: Implement closed descriptors and additive plug-in identity**

Pin native IDs `session-control`, `capture-review-choose-take`, `explicit-balance`, `load-named-plugin`; pin alias `{load_named_plugin:"load-named-plugin"}`. Encode argument types, permitted `ValueRefV1` sources, transaction class, and result schema. In `addExternalPluginMetadata`, add `o.setProperty ("catalogId", PluginHost::idFor (plugin.desc));`; add `catalogId?: string` to `Plugin`. Missing identity fails `plugin_instance_added_once` closed.

`MoshOpsInternal.h` does **not** currently include `PluginHost.h` (it includes `state/Ids.h`, `plugins/spectral/MasterSpectralTapPlugin.h`, and conditionally `plugins/transform/RaveInsertPlugin.h`), so this edit also needs `#include "plugins/hosting/PluginHost.h"` — `PluginHost::idFor` is declared at `src/plugins/hosting/PluginHost.h:102`. **This task's own GREEN command is TypeScript-only and no Catch2 target compiles this header**, so the edit is unverified until Task 4's app build compiles it. Hand the exact header hunk to Task 4 as a known-unverified change, and do not consider Task 2 proven until that build is green. `MoshOpsInternal.h` is included by every `MoshOps*.cpp` translation unit, so this one line forces a large recompile — landing Task 2 before Task 4's app build lets one rebuild absorb both.

- [ ] **Step 4: Implement parsers and every boundary pair**

Reject unknown keys; accumulate `{code,path,message}`. Use `^[A-Za-z][A-Za-z0-9_-]{0,63}$` for slot/bind/tag/source/claim IDs. Validate required/default graphs, finite ordered numeric bounds, `each` only on bounded string lists, duplicate bindings/entities, and reference-source rules. Strictly parse native payload, bundle-entry, and external release-verification schemas here as well; later slices import these parsers rather than redefining them. Add exact-limit acceptance plus one-over rejection for every Section 8.1 cap, counting Unicode scalars with `[...text].length` and bytes with `TextEncoder`.

Run: `cd ui && npm test -- --run src/agent/skillFoundry/catalogs.test.ts src/agent/skillFoundry/validate.test.ts && npm run typecheck`

Expected: PASS at every boundary; one-over cases return issues without throwing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/agent/skillFoundry/{catalogs,validate,catalogs.test,validate.test}.ts src/moshops/MoshOpsInternal.h ui/src/types.ts
git commit -m "feat(agent): validate bounded declarative skills"
```

---

### Task 3: Validate Source and Release Hash Chains

**Files:**
- Create: `ui/src/agent/skillFoundry/packageValidation.ts`
- Create: `ui/src/agent/skillFoundry/nativeIdentity.ts`
- Test: `ui/src/agent/skillFoundry/packageValidation.test.ts`
- Test: `ui/src/agent/skillFoundry/nativeIdentity.test.ts`

**Interfaces:**
- Consumes: artifact parsers, exact-byte hash, catalog fingerprint, exact repo-relative source bytes, and build metadata.
- Produces: locked package/source/native-identity functions, the sole pure `validateNativeArtifactGraphV1`, and `ValidatedDeclarativeSkillV1`.

- [ ] **Step 1: Write RED chain/staleness tests**

Build a fixture whose report binds the manifest SHA, approval binds artifact/report, release binds manifest/report/approval, and active entry binds manifest/release. Mutate one byte of each file and expect `hash_mismatch`; separately change only `execution.confirmation`, rebuild the candidate bytes, and prove the artifact/review SHA changes and the prior report/approval/release are invalid. Add the native graph `payload -> report/approval -> bundle entry -> external release verification`; reject every downstream hash in the payload, swapped references, catalog/native-source/build mismatches, and any release-verification path inside the bundle. Test missing/malformed source index, digest mismatch, stale/superseded/revoked/expired source, compatibility mismatches, wrong report/approval/release state, wrong review SHA, and directory ID/version mismatch.

For every native handler, test a sorted source-byte set, reordered input stability, one-byte source change sensitivity, duplicate/absolute/escaping/missing paths, dirty or unknown Git state, non-40-hex commit, app-version mismatch, catalog-fingerprint mismatch, and build-identity mismatch. The only accepted build identity is `git=<40-lower-hex>|version=<SemVer>|target=Mosh|configuration=Release|architecture=arm64`.

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/packageValidation.test.ts src/agent/skillFoundry/nativeIdentity.test.ts`

Expected: FAIL because validator is absent.

- [ ] **Step 3: Implement exact chain validation**

Re-encode each `utf8`, verify native `bytes`/`sha256`, enforce its cap before JSON parsing, and never canonicalize it. Compute:

```ts
const reviewSha256 = await sha256Bytes(utf8Bytes(
  `mosh-skill-review-v1\n${artifactSha256}\n${certificationReportSha256}\n`,
));
```

`validateSourceStatusForInvocationV1` compares fresh index generation/digests/state/expiry against the frozen skill. Return `manifest_stale` for drift and `observation_failed` for unreadable native data. `validateNativeArtifactGraphV1` is the only semantic validator for native payload/report/approval/entry/release edges; Slice E may build artifacts but must call this function.

`nativeSourceByteSetSha256V1` copies each input byte array, sorts normalized repo-relative paths, and hashes `canonicalJsonBytes({schemaVersion:1,files:[{path,bytes,sha256}]})`, where `bytes` is the byte count and each inner SHA covers the exact stored source bytes. The payload's `nativeSourceSha256` and command/predicate/resolver compatibility fields must reproduce that digest and the exact `catalogFingerprintV1()`; the bundle entry and external release envelope bind the canonical `moshBuildIdentity`. The loader build envelope's app SemVer, 40-character lowercase Git commit, state, and identity must equal the compatibility context and the tuple parsed from that bundle identity. Build identity is deliberately not embedded in payload bytes. `dirty`, `unknown`, Debug, wrong architecture, stale commit, catalog/source drift, or any mismatch fails closed.

- [ ] **Step 4: Run GREEN and commit**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/packageValidation.test.ts src/agent/skillFoundry/nativeIdentity.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add ui/src/agent/skillFoundry/packageValidation{,.test}.ts ui/src/agent/skillFoundry/nativeIdentity{,.test}.ts
git commit -m "feat(agent): validate certified skill packages"
```

---

### Task 4: Add the Native Safe Loader and Non-MoshOps Bridge Reads

**Files:**
- Create: `src/agent/CertifiedSkillLoader.h`
- Create: `src/agent/CertifiedSkillLoader.cpp`
- Create: `tests/test_certified_skill_loader.cpp`
- Modify: `CMakeLists.txt`
- Modify: `tests/CMakeLists.txt`
- Modify: `src/webview/WebBridge.cpp:145-250`
- Modify: `ui/src/bridge.ts:35-130`
- Create: `ui/src/agent/skillFoundry/nativeReads.ts`
- Test: `ui/src/agent/skillFoundry/nativeBridgeBoundary.test.ts`

**Interfaces:**
- Produces: `CertifiedSkillLoader::{read,readFromEnvironment,readSourceStatus,readSourceStatusFromEnvironment,readBundledNative,readBundledNativeFromApplication}` plus the exact `nativeReads.ts` wrappers `readCertifiedSkillPackagesV1`, `readSkillSourceStatusV1`, and `readBundledNativeSkillsV1`.

- [ ] **Step 1: Write RED Catch2 topology tests**

```cpp
auto result = CertifiedSkillLoader::read (rootWithValidPackage ("owner-safe", "1.0.0"));
REQUIRE ((bool) result.getProperty ("ok", false));
REQUIRE (result.getProperty ("packages", var()).size() == 1);
```

Add cases for relative override, wrong UID, symlinked/writable root or certified dir, missing root, invalid UTF-8, hard link, FIFO, extra/missing file, nested dir, path escape, invalid `<id>@<version>`, each file cap, 64/65 packages, and 8 MiB/one-byte-over total. Separately fixture the fixed application-resource native index and four-file native packages; reject missing/extra/link/oversized/tampered entries without consulting `$MOSH_AGENT_DIR`.

- [ ] **Step 2: Register tests and run RED**

Run: `cmake --preset macos-arm64-debug && cmake --build --preset macos-arm64-tests && build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[skillfoundry][loader]"`

Expected: compile failure because loader files are absent.

- [ ] **Step 3: Implement the engine-free loader**

```cpp
struct CertifiedSkillLoader {
  static juce::File resolveAgentRoot (const juce::String& overrideDir);
  static juce::var read (const juce::File& agentRoot);
  static juce::var readFromEnvironment();
  static juce::var readSourceStatus (const juce::File& agentRoot);
  static juce::var readSourceStatusFromEnvironment();
  static juce::var readBundledNative (const juce::File& resourcesRoot);
  static juce::var readBundledNativeFromApplication();
};
```

Use `lstat`/`fstat`, current UID, `O_NOFOLLOW|O_CLOEXEC`, regular-file/link-count-one checks, inode/device recheck, pre-allocation caps, exact reads, strict UTF-8/no NUL, `juce::SHA256`, one-level ASCII-sorted traversal, exactly four files, and bounded diagnostics. Root-security failure returns zero packages; a bad package is omitted while safe siblings remain. C++ does no semantic certification. CMake tracks `.git/HEAD` plus its referenced ref, embeds the exact Git commit, `PROJECT_VERSION`, target/configuration/architecture tuple, and exposes them in `CertifiedNativeSkillLoadV1.build`; unavailable Git becomes `unknown`, never a guessed value.

- [ ] **Step 4: Add dedicated bridge reads**

Register `read_certified_skill_packages`, `read_skill_source_status`, and `read_certified_native_skills` as three independent top-level `.withNativeFunction(...)` entries in `WebBridge::buildOptions`, each following the **threaded-relay pattern already used by `brain_chat`/`escalate_candidates`/`archive_pair`** (`src/webview/WebBridge.cpp:251-317`): `juce::Thread::launch ([...] { auto result = <read>(); juce::MessageManager::callAsync ([completion, result]() mutable { completion (result); }); });`. This is a different shape from the `list_directory` special case (`WebBridge.cpp:195-208`), which is dispatched *inside* the `execute_command` handler via `asyncCommandHandler` and therefore still passes through `commandHandler` and telemetry's command-name redaction — the three skill reads must never enter that path: never routed through `commandHandler`, never appear in `AGENT_COMMANDS` or MoshOps, and never reachable via `execute_command`'s `args[0].command` dispatch. Each launched thread calls the matching loader entry point directly — `CertifiedSkillLoader::readFromEnvironment()`, `readSourceStatusFromEnvironment()`, `readBundledNativeFromApplication()` — never the message thread, since Task 4 Step 3's filesystem admission does blocking `lstat`/`fstat`/read syscalls; each resolves its JUCE `var` back via `callAsync` exactly once. Keep literal bridge calls in `bridge.ts`, and put the public camel-case V1 wrappers in `skillFoundry/nativeReads.ts`; `nativeAdapter.ts` remains registry adaptation only. Mock/test returns explicit synthetic build identity and empty in-memory envelopes and never reads disk. A real missing binding rejects; production native adaptation rejects `dirty`, `unknown`, or payload/build mismatch.

- [ ] **Step 5: Run GREEN and commit**

Run: `cmake --preset macos-arm64-debug && cmake --build --preset macos-arm64-tests && cmake --build --preset macos-arm64-app && build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[skillfoundry][loader]"`

Run: `cd ui && npm test -- --run src/agent/skillFoundry/nativeBridgeBoundary.test.ts && npm run typecheck`

Expected: PASS; boundary test proves all three reads are non-MoshOps/model-inaccessible.

```bash
git add src/agent/CertifiedSkillLoader.* tests/test_certified_skill_loader.cpp CMakeLists.txt tests/CMakeLists.txt src/webview/WebBridge.cpp ui/src/bridge.ts ui/src/agent/skillFoundry/nativeReads.ts ui/src/agent/skillFoundry/nativeBridgeBoundary.test.ts
git commit -m "feat(agent): read certified skills safely"
```

---

### Task 5: Construct a Collision-Free Registry and Adapters

**Files:**
- Create: `ui/src/agent/skillFoundry/registry.ts`
- Create: `ui/src/agent/skillFoundry/nativeAdapter.ts`
- Create: `ui/src/agent/skillFoundry/declarativeAdapter.ts`
- Create: `ui/scripts/verifySkillIdentityUniverse.mts`
- Create: `tests/fixtures/skill-foundry/release-owner-active.json`
- Test: `ui/src/agent/skillFoundry/registry.test.ts`
- Test: `ui/src/agent/skillFoundry/adapters.test.ts`
- Test: `ui/src/agent/skillFoundry/skillIdentityUniverse.test.ts`
- Modify: `ui/package.json`
- Modify: `cmake/BuildUI.cmake`

`resources/skills/native/index.json` and `resources/skills/declarative/index.json` are never created in the source tree and never committed. Slice E's global constraints explicitly forbid tracking `resources/skills/native/` and enumerate "resource index" among what must not be committed; Slice A ships zero bundled skills of either origin (Task 9 Step 3 parses only the native resource envelope, and the declarative one has no real content yet), so the same argument applies to `resources/skills/declarative/` too — nothing here can populate either index with anything but an empty shell. `cmake/BuildUI.cmake` CMake-generates both as schema-valid **empty** indexes into the build/staging tree, the same mechanism this task already uses below for the owner active-index fixture (`MOSH_RELEASE_OWNER_ACTIVE_INDEX`).

**Interfaces:**
- Produces: locked registry functions, immutable `StudioSkillRegistryV1`, `adaptNativeSkillV1`, `adaptDeclarativeSkillV1`; no competing alias or alternate registry class.

- [ ] **Step 1: Write RED identity/adapter tests**

Reject owner IDs without `owner-`, built-ins without `builtin-`, all native IDs/aliases, case-folded duplicates, cross-origin duplicates, native payload/handler mismatch, native source/catalog/build mismatch, and payload/report/approval/bundle mismatch. Pin `load_named_plugin -> load-named-plugin`; similar examples/titles never create precedence. Feed `validateReleaseIdentityUniverseV1` a native bundled index (canonical IDs plus aliases), bundled-declarative index, and owner `active.json`; every cross-set ID/alias collision must fail.

```ts
const result = await buildStudioSkillRegistryV1({ generation:7, native:[native("load-named-plugin")], builtin:[], owner:[owner("owner-x"),owner("owner-x")] });
expect(result).toMatchObject({ok:false,code:"duplicate_identity"});
```

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/registry.test.ts src/agent/skillFoundry/adapters.test.ts src/agent/skillFoundry/skillIdentityUniverse.test.ts`

Expected: FAIL.

The identity-universe test lives at `ui/src/agent/skillFoundry/skillIdentityUniverse.test.ts`, **not** beside the `.mts` script. `ui/vitest.config.ts` sets `include: ["src/**/*.test.ts"]`, and a CLI filter narrows that set rather than extending it — a test under `ui/scripts/` is silently never collected, and "No test files found" for that filter reads as **green** in a run where the other two files pass. The cross-set ID/alias collision gate would ship untested. Test `validateReleaseIdentityUniverseV1` directly from `registry.ts` in `src/`; the `.mts` wrapper is exercised end-to-end by `npm run verify:skill-identities` in Step 4. Confirm the RED is a real import/assertion failure and never "No test files found".

- [ ] **Step 3: Implement atomic registry publication**

Build candidate/alias maps locally, validate all entries, then freeze/copy one registry. `get(idOrAlias)` lowercases ASCII and canonicalizes the one legacy alias. Any unexpected cross-source collision rejects the proposed generation; the caller retains its previous registry. Local invalid packages are quarantined before construction.

Native adapter binds only the closed handler map (`sessionControlV1`, `takeCycleV1`, `explicitBalanceV1`, `loadNamedPluginV1`) and consumes the Task 3 `validateNativeArtifactGraphV1` result; it does not implement a second graph checker. Declarative adapter accepts only `ValidatedDeclarativeSkillV1` and closes over its exact artifact.

Add `verify:skill-identities` to `ui/package.json`. `cmake/BuildUI.cmake` generates `resources/skills/native/index.json` and `resources/skills/declarative/index.json` as schema-valid **empty** indexes under `${CMAKE_BINARY_DIR}/skill-foundry/resources/skills/{native,declarative}/index.json` — never in the source tree — then adds always-run `MoshSkillIdentityGate`, passing `$<CONFIG>`, `PROJECT_VERSION`, target, architecture, those two generated bundled indexes, and `${CMAKE_BINARY_DIR}/skill-foundry/release-owner-active.json` before `Mosh` builds. CMake copies an explicitly supplied `MOSH_RELEASE_OWNER_ACTIVE_INDEX` there or generates the schema-valid empty production map; the fixture is test-only, and the gate never reads the real owner root. `git ls-files resources/skills/native/ resources/skills/declarative/` must return empty — Task 10 Step 4 asserts this directly. The script imports the same validator and exits nonzero on any canonical-ID or alias collision across all three inputs. In `Release` it also rejects dirty/unknown Git, stale commit, non-Release build identity, source-set hash drift, catalog drift, wrong version, or wrong architecture. Debug validates shapes/collisions but permits a dirty tree. Startup separately passes the actual parsed owner `active.json` through the same validator before atomic registry replacement.

- [ ] **Step 4: Run GREEN and commit**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/registry.test.ts src/agent/skillFoundry/adapters.test.ts src/agent/skillFoundry/skillIdentityUniverse.test.ts && npm run typecheck && npm run verify:skill-identities -- --configuration Debug`

Expected: PASS.

```bash
git add ui/src/agent/skillFoundry/{registry,nativeAdapter,declarativeAdapter,registry.test,adapters.test}.ts ui/scripts/verifySkillIdentityUniverse.mts ui/src/agent/skillFoundry/skillIdentityUniverse.test.ts ui/package.json cmake/BuildUI.cmake tests/fixtures/skill-foundry/release-owner-active.json
git commit -m "feat(agent): add collision-safe skill registry"
```

---

### Task 6: Add Bounded Single-Use Continuations

**Files:**
- Create: `ui/src/agent/skillFoundry/continuations.ts`
- Test: `ui/src/agent/skillFoundry/continuations.test.ts`

**Interfaces:**
- Produces: `ContinuationStoreV1.issue(payload)`, `.take(token,nowMs)`, `.clear()`.

- [ ] **Step 1: Write RED store tests**

Test token single-use, ten-minute expiry, 16-entry oldest-unused eviction, duplicate token rejection, clear, original-expiry preservation on reissue, attempts 1/2 then terminal at 3, and payload comparison fields. Use exact types:

```ts
type ContinuationPayloadBaseV1 = { readonly skillId:string; readonly version:string; readonly artifactSha256:string; readonly choices:readonly ContinuationChoiceValueV1[]; readonly targetIdentities:readonly ResolvedTargetIdentityV1[]; readonly projectEpoch:number; readonly registryGeneration:number; readonly sourceStatusGeneration:number; readonly createdAtMs:number; readonly expiresAtMs:number; readonly attempts:number };
export type ContinuationPayloadV1 = ContinuationPayloadBaseV1 & (
  | { readonly pendingKind:"choice"; readonly pendingSlot:string; readonly choiceReason:"ambiguity"|"missing_slot"; readonly confirmationPlanSha256?:never }
  | { readonly pendingKind:"confirmation"; readonly pendingSlot:"confirmation"; readonly confirmationPlanSha256:string }
);
export type ContinuationIssueResultV1 = {readonly ok:true;readonly token:string;readonly expiresAtMs:number}|{readonly ok:false;readonly code:"invalid_payload"|"token_collision"};
export type ContinuationTakeResultV1 = {readonly ok:true;readonly payload:ContinuationPayloadV1}|{readonly ok:false;readonly code:"unknown_token"|"expired"};
```

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/continuations.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement and run GREEN**

Constructor injects clock/random; default token is 32 random bytes from `crypto.getRandomValues`, hex encoded. `take` deletes before returning. Runtime compares artifact/project/registry/source/target fields and, for confirmation, the recompiled `confirmationPlanSha256`; it reissues invalid replies with `attempts+1` and original timestamps and returns blocked `invalid_slot` at attempt 3. Project replacement or registry generation change calls `clear()`.

Run: `cd ui && npm test -- --run src/agent/skillFoundry/continuations.test.ts && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/agent/skillFoundry/continuations{,.test}.ts
git commit -m "feat(agent): add bounded skill continuations"
```

---

### Task 7: Extract the Trusted Dynamic Atomic Runner

**Files:**
- Create: `ui/src/agent/skillFoundry/atomicPlan.ts`
- Test: `ui/src/agent/skillFoundry/atomicPlan.test.ts`
- Modify: `ui/src/agent/skillHarness.ts:181-640`
- Modify: `ui/src/agent/skillHarness.test.ts`

**Interfaces:**
- Produces: locked `runAtomicSkillPlanV1`; existing `runSkill` remains the static-catalog adapter.

- [ ] **Step 1: Write RED order/rollback tests**

Require `before_begin` before `batch_begin`; require `before_commit` after postcondition and before `batch_end`; second-guard failure must issue identified rollback and verify the pre-state fingerprint. Test same-request-ID reconciliation after lost response, unreadable status -> `needs_recovery`, and dynamic `owner-*` atomic execution without `SKILL_TRANSACTABILITY`.

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/atomicPlan.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract, preserving protocol**

Move `readStatus`, `unprovable`, `rollbackExactly`, and the atomic half of `runSkill` into `atomicPlan.ts`; do not rewrite transaction semantics. Insert the two guards at the exact positions above. Never retry with a new request ID. Keep old slot/precondition validation and best-effort handling in `runSkill`; static atomic entries delegate with an always-green guard. Dynamic owner plans reach this API only after fixed-catalog validation, while native `batch_begin` independently rejects unsafe commands.

- [ ] **Step 4: Run GREEN and commit**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/atomicPlan.test.ts src/agent/skillHarness.test.ts src/agent/skillHarness.failure.test.ts src/agent/skillTransaction.test.ts`

Expected: PASS with existing behavior unchanged.

```bash
git add ui/src/agent/skillFoundry/atomicPlan{,.test}.ts ui/src/agent/skillHarness.ts ui/src/agent/skillHarness.test.ts
git commit -m "refactor(agent): extract atomic skill plan runner"
```

---

### Task 8: Implement Closed Primitives and the Declarative Executor

**Files:**
- Create: `ui/src/agent/skillFoundry/primitives.ts`
- Create: `ui/src/agent/skillFoundry/declarativeExecutor.ts`
- Test: `ui/src/agent/skillFoundry/primitives.test.ts`
- Test: `ui/src/agent/skillFoundry/declarativeExecutor.test.ts`

**Interfaces:**
- Produces: `executeDeclarativeSkillV1(input:DeclarativeExecutionInputV1): Promise<SkillOutcomeV1>`.

- [ ] **Step 1: Write RED primitive tests**

Test selected track, normalized case-insensitive exact unique track name, fresh installed plug-in catalog, zero/multiple matches, five-choice cap, malformed/oversized catalog, duplicate resolved entities, and every predicate. `plugin_instance_added_once` passes only when exactly one after-state plug-in has the resolved `catalogId`; zero/two/missing identity fail.

- [ ] **Step 2: Write RED seven-phase tests**

Require order: slots -> before snapshot -> observations/resolvers -> preconditions -> expansion -> confirmation gate -> `before_begin` -> begin -> each mutation once -> status -> after snapshot -> postconditions -> `before_commit` -> end. Prove `never` proceeds without a confirmation, `always` returns typed `needs_choice` with confirm/cancel and zero bridge mutations, and `on_ambiguity` confirms only after an ambiguity was resolved. Confirm resume must consume once, rerun preflight, match the exact plan digest, then begin; cancel returns blocked `unsupported_intent`, and invalid/stale confirmation never mutates. Also test defaults, ordered `each`, 32/33 mutations and preflight calls, epoch/target/source drift, command/postcondition failure, timeout without new-ID retry, and rollback proof. Assert observations/resolvers never appear in `batch_begin.commands`.

```ts
expect(await executeDeclarativeSkillV1(alwaysConfirmInput)).toMatchObject({
  kind:"needs_choice", options:[{id:"confirm",label:"Apply"},{id:"cancel",label:"Cancel"}],
  continuationToken:expect.any(String),
});
expect(exec).not.toHaveBeenCalled();
```

- [ ] **Step 3: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/primitives.test.ts src/agent/skillFoundry/declarativeExecutor.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement bounded preflight and execution**

Resolve typed refs without interpolation, finish all reads/resolution before planning, expand `each` in input order, reject missing/ambiguous/duplicate targets atomically, and mint stable transaction/request IDs. Before `before_begin`, enforce the manifest's exact confirmation policy. Confirmation uses Task 6's `pendingKind:"confirmation"` payload with exactly `{id:"confirm",label:"Apply",value:true}` and `{id:"cancel",label:"Cancel",value:false}`, plus `confirmationPlanSha256 = SHA256(canonicalJsonBytes({skill,version,artifactSha256,slots,targetIdentities,mutations}))`; resume reruns preflight and requires the same digest. `on_ambiguity` triggers only after a consumed choice whose `choiceReason` is `ambiguity`. Both guards re-read context plus `readSourceStatus`, comparing epoch, target identity, source generation/digests, registry generation, and artifact hash. Map only allowed semantic reason codes; `before_commit` drift delegates to exact rollback.

- [ ] **Step 5: Run GREEN and commit**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/primitives.test.ts src/agent/skillFoundry/declarativeExecutor.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add ui/src/agent/skillFoundry/{primitives,declarativeExecutor,primitives.test,declarativeExecutor.test}.ts
git commit -m "feat(agent): execute atomic declarative skills"
```

---

### Task 9: Assemble Active-Only Startup Loading and Quarantine

**Files:**
- Create: `ui/src/agent/skillFoundry/loadCertifiedSkills.ts`
- Test: `ui/src/agent/skillFoundry/loadCertifiedSkills.test.ts`

**Interfaces:**
- Produces: `loadCertifiedOwnerSkillsV1(input): Promise<CertifiedOwnerSkillLoadResultV1>` and `loadBundledNativeSkillsV1(input): Promise<CertifiedNativeSkillLoadResultV1>`; Slice B combines accepted candidates in one registry build.

- [ ] **Step 1: Write RED startup tests**

Test empty/missing root, invalid root, active-only routing, inactive older version excluded, invalid active version with no fallback, one bad sibling quarantined while one safe sibling loads, `owner-*` active IDs only, active manifest/release hashes, 64/65 entries, total byte cap, duplicate package identity, stale source, and no thrown untrusted error. For bundled native resources, require a valid sorted index, exact four-file package topology, Task 3 graph validation, native payload/source/catalog/app-version/Git/build match, and zero registration when the index is absent or invalid. Add actual-startup fixtures where an owner active ID collides with a native canonical ID, native alias, or bundled-declarative ID; all must publish zero replacement registry entries.

```ts
const result = await loadCertifiedOwnerSkillsV1({readPackages:async()=>fixture, compatibility});
expect(result.accepted.map(x=>x.id)).toEqual(["owner-safe"]);
expect(result.quarantined).toContainEqual(expect.objectContaining({id:"owner-tampered",code:"hash_mismatch"}));
```

- [ ] **Step 2: Run RED**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/loadCertifiedSkills.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement startup assembly**

Parse local active/source envelopes and the separate bundled-native resource envelope. Select exact active `<id>@<version>` for owner packages; validate/adapt every indexed native package; then run `validateReleaseIdentityUniverseV1` over native IDs/aliases, bundled-declarative IDs, and the actual parsed owner active index before returning candidates. Sort accepted IDs and return bounded quarantine diagnostics plus activation/source generations and exact index hashes. Never fall back to an older/code-only candidate or replace the prior registry after a universe failure. Before Slice E stages approved native resources, the bundled-native result is intentionally empty and Slice B tests inject validated fixtures.

- [ ] **Step 4: Run GREEN and commit**

Run: `cd ui && npm test -- --run src/agent/skillFoundry/loadCertifiedSkills.test.ts && npm run typecheck`

Expected: PASS.

```bash
git add ui/src/agent/skillFoundry/loadCertifiedSkills{,.test}.ts
git commit -m "feat(agent): load certified owner skills"
```

---

### Task 10: Run Slice A Boundary and Regression Gates

**Files:**
- Test only.

**Interfaces:**
- Produces: evidence for Slice A only; it cannot certify or claim the full program.

- [ ] **Step 1: Run all new TypeScript tests**

Run: `cd ui && npm test -- --run src/agent/skillFoundry && npm run typecheck`

Expected: all new tests pass with zero skips.

- [ ] **Step 2: Run existing agent regressions**

Run:

```bash
cd ui && npm test -- --run \
  src/agent/skillHarness.test.ts src/agent/skillHarness.failure.test.ts \
  src/agent/skillTransaction.test.ts src/agent/studioSkills.test.ts \
  src/agent/studioSkills.integration.test.ts src/agent/skillCatalogBoundary.test.ts \
  src/agent/commands.contract.test.ts src/agent/txnSafeRegistry.test.ts
```

Expected: all existing transaction/catalog/named-plug-in tests pass.

- [ ] **Step 3: Run native tests and full gate**

Run:

```bash
scripts/auto-loop/memory-preflight.sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-tests
build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[skillfoundry]"
build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[agenttxn]"
test -z "$(git status --porcelain)"
cmake --preset macos-arm64-release
cmake --build build-macos-arm64-release --config Release --target MoshSkillIdentityGate
scripts/auto-loop/gate.sh native "$(pwd)" origin/main
```

Expected: zero failures, the clean-HEAD Release source/build/collision gate passes, and no test reads the owner root.

- [ ] **Step 4: Prove the boundary and commit corrections only if present**

Run:

```bash
git diff --check origin/main...
! rg -n 'install_skill|write_skill|MOSH_SKILL_CANDIDATE_TEST' ui/src/agent/skillFoundry src/agent src/webview/WebBridge.cpp
! rg -n 'service/skills/library\.jsonl' ui/src/agent/skillFoundry src/agent src/webview/WebBridge.cpp
test -z "$(git ls-files resources/skills/native/ resources/skills/declarative/)"
```

Expected: no runtime writer, candidate loader, or service-mined catalog reference; neither bundled resource index is tracked in the source tree. `load_named_plugin` may appear only as the canonical legacy alias and tests. If verification requires a correction, commit it, return to Step 1, and rerun every focused/native gate against the new clean HEAD; never carry forward evidence from the superseded commit.

## Slice A Completion Criteria

- Every exact boundary passes and every one-over boundary fails.
- Invalid, stale, oversized, tampered, and unsafe packages quarantine without startup failure.
- Native reads cannot follow links, escape the fixed root, accept unowned/writable roots, or touch the owner root in tests.
- Exact bytes bind manifest, report, approval, release, active index, sources, and compatibility.
- Native payloads bind a canonical source-byte-set hash, catalog fingerprint, app version, clean known Git commit, and exact Release build identity; dirty/unknown/mismatched builds cannot register them.
- Native IDs/aliases, `builtin-*`, and `owner-*` cannot collide or shadow; startup publication is atomic and the production Release/build identity-universe gate passes.
- Continuations are capped, single-use, stale-aware, and cleared on project/registry replacement.
- Preflight reads precede the transaction; required confirmation completes through a typed, digest-bound continuation before `batch_begin`, and absent/cancelled/stale confirmation mutates nothing.
- Only mutations enter the transaction manifest, postconditions and both guards run while required, and failures use identified rollback with pre-state proof.
- Existing static skills stay green; no router, installer, hot reload, QA candidate loader, certification claim, or Ableton dependency is added.
