# Moshi Skill Foundry Slice E: Certification and Owner Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the finite certification machinery, merge it, then certify the four native Moshi producer journeys from clean merged `main` through frozen mock/native/QA/manual/owner gates and the exact signed final app.

**Architecture:** The tracked Slice E PR contains only reusable runners, pure graders/builders, QA-only candidate loading, release staging code, tests, and runbooks. After that PR merges, a separate no-commit closure run creates rights-reviewed curriculum and evidence under the owner-only foundry root, calls Slice B's exact payload factory, lets Slice D perform every durable evidence/state write, stages approved native resources outside git, and verifies the exact Developer-ID-signed/notarized/stapled bundle. Slice A remains the sole native artifact-graph validator.

**Tech Stack:** TypeScript 5.6, Node 22, Vitest 2, React 18, Playwright, Python 3, C++20, JUCE 8, CMake/Ninja, MoshOps JSONL/identified transactions, macOS AX, `codesign`, `notarytool`, and `stapler`.

**Spec:** `docs/superpowers/specs/2026-08-14-moshi-skill-foundry-design.md`

## Global Constraints

- macOS Apple Silicon arm64 only. Skills execute and certify only in Mosh; Ableton is optional reference evidence.
- Slice E begins only after A-D merge. The implementation PR must merge before any real curriculum, approval, native resource, or final-release evidence is created.
- The closure run starts from clean merged `main` (or an explicitly immutable release commit equal to the recorded build identity). No commit follows closure start. Any tracked change requires a new PR, merge, and complete closure restart.
- No approved payload, report, approval, bundle entry, resource index, curriculum packet, manual evidence, attestation, or release verification is tracked. Nothing under `resources/skills/native/` is ever git-tracked: the empty index is CMake-generated at build time into the build/staging tree (Slice A), never written into the source tree, and real bundle entries are staged from an owner-local directory outside git and copied into the packaged app's `Resources` only at package time (Task 5). Enforceable invariant, checked at every gate: `git ls-files resources/skills/native/` must return nothing — a non-empty result is a hard failure, not a warning.
- Preserve the exact acyclic graph:

  ```text
  NativeSkillPayloadV1 (no downstream hashes)
    -> CertificationReportV1 + SkillApprovalV1 each bind payload
    -> NativeSkillBundleEntryV1 binds payload/report/approval/build
    -> NativeReleaseVerificationV1 binds exact final signed bundle and stays outside it
  ```

- Slice A's `validateNativeArtifactGraphV1` is the only graph validator. E builds raw bytes/envelopes and calls it; E does not add a second graph checker.
- Slice D is the sole durable evidence writer. E runners/graders/builders are pure over supplied bytes/data and may write disposable run-root output only. Only D promotes `state.jsonl`, `certification.json`, `manual-evidence.jsonl`, `approval.json`, and `release-verification.json`.
- Exact stored UTF-8 bytes determine hashes. Artifact bytes are never parsed and reserialized before hashing; canonical JSON is only for newly derived records.
- Every mutation uses existing MoshOps validation, identified transactions where atomic, events, Tracktion undo, JSONL, and post-state proof. Source-status reads never enter a mutation manifest.
- Candidate QA and final Release are separate. QA loads one hash-authorized candidate; Release compiles that loader out, rejects candidate flags with exit `64`, and loads only externally staged owner-approved native entries.
- Freeze before repair exactly 160 core cases: 30 supported and 10 non-success per journey. Every supported action has at least four cases; each journey's ten non-success cases include all six D categories.
- Supported pass bar is top-one journey **and** action: at least 27/30 per journey and 108/120 overall. All valid fills execute and meet final-state predicates. Every invalid fill is rejected before `batch_begin` at its declared phase.
- All 40 non-success cases reach the exact expected outcome with zero mutation. Infrastructure errors stay in the denominator. Required categories are `negative`, `ambiguity`, `stale_state`, `malformed_input`, `injection`, and `expected_failure`.
- Blind owner run is exactly 16 supported (four per journey) plus four unsupported (one per journey): at least 15/16, 4/4 safe unsupported, zero wrong-target or data-loss events.
- Case deadlines are mock 30 seconds and native/packaged 120 seconds; native/packaged gates are 30 minutes; a repair cycle is 60 minutes; maximum five cycles; third identical blocker stops. D owns SIGTERM, ten-second grace, identity recheck, and SIGKILL.
- Manual exit leaves no child alive. Missing primitives, unresolved rights, physical/taste judgment, UI blockers, signing credentials, or acceptance weakening are named blockers, never downgraded gates.
- Both QA and final installed-app gates exercise the shared composer in Live and Pro Tools. Browser green is not packaged/native proof.
- One optional Ableton block is capped at 30 minutes with four separate three-to-five-checkpoint journeys. It occurs before behavior approval, changes no gate state, and is never repeated because a Mosh UI/package gate is fragile.
- The four-contract combined owner review is at most 15 active minutes. A Mosh UI blocker records `ownerTeachingMayRepeat:false`; it never asks the owner to repeat teaching.
- Raw tutorial media, captions, transcripts, screenshots, `.als`, audio, and video stay outside the repo and runtime bundle. Only rights-reviewed metadata, short paraphrases, hashes, and local locators are admitted.

---

## Exact A-D Interfaces Consumed

### Slice A

- `ui/src/agent/skillFoundry/contracts.ts` owns `CertifiedSkillFileV1`, `CertifiedNativeSkillPackageBytesV1`, `CertifiedNativeSkillLoadV1`, `SkillSourceStatusReadV1`, `NativeSkillPayloadV1`, `CertificationReportV1`, `SkillApprovalV1`, `NativeSkillBundleEntryV1`, `NativeReleaseVerificationV1`, `NativeArtifactGraphInputV1`, `StudioSkillEnvironmentV1`, and all parse results.
- A raw file envelope is exact: `{name, bytes, sha256, utf8}`. Native reads return envelopes, not already-trusted parsed objects.
- `hash.ts` exports `utf8Bytes`, async `sha256Bytes`, and `canonicalJsonBytes`.
- `validate.ts` exports non-throwing `parse*V1(raw): ParseResult<T>` functions.
- `packageValidation.ts` exports `validateNativeArtifactGraphV1(input, context): Promise<NativeArtifactGraphValidationResultV1>`.
- `nativeReads.ts` exports:

  ```ts
  readCertifiedSkillPackagesV1(): Promise<CertifiedSkillLoadV1>
  readSkillSourceStatusV1(): Promise<SkillSourceStatusReadV1>
  readBundledNativeSkillsV1(): Promise<CertifiedNativeSkillLoadV1>
  ```

  They wrap literal non-MoshOps reads `read_certified_skill_packages`, `read_skill_source_status`, and `read_certified_native_skills`. `nativeAdapter.ts` remains registry adaptation only.

### Slice B/C

- `runtime.ts` exports `createStudioSkillRuntimeV1(input): StudioSkillRuntimeV1`; `.run(utterance, environment, continuationToken?)` returns `Promise<SkillOutcomeV1>`.
- `studioSkills.ts` exports `runStudioSkill(utterance, environment: StudioSkillEnvironment, continuationToken?)`; E injects this callable shape and imports `StudioSkillEnvironmentV1`, never defining another environment.
- `native/payloads.ts` exports `NATIVE_SOURCE_PATHS_V1` and `materializeNativePayloadArtifactsV1`. Closure passes exact path/byte pairs, catalog fingerprint, and `{gitCommit,gitStatusPorcelain:"",bundleVersion,target:"Mosh",configuration:"Release",architecture:"arm64"}`. E never recreates payload JSON.
- Live and Pro Tools mount the same `AgentComposer`; only an opaque `string | null` continuation is shell state.

### Slice D

Use these exact writers and ports from `ui/src/skillFoundry/`:

```ts
certifyDraftV1(input: CertificationInvocationV1, deps: CertificationCommandDepsV1): Promise<CertificationDriverResultV1>
promoteNativeReleaseVerificationV1(input: PromoteNativeReleaseVerificationInputV1, deps: CertificationCommandDepsV1): Promise<FoundryStateRecordV1>
seedNativeCoreDraftV1(input: SeedNativeCoreDraftInputV1, deps: NativeDraftSeedDepsV1): Promise<DraftSnapshotV1>
recordManualEvidenceV1(input: RecordManualEvidenceInputV1, deps: EvidenceDepsV1): Promise<ManualEvidenceRecordResultV1>
buildReviewV1(input: {draftId:string}, deps: ReviewDepsV1): Promise<SkillReviewV1>
approveDraftV1(input: ApproveDraftInputV1, deps: ApprovalDepsV1): Promise<SkillApprovalV1>
```

`nativeDraftSeed.ts` is the only native seed path and has no public CLI route. Its input contains the parsed canonical `NativeSkillPayloadV1` **and** parsed frozen `EvalCaseV1` slice; it atomically writes `candidate.skill.json` plus LF-terminated `evals.jsonl` under the same marker/lock/caps as D's declarative authoring. Native artifacts never pass through `authorCandidateArtifactsV1`. `DraftStoreV1` is exactly:

```ts
interface DraftStoreV1 {
  loadDraft(id:string):Promise<DraftSnapshotV1>
  readArtifactBytes(id:string,name:DraftArtifactNameV1,options?:{missing?:"throw"}):Promise<Uint8Array>
  readArtifactBytes(id:string,name:DraftArtifactNameV1,options:{missing:"null"}):Promise<Uint8Array|null>
  writeArtifactBytes(id:string,name:DraftArtifactNameV1,bytes:Uint8Array,
    options:{createOnly:boolean;expectedSha256?:string}):Promise<ArtifactWriteResultV1>
  createRunArtifactRoot(runId:string):Promise<string>
}
```

`ProcessSpecV1` is `{kind, executable, args, cwd, env, logDirectory}` with readonly args/env. `CertificationRunnerPortV1.run(input, supervisor)` returns the driver result. The fixed adapter command is exactly:

```text
<Mosh binary> --skill-foundry-certify-driver-v1 --request <run>/request.json --result <run>/result.json
```

`EvalCaseV1` is D's exact shape; do not add parallel journey/action fields:

```ts
type EvalCaseV1 = {
  schemaVersion:1
  id:string
  selected:
    | {journeyId:"session-control";action:"play"|"stop"|"from_start"|"save"|"undo"|"redo"}
    | {journeyId:"capture-review-choose-take";action:"record_start"|"record_stop"|"audition"|"again"|"keep"}
    | {journeyId:"explicit-balance";action:"mute"|"unmute"|"solo"|"set_level"}
    | {journeyId:"load-named-plugin";action:"load"}
  supported:boolean
  utterance:string
  fixtureSha256:string
  initialStateSha256:string
  expectedOutcome:
    | {kind:"completed";code:null}
    | {kind:"needs_choice";code:"ambiguous_skill"|"ambiguous_target"}
    | {kind:"blocked";code:Exclude<SkillReasonCodeV1,"no_match"|"ambiguous_skill"|"ambiguous_target"|"unsupported_intent">}
    | {kind:"unsupported";code:"no_match"|"unsupported_intent"}
  finalStatePredicates:readonly PredicateV1[]
  prohibitedEffects:readonly string[]
  evidenceLevel:"schema"|"mock"|"native"|"packaged"|"physical"
  scoringCategory:"selection"|"negative"|"ambiguity"|"stale_state"|"malformed_input"|"injection"|"expected_failure"
  invalidFillPhase:"none"|"candidate_selection"|"slot_validation"|"entity_resolution"|"preflight"
  expectedObservation?:string
}
```

## File Map

| Tracked file | Responsibility |
| --- | --- |
| `ui/src/agent/skillFoundry/certification/{evalCorpus,grader,artifactBuilders}.ts` | Pure frozen suites, grading, and A-validated graph-byte builders. |
| `ui/src/agent/skillFoundry/certification/{goalLoop,mockRunner,nativeRunner}.ts` | Finite next-gate decisions and shared-runtime runners. |
| `ui/src/agent/skillFoundry/certification/{candidateAuthorization,acceptance,abletonReference}.ts` | Pure QA/manual/blind/owner-boundary validators. |
| `ui/scripts/teachMoshi/{certificationRunner,prepareCoreClosure,buildCoreCurriculum,finalizeNativeRelease}.ts` | Disposable orchestration around D writers. |
| `src/app/SkillFoundryCertificationDriver.*`, `src/app/SkillCandidateTestMode.*` | Fixed native driver and compile-time QA capability. |
| `ui/src/agent/skillFoundry/{contracts,nativeReads}.ts`, `ui/src/bridge.ts`, `src/webview/WebBridge.*` | Raw candidate byte envelope and literal QA read. |
| `ui/e2e/moshi-skills.spec.ts`, `scripts/skill-foundry/{qa-package-gate.sh,packaged_skill_gate.py}` | Both-shell QA candidate proof. |
| `cmake/StageNativeSkills.cmake`, `run-mosh.sh`, release/gate scripts | External resource staging and exact signed-app proof. |
| `docs/skill-foundry/{OWNER_ACCEPTANCE,ABLETON_REFERENCE,CLOSURE_RUNBOOK}.md` | Owner/manual/no-commit procedures. |

Never add a tracked native resource directory. Synthetic test fixtures must be clearly fake and cannot satisfy a closure gate.

## Phase I — Tracked Slice E Implementation PR

### Task 1: Build Pure Frozen Suites, Grader, and Artifact Builders

**Files:** Create `evalCorpus.ts`, `grader.ts`, `artifactBuilders.ts` and colocated tests; create `ui/scripts/teachMoshi/generateCoreEvals.ts`.

**Interfaces:** Produce `buildCoreRouterCasesV1`, `buildOwnerBlindCasesV1`, `gradeCertificationCaseV1`, `summarizeCoreRouterGateV1`, and byte builders. Import D's `EvalCaseV1`; call A's parsers/hash/`validateNativeArtifactGraphV1`.

- [ ] **Write RED exact-count, selection, fill, category, and graph tests**

  ```ts
  expect(buildCoreRouterCasesV1()).toHaveLength(160);
  expect(countsByJourney(cases, true)).toEqual([30,30,30,30]);
  expect(countsByJourney(cases, false)).toEqual([10,10,10,10]);
  expect(categoriesFor(cases, "session-control")).toEqual(new Set([
    "negative","ambiguity","stale_state","malformed_input","injection","expected_failure",
  ]));
  expect(gradeCertificationCaseV1(c, {...obs, selected:{...c.selected, action:"stop"}}).passed).toBe(false);
  expect(gradeCertificationCaseV1(invalidFill, {...obs, batchBegan:true}).code).toBe("invalid_fill_after_batch_begin");
  expect(gradeCertificationCaseV1(nonSuccess, {...obs, mutationCount:1}).code).toBe("prohibited_mutation");
  expect(validateNativeArtifactGraphV1).toHaveBeenCalledTimes(1);
  // sabotage: a driver that self-reports "completed" for every case regardless of what it
  // actually did must still be caught on ground truth, never on its own self-report.
  const alwaysCompletedObs = {...obs, outcome:{kind:"completed",code:null}};
  expect(gradeCertificationCaseV1(c, alwaysCompletedObs).passed).toBe(false); // predicates/mutation still fail it
  expect(summarizeCoreRouterGateV1(cases.map((cc) => gradeCertificationCaseV1(cc, alwaysCompletedObs))))
    .toMatchObject({overallPassed:false});
  // pass-bar boundary, pinned in both directions so it cannot silently loosen
  expect(summarizeCoreRouterGateV1(journeyResultsAtScore(26, 30)).journeyPassed).toBe(false);
  expect(summarizeCoreRouterGateV1(journeyResultsAtScore(27, 30)).journeyPassed).toBe(true);
  expect(summarizeCoreRouterGateV1(aggregateResultsAtScore(107, 120)).overallPassed).toBe(false);
  expect(summarizeCoreRouterGateV1(aggregateResultsAtScore(108, 120)).overallPassed).toBe(true);
  ```

  The sabotage assertions are the RED-proof this repo's `freeze_layer` incident (CLAUDE.md
  "Gotchas that still bite") never got: a suite and grader written and unit-tested only against
  each other, with the one place real behaviour is exercised (the Phase II closure run) single-shot,
  untracked, and never re-run in CI. `grep -rn SABOTAGE` the diff before landing, per repo convention.

- [ ] **Run RED**

  Run: `npm --prefix ui test -- --run src/agent/skillFoundry/certification/evalCorpus.test.ts src/agent/skillFoundry/certification/grader.test.ts src/agent/skillFoundry/certification/artifactBuilders.test.ts`

  Expected: FAIL because the modules are absent.

- [ ] **Implement deterministic suites and state-only grading**

  Build 30 supported cases per journey using the exact D selected-action union and at least four per action. Build ten non-success cases per journey with all six categories and declared invalid-fill phase. Aggregate bytes are the LF-terminated concatenation of four 40-case slices in canonical journey order; blind bytes contain 20 cases. No timestamp enters either suite.

  Score supported cases only when top-one `selected.journeyId` and `selected.action` match, fill validation succeeded, exact outcome matched, and all state predicates passed. Require invalid fill rejection at the declared phase before `batch_begin`. Count every non-success mutation from native JSONL, not response prose.

- [ ] **Implement pure raw-byte builders**

  Convert exact stored bytes to `CertifiedSkillFileV1` using strict UTF-8, byte length, and `sha256Bytes`. Build report, approval-bound bundle entry, and external release-verification bytes without writing. At every complete graph stage call A's `validateNativeArtifactGraphV1`; return its discriminated failure unchanged. Reject any downstream hash in payload bytes.

- [ ] **Run GREEN and commit**

  ```bash
  npm --prefix ui test -- --run src/agent/skillFoundry/certification/evalCorpus.test.ts src/agent/skillFoundry/certification/grader.test.ts src/agent/skillFoundry/certification/artifactBuilders.test.ts
  npm --prefix ui run typecheck
  git add ui/src/agent/skillFoundry/certification ui/scripts/teachMoshi/generateCoreEvals.ts
  git commit -m "test(agent): define frozen skill certification suites"
  ```

  Expected: 160/120/40 and 20/16/4 counts, every category/fill invariant, sole-A-validator assertions, the sabotage-fixture rejection, and both pass-bar boundary pairs (26/30 fail, 27/30 pass; 107/120 fail, 108/120 pass) all pass.

### Task 2: Implement the Finite Driver, Mock Gate, and Native Mosh Gate

**Files:** Create `goalLoop.ts`, `mockRunner.ts`, `nativeRunner.ts`, tests, `ui/scripts/teachMoshi/{certificationRunner,mockCaseWorker,nativeCaseWorker}.ts`, `src/app/SkillFoundryCertificationDriver.{h,cpp}`; modify `src/Main.cpp`, `src/webview/WebBridge.{h,cpp}`, `ui/src/bridge.ts`, `src/app/SelfTest.cpp`, `tests/CMakeLists.txt`.

**Interfaces:** Produce `createCertificationRunnerV1(): CertificationRunnerPortV1`, `runMockGateV1`, and `runNativeGateV1`. E returns result/report bytes under the run root; D alone promotes them.

- [ ] **Write RED fixed-process, repair, and isolation tests**

  ```ts
  await runner.run(invocation, supervisor);
  expect(supervisor.specs[0]).toMatchObject({
    executable: invocation.bin, cwd: invocation.cwd, logDirectory: invocation.runRoot,
    args:["--skill-foundry-certify-driver-v1","--request",requestPath,"--result",resultPath],
  });
  expect(decideGate(repairs(5), failure("wrong_outcome"))).toMatchObject({code:"repair_budget_exhausted"});
  expect(decideGate(repeated("missing_primitive",3), failure("missing_primitive"))).toMatchObject({code:"repeated_blocker"});
  ```

  Test missing/malformed/mismatched result, nonzero exit, process timeout, dropped case, owner-root access, and active child at manual exit. D's process-supervisor tests remain the authority for PID/start-identity signaling.

- [ ] **Write a RED sabotage-fixture test proving the native gate cannot be faked green**

  Add `ui/src/agent/skillFoundry/certification/fixtures/broken-native-driver.mjs`, mirroring how Slice D's `fixtures/fake-certifier.mjs` stands in for the real driver process (Slice D Task 6): for every request it writes a `result.json` claiming `{status:"completed"}` regardless of the case's actual fixture/initial state, and never touches MoshOps — so native JSONL and final state never actually change. Point `nativeRunner.test.ts` at it across a full 120-case supported slice and assert the gate is graded on ground truth, not on the driver's self-report:

  ```ts
  const faked = await runNativeGateV1({...invocation, bin: BROKEN_NATIVE_DRIVER_FIXTURE}, supervisor);
  expect(faked.summary.overallPassed).toBe(false);
  expect(faked.summary.supportedPassed).toBeLessThan(108);
  ```

  This closes the same hole `freeze_layer` shipped through for weeks behind a passing selftest check (CLAUDE.md "Gotchas that still bite"): a self-reported `completed` status must never be trusted without matching final-state predicates and zero prohibited mutation from real native JSONL. `grep -rn SABOTAGE` the diff before landing.

- [ ] **Run RED**

  Run: `npm --prefix ui test -- --run src/agent/skillFoundry/certification/goalLoop.test.ts src/agent/skillFoundry/certification/mockRunner.test.ts src/agent/skillFoundry/certification/nativeRunner.test.ts`

  Expected: FAIL with missing runner exports.

- [ ] **Implement the exact entry mode and pure gate loop**

  `Main.cpp` accepts only the fixed D driver argv before normal GUI startup. Validate absolute same-run-root regular request/result files, bounded sizes, no link, create-only result, one result then clean exit. The UI dispatches only schema/mock/native/packaged/acceptance/release stages. No request field selects an executable, shell command, owner session, or arbitrary output.

  `Main.cpp` dispatches every mode by `commandLine.contains(...)` substring match — the exact footgun behind SLF-CONC-001, where `--selftest` matches inside `--selftest-undo` and undo must be checked first. Prove `--skill-foundry-certify-driver-v1` collides with none of the existing literals (`--brain-smoke`, `--selftest-undo`, `--golden-selftest`, `--live-audio-smoke`, `--midi-record-smoke`, `--audio-recovery-smoke`, `--scan-plugins-deep`, `--run-script`, `--voice-smoke`, `--demo3`, `--demo5`, `--demo6`, `--selftest`, `--mic`, plus Task 3's `--skill-candidate-test`/`--skill-candidate-auth`) in either direction — no existing flag is a substring of the new one and the new one is not a substring of any existing flag — and state explicitly where in the existing match-ordering chain the new check is inserted (before the generic `headless`/`--selftest` dispatch, since it must win independently of selftest mode).

  The runner revalidates run nonce/ID, payload/eval/catalog/source/build hashes, runs only the next state, and returns pure bytes/data. It never calls `DraftStoreV1.writeArtifactBytes` or a ledger function.

- [ ] **Implement the shared-runtime mock and native environments**

  Create an injected runtime with isolated registry and Slice B's normal `StudioSkillEnvironmentV1`; invoke the `runStudioSkill` callable shape. Mock uses deterministic in-memory Mosh adapters only. Native adapts `ui/scripts/agentBench.mts` cumulative-prefix replay to fresh `_harness/skill-cert-*` sessions and real MoshOps.

  At startup inject `readCertifiedSkillPackagesV1`; before transaction begin and commit call `readSkillSourceStatusV1`. Pre-approval payload bytes enter only through the QA-authorized registry seam. Prove save/relaunch, JSONL provenance, exact post-state, invalid manifest argument rollback, postcondition rollback, stale context zero mutation, and honest lifecycle partial-state recovery.

- [ ] **Add native C++20 selftest coverage**

  Extend `SelfTest.cpp` for identified begin/end/rollback, exact pre-state fingerprint, source drift before begin/commit, save/relaunch, and lifecycle partial-state reporting. Do not add a production failure-injection command.

- [ ] **Run GREEN and commit**

  ```bash
  scripts/auto-loop/memory-preflight.sh
  cmake --preset macos-arm64-debug
  cmake --build --preset macos-arm64-tests
  cmake --build --preset macos-arm64-app
  ctest --test-dir build-macos-arm64 --output-on-failure
  npm --prefix ui test -- --run src/agent/skillFoundry/certification/goalLoop.test.ts src/agent/skillFoundry/certification/mockRunner.test.ts src/agent/skillFoundry/certification/nativeRunner.test.ts
  # SLF-CONC-001-class check: the new flag must not be a substring of, or contain, any existing
  # commandLine.contains(...) literal in Main.cpp.
  FLAGS="$(rg -o 'commandLine\.contains \("(--[a-zA-Z0-9-]+)"\)' -r '$1' src/Main.cpp | sort -u)"
  echo "$FLAGS" | rg -qx -- '--skill-foundry-certify-driver-v1'
  while IFS= read -r f; do
    [ "$f" = "--skill-foundry-certify-driver-v1" ] && continue
    case "--skill-foundry-certify-driver-v1" in *"$f"*) echo "COLLISION: $f"; exit 1 ;; esac
    case "$f" in *"--skill-foundry-certify-driver-v1"*) echo "COLLISION: $f"; exit 1 ;; esac
  done <<< "$FLAGS"
  git add ui/src/agent/skillFoundry/certification ui/scripts/teachMoshi src/app/SkillFoundryCertificationDriver.* src/Main.cpp src/webview/WebBridge.* ui/src/bridge.ts src/app/SelfTest.cpp tests/CMakeLists.txt
  git commit -m "feat(agent): run bounded Mosh skill certification"
  ```

### Task 3: Add and Actually Execute the Compile-Time QA Candidate Mode

**Files:** Create `candidateAuthorization.ts`, tests, `src/app/SkillCandidateTestMode.{h,cpp}`, `tests/test_skill_candidate_mode.cpp`; modify `ui/src/agent/skillFoundry/{contracts,nativeReads}.ts`, `ui/src/bridge.ts`, `src/webview/WebBridge.{h,cpp}`, `src/Main.cpp`, `CMakeLists.txt`, `CMakePresets.json`, `cmake/BuildUI.cmake`, `tests/CMakeLists.txt`; create `scripts/skill-foundry/qa-candidate-smoke.sh` and test.

**Interfaces:** Add `NativeSkillCandidateLoadV1` to A's contract module using `CertifiedSkillFileV1` members `{authorization,payload}` plus bounded diagnostics/total bytes. Add `readSkillCandidateTestV1(): Promise<NativeSkillCandidateLoadV1>` to `nativeReads.ts`, wrapping literal `read_skill_candidate_test`.

- [ ] **Write RED authorization/raw-envelope/Release tests**

  Assert one exact run/payload/eval/native-result/source/build binding passes. Byte change, expired auth, second payload, owner-root path, symlink, wrong inode, cap +1, or parsed-object-without-raw-envelope fails. C++ test asserts the bridge binding exists only with `MOSH_SKILL_CANDIDATE_TEST`.

- [ ] **Run RED**

  Run: `npm --prefix ui test -- --run src/agent/skillFoundry/certification/candidateAuthorization.test.ts`

  Expected: FAIL because the authorization module and `nativeReads.ts` wrapper are absent.

- [ ] **Implement QA-only compile and Vite boundaries**

  Add `macos-arm64-skill-qa`/`macos-arm64-skill-qa-app` as arm64 RelWithDebInfo presets with C++ and Vite candidate flags. CMake fatally rejects `MOSH_SKILL_CANDIDATE_TEST=ON` with Release. Non-QA binaries recognize candidate flags only to print a bounded unavailable message and exit `64`; the bridge function and UI loader code are absent.

  `--skill-candidate-test` and `--skill-candidate-auth` enter the same substring-dispatch chain as every other mode, so they carry the same SLF-CONC-001 risk as Task 2's driver flag: prove each collides with no existing `commandLine.contains(...)` literal in `src/Main.cpp` in either direction, and state where each sits in the match order. Note that these two collide with *each other* by prefix — `commandLine.contains("--skill-candidate-test")` is false for `--skill-candidate-auth`, but any future shortening to a shared `--skill-candidate` stem would match both, so keep the full literals and never introduce a bare-stem check. Because the non-QA build must still *recognize* these flags to exit `64`, that recognition path is compiled into Release and is therefore inside the collision surface too — assert the ordering in both the QA and non-QA builds, not only the QA one.

- [ ] **Make the smoke create and execute its own artifacts**

  `qa-candidate-smoke.sh` creates a private `mktemp -d`, writes a valid fixture payload, authorization, driver request, and expected result path itself, runs the QA binary in candidate mode, validates returned raw byte/hash envelopes, then removes only that owned temp directory. It must assert:

  ```bash
  test -d "$QA_APP/Contents/Resources/ui"
  test -f "$QA_APP/Contents/Resources/ui/index.html"
  "$QA_BIN" --skill-candidate-test --skill-candidate-auth "$AUTH" --request "$REQUEST" --result "$RESULT"
  jq -e '.status=="passed" and .candidateLoaded==true' "$RESULT"
  ```

- [ ] **Run actual QA and prove Release absence**

  ```bash
  scripts/auto-loop/memory-preflight.sh
  cmake --preset macos-arm64-skill-qa
  cmake --build --preset macos-arm64-skill-qa-app
  QA_APP="$PWD/build-macos-arm64-skill-qa/Mosh_artefacts/RelWithDebInfo/Mosh.app"
  scripts/skill-foundry/qa-candidate-smoke.sh "$QA_APP"
  cmake --preset macos-arm64-release
  cmake --build --preset macos-arm64-release-app
  RELEASE_APP="$PWD/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app"
  scripts/skill-foundry/qa-candidate-smoke.sh --expect-unavailable "$RELEASE_APP"
  if strings "$RELEASE_APP/Contents/MacOS/Mosh" | rg -F 'read_skill_candidate_test'; then exit 1; fi
  if rg -F 'read_skill_candidate_test' "$RELEASE_APP/Contents/Resources/ui"; then exit 1; fi
  ```

  Expected: QA app really loads the fixture and has staged UI; Release returns `64` and contains no candidate binding.

- [ ] **Commit**

  ```bash
  git add ui/src/agent/skillFoundry src/app/SkillCandidateTestMode.* tests/test_skill_candidate_mode.cpp src/Main.cpp src/webview/WebBridge.* ui/src/bridge.ts CMakeLists.txt CMakePresets.json cmake/BuildUI.cmake tests/CMakeLists.txt scripts/skill-foundry/qa-candidate-smoke*
  git commit -m "feat(agent): isolate QA skill candidate loading"
  ```

### Task 4: Implement Both-Shell QA, Manual/Blind, and Owner-Time Boundaries

**Files:** Create `acceptance.ts`, `abletonReference.ts`, tests, `ui/e2e/moshi-skills.spec.ts`, `scripts/skill-foundry/{qa-package-gate.sh,qa-package-gate-test.sh,packaged_skill_gate.py,packaged_skill_gate_test.py}`; create the three `docs/skill-foundry/*.md`; modify only D's `certify.ts`, `evidence.ts`, and `reviewApproval.ts` to call E validators before D writes.

**Interfaces:** Pure validators return discriminated data; D remains the writer. Package evidence binds QA bundle identity, authorization SHA, payload/eval/native-result/source hashes, and shell result hashes.

- [ ] **Write RED both-shell and acceptance tests**

  For `bootLive()` and `bootProTools()`, test all four canonical journeys, ambiguity <=5, single-use continuation, stale project/target, unsupported refusal, exact final state, and no developer/raw fallback. Unit tests require 20 unique blind cases, >=15/16, 4/4, zero critical events, combined review elapsed `<=900_000`, one optional Ableton session, and `ownerTeachingMayRepeat:false` after a UI blocker.

- [ ] **Run RED**

  ```bash
  npm --prefix ui test -- --run src/agent/skillFoundry/certification/acceptance.test.ts src/agent/skillFoundry/certification/abletonReference.test.ts
  npm --prefix ui exec -- playwright test e2e/moshi-skills.spec.ts --project=chromium
  ```

  Expected: FAIL because validators and matrix are absent.

- [ ] **Implement QA package and real AX driver**

  Build/copy one QA app, stage one candidate authorization, clear xattrs, ad-hoc sign after all writes, strict-verify, and launch with an empty isolated agent root. Assert `Contents/Resources/ui/index.html` before launch. Each case is 120 seconds; whole gate is 30 minutes. Reuse `scripts/macos-ui-automation-gate.py` ownership patterns, capture only recorded PIDs, and grade native JSONL/final state. Browser-only or text-only success fails.

- [ ] **Implement manual, blind, Ableton, and review policy validators**

  Manual evidence binds run/case/observation/payload/eval/build and external regular-file hashes. Take requires three physical mic passes, retained prior IDs, audible kept take after save/relaunch, and zero unexpected clips/assertions. Plug-in requires exact installed ID on intended track and undo. Session/balance require explicit reviewed `physical_not_required` statements.

  Ableton accepts exactly four separate 3-5 checkpoint records from at most one 30-minute isolated blank Set and yields zero state transitions. If unsafe/unavailable, record `reference_skipped_unsafe`. A UI/package blocker prevents a repeated owner teaching/reference request. Combined review starts only after all gates/reference decisions and all four explicit fingerprints must be approved within 15 active minutes.

- [ ] **Run GREEN and commit**

  ```bash
  bash scripts/skill-foundry/qa-package-gate-test.sh
  python3 scripts/skill-foundry/packaged_skill_gate_test.py
  npm --prefix ui test -- --run src/agent/skillFoundry/certification/acceptance.test.ts src/agent/skillFoundry/certification/abletonReference.test.ts
  npm --prefix ui exec -- playwright test e2e/moshi-skills.spec.ts --project=chromium
  git add ui/src/agent/skillFoundry/certification ui/src/skillFoundry/{certify,evidence,reviewApproval}.ts ui/e2e/moshi-skills.spec.ts scripts/skill-foundry docs/skill-foundry
  git commit -m "test(agent): gate skill acceptance in both shells"
  ```

### Task 5: Implement External Native Resource Staging and Final Signed-App Proof

**Files:** Create `cmake/StageNativeSkills.cmake`, `scripts/skill-foundry/{native_bundle_inspect.py,native_bundle_inspect_test.py,native_release_verify.py,native_release_verify_test.py}` and synthetic fixtures; modify `CMakeLists.txt`, `run-mosh.sh`, `scripts/auto-loop/installed-app-gate.sh`, `scripts/release/sign-and-notarize.sh`, `tests/CMakeLists.txt`; create `ui/scripts/teachMoshi/{prepareCoreClosure,buildCoreCurriculum,finalizeNativeRelease}.ts`.

**Interfaces:** `MOSH_NATIVE_SKILL_RESOURCE_DIR` is an absolute external input root; `MOSH_RELEASE_DIR` is an absent external output root. Inspect signed identity first, run installed evidence second, then build external `NativeReleaseVerificationV1`; D's `promoteNativeReleaseVerificationV1` writes it and states.

- [ ] **Write RED staging/tamper/order tests**

  Synthetic roots test missing/extra/link/hardlink/tampered payload/report/approval/entry/index, wrong B build identity, resource verification inside bundle, candidate loader present, wrong CDHash, unstapled app, mismatched installed result, and verification emitted before installed evidence.

  Run: `python3 scripts/skill-foundry/native_bundle_inspect_test.py && python3 scripts/skill-foundry/native_release_verify_test.py`

  Expected: FAIL because inspectors do not exist.

- [ ] **Implement external-only resource staging**

  Accept exactly `index.json` plus four `<id>/{payload,certification,approval,bundle-entry}.json` directories: 17 regular files, no extras/links. Rebuild raw envelopes and call A's validator before copying into A's fixed application resource topology. Make staging precede UI/service metadata and every signature. With env unset, build a valid no-native-skills app; never fall back to a tracked resource root.

- [ ] **Wire the full release command**

  `run-mosh.sh release` must preserve and validate both env roots, take its build input from the exact canonical `$ROOT/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app` rather than the newest-app resolver, stage native resources before Developer-ID signing, and leave the exact final app at `$MOSH_RELEASE_DIR/Mosh.app`. Existing preflight, service bundle, sign, notarize, staple, DMG, DMG sign/notary/staple, and zip all still run. No post-sign step mutates the app.

- [ ] **Split identity inspection from final verification**

  `native_bundle_inspect.py` runs only after signing/stapling and emits bundle SHA-256 (sorted relative path/type/mode/size/file hash or link target, never following links), one CDHash, canonical B build identity, resource-index hash, signature/notary/staple checks, and candidate-loader absence.

  Extend installed-app gate to require that identity file, recompute bundle/CDHash/build before and after its tests, run selftest x3 and both packaged shells, and emit bound JSON. Only afterward may `native_release_verify.py` build four external verification byte sets with checks `native_selftest`, `live_shell`, `protools_shell`, `resource_index`, and `candidate_loader_absent`.

- [ ] **Run GREEN and commit all remaining tracked machinery**

  ```bash
  python3 scripts/skill-foundry/native_bundle_inspect_test.py
  python3 scripts/skill-foundry/native_release_verify_test.py
  npm --prefix ui test -- --run src/agent/skillFoundry/certification
  npm --prefix ui run typecheck
  git add cmake/StageNativeSkills.cmake scripts/skill-foundry ui/scripts/teachMoshi CMakeLists.txt run-mosh.sh scripts/auto-loop/installed-app-gate.sh scripts/release/sign-and-notarize.sh tests/CMakeLists.txt
  git commit -m "feat(release): stage and verify external native skills"
  ```

### Task 6: Gate the Clean Committed Slice E PR and Stop for Merge

**Files:** Verify all tracked Slice E files; create no evidence.

**Interfaces:** Produces a reviewable implementation commit series only. It does not produce certification.

- [ ] **Require clean committed HEAD before authoritative gates**

  ```bash
  test -z "$(git status --porcelain=v1)"
  git diff --check origin/main...HEAD
  git diff --stat origin/main...HEAD
  test -z "$(git ls-files resources/skills/native/)"
  scripts/auto-loop/memory-preflight.sh
  ```

- [ ] **Run focused, Release, and native gates against that HEAD**

  ```bash
  npm --prefix ui test -- --run src/agent/skillFoundry/certification src/skillFoundry
  npm --prefix ui run typecheck
  npm --prefix ui run build
  cmake --preset macos-arm64-release
  cmake --build --preset macos-arm64-release-tests
  ctest --test-dir build-macos-arm64-release --output-on-failure
  scripts/auto-loop/gate.sh native "$PWD" origin/main
  test -z "$(git status --porcelain=v1)"
  ```

  Expected: all pass, selftest x3 counts match with zero failures/assertions, and the tree stays clean. If a repair is needed, commit it and rerun this entire task.

- [ ] **Open the implementation PR and stop**

  Push the Slice E branch and open its PR with exact tallies. Do not create packets, owner approval, external resources, or release proof from the PR commit. The owner merges; then start Phase II from the merged commit.

## Phase II — Post-Merge Clean-Main Program Closure (No Commits)

Once Task 7 starts, no `git add`, `git commit`, source edit, documentation edit, payload rewrite, or eval correction is permitted. Any required change invalidates all downstream evidence and returns to a new implementation PR.

### Task 7: Freeze Clean Merged Identity and Create Four Five-Artifact Curriculum Packets

**Files:** External only beneath the path printed by `prepareCoreClosure.ts`; D writes four drafts. No repo file changes.

**Interfaces:** Calls B's factory and D's native-only `seedNativeCoreDraftV1`; outputs four packet roots and draft IDs in `closure.json`.

- [ ] **Pin clean merged main and fail early on signing**

  ```bash
  git switch main
  git pull --ff-only origin main
  test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
  test -z "$(git status --porcelain=v1)"
  scripts/auto-loop/memory-preflight.sh
  scripts/release/sign-and-notarize.sh --preflight-only
  ```

  Expected: clean merged identity and usable Developer ID/notary credentials. Failure stops before owner work.

- [ ] **Create an exact external closure root**

  ```bash
  CLOSURE_MANIFEST="$(cd ui && npm exec -- tsx scripts/teachMoshi/prepareCoreClosure.ts --print-manifest)"
  CLOSURE_ROOT="$(dirname "$CLOSURE_MANIFEST")"
  jq -e --arg head "$(git rev-parse HEAD)" '.gitCommit==$head and .status=="prepared"' "$CLOSURE_MANIFEST"
  ```

  The script uses `resolveFoundryPathsV1`/`createRunArtifactRoot`, creates 0700/0600 external paths, records the exact clean commit/version/catalog/build inputs, and refuses an existing nonempty closure root.

- [ ] **Create four rights-reviewed source cards**

  Under `$CLOSURE_ROOT/curriculum/<journey>/`, Codex creates one input from `docs/templates/recipe-source-candidate.md` and projects `source-card.json` with `service/corpus/recipe_source_intake.py`. Use the spec's official Ableton/Avid anchors; plug-in claims may use only the currently installed vendor guide. Each card has 1-10 short paraphrased claims, explicit rights/acquisition/handling, versions/access date, current review state, and no raw media/transcript.

  Exact claim ceilings are: session transport/save/undo state; take prerequisites/transitions/retention; balance mute/solo/explicit dB with no taste claim; plug-in catalog/type/disambiguation with no availability assumption.

- [ ] **Build exactly five artifacts per packet and seed D**

  ```bash
  (cd ui && npm exec -- tsx scripts/teachMoshi/buildCoreCurriculum.ts --closure "$CLOSURE_MANIFEST")
  jq -e '.packets|length==4 and all(.[]; (.artifacts|keys|sort)==["candidate","canonicalTrace","capabilityMap","evals","sourceCard"])' "$CLOSURE_MANIFEST"
  ```

  For each journey produce only: `source-card.json`, `capability-map.json`, `canonical-trace.json`, exact `candidate.skill.json`/native payload, and 40-case `evals.jsonl`. Capability maps classify `observed|executable|missing|reference_only`; traces are semantic Mosh state/operations, never Ableton coordinates.

  Read every exact regular file in `NATIVE_SOURCE_PATHS_V1`, call `materializeNativePayloadArtifactsV1`, and pass its parsed payload plus the parsed frozen D `EvalCaseV1` slice together to `seedNativeCoreDraftV1`. That D helper alone atomically writes both artifact files; E performs no durable write. Re-read with the exact `DraftStoreV1` overloads and verify hashes. Aggregate slices must be 160/120/40; blind suite 20/16/4. Freeze bytes before any repair.

- [ ] **Validate all four drafts with the real CLI spelling**

  ```bash
  jq -r '.packets[]|[.draftId,.artifacts.sourceCard,.artifacts.capabilityMap,.artifacts.canonicalTrace]|@tsv' "$CLOSURE_MANIFEST" | while IFS=$'\t' read -r draft source capability trace; do
    npm --prefix ui run teach-moshi -- add-source --draft "$draft" --card "$source"
    npm --prefix ui run teach-moshi -- add-reference --draft "$draft" --file "$capability"
    npm --prefix ui run teach-moshi -- add-reference --draft "$draft" --file "$trace"
  done
  jq -r '.packets[].draftId' "$CLOSURE_MANIFEST" | while IFS= read -r draft; do
    npm --prefix ui run teach-moshi -- validate --draft "$draft"
    npm --prefix ui run teach-moshi -- status --draft "$draft"
  done
  test -z "$(git status --porcelain=v1)"
  ```

  Expected: four `schema_valid` native drafts bound to exact packet/payload/eval/source/catalog/build hashes; git stays clean.

### Task 8: Run Frozen Mock, Native, and Actual QA Package Gates

**Files:** External run artifacts only.

- [ ] **Run mock then native through D's supervised CLI**

  ```bash
  DEBUG_BIN="$PWD/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh"
  for stage in mock native; do
    jq -r '.packets[].draftId' "$CLOSURE_MANIFEST" | while IFS= read -r draft; do
      npm --prefix ui run teach-moshi -- certify --draft "$draft" --bin "$DEBUG_BIN"
    done
  done
  ```

  Expected: `mock_green`, then `native_green`; supported top-one/fill bars pass, all 40 non-success cases have zero mutations, and native artifacts prove post-state/rollback/lifecycle truth.

- [ ] **Build and actually run the candidate QA app**

  ```bash
  scripts/auto-loop/memory-preflight.sh
  cmake --preset macos-arm64-skill-qa
  cmake --build --preset macos-arm64-skill-qa-app
  QA_APP="$PWD/build-macos-arm64-skill-qa/Mosh_artefacts/RelWithDebInfo/Mosh.app"
  test -f "$QA_APP/Contents/Resources/ui/index.html"
  scripts/skill-foundry/qa-package-gate.sh --closure "$CLOSURE_MANIFEST" --app "$QA_APP" --out "$CLOSURE_ROOT/gates/qa-package.json"
  jq -e '.pass and .candidateModeExecuted and .shells.live.pass and .shells.protools.pass' "$CLOSURE_ROOT/gates/qa-package.json"
  ```

  The gate creates exact authorization files under the closure root from prior hashes; there are no unexplained `/tmp` inputs. It launches candidate mode, not a mock, and binds output to QA app/payload/eval/native/source hashes.

- [ ] **Promote packaged results through D and honor UI blockers**

  Run `npm --prefix ui run teach-moshi -- certify --draft <id> --bin "$QA_APP/Contents/MacOS/Mosh"` for each manifest draft. If AX/screen/UI fails, record `product_ui_blocker` and `ownerTeachingMayRepeat:false`, stop without asking for manual/Ableton teaching, and fix only through a new PR/restart.

### Task 9: Complete Manual, Blind, Optional Ableton, Acceptance, and Combined Review

**Files:** External manual/reference/owner records; D promotes evidence/report.

- [ ] **Record required physical decisions through D**

  Create bounded evidence JSON under `$CLOSURE_ROOT/manual/` from real Mosh scratch sessions. Use:

  ```bash
  npm --prefix ui run teach-moshi -- record-evidence --draft "$DRAFT" --case "$CASE" --evidence "$EVIDENCE_JSON"
  ```

  Perform three physical mic take passes and one installed named-plug-in editor/undo check. Record explicit reviewed `physical_not_required` for session/balance. E validates; D alone appends `manual-evidence.jsonl`.

- [ ] **Run the blind 20-task Live-shell owner-style suite**

  ```bash
  python3 scripts/skill-foundry/packaged_skill_gate.py --closure "$CLOSURE_MANIFEST" --app "$QA_APP" --suite owner-blind-v1 --shell live --out "$CLOSURE_ROOT/gates/owner-blind.json"
  jq -e '.supported.total==16 and .supported.passed>=15 and .unsupported.total==4 and .unsupported.passed==4 and .wrongTarget==0 and .dataLoss==0' "$CLOSURE_ROOT/gates/owner-blind.json"
  ```

- [ ] **Optionally run Ableton once, before approval**

  If specific unresolved reference questions remain, use one blank isolated Set for <=30 minutes, four separate journeys, and 3-5 checkpoints each. Write `$CLOSURE_ROOT/ableton/<journey>/reference.json`, then add each with `npm --prefix ui run teach-moshi -- add-reference --draft "$DRAFT" --file "$REFERENCE_JSON"`. If Live is unsafe/unavailable or QA had a UI blocker, record skip/no-repeat and do not open or alter owner work. Ableton produces no certification transition.

- [ ] **Freeze acceptance reports through D**

  Invoke `npm --prefix ui run teach-moshi -- certify --draft <id> --bin "$QA_APP/Contents/MacOS/Mosh"` for each draft. D writes exact `certification.json` only after ordered schema/mock/native/packaged/acceptance results, manual hashes, blind hash, and optional-reference decision validate. Reports freeze at `acceptance_green`.

- [ ] **Run one combined <=15-minute review and stop for explicit approval**

  ```bash
  (cd ui && npm exec -- tsx scripts/teachMoshi/prepareCoreClosure.ts --begin-combined-review --closure "$CLOSURE_MANIFEST")
  jq -r '.packets[].draftId' "$CLOSURE_MANIFEST" | while IFS= read -r draft; do
    npm --prefix ui run teach-moshi -- review --draft "$draft"
  done
  ```

  Present the four contracts/fingerprints together. Stop for a new explicit owner statement approving those exact fingerprints. Architecture/plan approval does not count. If active review exceeds 900 seconds, record `owner_time_budget_exceeded`; teaching is not repeated.

### Task 10: Approve Exact Fingerprints and Stage Approved Resources Outside Git

**Files:** D writes approvals; external resource root only.

- [ ] **Validate the explicit combined attestation and approve each draft**

  Codex records the owner's actual statement, actor, channel/conversation locator, timestamp, four review SHAs, and review start in `$CLOSURE_ROOT/owner/combined-attestation.json`. Then:

  ```bash
  (cd ui && npm exec -- tsx scripts/teachMoshi/prepareCoreClosure.ts --split-attestation --closure "$CLOSURE_MANIFEST")
  jq -r '.packets[]|[.draftId,.reviewSha256,.attestationPath]|@tsv' "$CLOSURE_MANIFEST" | while IFS=$'\t' read -r draft sha attestation; do
    npm --prefix ui run teach-moshi -- approve --draft "$draft" --review-sha "$sha" --attestation "$attestation"
  done
  ```

  Expected: all four reach `owner_approved`; elapsed review <=900 seconds; all hashes still match.

- [ ] **Stage exactly 17 approved files externally**

  ```bash
  (cd ui && npm exec -- tsx scripts/teachMoshi/buildCoreCurriculum.ts --stage-approved-native --closure "$CLOSURE_MANIFEST")
  RESOURCE_ROOT="$(jq -er '.nativeResourceRoot' "$CLOSURE_MANIFEST")"
  test "$(find "$RESOURCE_ROOT" -type f | wc -l | tr -d ' ')" = 17
  test -z "$(find "$RESOURCE_ROOT" -type l -print -quit)"
  test -z "$(git status --porcelain=v1)"
  ```

  Re-envelope exact payload/report/approval bytes, build bundle entries with B build identity, call A's sole graph validator, write sorted `index.json`, and re-read/revalidate. No release verification is present. Never copy this root into the repository.

### Task 11: Release, Verify the Exact Signed App, Run Both Shells, and Certify

**Files:** External release/gate/evidence roots and D state only.

- [ ] **Run the full production release path with exact external roots**

  ```bash
  RELEASE_DIR="$(jq -er '.releaseRoot' "$CLOSURE_MANIFEST")"
  test ! -e "$RELEASE_DIR/Mosh.app"
  MOSH_NATIVE_SKILL_RESOURCE_DIR="$RESOURCE_ROOT" MOSH_RELEASE_DIR="$RELEASE_DIR" ./run-mosh.sh release | tee "$CLOSURE_ROOT/gates/full-release.log"
  FINAL_APP="$RELEASE_DIR/Mosh.app"
  test -d "$FINAL_APP"
  ```

  Expected: full Release build, external resource staging, Developer-ID signing, app notarization/stapling, DMG creation/sign/notarization/stapling, and zip complete. No shortcut build or ad-hoc signature can certify.

- [ ] **Verify signature/notary/staple and derive immutable identity**

  ```bash
  codesign --verify --deep --strict --verbose=2 "$FINAL_APP"
  spctl --assess --type execute --verbose=4 "$FINAL_APP"
  xcrun stapler validate "$FINAL_APP"
  python3 scripts/skill-foundry/native_bundle_inspect.py --app "$FINAL_APP" --resource-root "$RESOURCE_ROOT" --out "$CLOSURE_ROOT/gates/signed-bundle-identity.json"
  ```

  The identity includes final bundle SHA, CDHash, B build identity, resource index, and candidate-loader absence.

- [ ] **Run both-shell installed-app evidence bound to that same identity**

  ```bash
  MOSH_INSTALLED_APP="$FINAL_APP" MOSH_SKILL_BUNDLE_IDENTITY="$CLOSURE_ROOT/gates/signed-bundle-identity.json" scripts/auto-loop/installed-app-gate.sh --no-deploy full > "$CLOSURE_ROOT/gates/installed-app.json"
  jq -e '.pass and .skillIdentityMatched and .skills.shells.live.pass and .skills.shells.protools.pass' "$CLOSURE_ROOT/gates/installed-app.json"
  ```

  The gate re-hashes bundle/CDHash/build before and after selftest x3 and both-shell runs. Counts must match with zero failures/assertions; final Release still rejects candidate mode.

- [ ] **Only now emit external release verification and let D promote**

  ```bash
  python3 scripts/skill-foundry/native_release_verify.py --closure "$CLOSURE_MANIFEST" --app "$FINAL_APP" --signed-identity "$CLOSURE_ROOT/gates/signed-bundle-identity.json" --installed-gate "$CLOSURE_ROOT/gates/installed-app.json" --out-root "$CLOSURE_ROOT/gates/native-release"
  (cd ui && npm exec -- tsx scripts/teachMoshi/finalizeNativeRelease.ts --closure "$CLOSURE_MANIFEST")
  ```

  E builds four pure `NativeReleaseVerificationV1` byte sets, each bound to its payload/report/approval/entry plus the exact final bundle/CDHash/build and required checks. D's `promoteNativeReleaseVerificationV1` parses/rechecks, writes external draft verification, and appends `owner_approved -> release_packaged_green -> certified`.

- [ ] **Prove closure without changing git**

  ```bash
  jq -r '.packets[].draftId' "$CLOSURE_MANIFEST" | while IFS= read -r draft; do
    npm --prefix ui run teach-moshi -- status --draft "$draft" | jq -e '.state=="certified"'
  done
  test -z "$(git status --porcelain=v1)"
  test "$(git rev-parse HEAD)" = "$(jq -er '.gitCommit' "$CLOSURE_MANIFEST")"
  ```

  No commit follows. Any payload, report, approval, resource, app, signature, gate, code, or documentation change invalidates the verification and restarts from a newly merged clean commit.

## Completion Checklist

- [ ] Slice E implementation merged before real evidence; closure HEAD equals recorded merged `main` and remains clean.
- [ ] Four external rights-reviewed packets contain exactly five named artifacts and exact B-factory payload bytes.
- [ ] D's exact EvalCase union drives 160/120/40 plus blind 20/16/4; top-one journey/action, fill phase, categories, and zero-mutation rules pass.
- [ ] Mock/native/QA package gates pass; candidate mode actually executes and QA `Resources/ui/index.html` exists.
- [ ] Release loader is absent, candidate flags exit `64`, and no owner root is used by QA.
- [ ] Manual take/plugin evidence, physical-not-required decisions, blind run, and optional Ableton/no-repeat decision precede approval.
- [ ] One combined review is <=15 active minutes and exact fingerprint approval is explicit.
- [ ] No approved resource/evidence is tracked; external staging is exactly 17 regular files.
- [ ] Full env-bound `./run-mosh.sh release` produces the exact signed/notarized/stapled final app.
- [ ] Both-shell installed evidence binds the unchanged bundle SHA/CDHash/build identity.
- [ ] A alone validates graph semantics; D alone writes durable evidence/state.
- [ ] Four external verifications remain outside the bundle and all four native drafts finish `certified`.
- [ ] No commit or tracked edit occurs after closure starts.

Slice E is not complete at compile, mock green, QA green, approval, or signing alone. It completes only when D records `certified` for all four native journeys from external verification of the exact final signed Mosh app built from the immutable merged commit.

**`certified` is not protected by any standing gate.** Unlike a MoshOps command, which stays proven by `--selftest`/CI on every subsequent change, the native `certified` state comes from Phase II: a single, unrepeated, untracked, owner-supervised closure run with no CI re-entry point. Once it finishes, nothing re-runs it — a later change to the router, the catalog, a dependency, or any file the four journeys depend on can silently invalidate the certification with no automated signal. The only way to know `certified` still means something is to rerun the entire closure program from a newly merged clean commit. Do not assume a standing regression gate protects this state the way one protects everything else in this repo.
