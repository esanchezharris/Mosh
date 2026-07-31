# Vocal Map Playtest Program

**Status:** active as of 2026-07-30. This program supersedes the paused
[First-Stranger Program](../first-stranger-program/README.md) without deleting its
backlog, lane plans, status board, ledger, or evidence.

## Milestone

> A novice turns a 4–8-bar mumble into an editable, identity-preserving guide
> vocal, corrects one word or syllable, compares takes, and keeps a result they
> are proud of within 15 minutes.

The acceptance rehearsal is a local, solo-novice playtest on **2026-09-17**. The
owner does not intervene. Passing requires a kept guide vocal and at least one
word or syllable edit within the 15-minute window.

## Fixed dates

| Date | Gate |
| --- | --- |
| 2026-08-06 | Two additional singers recruited |
| 2026-08-13 | Candidate roster frozen; no additions without an explicit owner decision |
| 2026-08-27 | One stack selected; model shopping ends even if the best stack misses the target |
| 2026-09-11 through 2026-09-16 | Full-flow rehearsals, failure injection, performance tuning, and usability fixes only |
| 2026-09-17 | Solo-novice acceptance playtest |

## Operating rule

Implementation lands as serial PRs. A PR must be merged by the owner after its
complete class-correct local gate before work starts on the next PR. Agents open
PRs and stop; they never merge. Research evidence can accumulate in parallel,
but it cannot change frozen product contracts or reopen model shopping after
2026-08-27.

## Program map

| File | Authority |
| --- | --- |
| [SPEC.md](SPEC.md) | Decision-complete product, interface, state, privacy, and acceptance contract |
| [STATUS.md](STATUS.md) | Rolling program board and the only active serial implementation seat |
| [DECISIONS.md](DECISIONS.md) | Append-only owner decision log |
| [RESEARCH_ROSTER.md](RESEARCH_ROSTER.md) | Candidate cutoff, corpus protocol, evaluation matrix, and stack-freeze rule |

## Serial PR train

1. **VM-001 Program control and terminology:** stop First-Stranger automation,
   establish this program, and rename active Monster product terminology to
   Moshi while retaining legacy reads.
2. **VM-010 Deterministic contracts:** versioned adapter schemas, shared async
   job envelope, fake adapters, immutable artifact manifests, sidecar handling,
   and the localhost lab shell.
3. **VM-020 Vocal Map state:** authoritative `VocalIntent` semantic state,
   additive snapshot summary, lazy detail fetch, revision lineage, locks, and
   undo/redo.
4. **VM-030 Workflow commands:** finish/read/edit/link/unlink/preset/preview/
   render/profile/purge MoshOps commands with independent job cancellation.
5. **VM-040 Frozen-stack adapters:** only the 2026-08-27 winners, plus explicit
   license blockers and deterministic fallbacks.
6. **VM-050 Product workflow:** dedicated Vocal Map editor, take lanes, local
   preview, explicit cloud render, phrase-local stitching, and honest failures.
7. **VM-060 Privacy and hardening:** Keychain capability, R2 lifecycle,
   watermarking, telemetry restrictions, failure injection, performance, and
   playtest rehearsal.

The current seat and merge dependency are recorded in [STATUS.md](STATUS.md).
