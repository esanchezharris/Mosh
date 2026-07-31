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

## Pre-existing PR disposition

The following open work remains preserved, but it is outside the active serial
seat. None may merge into `main` during the Vocal Map train without an explicit
owner exception, a rebase onto the then-current trunk, and a fresh full gate.

| PR | Preserved work | State |
| --- | --- | --- |
| #322 | Finish-My-Song WIP checkpoint | parked; outside September surface |
| #462 | Universal 2 / Intel compatibility | parked; broad Mac compatibility is excluded |
| #472 | agent vocabulary expansion | parked; re-evaluate after VM-001 |
| #471 | FS-T2 plugin-crash safe mode | paused |
| #473 | FS-K3 opt-in crash reporting | paused |
| #475 | FS-K4 packaging/BOM gate | paused |
| #478 | combined First-Stranger ship-kit and brain work | paused |
| #507 | selftest chapter scaffold | parked; regenerate stack after VM-001 |
| #508 | selftest chapters 1/2 | parked with #507 |
| #510 | selftest chapters 2/2 | parked with #507/#508 |
| #514 | Graphite v2 shell | parked; rebase after VM-001 before continuation |

## Current risks

- Two singers and their separately consented adaptation recordings are not yet
  secured.
- Commercial use may remain blocked if a restricted-license model wins the
  private playtest.
- The 10-second, 90-second, and three-minute targets are unmeasured until the
  deterministic contracts and lab shell land.
- RunPod, R2, and Keychain capability integration remain future serial seats;
  no keys belong in this repository.
- VM-001 closes only the program-STOP subset of historical backlog item AL-028;
  the remaining stranger-loop hardening stays `needs-human` and the loop must
  not be armed.
