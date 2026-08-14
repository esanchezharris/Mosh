# Moshi Skill Foundry Slice D Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the offline `teach-moshi` CLI that creates bounded skill drafts, admits lawful source/reference evidence, maintains immutable certification state, and installs only exact approved declarative packages into Mosh's certified local registry.

**Architecture:** TypeScript modules under `ui/src/skillFoundry/` consume Slice A's contracts, validators, catalogs, hashes, registry, and package checker rather than duplicating runtime policy. The existing Python recipe-source intake becomes the bounded Markdown-to-`SourceCardV1` projector. Slice D owns safe storage, locking, process supervision, evidence, approval, and declarative package lifecycle; Slice E plugs its real certification driver into the port defined here.

**Tech Stack:** TypeScript 5.6, Node.js 22 standard library, `tsx`, Vitest 2, Python 3 standard library.

**Spec:** `docs/superpowers/specs/2026-08-14-moshi-skill-foundry-design.md`

## Global Constraints

- Add only `"teach-moshi": "tsx src/skillFoundry/cli.ts"` to `ui/package.json`. Root invocation is `npm --prefix ui run teach-moshi -- ...`; UI-local invocation is `cd ui && npm run teach-moshi -- ...`. There is no root `package.json`.
- Every invocation writes exactly one compact `CliEnvelopeV1` JSON object plus LF to stdout. Stderr is diagnostic only. Exit codes are `0` success/manual checkpoint, `1` domain or operational failure, and `2` usage failure.
- Commands are exactly `init`, `add-source`, `add-reference`, `validate`, `certify`, `record-evidence`, `review`, `approve`, `install`, `rollback`, `revoke`, `refresh-source`, `revoke-source`, `gc`, and `status`, with the flags in Spec §5.3.
- Draft root defaults to `$HOME/Library/Mosh/teach`; runtime root defaults to `$HOME/Library/Mosh/agent` unless `MOSH_AGENT_DIR` is set. Tests inject both roots and never read owner data. Overrides are absolute, owner-owned, non-symlink roots; root/certified directories are not group/world writable.
- Owner IDs match `[a-z0-9]+(?:-[a-z0-9]+)*`, have at most 64 characters, use `owner-*`, and cannot collide with native IDs, aliases, or generated `builtin-*` IDs. Versions are SemVer without build metadata.
- Public `init`, authoring, approval, and `install` accept declarative `owner-*` skills only. The non-public native seeder accepts only the four canonical native IDs and a `NativeSkillPayloadV1` already accepted by Slice A; it has no CLI command or general native-registration path.
- Artifact hashes cover exact stored UTF-8 bytes. Canonical JSON is used only for semantic records. Review SHA is exactly `SHA256(UTF8("mosh-skill-review-v1\n" + artifactSha256 + "\n" + certificationReportSha256 + "\n"))`.
- Raw media, transcripts, captions, screenshots, `.als` files, audio, and video are never copied. Source intake copies metadata JSON only; references/evidence store revalidated regular-file locators. No crawler, downloader, unofficial transcript API, AbletonOSC mutation, or Ableton execution is added.
- Exact foundry caps: 32 drafts; 64 MiB/draft; 1 GiB all draft metadata; 32 source cards/draft; 1 MiB/source card or attestation; 32 references/draft; 4 GiB/external referenced file; 512 evals and 4 MiB `evals.jsonl`; 4,096 records and 4 MiB `state.jsonl`; 128 records and 4 MiB `manual-evidence.jsonl`; 2 GiB/run; 20 GiB all run artifacts.
- Exact package caps inherited from Slice A: 64 local skills; 64 KiB manifest; 256 KiB report; 16 KiB approval; 4 KiB release; 64 KiB native release verification; 8 MiB accepted packages; 64 KiB/64-entry activation index; 256 KiB/256-entry source index.
- All mutations take one foundry lock. Quotas are rechecked under the lock immediately before publication. Root-cap failure deletes nothing.
- Process deadlines are fixed by kind: mock case 30 seconds; native/packaged case 120 seconds; native/packaged gate 30 minutes; repair cycle 60 minutes. Timeout signals only the verified child process group: `SIGTERM`, 10-second grace, then `SIGKILL` after another PID/start-identity check.
- Source freshness uses RFC 3339 UTC and requires `state === "current"`, matching snapshot hash, and `now < reviewAfter`; equality is expired. Missing, malformed, stale, superseded, revoked, expired, or mismatched entries fail closed.
- Source-card IDs are safe lowercase ASCII path components matching the skill-slug regex. Rights are exactly `official_public_documentation|creator_authorized|user_owned_or_licensed|manual_paraphrase_only`; acquisition is exactly `official_https_page|creator_authorized_file|user_supplied_local_file|manual_viewing_notes`; platform handling is exactly `metadata_and_short_paraphrases_only|local_locator_only`. Unknown, unresolved, scraped, unofficial-transcript, or unlisted values fail admission.
- Install writes exactly `skill.json`, `certification.json`, `approval.json`, and `release.json` (`release.json` last) to `<skill-id>@<version>`. It is offline, versioned, crash-safe, and visible only after next Mosh launch.
- Declarative state reaches `certified` when the exact `SkillReleaseV1` envelope is validated and durably published; activation is a separate index operation and is never a certification transition. Native state cannot use that branch: it must pass `owner_approved -> release_packaged_green -> certified`.
- `gc` is dry-run unless `--apply`, uses a 90-day strict age threshold, and never follows links, deletes packages/external references, or collects anything reachable from active, approved, installed, or unresolved-blocker state.
- Slice E owns actual schema/mock/native/package/physical gates, repair policy, QA candidate loader, native signed-bundle verification, and optional Ableton reference session. Slice D's driver result never writes approval.
- Slice D is the sole durable evidence writer. Slice E runners, graders, and validators are pure over supplied bytes/data and may write disposable run-root outputs only; only D promotes `state.jsonl`, `certification.json`, `manual-evidence.jsonl`, `approval.json`, or `release-verification.json`.

## Slice A Dependencies (consume verbatim)

```ts
// ui/src/agent/skillFoundry/hash.ts
utf8Bytes(value: string): Uint8Array
sha256Bytes(bytes: Uint8Array): Promise<string>
canonicalJsonBytes(value: unknown): Uint8Array

// validate.ts — each returns ParseResult<T>
parseSkillManifestV1(value: unknown)
parseCertificationReportV1(value: unknown)
parseSkillApprovalV1(value: unknown)
parseSkillReleaseV1(value: unknown)
parseSkillActivationIndexV1(value: unknown)
parseSourceStatusV1(value: unknown)
parseNativeSkillPayloadV1(value: unknown)
parseNativeReleaseVerificationV1(value: unknown)

// catalogs.ts
NATIVE_SKILL_IDS_V1
OWNER_PRIMITIVES_V1
OWNER_PREDICATES_V1
catalogFingerprintV1(): Promise<CatalogFingerprintV1>

// packageValidation.ts
validateCertifiedSkillPackageV1(input: CertifiedSkillPackageBytesV1, context: SkillCompatibilityContextV1): Promise<PackageValidationResultV1>
validateSourceStatusForInvocationV1(input: SourceStatusCheckInputV1): SourceStatusCheckResultV1

// registry.ts
buildStudioSkillRegistryV1(input: RegistryBuildInputV1): Promise<RegistryBuildResultV1>
validateRegistryCandidateV1(candidate: RegistryCandidateV1, occupied: RegistryIdentitySetV1): RegistryCandidateValidationV1
```

All V1 artifact/result types and `SKILL_LIMITS_V1`/`FOUNDRY_LIMITS_V1` come from `ui/src/agent/skillFoundry/contracts.ts` and `limits.ts`. Untrusted artifact failures use discriminated results, not exceptions.

## File Map

- Modify `ui/package.json`; create `ui/src/skillFoundry/{contracts,paths,safeFs,lock,quota,stateLedger,draftStore,sourceCards,sourceStatus,references,evals,candidate,compilerAuthoring,nativeDraftSeed,processSupervisor,certify,evidence,reviewApproval,packageLifecycle,gc,commands,cli}.ts`, `testHelpers.ts`, `fixtures/fake-certifier.mjs`, and the non-public developer entrypoint `ui/scripts/teachMoshi/authorCandidate.ts`.
- Create exactly `contracts.test.ts`, `pathsSafeFs.test.ts`, `lockQuota.test.ts`, `stateLedgerDraft.test.ts`, `sourceCardsStatus.test.ts`, `references.test.ts`, `candidateEvals.test.ts`, `compilerAuthoring.test.ts`, `nativeDraftSeed.test.ts`, `processSupervisor.test.ts`, `evidence.test.ts`, `reviewApproval.test.ts`, `packageLifecycle.test.ts`, `gc.test.ts`, and `cli.test.ts` beside those modules.
- Modify `docs/templates/recipe-source-candidate.md`, `service/corpus/recipe_source_intake.py`, `service/corpus/recipe_source_intake_test.py`, and its three existing Markdown fixtures.
- `contracts.ts` owns only Slice D CLI/draft/source/eval/process types. It imports Slice A types; it does not redefine runtime artifacts.
- `draftStore.ts` exposes exact draft slots: `request.json`, `sources/`, `references/`, `candidate.skill.json`, `evals.jsonl`, `state.jsonl`, `manual-evidence.jsonl`, `certification.json`, `approval.json`, and `release-verification.json`, plus `artifacts/<run-id>/`.

## Slice D Interfaces Exported to Slice E

Keep these names/signatures stable so Slice E can implement the real gate loop without reaching into CLI internals:

```ts
resolveFoundryPathsV1(env?: NodeJS.ProcessEnv, homeDir?: string, uid?: number): Promise<FoundryPathsV1>
createDraftStoreV1(paths: FoundryPathsV1, clock: ClockV1): DraftStoreV1
readStateLedgerV1(path: string): Promise<FoundryStateRecordV1[]>
createProcessSupervisorV1(deps?: ProcessSupervisorDepsV1): ProcessSupervisorV1
certifyDraftV1(input: CertificationInvocationV1, deps: CertificationCommandDepsV1): Promise<CertificationDriverResultV1>
promoteNativeReleaseVerificationV1(input: PromoteNativeReleaseVerificationInputV1, deps: CertificationCommandDepsV1): Promise<FoundryStateRecordV1>
authorCandidateArtifactsV1(input: AuthorCandidateArtifactsInputV1, deps: CompilerAuthoringDepsV1): Promise<AuthorCandidateArtifactsResultV1>
seedNativeCoreDraftV1(input: SeedNativeCoreDraftInputV1, deps: NativeDraftSeedDepsV1): Promise<SeedNativeCoreDraftResultV1>
recordManualEvidenceV1(input: RecordManualEvidenceInputV1, deps: EvidenceDepsV1): Promise<ManualEvidenceRecordResultV1>
buildReviewV1(input: { draftId: string }, deps: ReviewDepsV1): Promise<SkillReviewV1>
approveDraftV1(input: ApproveDraftInputV1, deps: ApprovalDepsV1): Promise<SkillApprovalV1>

interface DraftStoreV1 {
  loadDraft(draftId: string): Promise<DraftSnapshotV1>
  readArtifactBytes(draftId: string, name: DraftArtifactNameV1, options?: { missing?: "throw" }): Promise<Uint8Array>
  readArtifactBytes(draftId: string, name: DraftArtifactNameV1, options: { missing: "null" }): Promise<Uint8Array | null>
  writeArtifactBytes(draftId: string, name: DraftArtifactNameV1, bytes: Uint8Array, options: { createOnly: boolean; expectedSha256?: string }): Promise<ArtifactWriteResultV1>
  createRunArtifactRoot(runId: string): Promise<string>
}

interface CertificationRunnerPortV1 {
  run(input: CertificationInvocationV1, supervisor: ProcessSupervisorV1): Promise<CertificationDriverResultV1>
}

interface ProcessSupervisorV1 {
  run(spec: ProcessSpecV1): Promise<ProcessResultV1>
}

type ProcessSpecV1 = {
  kind: ProcessKindV1
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  logDirectory: string
}

type SeedNativeCoreDraftInputV1 = {
  goal: string
  nativePayloadBytes: Uint8Array
  evalsJsonlBytes: Uint8Array
}

type SeedNativeCoreDraftResultV1 = {
  draft: DraftSnapshotV1
  artifact: { kind: "native_payload"; sha256: string }
  evalSha256: string
}
```

`appendStateTransitionV1` and `DraftStoreV1.writeArtifactBytes` remain D-owned mutation seams. Slice E's `CertificationRunnerPortV1` receives immutable invocation bytes/locators and the supervisor, never a writable store; E returns pure results for `certifyDraftV1` to validate and promote.

`EvalCaseV1` is locked exactly for Slice E:

```ts
type SelectedJourneyActionV1 =
  | { journeyId: "session-control"; action: "play" | "stop" | "from_start" | "save" | "undo" | "redo" }
  | { journeyId: "capture-review-choose-take"; action: "record_start" | "record_stop" | "audition" | "again" | "keep" }
  | { journeyId: "explicit-balance"; action: "mute" | "unmute" | "solo" | "set_level" }
  | { journeyId: "load-named-plugin"; action: "load" };

type EvalExpectedOutcomeV1 =
  | { kind: "completed"; code: null }
  | { kind: "needs_choice"; code: "ambiguous_skill" | "ambiguous_target" }
  | { kind: "blocked"; code: Exclude<SkillReasonCodeV1, "no_match" | "ambiguous_skill" | "ambiguous_target" | "unsupported_intent"> }
  | { kind: "unsupported"; code: "no_match" | "unsupported_intent" };

type EvalNegativeCategoryV1 =
  | "negative" | "ambiguity" | "stale_state" | "malformed_input" | "injection" | "expected_failure";
type InvalidFillPhaseV1 = "none" | "candidate_selection" | "slot_validation" | "entity_resolution" | "preflight";

type EvalCaseV1 = {
  schemaVersion: 1; id: string; selected: SelectedJourneyActionV1; supported: boolean; utterance: string;
  fixtureSha256: string; initialStateSha256: string; expectedOutcome: EvalExpectedOutcomeV1;
  finalStatePredicates: readonly PredicateV1[]; prohibitedEffects: readonly string[];
  evidenceLevel: "schema" | "mock" | "native" | "packaged" | "physical";
  scoringCategory: "selection" | EvalNegativeCategoryV1; invalidFillPhase: InvalidFillPhaseV1;
  expectedObservation?: string;
};
```

Supported cases require `scoringCategory:"selection"` and `invalidFillPhase:"none"`. Non-success cases require one of the six exact negative categories and zero prohibited mutation. Invalid candidate/model selection uses `candidate_selection`; missing/invalid slot values use `slot_validation`; missing/ambiguous entities use `entity_resolution`; stale project/source/manifest or failed observation uses `preflight`; cases with no invalid fill use `none`. `malformed_input` requires a non-`none` phase. Slice E's ten negative cases per journey contain at least one case from every negative category; the other four remain frozen, not dropped or relabeled after execution.

## Command Acceptance Matrix

| Command | Required durable effect or result |
| --- | --- |
| `init` | Atomically publish one `owner-*` draft, `request.json`, and genesis ledger record. |
| `add-source` | Copy one validated metadata card, update status atomically, copy no media. |
| `add-reference` | Store one hash/size/file-identity locator, copy no external file. |
| `validate` | Bind exact manifest/eval/source/catalog hashes and append `schema_valid`, or a stable blocker. |
| `certify` | Supervise the bounded Slice E driver and persist only a validated result/report. |
| `record-evidence` | Append a current frozen-case `ManualEvidenceV1`; never overwrite attempts. |
| `review` | Emit the full plain-language contract and exact review fingerprint without mutation. |
| `approve` | Validate explicit matching attestation, write `approval.json`, append `owner_approved`. |
| `install` | Publish an exact four-file package, then independently update `active.json`. |
| `rollback` | Validate an installed older version, then atomically repoint activation. |
| `revoke` | Remove only the activation entry; preserve packages and evidence. |
| `refresh-source` | Admit supplied reviewed metadata through the already approved acquisition method; never fetch. |
| `revoke-source` | Advance source generation and mark an existing source `revoked`. |
| `gc` | Emit a dry-run plan by default; apply only revalidated foundry-owned entries. |
| `status` | Emit state, exact hashes, blockers, quotas, freshness, and legal next commands. |

Idempotency is exact: unchanged source refresh, identical approval/install, rollback-to-active, revoke-inactive, and repeated dry-run GC return `changed:false`, preserve bytes, and do not advance generations. A same-version package mismatch, stale approval, changed external file, malformed ledger/index, or activation failure always fails closed and preserves the last durable valid state.

---

### Task 1: Define the CLI wire contract and entrypoint

**Files:** Create `ui/src/skillFoundry/contracts.ts`, `commands.ts`, `cli.ts`, `contracts.test.ts`; modify `ui/package.json`.

**Interfaces:** Produces `TeachMoshiCommandV1`, `CliEnvelopeV1`, `CliExecutionV1`, `parseTeachMoshiArgsV1`, and `runTeachMoshiV1(argv, deps)`.

- [ ] **Write RED tests for exact flags, duplicates, missing values, unknown flags, and JSON output.**

```ts
expect(parseTeachMoshiArgsV1(["init", "--goal", "park backgrounds"])).toEqual({
  ok: true, value: { command: "init", goal: "park backgrounds" },
});
expect(parseTeachMoshiArgsV1(["gc", "--apply"])).toEqual({ ok: true, value: { command: "gc", apply: true } });
```

Run: `npm --prefix ui test -- --run src/skillFoundry/contracts.test.ts`

Expected RED: module/export missing.

- [ ] **Implement the exhaustive command union and stable envelope.**

```ts
export type CliEnvelopeV1<T = unknown> =
  | { schemaVersion: 1; ok: true; command: TeachMoshiCommandV1["command"]; result: T }
  | { schemaVersion: 1; ok: false; command: string; error: { code: FoundryErrorCodeV1; message: string; details: Record<string, unknown> } };
export type CliExecutionV1 = { exitCode: 0 | 1 | 2; envelope: CliEnvelopeV1 };
```

`mainV1` calls dependency-injected `runTeachMoshiV1`, writes one `JSON.stringify(envelope) + "\n"`, and sets `process.exitCode`; it never calls `process.exit`.

- [ ] **Register the script, run GREEN, and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/contracts.test.ts && npm --prefix ui run typecheck`

Expected GREEN: test/typecheck pass; unknown command emits one `ok:false` object and exits `2`.

```bash
git add ui/package.json ui/src/skillFoundry/{contracts,commands,cli}.ts ui/src/skillFoundry/contracts.test.ts
git commit -m "feat(agent): add teach-moshi CLI contract"
```

### Task 2: Project bounded Skill Foundry source cards

**Files:** Modify `docs/templates/recipe-source-candidate.md`, `service/corpus/recipe_source_intake.py`, its test, and `service/corpus/fixtures/recipe_source_cards/*.md`.

**Interfaces:** Produces Python `project_skill_source(card)` and `project-skill-source <explicit-card.md> [--out <source.json>]` while preserving legacy `validate`/`index` behavior.

- [ ] **Write RED tests for a valid projection plus 1 MiB+1, symlink, FIFO, hidden transcript, duplicate claims, and eleven claims.**

```py
projected = intake.project_skill_source(valid)
check("schema", projected["schemaVersion"] == 1, failures)
check("claim ceiling", len(projected["claims"]) <= 10, failures)
check("legacy summary", valid.safe_summary()["total_score"] == 17, failures)
```

Run: `python3 service/corpus/recipe_source_intake_test.py`

Expected RED: projector missing.

- [ ] **Extend the template and parser.** Add source/application version, explicit accepted rights/acquisition/platform-handling values from Global Constraints, evidence SHA, reviewer/review dates, source state, dependent knowledge/skill IDs, and a claim table with `claimId`, origin (`source_text|owner_observation|asr_ocr|codex_inference`), workflow moment, short paraphrase, and boundary. Scan every decoded string for embedded media/transcript payloads; reject unknown/unresolved rights and unofficial/scraped acquisition rather than projecting them.

- [ ] **Implement explicit bounded projection.** `lstat` one explicit file, require non-link regular file and size `<= 1_048_576`, strict UTF-8, 1–10 unique claims, then emit sorted separator-free JSON. `sourceSnapshotSha256` covers stable identity/version/rights/acquisition/evidence/ordered claims but excludes reviewer/timestamps/dependencies/state, so unchanged evidence can extend freshness. `--out` uses 0600 unique sibling temp, file fsync, `os.replace`, and parent fsync.

- [ ] **Run GREEN/regressions and commit.**

Run: `python3 service/corpus/recipe_source_intake_test.py && python3 service/training/rights_state_test.py && python3 service/teardown/scout_test.py`

Expected GREEN: all exit `0`; legacy summaries remain stable.

```bash
git add docs/templates/recipe-source-candidate.md \
  service/corpus/recipe_source_intake.py service/corpus/recipe_source_intake_test.py \
  service/corpus/fixtures/recipe_source_cards/valid_tutorial_card.md \
  service/corpus/fixtures/recipe_source_cards/invalid_embedded_media_card.md \
  service/corpus/fixtures/recipe_source_cards/invalid_transcript_card.md
git commit -m "feat(agent): project bounded skill source cards"
```

### Task 3: Build safe roots, durable writes, lock, and quotas

**Files:** Create `paths.ts`, `safeFs.ts`, `lock.ts`, `quota.ts`, `testHelpers.ts`, and `pathsSafeFs.test.ts`, `lockQuota.test.ts`.

**Interfaces:** Produces `FoundryPathsV1`, `resolveFoundryPathsV1(env?, home?, uid?)`, `inspectExternalRegularFileV1`, `atomicWriteBytesV1`, `atomicPublishDirectoryV1`, `withFoundryLockV1`, `measureFoundryQuotaV1`, `assertQuotaMutationV1`.

- [ ] **Write RED tests for symlink/wrong-owner/open-mode/path-escape roots; file replacement; exact/max+1 caps; concurrent/stale locks.**

```ts
await expect(resolveFoundryPathsV1(h.env, h.home, h.uid)).rejects.toMatchObject({ code: "unsafe_path" });
expect(() => assertQuotaMutationV1(atDraftCap(), { draftBytes: 1 })).toThrowError(/quota/i);
```

Run: `npm --prefix ui test -- --run src/skillFoundry/pathsSafeFs.test.ts src/skillFoundry/lockQuota.test.ts`

Expected RED: modules missing.

- [ ] **Implement safe filesystem primitives.** Validate every existing root component with `lstat`; create 0700 directories; open external files `O_RDONLY|O_NOFOLLOW`; require regular, owner UID, link count one, bounded size; compare `lstat/fstat` and post-hash device/inode/size/mtime. Durable writes use unique same-directory `O_EXCL` 0600 temp, complete write, file fsync, reread/hash, rename, and parent fsync. Directory publication fsyncs 0700 staging before target-absent rename.

- [ ] **Implement the ownership-bound lock and quota traversal.** Lock metadata is `{schemaVersion:1,nonce,pid,processStartIdentity,command,acquiredAt}` in an atomically renamed directory. `/bin/ps -o lstart= -p PID` distinguishes live ownership from PID reuse; release matches nonce/identity. Traverse known-depth regular files only, dedupe inode, reject mutation during scan, and enforce every global cap exactly before/after prospective writes.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/pathsSafeFs.test.ts src/skillFoundry/lockQuota.test.ts && npm --prefix ui run typecheck`

Expected GREEN: exact boundaries pass, +1 fails without deletion; one concurrent lock wins.

```bash
git add ui/src/skillFoundry/{paths,safeFs,lock,quota,testHelpers}.ts ui/src/skillFoundry/{pathsSafeFs,lockQuota}.test.ts
git commit -m "feat(agent): secure foundry local storage"
```

### Task 4: Create drafts and a fail-closed hash-chained ledger

**Files:** Create `stateLedger.ts`, `draftStore.ts`, `stateLedgerDraft.test.ts`.

**Interfaces:** Produces `FoundryStateRecordV1`, `readStateLedgerV1`, `appendStateTransitionV1`, `DraftStoreV1`, `createDraftStoreV1(paths, clock)`, with methods `loadDraft`, `readArtifactBytes`, `writeArtifactBytes`, and `createRunArtifactRoot`.

- [ ] **Write RED tests for deterministic `owner-*` init, collision, legal/illegal transition, truncation, reordered line, 4,096/4,097 records, and crash before rename.**

```ts
const created = await h.store.createDraft({ goal: "Park backgrounds" });
expect(created.skillId).toBe("owner-park-backgrounds");
expect((await readStateLedgerV1(created.statePath)).at(-1)?.state).toBe("draft");
```

Run: `npm --prefix ui test -- --run src/skillFoundry/stateLedgerDraft.test.ts`

Expected RED: store/ledger missing.

- [ ] **Implement the chain.** Record `{schemaVersion,sequence,previousRecordSha256,state,artifactHashes,executionIdentity,testCommand,startedAt,finishedAt,result,recordSha256}`. `executionIdentity` is required on every transition and is `{gitCommit,appVersion,build:{kind:"offline",toolVersion:"teach-moshi-v1"}|{kind:"mosh",moshBuildIdentity}}`; no optional/empty identity is valid. Resolve Git HEAD and app version before mutation, and require the exact Mosh build identity for native/package/manual transitions. Genesis previous hash is 64 zeroes. Hash canonical record without `recordSha256`; append one canonical line with LF and fsync. Reject invalid UTF-8, missing final LF, blank/malformed line, sequence/hash gap, over-count, over-bytes, or missing identity.

- [ ] **Implement artifact-kind state and draft publication.** Declarative path is `draft -> source_reviewed -> schema_valid -> mock_green -> native_green -> packaged_green -> acceptance_green -> owner_approved -> certified`; `certified` is appended when the exact local release envelope is validated/published, while activation is recorded separately as package metadata. Native path is identical through `owner_approved` but only `owner_approved -> release_packaged_green -> certified` is legal. `blocked` may resume at the last proven stage, `stale -> source_reviewed`; `rejected|superseded|revoked` are terminal. Public init creates declarative `owner-*` drafts only, validates collision through Slice A, atomically publishes the complete layout, and exposes state/hashes/blockers/next commands.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/stateLedgerDraft.test.ts`

Expected GREEN: all chain, transition, cap, collision, and crash tests pass.

```bash
git add ui/src/skillFoundry/{stateLedger,draftStore}.ts ui/src/skillFoundry/stateLedgerDraft.test.ts
git commit -m "feat(agent): persist bounded skill drafts"
```

### Task 5: Admit sources/references and maintain atomic freshness/revocation

**Files:** Create `sourceCards.ts`, `sourceStatus.ts`, `references.ts`, `sourceCardsStatus.test.ts`, `references.test.ts`.

**Interfaces:** Produces `parseSourceCardV1`, `sourceSnapshotSha256V1`, `addSourceCardV1`, `readSourceStatusV1`, `refreshSourceStatusV1`, `revokeSourceStatusV1`, `addReferenceV1`, and `revalidateReferenceV1`.

- [ ] **Write RED tests for all four runtime states, rejected/unresolved/unofficial exclusion, unsafe source IDs, secure exact status path, exact expiration, changed digest, acquisition mismatch, duplicate/unknown revoke, 32/33 references, 4 GiB/+1, valid/invalid `AbletonReferenceV1`, and runtime fail-closed check.**

```ts
const refreshed = await refreshSourceStatusV1(await h.changedCard(), h.deps);
expect(refreshed.generation).toBe(2);
expect(validateSourceStatusForInvocationV1(h.oldRefCheck(refreshed.index)).ok).toBe(false);
```

Run: `npm --prefix ui test -- --run src/skillFoundry/sourceCardsStatus.test.ts src/skillFoundry/references.test.ts`

Expected RED: modules missing.

- [ ] **Implement metadata-only import.** Validate the Task 2 JSON, require `sourceCardId` to match `[a-z0-9]+(?:-[a-z0-9]+)*` within 64 characters before using it as a component, recompute semantic snapshot, enforce the exact accepted rights/acquisition/handling allowlists, require 1–10 short unique claims, copy exact bytes to `<draft>/sources/<id>.json`, and mirror current reviewed metadata under `<teach>/source-cards/` for acquisition comparison. Reject `rejected`, unresolved rights, and unofficial acquisition from runtime index. Exact duplicates are idempotent; same ID/conflicting draft bytes fail.

- [ ] **Implement status transitions.** Publish exactly `$MOSH_AGENT_DIR/sources/status.json` beneath the validated owner-only, non-symlink source root: 0600 unique same-directory temp, file fsync, atomic rename, then parent fsync. Maintain the exact `SourceStatusV1`, sorted safe IDs, 256 entries/256 KiB; map `reviewedAt` to `checkedAt` and preserve `reviewAfter`. Same snapshot may extend freshness only with later signed review. Changed snapshot replaces the current hash: old dependent manifests immediately mismatch and remain stale until re-extraction/replay. `revoke-source` marks revoked and bumps generation once; repeated revoke/unchanged refresh does not bump. No command fetches a URL.

- [ ] **Implement immutable external locators and Ableton metadata validation.** Store `{schemaVersion,referenceId,absolutePath,sha256,bytes,fileIdentity:{device,inode,mtimeNs},recordedAt}`; derive ID from canonical fields; never copy the external file; revalidate identity/hash before certification/evidence. `references.ts` exports `parseAbletonReferenceV1(value): ParseResult<AbletonReferenceV1>`. When `add-reference` receives JSON declaring the Ableton reference schema, require that parser, validate every optional before/after set path/hash through the same no-follow inspector, and store sanitized metadata plus locators; it never converts checkpoints or `.als`/OSC observations into steps.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/sourceCardsStatus.test.ts src/skillFoundry/references.test.ts`

Expected GREEN: malformed updates preserve old bytes; source changes fail old invocation checks immediately.

```bash
git add ui/src/skillFoundry/{sourceCards,sourceStatus,references}.ts ui/src/skillFoundry/{sourceCardsStatus,references}.test.ts
git commit -m "feat(agent): manage skill source provenance"
```

### Task 6: Author and validate candidate/eval artifacts, seed native drafts, and supervise Slice E

**Files:** Create `evals.ts`, `candidate.ts`, `compilerAuthoring.ts`, `nativeDraftSeed.ts`, `processSupervisor.ts`, `certify.ts`, `candidateEvals.test.ts`, `compilerAuthoring.test.ts`, `nativeDraftSeed.test.ts`, `processSupervisor.test.ts`, `fixtures/fake-certifier.mjs`, and `ui/scripts/teachMoshi/authorCandidate.ts`.

**Interfaces:** Produces `EvalCaseV1`, `parseEvalCasesV1`, `authorCandidateArtifactsV1`, `seedNativeCoreDraftV1`, `validateDraftCandidateV1`, `ProcessSupervisorV1`, `CertificationRunnerPortV1`, and `certifyDraftV1`.

- [ ] **Write RED tests for internal create-only authoring, changed-artifact staleness, no public author command, four-ID native seed allowlist, malformed native payload, missing/malformed/mixed-journey native eval JSONL, atomic native payload+eval publication, exact `EvalCaseV1` branch/category/phase rules, valid/stale/missing primitive, 512/+1 evals, driver success/manual/blocker, every deadline, PID reuse, malformed result, and no orphan.**

```ts
const result = await validateDraftCandidateV1({ draftId: h.draftId }, h.deps);
expect(result).toMatchObject({ ok: true, state: "schema_valid" });
expect((await h.certifyWithFake("manual"))).toMatchObject({ kind: "needs_manual_evidence", caseId: "physical-001" });
```

Run: `npm --prefix ui test -- --run src/skillFoundry/candidateEvals.test.ts src/skillFoundry/compilerAuthoring.test.ts src/skillFoundry/nativeDraftSeed.test.ts src/skillFoundry/processSupervisor.test.ts`

Expected RED: modules missing.

- [ ] **Implement exact eval/candidate validation.** Enforce the locked `selected`, `expectedOutcome.kind/code`, `scoringCategory`, and `invalidFillPhase` unions above; strict LF-terminated JSONL within 512/4 MiB; unique IDs; physical observation; supported/negative relationships; and exact-byte hash. Parse declarative candidate through Slice A; require atomic `owner-*`, current sources, catalog compatibility, reserved-ID availability, and only owner primitives/predicates. Return foundry `blocked_missing_primitive` while runtime retains `missing_primitive`.

- [ ] **Implement the bounded non-public Codex compiler helper.** `authorCandidateArtifactsV1` accepts one parsed declarative candidate plus parsed eval cases, serializes deterministic UTF-8 `candidate.skill.json` and LF JSONL, takes the foundry lock, and rechecks draft/file/count/byte caps. Before changing either file, durably write `.authoring-v1.json` with nonce and old/new hashes; every draft load/validate treats that marker as `draft_update_incomplete`. Use `{createOnly:true}` when absent or `{createOnly:false,expectedSha256:<old>}` for compare-and-swap, fsync both artifacts, append `stale` with old/new hashes, then remove/fsync the marker. Exact existing bytes return unchanged. Crash recovery completes the hash-verified pair or leaves it explicitly stale; it never exposes old certification as current.

  `ui/scripts/teachMoshi/authorCandidate.ts` is the concrete Codex/developer entrypoint. It accepts only `--draft <safe-id> --candidate <absolute-file> --evals <absolute-file>`, no network or arbitrary output path. It no-follows each owner-owned regular input, enforces 64 KiB/4 MiB before reading, parses through Slice A/D, calls `authorCandidateArtifactsV1`, and emits one bounded JSON result. Invoke it only as:

  ```bash
  (cd ui && npx tsx scripts/teachMoshi/authorCandidate.ts \
    --draft "$DRAFT_ID" --candidate "$CANDIDATE_FILE" --evals "$EVAL_FILE")
  ```

  It is absent from `TeachMoshiCommandV1`, `commands.ts`, and `ui/package.json`; tests prove unknown flags, relative/link/FIFO/oversized inputs, and a public `teach-moshi author` command all fail without draft mutation.

- [ ] **Implement trusted four-core native seeding with its frozen eval bytes.** `seedNativeCoreDraftV1({goal,nativePayloadBytes,evalsJsonlBytes},deps)` strict-decodes/parses the exact payload bytes through `parseNativeSkillPayloadV1` and the exact supplied LF JSONL through `parseEvalCasesV1`. Require the payload ID to be exactly `session-control|capture-review-choose-take|explicit-balance|load-named-plugin`, present in `NATIVE_SKILL_IDS_V1`, and equal every eval's `selected.journeyId`; reject aliases, arbitrary handlers, downstream hashes, empty/malformed/mixed-journey evals, and any cap violation before draft publication. Under one foundry lock and quota snapshot, use the same durable `.authoring-v1.json` transaction to create-only publish exact `nativePayloadBytes` as `candidate.skill.json` and exact `evalsJsonlBytes` as `evals.jsonl`, then return their exact SHA-256 refs. Neither artifact can become current alone. There is no native-eval-only authoring mode: E calls only `seedNativeCoreDraftV1` and never `authorCandidateArtifactsV1`. Public `init`, `authorCandidateArtifactsV1`, and `installDraftV1` reject native artifact kinds.

- [ ] **Implement the finite process port.** `ProcessSpecV1.kind` selects the fixed deadline. Spawn detached, persist nonce/PID/start identity, bound stdout/stderr under run artifacts, and verify identity before negative-PGID termination. `CertificationRunnerPortV1.run(input, supervisor)` returns `completed|needs_manual_evidence|blocked` and never approval. Default adapter invokes `<bin> --skill-foundry-certify-driver-v1 --request <run>/request.json --result <run>/result.json`; until Slice E adds it, return `certification_driver_unavailable`, never pass.

- [ ] **Validate and durably promote results only in D.** Require matching run nonce/ID, artifact/eval/catalog/build hashes. Manual checkpoint exits `0` only after child exit and reports run/case/observation/hashes. Slice E runner/graders return pure result data and report bytes under the disposable run root; they never call a ledger/artifact writer. `certifyDraftV1` alone parses the report, atomically stores exact validated bytes as `certification.json`, and appends every matching proven transition. `promoteNativeReleaseVerificationV1` likewise calls `parseNativeReleaseVerificationV1`, rechecks payload/report/approval/bundle/build/signature hashes, atomically stores external `release-verification.json`, then appends `release_packaged_green` and `certified`; E never writes those durable records.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/candidateEvals.test.ts src/skillFoundry/compilerAuthoring.test.ts src/skillFoundry/nativeDraftSeed.test.ts src/skillFoundry/processSupervisor.test.ts`

Expected GREEN: exact bounds, stale/source/catalog cases, timeout escalation, log retention, and foreign PID protection pass.

```bash
git add ui/src/skillFoundry/{evals,candidate,compilerAuthoring,nativeDraftSeed,processSupervisor,certify}.ts ui/src/skillFoundry/{candidateEvals,compilerAuthoring,nativeDraftSeed,processSupervisor}.test.ts ui/src/skillFoundry/fixtures/fake-certifier.mjs ui/scripts/teachMoshi/authorCandidate.ts
git commit -m "feat(agent): validate and supervise skill certification"
```

### Task 7: Record manual evidence and bind explicit review approval

**Files:** Create `evidence.ts`, `reviewApproval.ts`, `evidence.test.ts`, `reviewApproval.test.ts`.

**Interfaces:** Produces `recordManualEvidenceV1`, `buildReviewV1`, and `approveDraftV1`.

- [ ] **Write RED tests for exact pending case, stale run/eval/build/artifact, physical-not-required statement, 128/+1 records, fingerprint golden, one-byte tamper, and stale/generic attestation.**

```ts
expect(await buildReviewV1({ draftId: h.draftId }, h.deps)).toMatchObject({ reviewSha256: h.expectedReviewSha });
expect(await h.recordPhysicalNotRequired("")).toMatchObject({ ok: false, code: "missing_reviewer_statement" });
```

Run: `npm --prefix ui test -- --run src/skillFoundry/evidence.test.ts src/skillFoundry/reviewApproval.test.ts`

Expected RED: modules missing.

- [ ] **Implement evidence.** Treat `--evidence` as a <=1 MiB `ManualEvidenceV1` JSON attestation. Match frozen run/case/expected observation/artifact/eval/build hashes; revalidate every listed regular-file locator (<=4 GiB); require nonempty `observed` for `physical_not_required`; append one canonical fsynced line within 128/4 MiB. Exact duplicates are idempotent; failed attempts remain immutable.

- [ ] **Implement review.** Require `acceptance_green`, rehash exact artifact/report bytes, render structured triggers, reads, changes, slots/defaults/bounds, `execution.confirmation` (`never|on_ambiguity|always`) and each ask/choice condition, postconditions, failures, and undo posture plus deterministic Markdown; compute the exact review hash, then re-read/re-hash before return. A review omitting or paraphrasing away the confirmation posture is invalid.

- [ ] **Implement approval.** `ApprovalAttestationV1` is `{schemaVersion:1,reviewSha256,exactStatement,actor,channel,conversationLocator?,approvedAt}`. Read <=1 MiB; require CLI SHA = attestation SHA = current SHA, nonempty statement <=4,096 scalars, actor/channel <=256, locator <=2,048, RFC 3339 time. Build/parse `SkillApprovalV1`, enforce 16 KiB, atomically write `approval.json`, and append `owner_approved`. Architecture approval cannot satisfy this gate.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/evidence.test.ts src/skillFoundry/reviewApproval.test.ts`

Expected GREEN: all frozen-binding, cap, tamper, duplicate, and explicit-attestation cases pass.

```bash
git add ui/src/skillFoundry/{evidence,reviewApproval}.ts ui/src/skillFoundry/{evidence,reviewApproval}.test.ts
git commit -m "feat(agent): bind skill evidence and approval"
```

### Task 8: Publish, activate, rollback, and revoke packages crash-safely

**Files:** Create `packageLifecycle.ts`, `packageLifecycle.test.ts`.

**Interfaces:** Produces `installDraftV1`, `rollbackSkillV1`, `revokeSkillV1`, and `writeActivationIndexV1`.

- [ ] **Write RED tests for exact four files, release-last, every write/rename/activation crash point, identical reinstall, conflict, 64/+1 active entries, rollback-to-active, and repeated revoke.**

```ts
const installed = await installDraftV1({ draftId: h.draftId }, h.deps);
expect(await h.packageFiles(installed.packagePath)).toEqual(["approval.json", "certification.json", "release.json", "skill.json"]);
```

Run: `npm --prefix ui test -- --run src/skillFoundry/packageLifecycle.test.ts`

Expected RED: lifecycle missing.

- [ ] **Implement release/package publication.** Public install requires current declarative `owner_approved` and rejects `native_payload`; under the foundry lock, reopen candidate/report/approval with no-follow handles and recheck device/inode/size/mtime/exact hashes against the approved identities before staging, again before package rename, and again before activation. Synthesize and parse `SkillReleaseV1` <=4 KiB. Stage 0700 same-filesystem directory, exact approved sibling bytes at 0600, `release.json` last, fsync/hash/validate every file and directory through `validateCertifiedSkillPackageV1`, then target-absent rename. Existing package is idempotent only when all bytes match; otherwise `package_conflict`. Reuse existing release bytes after a post-package/pre-activation crash.

- [ ] **Separate declarative certification from activation.** After exact four-file package and `SkillReleaseV1` validation/publication, append declarative `certified` even if later activation fails. Then atomically update `active.json` within 64 entries/64 KiB, incrementing generation exactly once. Activation failure leaves a certified inactive package and returns a retryable error without another certification transition. `rollback` validates an installed version before pointing at it; same-active is unchanged. `revoke` removes index entry only; repeated revoke is unchanged. Native drafts cannot use this installer and remain uncertified until D records E's `release_packaged_green`. No package/evidence deletion or hot reload.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/packageLifecycle.test.ts`

Expected GREEN: all crash, cap, mode/link/hash, idempotency, and recovery cases pass.

```bash
git add ui/src/skillFoundry/packageLifecycle.ts ui/src/skillFoundry/packageLifecycle.test.ts
git commit -m "feat(agent): install certified local skills"
```

### Task 9: Implement reachability-safe dry-run/apply GC

**Files:** Create `gc.ts`, `gc.test.ts`.

**Interfaces:** Produces `planFoundryGcV1` and `applyFoundryGcV1`.

- [ ] **Write RED tests for dry-run immutability, strict 90-day boundary, active/approved/installed/blocker retention, hash reachability, external locator, symlink/inode swap, and partial apply.**

```ts
const plan = await planFoundryGcV1({ apply: false }, h.deps);
expect(plan.entries.map((entry) => entry.path)).toContain(h.oldUnreachableRun);
expect(await h.exists(h.oldUnreachableRun)).toBe(true);
```

Run: `npm --prefix ui test -- --run src/skillFoundry/gc.test.ts`

Expected RED: GC missing.

- [ ] **Build retained graph before candidates.** Seed from active index/packages, installed reports, approved/certified/unresolved-blocker drafts, and every reachable artifact hash/locator. Consider only contained foundry `.tmp-*`, unreferenced run artifacts, and rejected/completed-but-not-approved drafts strictly older than 90 days. Never list package or external-reference paths. Sort entries and hash canonical plan fields.

- [ ] **Apply under lock.** Recompute reachability and revalidate containment/owner/device/inode/mtime/age immediately before each removal. A changed entry is skipped with `gc_revalidation_failed`; never follow a link. Root exhaustion never invokes GC automatically.

- [ ] **Run GREEN and commit.**

Run: `npm --prefix ui test -- --run src/skillFoundry/gc.test.ts`

Expected GREEN: dry-run changes nothing and apply removes only still-valid listed paths.

```bash
git add ui/src/skillFoundry/gc.ts ui/src/skillFoundry/gc.test.ts
git commit -m "feat(agent): add safe foundry garbage collection"
```

### Task 10: Wire every command and run Slice D gates

**Files:** Modify `commands.ts`, `cli.ts`; create `cli.test.ts`.

**Interfaces:** Consumes all Slice D services; produces the complete structured CLI.

- [ ] **Write RED subprocess tests for every command and one full temp-root flow.**

```ts
const result = await runCliHarnessV1(["status", "--draft", h.draftId]);
expect(result.stdout.trim().split("\n")).toHaveLength(1);
expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: true, command: "status" });
```

The flow is `init -> add-source -> add-reference -> validate -> fake certify/manual -> record-evidence -> fake certify/completed -> review -> approve -> install -> status -> revoke -> rollback -> refresh-source -> revoke-source -> gc`. Repeat unchanged refresh, approval, install, rollback-to-active, revoke-inactive, and dry-run GC; assert byte/generation idempotency.

Run: `npm --prefix ui test -- --run src/skillFoundry/cli.test.ts`

Expected RED: dispatcher branches missing.

- [ ] **Wire result/exit behavior.** Take the lock for every mutation; always release in `finally`. Domain errors exit `1`, parser errors `2`, manual checkpoint `0`; unexpected errors become bounded `io_error` without stack on stdout. Never auto-GC or weaken a failed gate.

- [ ] **Run focused pre-commit checks, stage exact Slice D paths, and inspect the staged/origin-main diff.**

```bash
npm --prefix ui test -- --run src/skillFoundry
npm --prefix ui run typecheck
python3 service/corpus/recipe_source_intake_test.py
git add ui/package.json ui/src/skillFoundry ui/scripts/teachMoshi/authorCandidate.ts \
  service/corpus/recipe_source_intake.py service/corpus/recipe_source_intake_test.py \
  service/corpus/fixtures/recipe_source_cards/valid_tutorial_card.md \
  service/corpus/fixtures/recipe_source_cards/invalid_embedded_media_card.md \
  service/corpus/fixtures/recipe_source_cards/invalid_transcript_card.md \
  docs/templates/recipe-source-candidate.md
git diff --cached --check
git diff --cached --name-status
git diff --cached --stat
git diff --cached
git diff --stat origin/main
if git diff --cached | rg -n 'api[_-]?key|token|secret|/Users/emiliosanchez-harris|BEGIN [A-Z ]*PRIVATE KEY'; then exit 1; fi
```

Expected: focused checks pass; staged names are only the explicit Slice D paths; staged diff and `git diff --stat origin/main` show the complete intended work; diff/secret checks are silent.

- [ ] **Commit the reviewed implementation before the clean-HEAD gates.**

```bash
git commit -m "feat(agent): complete teach-moshi foundry tooling"
```

Expected: commit succeeds and the index is empty.

- [ ] **Require clean HEAD, inspect the exact committed origin-main diff, then run full gates.**

```bash
test -z "$(git status --porcelain)"
git diff --check origin/main...HEAD
git diff --name-status origin/main...HEAD
git diff --stat origin/main...HEAD
if git diff origin/main...HEAD | rg -n 'api[_-]?key|token|secret|/Users/emiliosanchez-harris|BEGIN [A-Z ]*PRIVATE KEY'; then exit 1; fi
npm --prefix ui test
npm --prefix ui run build
python3 service/training/rights_state_test.py
python3 service/teardown/scout_test.py
(cd service/skills && python3 -m pytest -q)
scripts/auto-loop/memory-preflight.sh
scripts/auto-loop/gate.sh native "$PWD" origin/main
test -z "$(git status --porcelain)"
```

Expected GREEN: clean committed HEAD before and after gates; complete origin-main diff is reviewed; all tests pass; native selftests report zero failures/JUCE assertions. Any gate repair receives its own commit and the entire clean-HEAD ladder is rerun. The handoff states explicitly that Slice E's real native/package/manual certification loop remains outstanding.
