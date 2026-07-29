# RFC 002 — SelfTest chapter split by prefix-motion

- **Status:** accepted
- **Decided:** 2026-07-28 (owner approved the program plan)

## Problem

[`src/app/SelfTest.cpp`](../../src/app/SelfTest.cpp) is 9,738 LOC, and `runSelfTest` alone is
~8,500 LOC with ~96 `section()` blocks. Unlike MoshOps, the blocks are **not** independent:
locals deliberately flow across sections — `tid`, the `trackById` lambda, the
reference-capturing event sink — because later sections assert against state earlier sections
created. Any split that treats sections as movable units in isolation silently changes what the
harness tests. The file is also the app target's second compile hotspot and a constant
merge-collision surface for lanes that add checks.

## Invariants touched

- **The selftest harness is a load-bearing oracle** for every native gate (CLAUDE.md gate
  ledger); its observable behaviour must not change at all — this RFC's verification is an
  identity oracle for exactly that reason.
- **Test semantics:** the deliberate cross-section state flow is an intentional design
  (integration-style, one session evolving), not an accident to be "fixed". Preserved.
- No MoshOps contract or UI seam is touched.

## Options considered

**(a) Chapter files cut at `section()` boundaries, moved by PREFIX-MOTION — CHOSEN.**
`src/app/selftest/` gains `SelfTestSupport.h`/`.cpp` (plumbing plus a `SelfTestCtx` struct
carrying counters, session state, and the event sink), `SelfTest.Modes.cpp` (the
non-`runSelfTest` entry points), then chapter files cut at `section()` boundaries **in exact
current order**. Each PR moves only a *leading run* of sections out of `runSelfTest` into a
`runChapterX(SelfTestCtx&)` — prefix-motion — so the compiler enumerates every cross-cut local
at the cut point (an undeclared `tid` or missing lambda is a build error, not a silent semantic
change). Chosen because it is the only mechanical split where the toolchain itself proves no
state-flow was severed.

**(b) Test redesign / reordering into independent tests — REJECTED because** the state-flow is
intentional: the harness's value is one continuously evolving session. Redesign changes what is
tested, which is a different (and much riskier) project than splitting a file.

**(c) Per-domain handler/test classes — REJECTED because** the pattern is meaningless for a
harness: there is no interface to narrow, only a linear script to partition.

## Decision

Option (a): `src/app/selftest/` with `SelfTestSupport.h`/`.cpp` (+ `SelfTestCtx`),
`SelfTest.Modes.cpp` for the non-`runSelfTest` entry points, then chapter files cut at
`section()` boundaries in exact current order, moved strictly by prefix-motion into
`runChapterX(SelfTestCtx&)` functions.

## Migration / PR plan

Serial PRs (Wave 2 of the program), each: (1) support/modes extraction first, then (2..N) one
leading run of sections per PR. Change-class per
[`classify.sh`](../../scripts/auto-loop/classify.sh): `src/app/*` → **native**; full gate,
owner-merge. Each PR's review checks the moved chapter is verbatim (`--color-moved`) and the
`SelfTestCtx` additions are exactly the locals the compiler demanded.

## Verification

- **Identity oracle (the load-bearing one):** the `--selftest` stderr transcript, with timing
  lines stripped, must be **byte-identical** to the base-commit build's transcript, **×3, same
  machine** (check counts are environment-dependent, so cross-machine comparison is invalid).
  This oracle cannot pass vacuously: any dropped, reordered, or semantically-drifted section
  changes the transcript.
- **Gate lane:** full native gate per PR, built from committed source.
- **RED-proof of the oracle harness itself:** before trusting the transcript-diff script, prove
  it fails on a deliberate one-line transcript perturbation (a test that cannot fail looks
  identical to one that passes — the repo's recorded failure mode; see the vacuous-tests
  post-mortems in [`../worklog/INDEX.md`](../worklog/INDEX.md)).
- **Session isolation:** runs use `MOSH_SELFTEST_SESSION` isolation (JUCE ignores `$HOME`; two
  runs sharing a leaf delete each other's artifacts — see the SLF-CONC-001 note in the worklog).

## Status log

- 2026-07-28 — accepted (owner approved the program plan).
