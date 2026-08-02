# Vocal Map Playtest Program — Status

**Updated:** 2026-08-02

**Target:** 2026-09-17 solo-novice playtest

**Current serial seat:** VM-001 Program control and terminology

**Next seat:** VM-010 Deterministic contracts, blocked until VM-001 is owner-merged

## Program gates

| Gate | Date | State | Evidence needed |
| --- | --- | --- | --- |
| Confirm owner-only participant scope | 2026-08-02 | complete | VM-D016 |
| Accept natural editable-draft criterion | 2026-08-02 | complete | VM-D017 and frozen owner-lab verdict |
| Freeze research roster | 2026-08-13 | open | signed roster revision in `RESEARCH_ROSTER.md` |
| Seal eight owner evaluation clips | before deep evaluation | open | hashes, balance table, consent/provenance |
| Freeze one stack | 2026-08-27 | open | scored packet, disqualifications, owner decision |
| Debugging-only loop begins | 2026-08-28 | blocked | stack freeze |
| Full-flow hardening | 2026-09-11 through 2026-09-16 | blocked | integrated frozen stack |
| Solo-novice acceptance | 2026-09-17 | blocked | self-guided full workflow without an external facilitator, operator, or agent; kept result under 15 minutes |

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

The following work was open when VM-001 established the program and remains
preserved outside the active serial seat unless its row records an executed
owner exception. None may merge into `main` during the Vocal Map train without
an explicit owner exception, a rebase onto the then-current trunk, and a fresh
full gate.

| PR | Preserved work | State |
| --- | --- | --- |
| #322 | Finish-My-Song WIP checkpoint | parked; outside September surface |
| #358 | FMS mechanism verification and duration derivation | research artifact; no merge during the serial train without an owner exception |
| #363 | FMS solve-for-the-song benchmark | research artifact; no merge during the serial train without an owner exception |
| #462 | Universal 2 / Intel compatibility | parked; broad Mac compatibility is excluded |
| #463 | packaging usage-key guard | parked with the superseded packaging lane; re-evaluate in VM-060 |
| #464 | replay-capture command guard | parked; rebase and regate only by owner exception |
| #465 | hermetic lyrics-bench repair | research infrastructure; no merge during the serial train without an owner exception |
| #466 | v2 overflow-menu fix | parked; rebase and regate only by owner exception |
| #468 | hosted-check documentation update | parked; its recovered-billing correction is incorporated in VM-001 current documentation |
| #470 | v2 instrument discoverability | parked; outside the September surface |
| #472 | agent vocabulary expansion | parked; re-evaluate after VM-001 |
| #471 | FS-T2 plugin-crash safe mode | paused |
| #473 | FS-K3 opt-in crash reporting | paused |
| #475 | FS-K4 packaging/BOM gate | paused |
| #478 | combined First-Stranger ship-kit and brain work | paused |
| #497 | Arrange renderer extraction | parked architecture work; rebase after the Vocal Map train |
| #500 | v2 reachability ratchet stacked on #497 | parked with #497 |
| #507 | selftest chapter scaffold | parked; regenerate stack after VM-001 |
| #508 | selftest chapters 1/2 | parked with #507 |
| #510 | selftest chapters 2/2 | parked with #507/#508 |
| #514 | Graphite v2 shell | parked; rebase after VM-001 before continuation |
| #515 | FMS lyric-pilot measurements | research artifact; preserve results, but do not merge during the serial train without an owner exception |
| #522 | visible Moshi brain-unavailable fallback | merged 2026-07-31 by explicit owner exception as `6c3687db`, after rebase and fresh gate |
| #524 | owner-only Moshi + Codex cockpit | parked behind VM-001; its earlier #514/#507/#508/#510 landing chain is superseded by VM-D015; resume only after current-trunk rebase and fresh full gate |
| #526 | keep the agent task drawer visible from mount | merged 2026-07-31 by explicit owner exception as `379bd6a1`, after #522 |
| #528 | CoreAudio timeout recovery | merged by owner exception as `e520550b`; VM-001 refreshed on the resulting current trunk |

VM-001/PR #523 is rebuilt as one squash on current `main` at `01adca36`. Its
earlier evidence is historical; publication and owner merge require fresh gates
and reviews bound to the refreshed exact head.

## Current risks

- Eight balanced owner evaluation clips and any candidate-required adaptation
  material are not yet sealed.
- The accepted Cycle 9 result proves one owner-useful first draft, not
  multi-singer generalization or hidden-original lyric recovery.
- Commercial use may remain blocked if a restricted-license model wins the
  private playtest.
- The 10-second, 90-second, and three-minute targets are unmeasured until the
  deterministic contracts and lab shell land.
- RunPod, R2, and Keychain capability integration remain future serial seats;
  no keys belong in this repository.
- VM-001 closes the program-STOP, exact gated-head, and failed-push subsets of
  historical backlog item AL-028; the remaining stranger-loop hardening stays
  `needs-human` and the loop must not be armed.
