# Vocal Map Playtest Program — Status

**Updated:** 2026-07-30

**Target:** 2026-09-17 solo-novice playtest

**Current serial seat:** VM-001 Program control and terminology

**Next seat:** VM-010 Deterministic contracts, blocked until VM-001 is owner-merged

## Program gates

| Gate | Date | State | Evidence needed |
| --- | --- | --- | --- |
| Recruit two additional singers | 2026-08-06 | open | consented participant roster |
| Freeze research roster | 2026-08-13 | open | signed roster revision in `RESEARCH_ROSTER.md` |
| Seal 24 evaluation clips | before deep evaluation | open | hashes, balance table, consent/provenance |
| Freeze one stack | 2026-08-27 | open | scored packet, disqualifications, owner decision |
| Debugging-only loop begins | 2026-08-28 | blocked | stack freeze |
| Full-flow hardening | 2026-09-11 through 2026-09-16 | blocked | integrated frozen stack |
| Solo-novice acceptance | 2026-09-17 | blocked | full workflow, no owner help, kept result under 15 minutes |

## Serial implementation board

| ID | Deliverable | State | Dependency |
| --- | --- | --- | --- |
| VM-001 | Program control and active Monster→Moshi terminology | in progress | none |
| VM-010 | Adapter schemas, async envelope, fakes, artifacts, sidecars, localhost lab | blocked | VM-001 merged |
| VM-020 | `VocalIntent` state, snapshot summary, lazy map, lineage, locks | blocked | VM-010 merged |
| VM-030 | Finish/edit/link/preview/render/profile/purge MoshOps commands | blocked | VM-020 merged |
| VM-040 | Frozen-stack adapters | blocked | VM-030 merged and 2026-08-27 decision |
| VM-050 | Dedicated editor and take-lane workflow | blocked | VM-040 merged |
| VM-060 | Privacy, watermark, failure injection, performance, rehearsal | blocked | VM-050 merged |

Only one row may be `in progress`. The owner merges each fully gated PR before
the next row starts.

## Superseded First-Stranger PRs

The First-Stranger evidence and open implementation work remain preserved, but
they are not active Vocal Map dependencies and must not merge without a new
owner disposition.

| PR | Preserved work | State |
| --- | --- | --- |
| #471 | FS-T2 plugin-crash safe mode | paused |
| #473 | FS-K3 opt-in crash reporting | paused |
| #475 | FS-K4 packaging/BOM gate | paused |
| #478 | combined First-Stranger ship-kit and brain work | paused |

## Current risks

- Two singers and their separately consented adaptation recordings are not yet
  secured.
- Commercial use may remain blocked if a restricted-license model wins the
  private playtest.
- The 10-second, 90-second, and three-minute targets are unmeasured until the
  deterministic contracts and lab shell land.
- RunPod, R2, and Keychain capability integration remain future serial seats;
  no keys belong in this repository.
