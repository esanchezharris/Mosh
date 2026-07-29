# RFC 003 — Lock-scope golden ledger

- **Status:** accepted
- **Decided:** 2026-07-28 (owner approved the program plan)

## Problem

[`LockManager::classify`](../../src/multiplayer/LockManager.cpp) decides which multiplayer lock
scope guards each MoshOps command. Exhaustiveness is enforced by a drift guard in
[`tests/test_multiplayer_lock_manager.cpp`](../../tests/test_multiplayer_lock_manager.cpp)
(AL-011): every dispatched command must be classified or reasoned-allow-listed — 209 = 170 + 39
today. But only ~61 spot assertions pin **which** scope a command gets; the other ~150
classifications could silently flip scope without any test noticing. Worse, the documentation
disagrees with the code: CLAUDE.md's gotcha claims "unclassified means unguarded", while
`LockManager.cpp:108` actually fails **CLOSED** to `Scope::SessionGlobal` ("guarded until
deliberately classified"). A written reason is a claim about the code, and this one aged wrong —
exactly the class of drift a golden ledger makes impossible.

## Invariants touched

- **Multiplayer lock discipline** (the AL-011 drift guard): strengthened from "every command is
  *some* scope" to "every command is *this* scope, pinned".
- **The three-registrations rule for a new MoshOps command** (dispatch + agent
  catalog/classification + lock scope) becomes a **FOURTH registration**: the golden row. This is
  deliberate — the added friction *is* the review point.
- No runtime behaviour changes; `classify()` itself is untouched.

## Options considered

**(a) Committed golden ledger + row-by-row assertion — CHOSEN.** A committed
`tests/golden/lock_scopes.tsv` (209 rows, `command TAB scope`) plus a Catch2 test asserting
`classify()` row-by-row **and** row-set == extracted dispatch set, **both directions** (no golden
row without a dispatched command; no dispatched command without a golden row). The test lives
*inside* the existing `test_multiplayer_lock_manager.cpp` because `tests/CMakeLists.txt` is on
the exclusion list in [`classify.sh`](../../scripts/auto-loop/classify.sh) — extending an
existing TU needs no build-file change. Chosen because the PR review of the 209 rows —
especially the ~77 `Unguarded` ones — **is** the classification audit, and every future scope
change becomes a visible diff on a reviewable file.

**(b) More spot assertions — REJECTED because** spot coverage is exactly what allowed the
current gap: ~61 of 209 pinned, and nobody can see which 148 are not.

**(c) Fix only the CLAUDE.md wording — REJECTED because** it corrects the stale claim but pins
nothing; the next scope flip is still silent. (The wording still gets fixed, in the program's
docs lane — it is necessary, not sufficient.)

## Decision

Option (a): commit `tests/golden/lock_scopes.tsv` with all 209 `command TAB scope` rows; add a
Catch2 test inside `test_multiplayer_lock_manager.cpp` asserting `classify()` matches every row
and that the row set equals the extracted dispatch set in both directions, with a >150-row floor
so a broken extractor cannot pass by extracting almost nothing. A new command now requires a
fourth registration: its golden row.

## Migration / PR plan

One PR. Change-class per [`classify.sh`](../../scripts/auto-loop/classify.sh): touches `tests/`
(not in the cheap set) → **native**; full gate; owner-merge per program routing. The PR
description must call out the ~77 `Unguarded` rows explicitly so the review is the audit, not a
rubber stamp.

## Verification

- **Gate lane:** full native gate (Catch2 target), built from committed source.
- **RED-proofs (both mandatory, absolute-path sabotage, restore verified, `grep SABOTAGE`
  before landing):**
  1. **Flip one row** in `lock_scopes.tsv` — the test must fail **naming that command** (not a
     generic count mismatch).
  2. **Bogus extractor path** — point the dispatch-set extraction at a wrong/empty source; the
     >150-row floor must trip. This proves the both-directions set comparison cannot be satisfied
     by an extractor that silently returns nothing (the vacuous-verification failure mode this
     repo has shipped before).
- **Oracle:** the committed TSV itself — human-reviewed once, then any change is a diff a
  reviewer sees.

## Status log

- 2026-07-28 — accepted (owner approved the program plan).
