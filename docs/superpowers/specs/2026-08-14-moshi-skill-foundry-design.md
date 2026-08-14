# Moshi Skill Foundry Design

**Date:** 2026-08-14

**Status:** architecture approved; written spec awaiting owner review

**Branch:** `codex/moshi-agent-skills-next`

**Base:** `origin/main` at `6fee7100`

## 1. Decision

Moshi will become a bounded studio copilot with four certified producer journeys
and an owner-facing, Codex-assisted way to add more skills without teaching them
through Mosh's unfinished UI.

The authoring model is:

1. The owner asks Codex to teach Moshi a workflow and may provide tutorials,
   guides, or a short Ableton demonstration.
2. Codex turns that evidence into a declarative, typed Mosh skill plus frozen
   evaluations.
3. Mosh validates and executes the skill only through the existing MoshOps
   command, transaction, event, undo, and JSONL seams.
4. A finite certification loop proves the skill in Mosh before it becomes
   available to the packaged app.

Ableton is an optional teaching and semantic-reference surface. It is never the
runtime, the executable trace authority, or the pass/fail gate for a Mosh skill.
Mosh is the only runtime and certification target.

This design deliberately does **not** build a general self-modifying agent. It
builds a governed skill foundry: online material can propose knowledge and
procedures; only allowlisted, versioned, tested Mosh skill contracts can act.

### 1.1 Alternatives considered

| Approach | Decision |
| --- | --- |
| Teach through a new recorder inside Mosh | Rejected for v1. It makes the owner's unfamiliarity with the new UI and current UI fragility part of every skill-authoring session. The shared Mosh Live-shell composer is a runtime surface, not an authoring dependency. |
| Convert AbletonOSC, screen recordings, or `.als` diffs into Mosh actions | Rejected. Those observations do not reliably encode producer intent, causal gesture order, transaction boundaries, or Mosh-compatible identities. They are useful evidence only. |
| Summarize tutorials and fine-tune a general tool-calling model | Rejected for the first release. Mutable facts and procedures would lose explicit provenance, compatibility, revocation, and postcondition proof. |
| Codex-authored declarative skills, optional Ableton reference, Mosh-native certification | Chosen. It minimizes owner interaction, keeps execution local to Mosh, and gives each learned behavior a reviewable contract and reproducible gate. |

## 2. Product boundary

### 2.1 First certified journeys

The first release promise is four producer journeys, not broad DAW coverage:

1. **Session control and safety**
   - Play, stop, return to the beginning, save, undo, and redo.
   - No creative interpretation.
   - Invalid state fails without mutation.

2. **Capture, review, and choose a take**
   - Start or stop a recording, audition a take, try again, and keep the chosen
     take.
   - Recording is a lifecycle, not a pretend-atomic edit.
   - The kept take must remain audible after save and relaunch.

3. **Focus and basic explicit balance**
   - Mute, unmute, or solo uniquely resolved tracks and set a named or selected
     track to an explicit dB value.
   - Vague requests such as "mix this" or "make it sound professional" remain
     unsupported.

4. **Resolve and load a named plug-in**
   - Inspect the installed catalog, resolve an exact name or bounded choice, and
     load once on the selected track.
   - Project and selection staleness, missing plug-ins, catalog corruption, and
     instrument/audio mismatch remain explicit outcomes.

These are competency journeys. Each may expose a small action enum rather than
forcing every action into a separate package. One invocation performs one
bounded action or one atomic group; it never turns a journey into an open-ended
plan.

### 2.2 Expansion order

After all four journeys pass the installed-app gates, candidate skills are
chosen from real unserved asks and owner workflows, not from a DAW feature
taxonomy. The initial queue is:

1. explicit drum or MIDI sketch;
2. one built-in effect or one send to an existing bus;
3. selected-clip cleanup or warp to an explicit length;
4. selected-source Re-imagine as preview, accept, or reject;
5. explicit automation;
6. export or bounce as a separately confirmed lifecycle operation.

No queue item is automatically enabled merely because a MoshOps command exists.

### 2.3 Non-goals

- Learning every Mosh command or exposing every current `skills.ts` definition.
- Importing the 36 offline mined micro-skills into the app without recertifying
  them.
- Runtime web browsing, runtime tutorial watching, or transcript-fed tool use.
- Automatic conversion of AbletonOSC changes, screen recordings, `.als` files,
  or tutorial text into executable commands.
- Fine-tuning for the first release.
- A packaged end-user skill marketplace, sharing system, or remote update feed.
- Vague production, mixing, mastering, arrangement, or taste autonomy.
- Arbitrary scripts, JavaScript, shell commands, network calls, or filesystem
  paths inside a skill manifest.
- Making Moshi operate real Ableton. Ableton remains reference-only.
- Reviving the parked MoshIR/training stack wholesale.

## 3. Current-state constraints

The implementation must begin from the current behavior rather than its older
plans:

- `AgentComposer` routes section-scoped rework, deterministic fast paths, then
  `runStudioSkill`; the developer-only free-form loop is not a packaged fallback.
- `studioSkills.ts` currently exposes one production studio skill:
  `load_named_plugin`.
- `skills.ts` contains thirteen typed workflow definitions and
  `skillHarness.ts` can execute them, but they are not production-natural-language
  reachability proof.
- `service/skills/library.jsonl` contains thirty-six offline mined micro-skills.
  It remains a separate evidence artifact with different bounds and semantics.
- `mosh-log.jsonl` records MoshOps commands, results, undoability, and agent-turn
  provenance. The current harvester intentionally excludes direct manipulation
  from agent turns.
- The Mosh Live shell uses the real shared store and MoshOps command seam, but
  its Moshi dock is currently a stub. The shared composer is already mounted in
  the Pro Tools and Mosh shells.
- The local AbletonOSC checkout is owner-modified and dirty. It reports Live
  Object Model property changes, not producer intent or UI gestures. The first
  implementation must not modify, replace, vendor, or depend on that checkout
  for runtime behavior.

These three catalogs retain their current distinction:

| Surface | Role after this design |
| --- | --- |
| `studioSkills.ts` and deterministic fast paths | Proven native implementations, registered behind one runtime interface |
| `skills.ts` | Candidate declarative contracts; each remains unavailable until individually certified |
| `service/skills/library.jsonl` | Offline mining evidence only; never loaded by the packaged app |

## 4. Architecture

```text
official docs / allowed tutorials / owner description / optional Ableton walkthrough
                                  |
                                  v
                         source + reference cards
                                  |
                                  v
                     Codex skill compiler workflow
                                  |
               +------------------+------------------+
               |                                     |
               v                                     v
      declarative skill candidate              frozen eval cases
               |                                     |
               +------------------+------------------+
                                  v
                         certification goal loop
     schema -> mock -> native -> QA package -> acceptance -> owner approval
                                  |
                                  v
                         certified local registry
                                  |
                                  v
           deterministic retrieval / structured skill selection
                                  |
                                  v
             resolve -> validate -> MoshOps -> verify post-state
                                  |
                                  v
       completed | needs_choice | blocked | unsupported
```

The system has five isolated components:

1. **Source intake** records lawful, sanitized evidence and provenance.
2. **Skill compiler tooling** turns a user request and evidence into a candidate
   manifest and eval suite. Codex drives this tooling; it is not a runtime model
   feature.
3. **Skill contract and validator** define the only local extension format.
4. **Certification runner** proves a candidate against Mosh and produces an
   immutable report.
5. **Runtime registry and router** load only certified manifests and execute them
   through the existing command seam.

No component needs Ableton to run, test, load, or execute a skill.

## 5. Authoring experience

### 5.1 Owner interaction

The normal owner request is conversational:

> Teach Moshi that when I say "park the backgrounds," it should set the uniquely
> named Background Vocals track to -8 dB and mute it.

That is a successful v1 example. "Create a vocal reverb send, reusing an
existing bus" is intentionally a post-v1 blocker until a reviewed bus resolver
and send mutations join the local allowlist.

Codex then performs the mechanical work:

1. checks whether the request is already covered;
2. checks the live MoshOps command and snapshot surfaces;
3. gathers allowed source evidence if producer semantics need grounding;
4. creates a local draft;
5. writes the skill contract and frozen positive, negative, ambiguity, stale,
   and failure cases;
6. runs the certification loop;
7. shows the owner a plain-language contract;
8. installs only after explicit owner approval and all required gates pass.

The owner never has to hand-author JSON, repeat every paraphrase, or navigate the
Mosh UI to create a skill.

### 5.2 Plain-language review contract

Before certification can reach `owner_approved`, the owner sees:

- **When it runs:** representative supported utterances.
- **What it reads:** project state, selected objects, catalogs, or analysis.
- **What it changes:** exact producer-facing operations and target resolution.
- **Variables:** user-supplied and context-derived slots with defaults and bounds.
- **When it asks:** ambiguity and confirmation conditions.
- **Success:** observable postconditions.
- **Failure:** blocked and unsupported cases.
- **Undo posture:** atomic, lifecycle, or best-effort, stated honestly.

Approval binds to the exact declarative-manifest or native-payload version and
certification-report hash.

For the first four journeys, the owner-time budget is one optional thirty-minute
Ableton reference block, one combined contract review, and only the final
physical/taste checks that cannot be automated. When the required Mosh
primitives already exist, a normal later skill targets no more than fifteen
minutes of active owner time: describe or demonstrate once, then approve or
correct the generated contract. If Mosh UI fragility blocks a
packaged gate, the foundry records a product blocker; it does not ask the owner
to repeat the teaching session.

### 5.3 Tooling interface

Implement one developer/owner CLI, invoked by Codex rather than exposed as a
packaged UI:

```text
npm run teach-moshi -- init --goal <text> [--id <slug>]
npm run teach-moshi -- add-source --draft <draft-id> --card <path>
npm run teach-moshi -- add-reference --draft <draft-id> --file <path>
npm run teach-moshi -- validate --draft <draft-id>
npm run teach-moshi -- certify --draft <draft-id> --bin <Mosh binary>
npm run teach-moshi -- record-evidence --draft <draft-id> --case <case-id> --evidence <path>
npm run teach-moshi -- review --draft <draft-id>
npm run teach-moshi -- approve --draft <draft-id> --review-sha <sha> --attestation <path>
npm run teach-moshi -- install --draft <draft-id>
npm run teach-moshi -- rollback --id <skill-id> --version <version>
npm run teach-moshi -- revoke --id <skill-id>
npm run teach-moshi -- refresh-source --card <path>
npm run teach-moshi -- revoke-source --id <source-card-id>
npm run teach-moshi -- gc [--apply]
npm run teach-moshi -- status --draft <draft-id>
```

`review` emits the plain-language contract plus a SHA-256 fingerprint covering
the exact behavior artifact (declarative manifest or native payload) and
certification report. `approve` is valid only after the owner
explicitly approves that exact fingerprint in the active conversation; Codex
must not infer approval from an earlier design decision or a general "looks
good." Codex then writes the supplied local attestation JSON with the
fingerprint, exact approval statement, channel/thread locator, actor label, and
timestamp. The CLI validates and copies it into the draft. This is an auditable
owner attestation, not an authentication boundary. It cannot bypass failed gates.
`install` requires a valid approval bound to the current candidate and
certification report. Every command emits structured JSON so Codex can reason
over exact state instead of scraping prose.

The fingerprint is deterministic:

```text
reviewSha = SHA256(
  UTF8("mosh-skill-review-v1\n" + artifactSha256 + "\n" + certificationReportSha256 + "\n")
)
```

Both input hashes cover the exact stored UTF-8 bytes. The certification report
itself records the eval-suite hash, command/resolver/predicate catalog versions,
Mosh build identity, and every gate result. Any byte change invalidates review,
approval, and install. Large logs, audio, screenshots, and traces remain in the
draft evidence directory; the bounded report stores only summaries, hashes, and
local evidence locators.

Drafts and evidence live outside the repository:

```text
~/Library/Mosh/teach/
  drafts/<draft-id>/
    request.json
    sources/
    references/
    candidate.skill.json
    evals.jsonl
    state.jsonl
    manual-evidence.jsonl
    certification.json
    approval.json
    release-verification.json
```

The runtime install root is separate:

```text
$MOSH_AGENT_DIR/skills/certified/
  active.json
  <skill-id>@<version>/
    skill.json
    certification.json
    approval.json
    release.json

$MOSH_AGENT_DIR/sources/
  status.json
```

When `MOSH_AGENT_DIR` is unset, native code resolves it to
`$HOME/Library/Mosh/agent`; it does not rely on shell tilde expansion. An
override must be an absolute, owner-owned path whose root and certified-skill
directories are neither symlinks nor group/world writable.

Tests and harnesses override both roots; they never read the owner's real local
skills or teach drafts.

### 5.4 Authoring and runner bounds

Foundry metadata is bounded separately from runtime packages:

| Resource | V1 cap |
| --- | ---: |
| Drafts | 32 |
| One draft metadata tree | 64 MiB |
| All draft metadata | 1 GiB |
| Source cards per draft | 32 |
| One imported source card or attestation | 1 MiB |
| Reference locators per draft | 32 |
| One referenced external regular file | 4 GiB |
| Eval cases / `evals.jsonl` | 512 / 4 MiB |
| State records / `state.jsonl` | 4,096 / 4 MiB |
| Manual-evidence records | 128 / 4 MiB |
| One certification run artifact tree | 2 GiB |
| All foundry-owned run artifacts | 20 GiB |

`add-source` copies only validated metadata JSON. `add-reference` and
`record-evidence` do not copy owner media, sessions, audio, screenshots, or
videos; they accept an explicit, owner-readable regular file of known size,
reject symlinks and special files, hash it, and store a locator. Foundry-owned
logs live under `~/Library/Mosh/teach/artifacts/<run-id>/`. Root-cap exhaustion
blocks new work without deleting anything.

`gc` is a dry run unless `--apply` is supplied. It lists exact foundry-owned
temporary directories, inactive artifacts, and completed/rejected drafts older
than ninety days; apply mode removes only the listed paths after revalidating
containment. It never follows links or deletes an external reference. Active,
approved, installed, or unresolved-blocker drafts are never GC candidates.
Any artifact hash reachable from such a draft, an installed report, or the
activation index is retained regardless of age.

One certification run holds the foundry lock. Mock cases have a 30-second
wall-clock limit, native and packaged cases 120 seconds, each native or packaged
gate 30 minutes, and one repair cycle 60 minutes. A manual checkpoint exits
instead of waiting. The runner creates a process group, records its run nonce,
PID, and process-start identity, and on timeout terminates only that verified
child group (`SIGTERM`, ten-second grace, then `SIGKILL`). It preserves logs,
removes its own temporary roots, and never kills a PID it did not spawn.

## 6. Online-resource curriculum

### 6.1 Authority order

Sources are used in this order:

1. **Mosh code, command schemas, snapshots, and native tests** define what Moshi
   can truthfully execute.
2. **Official DAW manuals and training** define producer concepts and workflow
   order. Initial anchors are the
   [Ableton Live 12 Manual](https://www.ableton.com/en/live-manual/12/),
   [Avid Pro Tools documentation](https://kb.avid.com/pkb/articles/en_US/Knowledge/Pro-Tools-Documentation),
   and Avid's official
   [Learn Pro Tools in 1 Hour](https://www.youtube.com/watch?v=2ywNbOLePOo)
   chapter sequence.
3. **Official plug-in vendor manuals** apply only to a plug-in that the installed
   Mosh catalog can identify. Vendor knowledge may explain controls; it cannot
   authorize a parameter index that Mosh cannot observe and verify.
4. **Third-party tutorials** can propose technique or vocabulary only after
   source review. Subjective claims remain hypotheses until owner-approved.

Cross-DAW material supplies concepts, not copied shortcuts, UI coordinates, or
implementation details. Mosh's actual semantics win when a DAW differs.

#### Core curriculum packets

The source pass is finite and tied to an executable question. Each packet
extracts at most ten short, paraphrased claims, maps every claim to observable
Mosh state and an allowlisted primitive, and records unsupported gaps instead
of inventing equivalents.

| Journey | Primary official material | What Moshi may learn | What must not transfer |
| --- | --- | --- | --- |
| Session control and safety | Ableton [Live Concepts](https://www.ableton.com/en/live-manual/12/) sections on the control bar, undo history, and saving; Avid [Quick Reference Guide](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Quick_Reference_Guide.pdf) | Producer vocabulary, mode distinctions, observable end states, and recovery expectations | Shortcuts, window locations, or DAW-specific save semantics |
| Capture, review, and choose | Ableton [Recording New Clips](https://www.ableton.com/en/live-manual/12/recording-new-clips/); Avid's current reference-guide hub and official one-hour tutorial | Input/arm/monitor prerequisites, record-state transitions, audition, retry, and take retention questions | Live Session-View clip-slot behavior, Pro Tools comping modes, or any take operation Mosh cannot represent |
| Focus and explicit balance | Ableton [Mixing](https://www.ableton.com/en/live-manual/12/mixing/); Avid's current reference guide sections on basic mixing | Meaning of mute, solo, explicit dB targets, signal-flow cautions, and exact state checks | Prescriptive taste, mastering claims, or copied fader scales |
| Resolve and load a named plug-in | Ableton [Working with Instruments and Effects](https://www.ableton.com/en/live-manual/12/working-with-instruments-and-effects/); current Avid and installed-vendor plug-in guides | Track/device compatibility vocabulary, chain placement questions, and human-readable disambiguation | Browser paths, parameter indices, plug-in availability, or an assumption that a documented product is installed |

Every packet yields the same artifacts:

1. a source card with version, rights, claim boundaries, and freshness state;
2. a Mosh capability map of `observed`, `executable`, `missing`, and
   `reference_only` facts;
3. positive, negative, ambiguous, stale-state, and recovery utterances;
4. one plain-language owner contract;
5. a frozen eval slice graded on Mosh final state.

The useful-next queue receives source packets only when its Mosh primitive is
ready. Initial official anchors are Ableton's interactive
[Learning Music](https://learningmusic.ableton.com/) lessons for explicit beat,
bass, chord, melody, and structure vocabulary; the Live manual sections on
[warping](https://www.ableton.com/en/live-manual/12/audio-clips-tempo-and-warping/),
[automation](https://www.ableton.com/en/live-manual/12/automation-and-editing-envelopes/),
and [export](https://www.ableton.com/en/manual/managing-files-and-sets/). These
links establish a review queue, not enabled skills.

### 6.2 Source-card admission

Reuse and extend `docs/templates/recipe-source-candidate.md` and
`service/corpus/recipe_source_intake.py`. Each promoted claim records:

- stable source identity, creator, URL, and access date;
- source and application version where available;
- rights and platform-handling decision;
- the bounded claim or workflow moment used;
- whether it came from source text, owner observation, ASR/OCR, or Codex
  inference;
- reviewer and review date;
- dependent knowledge-card or skill IDs;
- current, stale, superseded, rejected, or revoked status.

Raw tutorial media, long transcripts, caption payloads, and screenshots stay
outside the repository and are never redistributed. The repository contains
only source metadata, short paraphrased claims, and hashes or local evidence
locators.

The CLI projects reviewed source cards into the bounded local
`sources/status.json` index:

```ts
type SourceStatusV1 = {
  schemaVersion: 1
  generation: number
  updatedAt: string
  entries: Array<{
    sourceCardId: string
    sourceSnapshotSha256: string
    state: "current" | "stale" | "superseded" | "revoked"
    checkedAt: string
    reviewAfter: string
  }>
}
```

Certification requires every `SourceRefV1` to match a current, unexpired index
entry. `refresh-source` follows only the acquisition method already approved on
the source card; unchanged evidence can extend review after reviewer sign-off,
while a new digest leaves dependent skills stale until re-extraction and replay.
`revoke-source` atomically advances the index generation and marks the source
revoked. Neither command uses an undocumented API or broad crawler.

The runtime loads this index at startup and checks its generation and bounds
before every owner-local skill invocation. A changed valid index can disable a
skill immediately without loading any new manifest; missing, invalid, expired,
mismatched, stale, superseded, or revoked entries fail closed. This narrow
revocation check is not a skill hot-reload or runtime web-browsing path.

### 6.3 YouTube boundary

The official YouTube Data API is not a general public-transcript API:
[`captions.list`](https://developers.google.com/youtube/v3/docs/captions/list)
returns track metadata, while
[`captions.download`](https://developers.google.com/youtube/v3/docs/captions/download)
requires permission to edit the video. The consumer transcript viewer is not an
ingestion contract.

Therefore the foundry may use:

- official descriptions and chapter timestamps;
- creator-owned videos accessed through creator authorization;
- creator-provided or explicitly licensed transcripts;
- user-supplied local media or captions with a recorded rights basis;
- manual, short, paraphrased notes from normal viewing.

It must not silently fall back to unofficial transcript scraping, audiovisual
downloading, or bulk caption retention. Current YouTube policies are rechecked
before shipping any acquisition tool.

### 6.4 Knowledge is not execution

Online sources can produce two independent artifacts:

- a **knowledge card** explaining why, when, or what to listen for;
- a **skill candidate** describing a bounded, executable workflow.

A knowledge card never supplies tool arguments. A skill cannot be promoted on
knowledge quality alone. The existing producer-knowledge cards remain intact;
only cards needed by the four core journeys receive provenance in this slice.

All retrieved source text is untrusted data. It cannot change system
instructions, add tools, loosen validation, choose an install path, or approve a
skill.

## 7. Optional Ableton reference session

### 7.1 Role

Actual Ableton is useful because it is the owner's familiar producer surface.
It provides workflow order, intent, vocabulary, decision points, and reference
end states. It does not provide Mosh commands.

The first curriculum uses one isolated 30-minute Ableton block with four
separately checkpointed journeys:

1. session control and safety;
2. capture, review, and choose a take;
3. focus and explicit balance;
4. resolve and load a named plug-in.

For each journey the owner states the goal, performs it once, names variable and
forbidden behavior, and pauses at three to five checkpoints. One block replaces
one session per action, but the journeys remain separate evidence units.

### 7.2 Evidence shape

An optional `reference.json` records:

```ts
type AbletonReferenceV1 = {
  schemaVersion: 1
  journeyId: string
  liveVersion: string
  startedAt: string
  goal: string
  checkpoints: Array<{
    name: string
    narration: string
    observedState?: Record<string, unknown>
    unobservedOrAmbiguous: string[]
  }>
  beforeSet?: { path: string; sha256: string }
  afterSet?: { path: string; sha256: string }
  ownerRules: { variables: string[]; forbidden: string[] }
}
```

Paths point to local evidence outside the repository. `.als` import and
AbletonOSC data are optional supporting observations. Neither is converted into
steps automatically.

### 7.3 AbletonOSC posture

The first release performs no product integration with the dirty local Remote
Script. If a read-only developer helper is later added, it must:

- connect only to loopback;
- verify the Live and AbletonOSC versions;
- use a per-session nonce and bounded reply port;
- query or subscribe only to named allowlisted properties;
- coalesce high-rate parameter changes;
- distinguish observed source, automation, and unknown origin where possible;
- mark everything else ambiguous instead of inferring a command;
- never mutate Live or the owner's set.

If Live is unavailable, in recovery, not on a blank scratch set, or has an
unsaved owner session, reference capture is skipped. Skill authoring continues
offline.

## 8. Skill contract

### 8.1 Manifest

Local extension skills are declarative JSON. They cannot contain executable
code. Built-in native skills expose the same metadata and outcome contract but
may use audited TypeScript implementations for lifecycle or resolver behavior
that the declarative language cannot yet express.

```ts
type SkillManifestV1 = {
  schemaVersion: 1
  id: string
  version: string
  title: string
  description: string
  implementation: "declarative"
  intents: {
    positiveExamples: string[]
    negativeExamples: string[]
    tags: string[]
  }
  slots: SkillSlotV1[]
  preconditions: PredicateV1[]
  steps: SkillStepV1[]
  postconditions: PredicateV1[]
  execution: {
    mode: "atomic" | "lifecycle" | "best_effort"
    confirmation: "never" | "on_ambiguity" | "always"
    maxMutations: number
    timeoutMs: number
  }
  responses: {
    completed: string
    needsChoice: string
    blocked: string
  }
  provenance: SourceRefV1[]
  compatibility: {
    minMoshVersion: string
    commandCatalogSha256: string
    predicateCatalogVersion: number
    resolverCatalogVersion: number
  }
}

type SkillReleaseV1 = {
  schemaVersion: 1
  state: "certified"
  skillId: string
  version: string
  manifestSha256: string
  certificationReportSha256: string
  approvalSha256: string
  certifiedAt: string
}

type SkillActivationIndexV1 = {
  schemaVersion: 1
  generation: number
  skills: Record<string, {
    version: string
    manifestSha256: string
    releaseSha256: string
  }>
}

type SourceRefV1 = {
  sourceCardId: string
  claimIds: string[]
  sourceSnapshotSha256: string
}

type SkillArtifactRefV1 =
  | { kind: "declarative_manifest"; sha256: string }
  | { kind: "native_payload"; sha256: string }

type CertificationReportV1 = {
  schemaVersion: 1
  state: "acceptance_green"
  runId: string
  skillId: string
  version: string
  artifact: SkillArtifactRefV1
  evalSha256: string
  gitCommit: string
  moshBuildIdentity: string
  commandCatalogSha256: string
  predicateCatalogVersion: number
  resolverCatalogVersion: number
  sourceStatusIndexSha256: string
  gates: Array<{
    name: "schema" | "mock" | "native" | "packaged" | "acceptance"
    status: "passed"
    startedAt: string
    finishedAt: string
    passed: number
    total: number
    artifactHashes: string[]
  }>
  manualEvidenceSha256: string[]
  frozenAt: string
}

type SkillApprovalV1 = {
  schemaVersion: 1
  state: "owner_approved"
  reviewSha256: string
  artifact: SkillArtifactRefV1
  certificationReportSha256: string
  exactStatement: string
  actor: string
  channel: string
  conversationLocator?: string
  approvedAt: string
}
```

Native built-ins use a separate immutable code-bound payload rather than
pretending to be local declarative manifests:

```ts
type NativeSkillPayloadV1 = {
  schemaVersion: 1
  id: "session-control" | "capture-review-choose-take" |
      "explicit-balance" | "load-named-plugin"
  version: string
  implementation: "native"
  handlerKey: "sessionControlV1" | "takeCycleV1" |
              "explicitBalanceV1" | "loadNamedPluginV1"
  title: string
  description: string
  intents: SkillManifestV1["intents"]
  slots: SkillSlotV1[]
  execution: {
    mode: "atomic" | "lifecycle" | "best_effort"
    confirmation: "never" | "on_ambiguity" | "always"
  }
  responses: SkillManifestV1["responses"]
  provenance: SourceRefV1[]
  legacyAliases: string[]
  compatibility: SkillManifestV1["compatibility"] & {
    nativeSourceSha256: string
  }
}

type NativeSkillBundleEntryV1 = {
  schemaVersion: 1
  state: "owner_approved"
  skillId: NativeSkillPayloadV1["id"]
  version: string
  nativePayloadSha256: string
  certificationReportSha256: string
  approvalSha256: string
  moshBuildIdentity: string
  bundledAt: string
}

type NativeReleaseVerificationV1 = {
  schemaVersion: 1
  state: "release_packaged_green"
  nativePayloadSha256: string
  certificationReportSha256: string
  approvalSha256: string
  bundleEntrySha256: string
  moshBuildIdentity: string
  bundleSha256: string
  codeSignatureCDHash: string
  checks: Array<{
    name: "native_selftest" | "live_shell" | "protools_shell" |
          "resource_index" | "candidate_loader_absent"
    status: "passed"
    artifactHashes: string[]
  }>
  verifiedAt: string
}
```

`handlerKey` resolves through a closed compile-time map; data cannot add native
code. The payload contains no report, approval, bundle-entry, or release hash,
so its hash is stable before certification. Both report and approval bind to
`{ kind: "native_payload", sha256: nativePayloadSha256 }`; the separate bundle
entry then binds payload, report, approval, and build identity without a hash
cycle. A generated bundle resource index contains every payload and bundle
entry. Startup registers a native skill only when those values, the native-source
digest, and catalog hashes match the running build. The Release package gate
verifies the resource index, reports, and approvals. The existing
`load_named_plugin` identifier remains a legacy input/log alias for
`load-named-plugin`; registry outcomes and new evidence use only the canonical
hyphenated ID. The other three canonical IDs have no legacy aliases.

`moshBuildIdentity` is a non-circular canonical tuple of git commit, bundle
version, target, configuration, and architecture—not a hash of the final bundle
that contains the payload.

`NativeReleaseVerificationV1` remains in the foundry/release evidence, outside
the bundle it hashes. The shipping gate consumes it; the runtime consumes only
the already approved payload and bundle entry. This keeps the graph acyclic
while binding certification to the exact signed app that was retested.

Certification is a separate release envelope so approving a candidate never
creates a self-referential hash or requires changing the approved manifest.
Candidate drafts have no release envelope. The installed loader accepts a
package only when `release.json` is certified and all three referenced hashes
match its sibling files.

The v1 schema enforces these exact UTF-8 and collection limits before any
semantic validation:

| Field or collection | Limit |
| --- | ---: |
| Certified local skills loaded at startup | 64 |
| One manifest | 64 KiB |
| One certification report | 256 KiB |
| One approval record | 16 KiB |
| One release envelope | 4 KiB |
| One native release verification | 64 KiB |
| All accepted package bytes at startup | 8 MiB |
| Activation index | 64 KiB / 64 entries |
| Source-status index | 256 KiB / 256 entries |
| Skill ID | 64 ASCII slug characters |
| Title | 80 Unicode scalar values |
| Description or fixed response string | 512 Unicode scalar values |
| Positive examples | 32 |
| Negative examples | 32 |
| One example | 256 Unicode scalar values |
| Tags | 16 |
| Enum values in one slot | 32 |
| Slots | 16 |
| Preconditions | 16 |
| Declared step nodes | 32 |
| Expanded preflight observation/resolver calls | 32 |
| Expanded mutation commands | 32 |
| Postconditions | 16 |
| Arguments on one command, resolver, or predicate | 16 |
| Provenance references | 32 |
| Claim IDs in one provenance reference | 16 |
| Choice options | 5 |
| One string slot | 1,024 Unicode scalar values |
| One list slot | 16 items |

IDs are lowercase ASCII slugs matching `[a-z0-9]+(?:-[a-z0-9]+)*`, and
versions use SemVer without build metadata. Counts apply after decoding and
step expansion. The validator rejects a declared `execution.maxMutations` outside
`1..32`; the runtime applies the smaller of that declaration and the global
cap. `timeoutMs` must be an integer from 100 through 120,000; timeouts never
retry a mutation automatically. Exact boundary and one-over-boundary cases are
mandatory tests.

### 8.2 Slots

```ts
type SlotValueV1 = string | number | boolean | string[]

type SkillSlotV1 = {
  name: string
  type: "string" | "number" | "boolean" | "enum" | "string[]"
  required: boolean
  source: "utterance" | "context" | "observation"
  default?: SlotValueV1
  enumValues?: string[]
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  description: string
}
```

Defaults must validate against the same bounds. IDs, file paths, plug-in IDs,
and engine indices cannot be embedded as owner-machine defaults. They are
resolved from current state at invocation time.

Every slot referenced by a step or predicate must be required or have a valid
default. V1 has no conditional control flow, so a referenced optional slot with
no default is rejected. Numbers must be finite; minimum and maximum must be
finite and ordered. Each item in a string list inherits the string-slot limit.

### 8.3 Typed value references

Arguments use typed references, not string interpolation or template code:

```ts
type ValueRefV1 =
  | { literal: string | number | boolean }
  | { slot: string }
  | { context: "selectedTrackId" | "projectEpoch" }
  | { binding: string }
  | { each: string; field?: string }
```

`each` is permitted only for bounded list slots and expands before transaction
preflight. Expansion preserves input order. All observations and resolutions
complete before `batch_begin`; one missing target blocks the whole invocation,
and the first ambiguous item yields a choice with zero mutations. Resume
rechecks every earlier binding. Resolving two inputs to the same entity is an
error rather than a duplicate mutation. Expansion may not exceed the skill's
fixed `maxMutations`; expanded preflight calls have their own global cap.

### 8.4 Steps

```ts
type SkillStepV1 =
  | { kind: "observe"; command: string; args: Record<string, ValueRefV1>; bind: string }
  | { kind: "resolve"; resolver: string; input?: ValueRefV1; bind: string; maxChoices: number }
  | { kind: "mutate"; command: string; args: Record<string, ValueRefV1>; forEach?: string }

type PredicateV1 = {
  name: string
  args: Record<string, ValueRefV1>
}
```

Observe commands, resolvers, mutation commands, and predicates each come from a
separately versioned allowlist. Local manifests cannot define a resolver,
predicate, regex, callback, retry loop, or conditional program. If a requested
workflow needs a new primitive, compilation stops as
`blocked_missing_primitive`; Codex must propose a normal reviewed code change.

#### V1 owner-local allowlist

Owner-local manifests begin with a deliberately smaller capability catalog than
the general agent command catalog:

| Kind | V1 entries |
| --- | --- |
| Observation | `current_snapshot()` and `list_plugins()` |
| Resolver | `selected_track()`, `track_by_unique_name(name)`, and `plugin_by_name(name)` |
| Mutation | `set_track_volume(trackId, db)`, `set_track_mute(trackId, mute)`, `set_track_solo(trackId, solo)`, and `load_plugin(trackId, pluginId)` |
| Predicate | `not_recording()`, `project_epoch_unchanged(epoch)`, `selected_track_is(trackId)`, `track_exists(trackId)`, `track_volume_equals(trackId, db)`, `track_mute_equals(trackId, mute)`, `track_solo_equals(trackId, solo)`, and `plugin_instance_added_once(trackId, pluginId)` |

The volume argument remains `-60..+6` dB. Entity-ID arguments accept only a
resolver binding or the selected-track context; `pluginId` accepts only the
current `plugin_by_name` binding. Literal strings are permitted only where a
catalog entry declares a fixed enum. Each catalog entry declares argument
types, permitted `ValueRefV1` sources, transaction class, and result schema, so
the candidate is fully type-checked before execution.

`track_by_unique_name` accepts one normalized case-insensitive exact match; zero
matches return `missing_target`, while multiple exact matches yield a bounded
choice rather than a fuzzy target.
`plugin_by_name` reuses the current named-plug-in resolver over the freshly
observed installed catalog and retains its exact, ambiguous, missing, and
malformed-catalog outcomes. A final `projectEpoch` and target-identity check runs
immediately before `batch_begin`, along with a source-status generation recheck
for owner-local skills.

Transport, save, undo/redo, recording, take destruction, file I/O, analysis,
export, plug-in parameter changes, and every remove/delete command are forbidden
to owner-local v1 manifests even if they exist in MoshOps. The four core native
adapters may use their already reviewed commands and lifecycle methods; that
does not grant those commands to local manifests. Expanding the local allowlist
requires a normal code review, command safety classification, negative and
rollback tests, a catalog-version bump, and recertification of dependent skills.

### 8.5 Execution modes

Every invocation uses these fixed phases:

1. parse and validate slots;
2. capture the pre-state fingerprint, perform all allowlisted observations and
   resolutions, evaluate preconditions, and stop for any choice;
3. expand and type-check a mutation-only plan with stable request IDs, enforcing
   `maxMutations` and all command-specific source rules;
4. run one final epoch/target check, then send only that mutation manifest to
   `batch_begin`;
5. dispatch each manifested mutation exactly once and reconcile ambiguous
   replies by request ID and transaction status;
6. take read-only post-state observations and evaluate every postcondition while
   the identified transaction is still open, then recheck project and source
   generations;
7. call `batch_end` only on success, otherwise use the identified rollback and
   verify the pre-state fingerprint.

Observation and resolver operations never appear in the engine mutation
manifest. `maxMutations` counts only expanded mutation commands; declared step
nodes and expanded preflight calls use the separate caps in Section 8.1.

- **Atomic:** every mutation is engine-classified transaction-safe. The harness
  sends one identified mutation manifest to `batch_begin`, executes it, verifies,
  and commits with `batch_end`. Failure uses the identified
  rollback path. A timeout or lost response is treated as ambiguous: query the
  identified transaction status, never reissue the mutation blindly, and claim
  rollback only after the engine verifies the pre-state fingerprint.
- **Lifecycle:** recording, playback, save, analysis, and export run as explicit
  state transitions. No atomic rollback is claimed. Each invocation performs
  one bounded transition and reports the observed state.
- **Best effort:** mixed analysis and mutation is allowed only for named built-in
  workflows with a documented compensation policy. Owner-authored local skills
  cannot use `lifecycle` or `best_effort` in v1; they must be atomic.

`maxChoices` is an integer from one through five. Response strings are fixed
plain text, not interpolation templates; audited UI code may render structured
target labels from the result beside them. Bind names, slot names, tag values,
and source/claim IDs are ASCII identifiers of at most 64 characters.

Every continuation captures `projectEpoch` and resolved target identity. A
choice answered after project or target change is blocked before mutation.

### 8.6 Outcomes

All skills terminate through the existing semantic union, extended with stable
reason codes and manifest version:

```ts
type SkillOutcomeV1 =
  | { kind: "completed"; skill: string; version: string; say: string; changes: ChangeSet | null }
  | { kind: "needs_choice"; skill: string; version: string; say: string; options: SkillChoiceV1[]; continuationToken: string }
  | { kind: "blocked"; skill: string; version: string; code: string; say: string; unserved: boolean }
  | { kind: "unsupported"; code: string; say: string }

type SkillChoiceV1 = {
  id: string
  label: string
}
```

Options are bounded to five. Unsupported and unserved asks continue to reach the
existing demand log but never enter the imitation corpus as successful traces.
Continuation payloads remain in a bounded in-memory store, not in model-visible
text. A cryptographically random, single-use token refers to the skill and
behavior-artifact hash, pending slot, allowed choice IDs and values, resolved target
identities, `projectEpoch`, creation time, and a ten-minute expiry. Project
replacement clears the store. The store holds at most sixteen continuations and
evicts the oldest unused entry first. Lookup atomically consumes the token. A
valid choice continues preflight. An invalid reply with otherwise-current
context returns the same choices under a fresh token, preserves the original
expiry, and increments an attempt counter; after three invalid replies it
returns `blocked`. Resume rejects expired, used, unknown, stale, or
artifact-mismatched tokens before mutation. The existing named-plug-in adapter
is migrated to this rule.
The v1 reason-code allowlist is:

```text
no_match | ambiguous_skill | missing_slot | invalid_slot | missing_target |
ambiguous_target | stale_context | observation_failed | manifest_stale |
command_failed | rollback_failed | postcondition_failed | missing_primitive |
provider_unavailable | timeout | unsupported_intent
```

New reason codes are additive schema changes; a manifest cannot invent one.

## 9. Runtime registry and routing

### 9.1 Registry

Introduce one `StudioSkillRegistry` that presents native built-ins and validated
declarative manifests through the same interface. The first migration wraps,
rather than rewrites, the proven fast-path and named-plug-in behavior.

The registry contains:

- built-in metadata and native implementations for the four core journeys;
- individually certified declarative built-ins from `skills.ts`;
- owner-local certified declarative manifests loaded from the fixed agent root.

The thirty-six mined service skills are never scanned.

The canonical ID namespace is global and origin-qualified by rule:

- the four native IDs and every native legacy alias are permanently reserved;
- a certified declarative built-in uses `builtin-<hyphenated-id>` and its ID is
  added to the generated reserved set;
- an owner-local ID must use `owner-<slug>`; `teach-moshi init` prepends
  `owner-` by default and rejects a supplied ID outside that namespace;
- `active.json` may reference only `owner-` IDs.

Validation compares canonical IDs and aliases as lowercase ASCII and rejects a
local draft or install that collides with any reserved ID or alias. The release
build fails if native and bundled-declarative indexes collide. Registry
construction is atomic and publishes nothing if any cross-source duplicate is
found; at runtime a newly discovered local collision is quarantined and cannot
replace a previously valid registry. Similar titles or examples may produce
`needs_choice`, but they never establish precedence or shadow an ID.

At startup, a read-only native command reads `active.json` and traverses exactly
one directory level beneath the fixed certified root. A package directory must
be named `<skill-id>@<version>` and contain exactly the four named regular files;
deeper nesting is rejected. The loader rejects symlinks, hard-linked files,
special files, path escapes, duplicate ID/version packages, and count or
byte-cap violations. It is not agent-callable. TypeScript then performs full
schema, compatibility, allowlist, hash, source-status, and certification
validation. Invalid or stale manifests are quarantined in memory, reported
locally, and never crash startup.

`active.json` is a capped, validated map from skill ID to exactly one version
and manifest hash. Only listed packages are routable. An invalid active package
makes that skill unavailable; the loader never silently falls back to an older
version. Inactive older versions remain available for explicit rollback.

There is no runtime `install_skill`, `write_skill`, or arbitrary file-read tool.
The Codex-driven CLI installs outside the running agent after certification. It
holds a foundry lock, writes all four files—including `release.json` last—inside
a same-filesystem temporary directory with owner-only permissions, verifies and
fsyncs every file and the directory, then atomically renames the complete
package. It next writes, fsyncs, and atomically renames a new `active.json`.
A crash before the package rename leaves only reclaimable `.tmp-*` data; a
crash after package rename but before activation leaves a valid inactive
package. Re-running install is idempotent when every existing hash matches and
fails closed on a mismatch. An update requires a new SemVer version rather than
in-place overwrite.

`rollback` validates an already installed package and atomically points the
activation map to it. `revoke` atomically removes the skill ID from that map but
does not delete evidence or packages. Registry generation changes clear every
continuation. Package deletion is a separate manual maintenance action, not
part of routing or rollback.

V1 scans packages only at app startup. Installation while Mosh is running takes
effect on the next launch; there is no agent-callable or filesystem-watcher hot
reload path.

`packaged_green` does not install or certify a candidate. The certification
runner builds a dedicated QA bundle with the compile-time
`MOSH_SKILL_CANDIDATE_TEST` capability, then launches it with an isolated
temporary root and exact artifact kind/hash, `evalSha256`, native-gate result
hash, and certification-run ID. That build may load only the one matching
candidate and cannot read the normal owner skill root. Release builds omit the candidate
loader code path and reject all candidate flags; a binary/package test proves
that boundary. The final certification report records the QA bundle identity
and candidate-authorization hash. Thus `packaged_green` can precede approval
without weakening the production loader's release-envelope requirement.

### 9.2 Selection pipeline

The packaged path is:

1. resume a valid active continuation;
2. apply existing deterministic section and core matchers;
3. filter registry entries by compatibility and current preconditions;
4. retrieve at most three candidates from curated examples and tags;
5. use exact/deterministic parsing when it uniquely resolves the skill and slots;
6. otherwise ask the existing brain only for a structured candidate selection
   and slot object;
7. validate every slot and resolve current entities;
8. ask a bounded choice or return unsupported when resolution is ambiguous;
9. execute through the skill harness and verify postconditions.

The model never receives or selects the raw command catalog on this path. It can
choose only among retrieved skill IDs and fill their published slot schemas. An
invalid response, provider failure, tie, missing slot, or unavailable candidate
causes clarification or refusal, never raw-command fallback.

Manifest titles, descriptions, examples, tags, and response strings are always
encoded as length-bounded untrusted JSON data, never concatenated into system or
developer instructions. The structured model schema accepts only one of the
three supplied IDs plus that candidate's declared slots. Even a same-user
package containing injection text cannot add tools, reveal the command catalog,
alter policy, or bypass deterministic validation.

Deterministic matching and all four core journeys remain available with no
model provider. V1 retrieval uses local normalized-token matching over curated
examples and tags; it does not require a remote embedding service. A configured
brain can disambiguate only the bounded top-three candidate set. If it is
unavailable, an exact explicit skill invocation can still run, otherwise the
router asks a deterministic choice or refuses. An exact invocation means the
utterance names a unique manifest ID or the user selects a returned choice; v1
does not add a hidden command syntax.

The developer-only free-form loop remains an experiment and is never the
packaged fallback.

### 9.3 Live-shell reachability

Replace the Live shell's Moshi stub with the same shared `AgentComposer`, task
drawer, and change toast used by the proven shells. The Live shell adds layout
and focus treatment only; it owns no new agent logic or command path.

The shared composer must behave identically in Live and Pro Tools shells for:

- text input and final speech input;
- pending choices;
- task and change feedback;
- Escape/close/focus return;
- project replacement and stale continuation invalidation;
- packaged refusal behavior.

This is runtime convenience for the owner, not a teaching recorder.

## 10. Certification goal loop

### 10.1 States

A candidate advances monotonically:

```text
draft
  -> source_reviewed
  -> schema_valid
  -> mock_green
  -> native_green
  -> packaged_green
  -> acceptance_green
  -> owner_approved
       |-> certified                         (declarative local)
       `-> release_packaged_green -> certified  (native built-in)
```

`blocked`, `rejected`, `stale`, `superseded`, and `revoked` are terminal or
review states, never aliases for certified.

The `owner_approved` transition requires the explicit fingerprint approval from
Section 5.3. Earlier approval of this architecture does not approve any future
skill, behavior artifact, evaluation report, or release.

`acceptance_green` means every required physical or taste check passed. When a
skill has no such claim, its report must contain a reviewed
`physical_not_required` decision rather than silently skipping the level.

Every transition records artifact hashes, app/git version, test command,
timestamps, and exact results in the draft-only, hash-chained `state.jsonl`.
`certification.json` is built during the automated and manual gates and freezes
at `acceptance_green`; it contains no later transition. `approval.json` is the
`owner_approved` transition. Creation and validation of a hash-bound local
`release.json` is the declarative `certified` transition. For a native built-in,
approval creates the bundle entry; the exact final signed bundle must then pass
all `NativeReleaseVerificationV1` checks in both shells before the state ledger
records `certified`. Any code, payload, resource-index, build-identity, or bundle
change invalidates that verification and requires a new final gate. This avoids
changing the frozen report or approval after the fact while still retesting the
exact shippable app. Editing the behavior artifact or frozen eval suite resets
all downstream states. A command, predicate, resolver, model-routing, or Mosh
compatibility change marks
dependent skills stale until replayed.

### 10.2 One-skill loop

The certification loop pursues one concrete skill objective at a time:

1. establish observable success and failure criteria;
2. freeze the eval suite and its hash;
3. validate the declarative manifest or native payload and compile the bounded
   command/lifecycle plan;
4. run deterministic mock and native cases;
5. inspect artifacts and categorize each failure;
6. fix the candidate, compiler, or missing primitive without weakening the
   frozen acceptance criteria;
7. rerun affected gates, then the full skill gate;
8. stop only at certified or an explicit blocker.

The default budget is five repair cycles. Stop earlier when:

- the workflow requires a missing MoshOps or resolver primitive;
- source rights are unresolved;
- the same blocker appears in three consecutive cycles;
- physical hardware or owner judgment is required;
- the only apparent fix is weakening the acceptance criteria;
- the workflow is outside the bounded product promise.

The loop never broadens its own scope, auto-approves, edits source media, or
promotes on test-command exit code alone. Final-state evidence is mandatory.

### 10.3 Evidence levels

1. **Schema:** exact behavior artifact, catalog, bounds, and hash validation.
2. **Mock:** precondition, expansion, result, postcondition, and refusal logic.
3. **Native engine:** real MoshOps, snapshot, JSONL, undo/rollback, save/reload,
   and failure injection in an isolated session.
4. **Packaged app:** actual composer and current resources in both Live and Pro
   Tools shells.
5. **Physical/taste:** microphone, audible take, plug-in editor, or owner
   judgment where the claim requires it.

Higher levels do not erase failures at lower levels, and browser/mock green is
not packaged or physical proof.

When a frozen case requires physical or taste evidence, `certify` exits cleanly
with `kind: "needs_manual_evidence"`, the run ID, case ID, expected observation,
and current artifact hashes. It leaves no test process running. Codex then uses
`record-evidence`; a valid record is:

```ts
type ManualEvidenceV1 = {
  schemaVersion: 1
  runId: string
  caseId: string
  artifact: SkillArtifactRefV1
  evalSha256: string
  expectedObservation: string
  decision: "passed" | "failed" | "physical_not_required"
  observed: string
  actor: string
  recordedAt: string
  artifacts: Array<{
    kind: "audio" | "image" | "video" | "log" | "other"
    localPath: string
    sha256: string
    bytes: number
  }>
}
```

The command verifies the case and expected observation against the frozen eval
manifest, validates each regular-file locator, appends the record, and never
copies or edits the evidence file. `physical_not_required` requires an explicit
reviewer statement in `observed`. A later `certify` resumes only when run,
behavior-artifact, eval, and build hashes still match; otherwise it starts a new run.
Failed attempts remain in the ledger and cannot be overwritten.

## 11. Four-core acceptance matrix

### 11.1 Session control and safety

- Supported canonical and held-out phrases select the right action.
- Play, stop, and from-start reach the exact transport state.
- Save survives relaunch in an isolated scratch project.
- Undo and redo affect exactly the reported change.
- Invalid or unavailable state returns blocked with zero new mutation.
- Lifecycle operations never claim one atomic undo group.

### 11.2 Capture, review, and choose a take

- Unique track/context resolution is observed before record.
- Record start and stop report actual transport/controller state.
- Before "again," the transport is stopped and review state identifies one clip,
  its current take ID, and `N >= 1` take IDs. Starting again changes none of
  those takes. A successful stop produces exactly `N + 1` take IDs, selects the
  one new ID, and preserves every prior ID as recoverable.
- A failed restart before record leaves take count and selection unchanged. A
  failure after record begins reports the observed lifecycle state and recovery
  action; it never deletes a prior take or claims rollback.
- Audition navigates the expected take and "keep" chooses only an existing take.
- Explicit "keep" retains exactly the selected take, reduces the lane set to
  that one ID, and one undo restores all discarded IDs and the prior selection.
- The kept take is audible and remains after save and relaunch.
- Run three consecutive physical-input passes in a scratch session with zero
  data loss, unexpected clips, or JUCE assertions.

### 11.3 Focus and explicit balance

- Track names resolve uniquely; ambiguity produces at most five choices and no
  mutation.
- Mute, unmute, and solo reach the requested exact state.
- Explicit level values validate against the existing safe range and reach the
  exact snapshot value.
- Multi-target actions expand only within the fixed mutation cap.
- One atomic undo restores every changed target.
- Vague taste requests are unsupported and write no mutation.

### 11.4 Named plug-in

- The current installed catalog is observed before resolution.
- Exact names load once on the intended selected track.
- Ambiguous names produce at most five producer-facing choices.
- Missing names suggest rescan or plug-in management without mutation.
- Project or selected-track change blocks a stale continuation.
- Instrument/audio mismatch gives actionable guidance.
- One undo removes a successful load.
- Malformed, failed, overlong, and oversized catalog responses fail closed.

## 12. Cross-cutting evaluation bar

Before the first repair attempt, the runner freezes and hashes an eval manifest.
Each case contains a stable ID, journey/action slice, supported flag, utterance,
fixture and initial-state hashes, expected semantic outcome, exact final-state
predicates, prohibited effects, required evidence level, and scoring category.
The core router suite has exactly 160 cases:

- 30 supported held-out selection cases per journey (120 total), with every
  supported action represented at least four times;
- 10 negative, ambiguity, stale-state, malformed-input, injection, or expected-
  failure cases per journey (40 total).

Top-one selection is scored on the 120 supported cases only. Passing requires
at least 27 of 30 correct in every journey and at least 108 of 120 overall,
using integer counts with no rounding. Every one of the 40 non-success cases
must reach its exact expected outcome with zero mutation. No case is dropped
after execution begins; an infrastructure error fails the case and blocks the
gate rather than changing the denominator.

The first release requires:

- the frozen core-router counts above;
- 100% schema-valid executed fills, with all invalid fills caught before
  mutation;
- zero wrong mutations across negative, ambiguity, stale-project, missing-target,
  malformed-source, and prompt-injection cases;
- 100% postcondition checks on completed native runs;
- exact rollback for every failed atomic run;
- explicit partial/lifecycle state for every non-atomic failure;
- all four journeys green from the packaged Live and Pro Tools composers;
- no raw-command or developer-loop fallback in a packaged build;
- one blind twenty-task owner-style run through the Mosh Live shell: four
  supported tasks per journey and one unsupported/adversarial task per journey.
  At least fifteen of sixteen supported tasks must complete correctly, all four
  unsupported tasks must refuse or ask safely as specified, and there must be
  zero wrong-target or data-loss events.

Failures and production corrections become immutable regression cases. Reports
show per-skill results; a single aggregate score cannot hide a weak skill.

## 13. Security, rights, and failure handling

### 13.1 Local skill safety

- Runtime manifests are data-only and pass fixed-root path containment.
- File counts, bytes, examples, slots, steps, and choices are capped.
- Only allowlisted observations, resolvers, predicates, and MoshOps commands are
  legal.
- All arguments are typed; no interpolation, code, URL fetch, or environment
  expansion is allowed.
- Certification and approval hashes must match the exact manifest.
- The runtime revalidates safety even for owner-local files; filesystem presence
  is not trust.
- A local skill may narrow permissions but cannot add a command to the catalog.

V1 does not claim artifact signatures or protection from a malicious process
running as the owner. Hashes detect accidental mismatch and bind review records;
they do not prove authorship. The data-only language, runtime allowlist, typed
arguments, and MoshOps validation remain the enforcement boundary even if a
local package is deliberately rewritten and rehashed.

The explicit v1 trust assumption is that the owner account and same-user Codex
session are authorized to install local packages. They are not trusted to widen
runtime capabilities: self-consistent hashes can admit only operations already
present in the fixed allowlist.

### 13.2 Source-content safety

- Tutorial text, captions, PDFs, web pages, comments, and OCR/ASR output are
  untrusted data.
- Sources are never placed in runtime system instructions.
- Source-derived values cannot flow directly into a mutation argument.
- Codex must state which procedure step is source fact, Mosh inference, or owner
  decision.
- Injection-shaped source content is preserved only as a test case and cannot
  approve, install, fetch, or execute anything.

### 13.3 Failure behavior

| Failure | Required outcome |
| --- | --- |
| Invalid or stale local manifest | Quarantine, local diagnostic, continue without it |
| No matching skill | `unsupported`; record unserved ask |
| Multiple skills or targets | `needs_choice`; no mutation |
| Project/selection changed | `blocked` with retry guidance |
| Observation failed | `blocked`; no mutation |
| Atomic command failed | identified rollback, verify pre-state, report blocked |
| Lifecycle transition failed | report observed state and recovery action; no false rollback claim |
| Postcondition failed | never report completed; rollback if atomic |
| Brain/provider unavailable | deterministic skills remain; otherwise clarify or refuse |
| Ableton unavailable or unsafe | skip reference capture; author offline |
| Rights unresolved or source revoked | block source promotion; mark dependent draft stale |

## 14. Migration and compatibility

- Snapshot and event changes remain additive. Existing consumers stay valid.
- The existing named-plug-in implementation remains the initial native
  implementation and retains its tests while joining the shared registry.
- Existing fast paths remain deterministic and are wrapped as certified native
  skill metadata before any internal refactor.
- Existing `skills.ts` entries begin as candidates. No bulk certification.
- The service-mined JSONL catalog remains offline and its boundary tests remain.
- The current agent-turn harvester remains unchanged for normal imitation data.
  Teach drafts and Ableton references use a separate schema and directory.
- Useful concepts from the parked SessionRecorder—source, actor, consent,
  version, step result, state hash, and replay—may be ported selectively. The
  archived stack and old MoshIR vocabulary do not become runtime dependencies.
- A removed, revoked, incompatible, or stale local skill disappears from routing
  without changing projects or saved sessions.

## 15. Delivery slices

### Slice A — contract and registry

- Define manifest, typed references, predicates, resolvers, validators, caps,
  hashes, flattened packages, activation index, and local read-only loader.
- Add code-bound native payloads, bundle entries, and registry adapters for native and
  declarative skills, including the legacy named-plug-in alias.
- RED-prove invalid, stale, oversized, tampered, and unsafe manifests.

### Slice B — four-core runtime

- Register the proven session/take/plugin paths.
- Expose bounded explicit balance through the registry and harness.
- Consolidate composer routing without changing proven precedence.
- Keep packaged free-form fallback disabled.

### Slice C — Live-shell composer

- Replace the stub with shared composer, task, and change surfaces.
- Add parity, focus, Escape, stale-choice, and packaged tests.

### Slice D — foundry tooling and source intake

- Implement the structured `teach-moshi` CLI and local draft layout.
- Enforce draft/reference/process quotas and crash-safe, versioned install,
  activate, rollback, revoke, and dry-run GC behavior.
- Extend source cards with claim dependency and freshness fields plus the local
  status/revocation index and pre-invocation fail-closed check.
- Produce candidate, eval, state-ledger, manual-evidence, report, approval, and
  release artifacts.

### Slice E — certification and owner reference

- Implement the finite goal loop, frozen benchmark manifests, immutable
  reports, manual checkpoints, and the QA-only packaged candidate loader.
- After native approval, build and verify the exact signed Release bundle and
  record `NativeReleaseVerificationV1` before certification.
- Run the single Ableton reference block only after the offline contracts exist,
  so owner time answers specific questions rather than generating raw footage.
- Certify all four journeys through packaged and physical gates.

Each slice receives its own implementation plan, worktree, review, and evidence.
No slice may claim the program complete while a later required slice remains
unimplemented.

## 16. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Building a second general agent inside the skill compiler | Compiler runs under Codex/developer control; runtime sees only declarative, allowlisted manifests |
| Ableton reference creates false confidence | Reference is never an execution gate; all postconditions are proved in Mosh |
| Owner teaching remains time-consuming | Four checkpointed journeys in one block; Codex derives variants and exceptions offline |
| Existing catalogs drift further | One registry interface, explicit adapters, and boundary tests; no bulk merge |
| Dynamic local skills widen attack surface | Data-only schema, fixed roots, allowlists, caps, hashes, compatibility checks, no runtime writes |
| Router executes a plausible but wrong skill | Candidate filtering, bounded selection, schema validation, clarification, and zero raw-command fallback |
| Tests overfit authored examples | Freeze held-out paraphrases and negatives before repair; production corrections become regressions |
| Recording cannot be rolled back | Lifecycle state machine and physical proof; never label it atomic |
| Online material changes or is revoked | Versioned source cards, dependent-skill staleness, replay before reactivation |
| Mosh UI remains unfamiliar | Shared Moshi composer becomes reachable in the Live shell; authoring stays outside Mosh UI |

## 17. Completion claim

This program is complete only when a packaged Mosh build can truthfully claim:

> Moshi can control and preserve a session, guide one take through keep/retry,
> make explicit basic balance changes, and resolve and load a named installed
> plug-in. New bounded workflows can be authored through Codex, reviewed in
> plain language, and installed only after reproducible Mosh-native proof.

Anything outside that claim is either a named candidate, a knowledge card, or an
honest unsupported request—not an implied capability.
