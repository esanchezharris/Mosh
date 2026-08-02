# Vocal Map Playtest Specification

**Status:** decision-complete for the 2026-09-17 private playtest. Do not reopen
settled scope while implementing a lane. Record a changed owner decision in
[DECISIONS.md](DECISIONS.md) before changing this contract.

## 1. Acceptance surface

The playtest user:

1. uploads an owned, clean, 10–30-second singing reference and creates one
   reusable install-scoped voice profile;
2. records or imports a dominant solo vocal already fitted to project tempo;
3. selects a 4–8-bar hook and presses **Finish this hook**;
4. receives an aligned Vocal Map and one concrete, natural, singable,
   house-style lyric first draft within 10 seconds; the draft is constrained by
   the source performance but is not presented as recovered original lyrics;
5. changes at least one word or syllable boundary;
6. compares the untouched source, ephemeral local previews, and durable cloud
   takes; and
7. keeps a guide vocal they are proud of within 15 minutes, self-guided and
   without an external facilitator, operator, or agent intervention.

The cloud guide target is 90 seconds. A settled edit refreshes one ephemeral
local own-voice preview automatically, targeting under three minutes on the
observed M1 Max/64 GB owner machine. These are target measurements, not broad
hardware claims.

## 2. Adapter capabilities

Three independently versioned capabilities share one asynchronous protocol:

- `vocal_analysis`
- `aligned_lyric_generation`
- `vocal_synthesis_span_edit`

Each capability supports discovery plus `submit`, `status`, `cancel`, and
`result`. Every response carries:

- protocol and capability version;
- adapter/model identity and immutable model hash;
- job and request identity;
- state, timestamps, elapsed/queue/runtime latency, and cancellation posture;
- structured diagnostics and terminal error classification;
- input/output artifact manifests with content hashes;
- provenance, license posture, and runtime identity; and
- immutable result artifacts.

Malformed results, unknown versions, hash drift, missing artifacts, timeout,
unavailable runtime, and cancellation races fail closed. Fake adapters and
deterministic fixtures land before third-party runtimes.

## 3. VocalIntent and Vocal Map

Each source clip has at most one `VocalIntent`, presented as its **Vocal Map**.
It references the existing lyric-line state and contains:

- notes, words, syllables, and phonemes;
- note/audio spans and word/syllable anchor boundaries;
- repetition links and per-occurrence unlink state;
- identity, lyric, melody, rhythm, and expression locks;
- confidence and diagnostics;
- source fingerprint;
- semantic revisions; and
- generated-take lineage.

Editable semantic state belongs in the authoritative session ValueTree. Dense
F0/features live in immutable, content-addressed project sidecars. Snapshots add
only a compact Vocal Map summary; clients fetch detailed maps lazily. Missing or
corrupt sidecars produce an honest recoverable state and never mutate source
audio.

Save/reopen must retain semantic revisions, lineage, links, locks, and the
compact summary. Existing sessions without a Vocal Map remain valid. Snapshot
and event changes are additive.

## 4. MoshOps surface

Existing `build_skeleton_from_clip`, lyric-sheet, render-layer, and take
commands remain backward-compatible. New commands cover:

- finishing a selected hook and reading its Vocal Map;
- editing words and syllable boundaries;
- changing presets and individual locks;
- unlinking a repeated occurrence;
- generating, replacing, and keeping an ephemeral local preview;
- explicitly rendering a durable cloud take;
- enrolling, replacing, and deleting the reusable voice profile; and
- purging retained project cloud assets.

Every semantic edit and every landed take is its own Tracktion undo
transaction. Background jobs are independently cancellable and are not folded
into edit undo. A generated result lands as a new take and never overwrites the
source.

Repeated phrases share words by default. An edit changes every linked
occurrence until the user explicitly unlinks one. One-best regeneration returns
one new best interpretation rather than a candidate grid.

## 5. Presets and edit locality

| Preset | Identity | Lyrics | Melody | Rhythm | Expression |
| --- | ---: | ---: | ---: | ---: | ---: |
| Strict | 100 | 100 | 100 | 100 | 100 |
| Musical | 100 | 100 | 100 | 80 | 80 |
| Reimagine | 100 | 100 | 50 | 50 | 50 |

`Musical` is the default. Individual advanced locks are visible and editable.
Exact source F0/contour is preserved by default; the playtest does not promise
pitch correction. Arrangement and audio outside the affected phrase are hard
locked. Cloud span edits stitch only the safe affected phrase into a complete
new take, with byte/sample stability checks outside the edit range.

## 6. Local and cloud posture

- Local preview starts with zero-shot/quantized SoulX-family candidates.
- The optional local pack is at most 10 GB.
- Cloud inference runs on RunPod Serverless.
- Encrypted retained artifacts live in isolated Cloudflare R2 project
  namespaces.
- Combined cloud spend is capped at $150/month for this program.
- A cloud failure leaves the source untouched and offers the best available
  approximate local own-voice preview.
- Cloud rendering occurs only after explicit **Render change**.

Generated guide vocals carry AudioSeal metadata plus an inaudible watermark.
Restricted-license systems may win the private playtest, but the product must
surface the commercial replacement or negotiation blocker explicitly.

## 7. Identity, authorization, retention, and privacy

There is no account flow in this playtest. A voice profile is install-scoped and
protected by an invisible Keychain capability. Project IDs without the
capability are rejected. Profile enrollment requires an owned-reference
attestation.

Project cloud assets remain until local project deletion or explicit purge.
The reusable voice profile has a separate replace/delete lifecycle. R2 objects
are isolated by project capability and corpus/artifact lineage records
revocation.

Telemetry is opt-in and contains only redacted events, state transitions,
latencies, error classes, and aggregate timings. It never contains audio,
lyrics, detailed Vocal Map content, voice embeddings, or training data. Mosh
adds no lyric-content filter; unavoidable upstream restrictions are disclosed.

## 8. Research and data

The owner is the sole participant for the September proof. Record up to 30
minutes of separately consented owner adaptation material if a candidate needs
it. Seal eight owned evaluation clips, balanced across melodic/rap and
free/paired mumble cases. This packet establishes owner-playtest fitness only;
it does not support multi-singer generalization claims.

Evaluation clips never enter fine-tuning. Fine-tuning may use only the separate
adaptation corpus or independently rights-cleared/synthetic data. Consent,
source, transformations, model use, and revocation lineage are explicit.

Candidates admitted by 2026-08-13 are listed in
[RESEARCH_ROSTER.md](RESEARCH_ROSTER.md). On 2026-08-27, disqualify stacks that
lose identity, exact F0/contour, rhythmic emphasis, or expressive phrasing.
Among survivors maximize Keep rate, then pride/edit-locality, then latency and
cost. If no stack clears the bar, freeze the best stack anyway and debug it.
Model shopping does not extend.

Aligned lyrics are judged as a natural, editable constrained interpretation.
Hidden-original exact-word recovery and raw-ASR edit distance are reported as
diagnostics, not acceptance gates. Passing requires cadence, syllable shape,
melodic intent, and repetition to support a direct word or syllable edit.

## 9. Verification

Each relevant serial PR runs its class-correct portion of:

- adapter conformance, malformed fixtures, discovery, hash identity,
  cancellation, timeout, and runtime-unavailable tests;
- save/reopen, corrupt/missing sidecar, additive snapshot, source stability,
  lineage, repetition-link, and undo/redo tests;
- local/cloud crossover, latency measurements, phrase-only preservation, take
  A/B, watermark detection, and no-surrounding-audio-change tests;
- capability rejection, replace/delete/purge, R2 isolation, secret/log scan,
  content-telemetry denial, and revocation-lineage tests;
- editor confidence, preset disclosure, boundary drag, linked edits, preview
  replacement, cloud progress/cancel/retry, and honest failure UI tests; and
- standard build, selftest ×3, undo battery, Catch2, service tests, TypeScript,
  Playwright, and real-app manual QA.

The 2026-09-17 acceptance is a real solo-novice completion of Section 1 within
15 minutes.

## 10. Explicit exclusions

The September surface excludes semantic import, source separation, live
beatboxing, You→You+ technique correction, multiplayer synchronization,
packaging/notarization, broad Mac compatibility claims, automatic tempo
inference, and pitch correction.
