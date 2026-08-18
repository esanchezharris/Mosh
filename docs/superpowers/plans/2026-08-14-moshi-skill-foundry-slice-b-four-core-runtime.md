# Moshi Skill Foundry Slice B — Four-Core Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route session control, capture/review/choose, explicit balance, and named plug-in loading through one certified Mosh runtime while preserving the proven MoshOps, undo, recording, and refusal behavior.

**Architecture:** Four code-bound native handlers register behind the Slice A registry/runtime contracts. Balance and plug-in edits compile identified atomic plans with source-status guards; session and recording actions remain explicit lifecycles and never claim rollback. Additive persisted take IDs make review, retry, Keep, undo, save, and relaunch independent of mutable lane indices.

**Tech Stack:** TypeScript 5, React 18, Zustand, Vitest, C++20, JUCE 8, Tracktion Engine, Catch2, CMake, native `--selftest`, CoreAudio/BlackHole smoke.

**Spec:** `docs/superpowers/specs/2026-08-14-moshi-skill-foundry-design.md`

## Global Constraints

- Implement one slice per isolated git worktree and PR; never merge. The owner merges each accepted slice before a dependent slice starts.
- Before creating an execution worktree, use `superpowers:using-git-worktrees`; implement with `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
- macOS / Apple Silicon arm64 is the shipping target.
- Every user-visible DAW mutation remains a MoshOps command: validate, identified undo transaction where applicable, events, JSONL, and result envelope.
- Tracktion remains the one undo system. Lifecycle operations never claim atomic rollback.
- Snapshot and event changes are additive; existing consumers remain valid.
- Owner-local manifests are data-only, atomic-only, and limited to the exact V1 catalog in the spec. They cannot contain code, URLs, filesystem paths, environment expansion, retries, or arbitrary commands.
- Ableton, AbletonOSC, `.als` files, tutorials, and source text are reference evidence only. They never execute or certify a skill.
- Raw tutorial media stays local and outside the repository. Store only bounded metadata, short paraphrases, hashes, and local locators.
- Tests use isolated teach and agent roots; they never read or modify the owner's real `~/Library/Mosh/teach` or `$MOSH_AGENT_DIR` data.
- Preserve the boundary among native studio skills, uncertified `skills.ts` candidates, and the offline `service/skills/library.jsonl` corpus.
- The developer free-form loop remains compiled/gated exactly as today and is never a packaged fallback.
- Release builds omit the QA candidate loader and reject candidate-loader flags.
- No secrets, owner media, generated build products, or local attestations enter git.
- Before every native build or test suite, run `scripts/auto-loop/memory-preflight.sh`; stop if it fails.

## Slice Boundary and Locked Interfaces

Slice B owns only the four native journeys, stable take identity, deterministic
routing, and focused runtime proof. Slice C owns the Live-shell wrapper; Slice D
owns authoring/intake; Slice E owns the frozen 160-case certification and signed
release gates. Canonical IDs and handler keys are fixed:

```ts
type NativeCoreIdV1 =
  | "session-control"
  | "capture-review-choose-take"
  | "explicit-balance"
  | "load-named-plugin";
type NativeCoreHandlerKeyV1 =
  | "sessionControlV1"
  | "takeCycleV1"
  | "explicitBalanceV1"
  | "loadNamedPluginV1";
```

Only `load-named-plugin` accepts legacy alias `load_named_plugin`; emitted
outcomes and evidence always use the canonical ID.

Import these exact Slice A contracts; do not redeclare or alias a competing
shape. Add a compile-only contract test that imports every listed symbol from
`skillFoundry/contracts.ts`, `nativeIdentity.ts`, `registry.ts`, `continuations.ts`,
`atomicPlan.ts`, `loadCertifiedSkills.ts`, and `nativeReads.ts`:

```ts
import type {
  ContinuationStoreV1, MoshBuildIdentityInputV1, NativeSkillHandlerV1,
  NativeSourceByteSetV1, RecordingLifecycleEnvironmentV1,
  RecordingLifecycleResultV1, SkillOutcomeV1, StudioSkillEnvironmentV1,
  StudioSkillRuntimeInputV1, StudioSkillRuntimeV1,
} from "./contracts";
import { buildStudioSkillRegistryV1, type RegistryBuildInputV1, type StudioSkillRegistryV1 } from "./registry";
import { runAtomicSkillPlanV1 } from "./atomicPlan";
import { canonicalMoshBuildIdentityV1, nativeSourceByteSetSha256V1 } from "./nativeIdentity";
import { loadBundledNativeSkillsV1, loadCertifiedOwnerSkillsV1 } from "./loadCertifiedSkills";
import { readBundledNativeSkillsV1, readCertifiedSkillPackagesV1 } from "./nativeReads";

export type StudioSkillEnvironment = StudioSkillEnvironmentV1;
export function createStudioSkillRuntimeV1(input: StudioSkillRuntimeInputV1): StudioSkillRuntimeV1;
export function runStudioSkill(utterance: string, environment: StudioSkillEnvironment,
  continuationToken?: string): Promise<SkillOutcomeV1>;
```

`AgentComposer` stores only `string | null`. `needs_choice` returns only an
opaque `continuationToken`. `readSourceStatus()` is read-only infrastructure and
never appears in a mutation manifest or `mosh-log.jsonl`. Slice A already owns
additive `Plugin.catalogId?: string`, projected from
`PluginHost::idFor(ext.desc)`; Slice B consumes it and does not reimplement it.
`createStudioSkillRuntimeV1(...).onProjectReplaced()` clears its injected store;
the compatibility `clearStudioSkillContinuations()` delegates only to that method.

## File Map

Native/take work spans `src/{state,engine,moshops,app}`, `tests/`, and UI types/mock/store/lifecycle. Handlers/runtime live under
`ui/src/agent/skillFoundry/`; routing remains in `studioSkills.ts`, `fastPath.ts`,
and `AgentComposer.tsx`; physical proof extends SelfTest and the BlackHole gate.

### Task 1: Add Stable Take IDs and Guarded Native Keep

**Files:** Create `src/state/TakeIdentity.h`, `tests/test_take_identity.cpp`; modify `src/state/Ids.h`, `src/engine/MoshEngine.cpp`, `tests/CMakeLists.txt`, `src/moshops/MoshOps.Tracks.cpp`, `src/moshops/MoshOps.cpp`, `src/app/SelfTest.cpp`, `ui/src/types.ts`, `ui/src/bridge.mock.ts`, `ui/src/bridge.mock.recording.test.ts`.

**Interfaces:** Produce persisted `moshTakeId`; additive `ClipTake.id`,
`Clip.currentTakeId/takeIds`, and `ControllerTake.currentTakeId/takeIds`; optional
`takeId`, `expectedCurrentTakeId`, and ordered `expectedTakeIds` command args.

- [ ] **Step 1: Write RED identity and native command tests**

```cpp
TEST_CASE ("take ids are unique, idempotent, and persisted", "[takes][identity]")
{
    juce::ValueTree edit ("EDIT"), clip ("WAVECLIP"), takes ("TAKES");
    for (auto source : { "a.wav", "a.wav", "b.wav" }) {
        juce::ValueTree take ("TAKE");
        take.setProperty ("source", source, nullptr); takes.appendChild (take, nullptr);
    }
    clip.appendChild (takes, nullptr); edit.appendChild (clip, nullptr);
    REQUIRE (mosh::takeidentity::backfill (edit) == 3);
    const auto id0 = mosh::takeidentity::idFor (takes.getChild (0));
    CHECK (mosh::takeidentity::isValid (id0)); CHECK (id0 != mosh::takeidentity::idFor (takes.getChild (1)));
    CHECK (mosh::takeidentity::backfill (edit) == 0);
}
```

Extend native selftest with: `list_takes` returns unique IDs; guarded ID switch;
stale-current refusal before transaction; Keep requested ID to one lane; one
Undo restores the full ordered ID set and prior selection; duplicate/malformed
guards create no undo; snapshot/list/controller agree; save/reload preserves IDs.

- [ ] **Step 2: Run RED**

```bash
scripts/auto-loop/memory-preflight.sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-tests
cmake --build --preset macos-arm64-app
build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[takes][identity]"
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
```

Expected: missing header/property and missing JSON fields/guards fail.

- [ ] **Step 3: Implement identity, projection, and one-undo Keep**

Add `MOSH_DECLARE_ID (moshTakeId)`. `backfill(ValueTree)` recursively visits only
direct source-bearing children of Tracktion `TAKES` nodes, writes missing
lowercase dashed `juce::Uuid` values with a null UndoManager, returns the count,
and never stamps clips or plug-ins. Call it on every edit adoption and before
each post-record take enumeration. Never replace malformed IDs; fail ID mutations
on empty/duplicate IDs. Legacy index plus optional ID must resolve identically.
This is a behavioral rewrite of `cmdKeepTake`, not a light touch: today it
accepts only `{clipId}`, takes no target take id, and calls
`w->deleteAllUnusedTakes(false)` on whichever take is already current — it never
calls `switchTakePreservingDirectFile`. Rewrite it to accept an optional target
`takeId`. Validate all guards before `beginTxn`, then, inside that single
transaction, call `switchTakePreservingDirectFile` when a target id is supplied
and `deleteAllUnusedTakes(false)` to keep it. Preserve legacy `{clipId}`-only
behavior unchanged: with no target id, keep whichever take is already current.

Mirror IDs and guards in the mock using deterministic UUID-shaped fixture IDs.
Snapshot the whole clip before mock Keep so one Undo restores IDs and selection.

- [ ] **Step 4: Run GREEN and commit**

```bash
scripts/auto-loop/memory-preflight.sh
cmake --build --preset macos-arm64-tests
cmake --build --preset macos-arm64-app
build-macos-arm64/tests/MoshTests_artefacts/Debug/MoshTests "[takes]"
MOSH_NO_AUDIO=1 build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh --selftest
cd ui
npx vitest run src/bridge.mock.recording.test.ts src/ui/takeLanes.test.ts
npm run typecheck
cd ..
git add src/state/TakeIdentity.h src/state/Ids.h src/engine/MoshEngine.cpp \
  src/moshops/MoshOps.Tracks.cpp src/moshops/MoshOps.cpp src/app/SelfTest.cpp \
  tests/{test_take_identity.cpp,CMakeLists.txt} \
  ui/src/{types.ts,bridge.mock.ts,bridge.mock.recording.test.ts}
git commit -m "feat(recording): add stable guarded take identity"
```

Expected: focused/native tests pass and selftest reports `0 failed`.
### Task 2: Expose Recording Lifecycle State and the Take Handler

**Files:** Modify `ui/src/recordingLifecycle.ts`, `ui/src/store.ts`, `ui/src/store.record.test.ts`; create `ui/src/recordingLifecycle.test.ts`, `ui/src/agent/skillFoundry/native/takeCycle.ts`, and `.test.ts`.

**Interfaces:** Consume Slice A's verbatim `RecordingLifecycleResultV1` and
`RecordingLifecycleEnvironmentV1`; produce store adapters and private observed
baseline/review helpers.

- [ ] **Step 1: Write RED lifecycle/journey cases**

```ts
expect(await store.enterRecord()).toMatchObject({
  kind: "started", baseline: { takeIds: ["t1", "t2"], currentTakeId: "t2" },
});
expect(store.takeReview?.takeIds).toEqual(["t1", "t2"]);
expect(await store.stopRecord()).toMatchObject({
  kind: "reviewing",
  review: { takeIds: ["t1", "t2", "t3"], currentTakeId: "t3" },
});
```

Add exact cases for failed restart before recording (byte-identical review),
failure after start (`state:"recording"`), malformed stop
(`state:"landed_unverified"`), project replacement clearing review, stable-ID
audition, Keep guards, and one-lane postcondition. Pin real snapshot fields:
pre-record `transport:{playing:false,recording:false}` plus
`controller.record:"idle"|"armed"`; started means both
`transport.recording:true` and `controller.record:"recording"`; review means
stopped transport plus `controller.mode:"judgment"` and matching
`controller.take.{exists,trackId,clipId,numTakes,currentTakeId,takeIds}`. Test two
armed/input-capable tracks as `ambiguous_target`, no eligible target as
`missing_target`, missing/malformed controller fields as `observation_failed`,
and zero arm/transport calls for every preflight failure.

- [ ] **Step 2: Run RED**

```bash
cd ui
npx vitest run src/store.record.test.ts src/agent/skillFoundry/native/takeCycle.test.ts
```

Expected: methods still return `void` and the handler module is absent.

- [ ] **Step 3: Implement strict observed lifecycle results**

Import and return Slice A's `RecordingLifecycleResultV1` and
`RecordingLifecycleEnvironmentV1` verbatim; do not redeclare either in
`recordingLifecycle.ts`. Private baseline/review helpers must remain structurally
assignable to those contracts.

Strictly parse unique nonempty IDs, count equality, and exactly one current ID.
Before record, resolve exactly one target: the sole armed track with
`hasInput===true`, otherwise the selected `hasInput===true` track; never fall
back to the first audio/first project track. Start preserves the baseline and
verifies refreshed transport/controller state. Stop requires stopped observed
state, old ordered IDs plus exactly one new current ID, and matching controller
take identity. Audition sends ID/current guard. Keep sends ID/current/ordered-set
guards and succeeds only after refresh observes exactly that ID. Preserve
`lastTakeClipId` as a compatibility projection.

Implement `takeCycleV1` for `start|stop|again|audition_next|audition_previous|keep`.
Use only stable IDs. Lifecycle outcomes use `changes:null`. Before “again”,
require `transport.playing===false`, `transport.recording===false`, and
`controller.record!=="recording"`; otherwise block without calling `start`.
“Again” never deletes a take or calls Undo.

- [ ] **Step 4: Run GREEN and commit**

```bash
cd ui
npx vitest run src/{store.record,recordingLifecycle}.test.ts \
  src/agent/{fastPath,skillFoundry/native/takeCycle}.test.ts
npm run typecheck
cd ..
git add ui/src/{recordingLifecycle,recordingLifecycle.test,store,store.record.test}.ts \
  ui/src/agent/skillFoundry/native/{takeCycle,takeCycle.test}.ts
git commit -m "feat(agent): add observed capture review choose lifecycle"
```

### Task 3: Add Deterministic Session Control

**Files:** Create `ui/src/agent/skillFoundry/native/sessionControl.ts` and `.test.ts`.

**Interfaces:** `sessionControlV1` owns
`play|stop|from_start|save|undo|redo`; no toggles and no atomicity claim.

- [ ] **Step 1: Write and run RED**

Assert `run("play")` on `{playing:true}` completes with zero `exec` calls. Also
cover held-out phrases, exact from-start, already-satisfied state, dirty-to-
clean Save, history no-op, command failure, and recording-aware Stop.

```bash
cd ui
npx vitest run src/agent/skillFoundry/native/sessionControl.test.ts
```

Expected RED: module not found.

- [ ] **Step 2: Implement, verify, and commit**

Use anchored phrases. Issue explicit `play`, `stop`, and `to_start` actions.
While recording, Stop calls `recording.stop()`. Save completes only after refresh
observes `dirty === false`. Undo/redo run alone and require one applied entry.

```bash
cd ui
npx vitest run src/agent/skillFoundry/native/sessionControl.test.ts \
  src/agent/fastPath.test.ts src/agent/executor.test.ts
npm run typecheck
cd ..
git add ui/src/agent/skillFoundry/native/sessionControl.ts \
  ui/src/agent/skillFoundry/native/sessionControl.test.ts
git commit -m "feat(agent): add bounded session control skill"
```

### Task 4: Add Explicit Balance Through the Atomic Executor

**Files:** Create `ui/src/agent/skillFoundry/native/explicitBalance.ts` and `.test.ts`; modify `ui/src/agent/skills.ts`.

**Interfaces:** `explicitBalanceV1` owns explicit
`set_level|mute|unmute|solo`; uses `runAtomicSkillPlanV1`, never legacy
`runSkill` for a runtime-selected owner ID.

- [ ] **Step 1: Write and run RED**

Test selected track, normalized exact unique name, duplicate-name choice capped
at five, missing target, `-60`/`+6` boundaries, out-of-range rejection,
multi-target cap, duplicate entity rejection, vague-taste refusal, one Undo,
postcondition rollback, and source change before commit:

```ts
const out = await explicitBalanceV1.run("set Drums to -8 dB", h.environment);
expect(out).toMatchObject({ kind: "blocked", code: "manifest_stale" });
expect(h.readSourceStatus).toHaveBeenCalledTimes(2);
expect(h.commands()).toEqual([
  "batch_begin", "set_track_volume", "batch_rollback", "batch_status",
]);
expect(h.mutationManifest()).toEqual(["set_track_volume"]);
```

```bash
cd ui
npx vitest run src/agent/skillFoundry/native/explicitBalance.test.ts
```

Expected RED: module not found.

- [ ] **Step 2: Implement guarded atomic plans**

Resolve only selected track or normalized exact names; ambiguity never mutates.
Compile only `set_track_volume`, `set_track_mute`, or `set_track_solo`. Capture
project epoch, target IDs, source generation, and source digest before planning.
Supply `guard(phase, context)` that calls `environment.readSourceStatus()` on
both phases, checks `context.after ?? context.before` still contains every target,
and rejects changed status/generation/digest/epoch. The second guard runs after
postconditions and before commit; failure exact-rolls back. Neither guard is in
`transaction.commands` or JSONL. Factor the existing level postcondition for
reuse; leave `SET_TRACK_LEVEL_SKILL` uncertified.

- [ ] **Step 3: Run GREEN and commit**

```bash
cd ui
npx vitest run src/agent/{skillsFsB2,skillCatalogBoundary}.test.ts \
  src/agent/skillFoundry/{atomicPlan,native/explicitBalance}.test.ts
npm run typecheck
cd ..
git add ui/src/agent/skillFoundry/native/{explicitBalance,explicitBalance.test}.ts \
  ui/src/agent/skills.ts
git commit -m "feat(agent): add guarded explicit balance skill"
```

### Task 5: Migrate Named Plug-in Loading Behind the Atomic Runtime

**Files:** Create `ui/src/agent/skillFoundry/native/loadNamedPlugin.ts` and `.test.ts`; modify `ui/src/agent/studioSkills.test.ts`, `studioSkills.integration.test.ts`.

**Interfaces:** Consume Slice A `Plugin.catalogId`, `plugin_by_name`, continuation
contracts, and `runAtomicSkillPlanV1`; produce canonical `loadNamedPluginV1`.

- [ ] **Step 1: Port RED behavior and token tests**

Retain selected-track missing, exact, ambiguity capped to five, absent/rescan,
instrument-on-audio guidance, one Undo, and catalog/project/selection/source
staleness. Add distinct `list_plugins` command-failed, malformed envelope,
64-entry accepted, 65-entry rejected, and overlong `id`, `name`, `format`, and
`manufacturer` field cases; every rejection is `observation_failed` with zero
`batch_begin`/`load_plugin`. Replace raw continuation objects:

Assert an ambiguous `runStudioSkill("load Serum 2", env)` returns only an opaque
token; `runStudioSkill("2", env, token)` completes canonically with mutation
manifest exactly `["load_plugin"]`. Add old-token replay rejection and
before-commit source change exact rollback.

```bash
cd ui
npx vitest run src/agent/skillFoundry/native/loadNamedPlugin.test.ts \
  src/agent/studioSkills.test.ts src/agent/studioSkills.integration.test.ts
```

Expected RED: new module/token/atomic expectations fail.

- [ ] **Step 2: Move proven bounded resolution and add atomic postcondition**

Move the current catalog parser/query/choice labels and `resolvePluginMatch`.
Set the handler's bounded catalog cap to 64 and retain the existing
`MAX_PLUGIN_FIELD_LENGTH=1024` UTF-16-code-unit check for every string field.
Observe `list_plugins` before the transaction. Bind choice payload to exact
catalog ID, selected track, project epoch, payload hash, registry generation,
source generation, creation, expiry, and attempts. Compile one
`load_plugin(trackId, pluginId)` command. On resume, re-read `list_plugins` and
require that catalog ID remains loadable. Apply the same two read-only guards as
Task 4. Postcondition: target track's matching `catalogId` count increases by
exactly one and every other track's count is unchanged.

- [ ] **Step 3: Run GREEN and commit**

```bash
cd ui
npx vitest run src/agent/{studioSkills,studioSkills.integration}.test.ts \
  src/agent/skillFoundry/{atomicPlan,native/loadNamedPlugin}.test.ts
npm run typecheck
cd ..
git add ui/src/agent/skillFoundry/native/{loadNamedPlugin,loadNamedPlugin.test}.ts \
  ui/src/agent/{studioSkills.test,studioSkills.integration.test}.ts
git commit -m "refactor(agent): make named plugin loading atomic"
```

### Task 6: Define Four Canonical Payloads and Build One Runtime

**Files:** Create `ui/src/agent/skillFoundry/native/payloads.ts`, `payloads.test.ts`, `ui/src/agent/skillFoundry/native/index.ts`, `ui/src/agent/skillFoundry/runtime.ts`, `runtime.test.ts`, `runtime.contract.test.ts`; modify `ui/src/agent/studioSkills.ts`, `skillCatalogBoundary.test.ts`.

**Interfaces:** Export `createStudioSkillRuntimeV1(input)`; keep the locked public
`runStudioSkill` delegate; export `NATIVE_SOURCE_PATHS_V1`,
`materializeNativePayloadArtifactsV1(input:{nativeSource:NativeSourceByteSetV1;
buildIdentity:MoshBuildIdentityInputV1;catalogFingerprint:CatalogFingerprintV1})`,
and `clearStudioSkillContinuations()` solely for project/registry replacement.

- [ ] **Step 1: Write and run RED registry, precedence, and continuation cases**

Assert four IDs/handler keys, only the plug-in alias, deterministic exact-byte
payload serialization, no collision with `SKILL_CATALOG`/`library.jsonl`,
continuation first, provider-off exact invocation/failure refusal, and no raw
callback. Spy the default boot: it calls `readCertifiedSkillPackagesV1` then
`loadCertifiedOwnerSkillsV1`, calls `readBundledNativeSkillsV1` then
`loadBundledNativeSkillsV1`, combines both accepted arrays in one
`buildStudioSkillRegistryV1` call, and publishes nothing until that call passes.
Missing/invalid bundled index, payload without approval/bundle entry, or valid
handler code alone must make “play” unsupported with zero handler calls; a safe
owner skill in the same fixture remains routable.

Assert explicit balance completes with trace `continuation:none ->
deterministic:explicit-balance -> handler:explicitBalanceV1` and no `free-form`.
Add an incompatible candidate and a current-precondition-false candidate that
would otherwise score first. Assert both are removed before retrieval, only the
eligible set reaches `registry.retrieve(..., 3)`, and the provider sees no more
than those three IDs. A deterministic core phrase may invoke a handler only by
resolving its canonical ID from that eligible published registry.

Test invalid choice replies one and two consume the old token and return fresh
tokens; the third returns `blocked/invalid_slot`; original expiry is unchanged;
used/unknown/expired/project/target/artifact/registry/source mismatches mutate
nothing. Verify project or registry replacement calls `clear()`.

```bash
cd ui
npx vitest run src/agent/skillFoundry/{runtime,runtime.contract}.test.ts \
  src/agent/skillFoundry/native/payloads.test.ts \
  src/agent/skillCatalogBoundary.test.ts
```

Expected RED: registration/runtime modules do not exist.

- [ ] **Step 2: Build canonical payload artifacts and fixed precedence**

Define four semantic payload specs once in `native/payloads.ts` and export this
exact lexicographically sorted byte set:

```ts
export const NATIVE_SOURCE_PATHS_V1 = [
  "src/engine/MoshEngine.cpp", "src/moshops/MoshOps.Tracks.cpp",
  "src/moshops/MoshOps.cpp", "src/moshops/MoshOpsInternal.h",
  "src/plugins/hosting/PluginHost.cpp", "src/plugins/hosting/PluginHost.h",
  "src/state/Ids.h", "src/state/TakeIdentity.h",
  "ui/src/agent/commands.ts", "ui/src/agent/skillFoundry/atomicPlan.ts",
  "ui/src/agent/skillFoundry/contracts.ts", "ui/src/agent/skillFoundry/native/explicitBalance.ts",
  "ui/src/agent/skillFoundry/native/index.ts", "ui/src/agent/skillFoundry/native/loadNamedPlugin.ts",
  "ui/src/agent/skillFoundry/native/payloads.ts", "ui/src/agent/skillFoundry/native/sessionControl.ts",
  "ui/src/agent/skillFoundry/native/takeCycle.ts", "ui/src/agent/skillFoundry/runtime.ts",
  "ui/src/agent/skills.ts", "ui/src/agent/studioSkills.ts",
  "ui/src/recordingLifecycle.ts", "ui/src/store.ts", "ui/src/types.ts",
  "ui/src/ui/pluginBrowserUtil.ts",
] as const;
```

Build Slice A's `NativeSourceByteSetV1` from the exact committed bytes. Its
`nativeSourceByteSetSha256V1` sorts normalized repo-relative paths and hashes
`canonicalJsonBytes({schemaVersion:1,files:[{path,bytes,sha256}]})`; no source-byte
newline/Unicode normalization is allowed. Missing, linked, duplicate, dirty, or
extra paths fail materialization.

`materializeNativePayloadArtifactsV1` accepts Slice A's verbatim
`NativeSourceByteSetV1`, `MoshBuildIdentityInputV1`, and `catalogFingerprint`.
Populate the verbatim build type with exact app SemVer/commit and
`gitState:"clean"`, `target:"Mosh"`, `configuration:"Release"`, and
`architecture:"arm64"`; derive `gitState` only after porcelain output is empty.
Call Slice A's
`nativeSourceByteSetSha256V1` and `canonicalMoshBuildIdentityV1` rather than
redefining their framing or identity grammar. Parse with Slice A, serialize
stored payload UTF-8 deterministically, and return exact payload/bytes/SHA tuples
plus the build identity; build identity is not embedded in payload bytes. Slice
E calls this factory after code freeze from clean HEAD,
using the `macos-arm64-release`/`macos-arm64-release-app` build and stages the
returned bytes verbatim—no JSON recreation or pretty-print pass. B tests inject
fixture bytes/digests and reject dirty status, changed source byte, reordered
input, wrong architecture/configuration, and post-materialization edit.

The default runtime reads and loads both certified owner and bundled native
origins, then makes one atomic registry build over their accepted candidates.
It never adapts the handler map directly. Before Slice E stages a valid bundled
approval entry, the native accepted set is empty and every core native ask is
unsupported rather than a code-only bypass.

Runtime order is: atomically `take(token, now)` and validate its captured
identities/hashes; evaluate compatibility and current preconditions; match a
deterministic native only inside that eligible set; retrieve at most three from
the same eligible set; deterministic selection; bounded provider selection;
validated execution; otherwise `unsupported_intent`. Provider exception, invalid
ID/slot, or tie yields choice/refusal. Never call `commandCatalogPrompt`,
model-produced `runAgentBatch`, or `runLoopTask`.

Invalid reply reissue is exactly:

```ts
const attempts = payload.attempts + 1;
if (attempts >= 3) return blocked("invalid_slot");
const next = input.continuations.issue({ ...payload, attempts });
return next.ok ? needsChoice(payload, next.token) : blocked("observation_failed");
```

This preserves `createdAtMs`/`expiresAtMs`; `take()` already deleted the old
token. Resume validates artifact, project, target, registry, and source fields
before mutation. Construct the default registry/runtime once asynchronously in
`studioSkills.ts`; the public delegate awaits it and keeps its exact signature.
The compile-contract test imports Slice A's exact names without local
redefinitions and calls `onProjectReplaced()`.

- [ ] **Step 3: Run GREEN and commit**

```bash
cd ui
npx vitest run src/agent/{skillCatalogBoundary,studioSkills,studioSkills.integration}.test.ts \
  src/agent/skillFoundry/{runtime,runtime.contract}.test.ts \
  src/agent/skillFoundry/native/payloads.test.ts
npm run typecheck
cd ..
git add ui/src/agent/skillFoundry/native/{index,payloads,payloads.test}.ts \
  ui/src/agent/skillFoundry/{runtime,runtime.test,runtime.contract.test}.ts \
  ui/src/agent/{skillCatalogBoundary.test,studioSkills}.ts
git commit -m "feat(agent): register four core studio skills"
```

### Task 7: Consolidate Composer Routing Without Moving Remember

**Files:** Modify `ui/src/agent/fastPath.ts`, `ui/src/ui/AgentComposer.tsx`, `ui/src/ui/AgentComposer.namedPlugin.test.ts`, `ui/src/agent/fastPath.test.ts`; create `ui/src/ui/AgentComposer.skillFoundry.test.ts`.

**Interfaces:** When no continuation is pending: section rework, explicit
remember, shared runtime, gated developer loop, unsupported. A continuation
always resumes before any new matcher.

- [ ] **Step 1: Write and run RED precedence/fallback cases**

Prove section rework still owns bare redo; the existing `matchRemember` (the
current unexported helper in `fastPath.ts`, called today from `matchFastPath`)
calls only `agent_memory_write` and never skill routing; all four core phrases call
`runStudioSkill`; only a token string is stored; token is cleared before await;
replacement clears both React token and continuation store; packaged vague,
injection-shaped, and multi-step asks never call brain/dev loop; existing dev
gate still permits the loop. Unknown hands-free speech is dropped.

```bash
cd ui
npx vitest run src/ui/AgentComposer.skillFoundry.test.ts \
  src/ui/AgentComposer.namedPlugin.test.ts
```

Expected RED: Composer still stores raw continuation data and bypasses runtime.

- [ ] **Step 2: Implement one typed core path, verify, and commit**

Add `export` to the existing `matchRemember` function in `fastPath.ts` in place
(no rename, no new sibling export); keep its existing non-MoshOps preference
write outside registry. If a token exists, consume it through
`runStudioSkill` first. Otherwise run section/remember branches, then the shared
runtime. Store a returned token only after await. On project epoch change call
`clearStudioSkillContinuations()`. Hands-free may retain its direct deterministic
transport/take path, but its unknown branch cannot reach registry/provider/dev.

```bash
cd ui
npx vitest run src/ui/{AgentComposer.skillFoundry,AgentComposer.namedPlugin}.test.ts \
  src/agent/{fastPath,performer,loop/router,skillFoundry/runtime}.test.ts
npm run typecheck
npm run build
cd ..
git add ui/src/agent/{fastPath,fastPath.test}.ts ui/src/ui/AgentComposer.tsx \
  ui/src/ui/{AgentComposer.skillFoundry,AgentComposer.namedPlugin}.test.ts
git commit -m "refactor(agent): consolidate four core routing"
```

### Task 8: Prove Four Journeys, Relaunch, and Three Loopback Passes

**Files:** Create `ui/src/agent/skillFoundry/fourCore.integration.test.ts`; modify `src/Main.cpp`, `src/app/SelfTest.cpp`, `scripts/blackhole-live-audio-gate.sh`.

**Interfaces:** Public `runStudioSkill` proof plus isolated native persistence and
owner-gated CoreAudio loopback evidence. Actual microphone/audibility proof remains Slice E manual evidence. No Ableton execution counts as proof.

- [ ] **Step 1: Write RED public-runtime journeys**

Boot the public default through a complete graph-valid mocked bundled index,
then cover supported/failure outcomes and exact final snapshots for all four;
a separate missing-approval boot must leave all four unsupported. Pin the take sequence:

Assert `start -> stop` yields `[t1]/t1`; `again` leaves `[t1]`; the next Stop
yields `[t1,t2]/t2`; Previous selects `t1`; Keep yields `[t1]`; one Undo restores
`[t1,t2]/t1`; Redo plus Save returns `[t1]/t1`.

```bash
cd ui
npx vitest run src/agent/skillFoundry/fourCore.integration.test.ts
```

Expected RED: unified runtime/lifecycle expectations are not yet integrated.

- [ ] **Step 2: Extend native live smoke to three CoreAudio loopback passes**

On one scratch clip, each successful Stop must grow stable IDs `0→1→2→3`,
preserve every earlier ID, select exactly the new ID, and produce a readable
non-silent WAV. Switch by ID, Keep, Undo once to restore all IDs/prior selection,
Redo Keep, Save, and print:

```text
take-cycle passes=3 kept_id=<uuid> source=<absolute-scratch-wav>
```

None of this exists today: `--live-audio-smoke` (`src/Main.cpp` → `runLiveAudioSmoke`
in `src/app/SelfTest.cpp`) performs one arm→record→stop pass and checks a single
non-silent WAV — it has no concept of switching by stable id, Keep, an
Undo-restores-ids/Redo cycle, or the `take-cycle passes=...` line above. Add a
new native smoke mode (e.g. a `--take-cycle-smoke` command-line flag in
`Main.cpp`, dispatching to a new `runTakeCycleSmoke` in `SelfTest.cpp`, parallel
to `runLiveAudioSmoke`) that implements the growing-ID loop, ID-based switch,
Keep, Undo-restore, Redo, Save, and the `take-cycle passes=3 kept_id=<uuid>
source=<absolute-scratch-wav>` print — this is native work, not a shell change.
The flag name is a free choice; only the dispatch discipline is fixed. `Main.cpp`
selects modes by SUBSTRING match (`commandLine.contains(...)`), which is exactly
the footgun behind SLF-CONC-001 — `commandLine.contains("--selftest")` is also
true for `--selftest-undo`, so the longer flag must be matched FIRST. Prove the
new flag collides with no existing `commandLine.contains(...)` check in
`Main.cpp` (in either direction: no existing flag is a substring of the new one,
and the new one is a substring of no existing flag), and state its required
match position relative to the existing checks. Update the BlackHole script only
to require/derive an `_harness/` session, pass it through, and invoke the new
native mode; then launch a second process:

```bash
printf '%s\n' '{"command":"__snapshot","args":{"label":"take-relaunch"}}' \
  > "$EVID/take-relaunch.jsonl"
MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="$SESSION" \
MOSH_RUNSCRIPT_KEEP_SESSION=1 \
MOSH_RUN_SCRIPT="$EVID/take-relaunch.jsonl" \
MOSH_RUN_SCRIPT_OUT="$EVID/take-relaunch.out.jsonl" \
  "$APP" --run-script > "$EVID/take-relaunch.log" 2>&1
```

Parse that second-process snapshot and assert the logged kept ID is the sole
take/current ID and its scratch `sourceFile` exists and remains non-silent. This
is the save/relaunch proof; in-process `reload` alone is insufficient.

- [ ] **Step 3: Run provisional focused checks GREEN**

```bash
cd ui
npx vitest run src/agent/skillFoundry/{fourCore.integration,runtime}.test.ts \
  src/agent/skillFoundry/native/{sessionControl,takeCycle,explicitBalance,loadNamedPlugin}.test.ts
npm run typecheck
npm run build
cd ..
scripts/auto-loop/memory-preflight.sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-tests
cmake --build --preset macos-arm64-app
ctest --test-dir build-macos-arm64 -R MoshTests --output-on-failure
```

Expected: all exit zero. This dirty-tree TDD check is not final evidence.

- [ ] **Step 4: Commit the tested harness, then run loopback/repository gates on exact HEAD**

```bash
git add src/app/SelfTest.cpp scripts/blackhole-live-audio-gate.sh \
  ui/src/agent/skillFoundry/fourCore.integration.test.ts
git commit -m "test(agent): prove four core studio journeys"
test -z "$(git status --porcelain)"
git rev-parse HEAD
scripts/auto-loop/memory-preflight.sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-tests
cmake --build --preset macos-arm64-app
ctest --test-dir build-macos-arm64 -R MoshTests --output-on-failure
APP="$PWD/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"
for pass in 1 2 3; do
  MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="_harness/skill-foundry-b-$pass" \
    "$APP" --selftest
done
MOSH_NO_AUDIO=1 MOSH_SELFTEST_SESSION="_harness/skill-foundry-b-undo" \
  "$APP" --selftest-undo
MOSH_APP_BIN="$PWD/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh" \
MOSH_AUDIO_OUTPUT_DEVICE="BlackHole 2ch" \
MOSH_AUDIO_INPUT_DEVICE="BlackHole 2ch" \
MOSH_BLACKHOLE_ATTEMPTS=3 \
scripts/blackhole-live-audio-gate.sh
scripts/auto-loop/memory-preflight.sh
scripts/auto-loop/gate.sh native "$PWD" origin/main
```

Expected: BlackHole report `PASS`, three loopback recording passes are non-silent,
the second process verifies the kept ID, and the native gate exits zero on the
same printed clean HEAD used for the canonical configure/build. Three selftest
tallies match, every summary says `0 failed`, and no JUCE assertion appears.
Missing device/permission is an environment blocker; do
not call loopback microphone proof or weaken the test. Any correction requires a
new commit and a complete rerun. Slice E still requires three real physical-input
passes plus owner audibility evidence.

## Final Review Checklist

- Four IDs map to four handlers; only the documented alias exists; continuation is first, single-use, bounded, and cleared on replacement.
- Remember stays an explicit non-MoshOps branch; packaged unsupported asks never reach provider-produced commands or the developer loop.
- Atomic balance/plugin uses `runAtomicSkillPlanV1`; both source reads stay outside manifests and pre-commit failure exact-rolls back.
- Recording never claims atomic rollback; stable IDs survive relaunch; “again” never runs blind Undo; one Undo restores Keep.
- Balance rejects taste/ambiguity/range errors; named plug-in uses the current catalog ID and adds exactly one instance.
- Mined corpora remain offline, Ableton remains reference-only, and three deterministic plus three CoreAudio loopback passes meet this slice's gates; Slice E owns the three physical-input passes.

Stop and report if Slice A differs, stable IDs cannot survive relaunch, Tracktion cannot restore Keep with one Undo, an identified
transaction cannot exact-roll back after the second guard, or physical owner input is required. Do not widen allowlists, weaken predicates, revive packaged
free-form execution, or substitute Ableton evidence for Mosh proof.
