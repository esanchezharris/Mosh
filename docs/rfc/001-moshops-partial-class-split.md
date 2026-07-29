# RFC 001 — MoshOps partial-class file split

- **Status:** accepted
- **Decided:** 2026-07-28 (owner approved the program plan)

## Problem

[`src/moshops/MoshOps.cpp`](../../src/moshops/MoshOps.cpp) is a 12,049-LOC, 209-command
god-file. The dispatch if-chain in `executeImpl` (~lines 1056–1305) is fine; the problem is
everything after it — every `cmd*` body for every domain (lyrics, notes, clips, tracks, tempo,
plugins, mixer, generative, multiplayer, project I/O) lives in one translation unit. Consequences
observed in practice:

- Every command change recompiles the whole TU (it is the slowest single TU in the app build).
- Concurrent lanes collide on the same file constantly — the same hotspot dynamic the repo
  already partitioned `shell.css` for.
- Review diffs on unrelated commands interleave in one file, defeating `--color-moved` and
  making motion vs. mutation hard to distinguish.

[`src/moshops/MoshOps.h`](../../src/moshops/MoshOps.h) shows the class holds essentially one
shared private estate (engine, pluginHost, jobManager, lockManager, pendingSwaps, ~50 helpers) —
which constrains which split shapes are honest (see Options).

## Invariants touched

- **One mutation path** (prime directive): preserved **by construction** — `beginTxn` /
  `logLine` / `okResult` / `emit*` stay in `MoshOps.cpp`; every moved `cmd*` body still routes
  through them. No new mutation entry point exists after the split.
- **MoshOps command surface** ([`../02_MOSHOPS_CONTRACT.md`](../02_MOSHOPS_CONTRACT.md)):
  byte-unchanged. `executeImpl` and its if-chain do not move or change.
- **External parsers of the dispatch site** — three tools parse `MoshOps.cpp` textually:
  [`ui/src/agent/commands.contract.test.ts`](../../ui/src/agent/commands.contract.test.ts),
  [`tests/test_multiplayer_lock_manager.cpp`](../../tests/test_multiplayer_lock_manager.cpp),
  [`scripts/daw-conformance/coverage_check.py`](../../scripts/daw-conformance/coverage_check.py).
  A-PR0 makes them glob-aware *first*, so the split cannot silently blind them.

## Options considered

**(a) Partial-class file split — CHOSEN.** Same `MoshOps` class; `cmd*` bodies move **verbatim**
to per-domain TUs: `MoshOps.Lyrics.cpp`, `MoshOps.Notes.cpp`, `MoshOps.Clips.cpp`,
`MoshOps.Tracks.cpp`, `MoshOps.TempoProject.cpp`, `MoshOps.Plugins.cpp`, `MoshOps.Mixer.cpp`,
`MoshOps.Generative.cpp`, `MoshOps.Multiplayer.cpp`, `MoshOps.ProjectIo.cpp`. The `executeImpl`
if-chain stays byte-identical in `MoshOps.cpp`. Anonymous-namespace helpers needed across TUs are
promoted to a private `MoshOpsInternal.h` as `inline`. Chosen because it has the highest
diff-reviewability (`git diff --color-moved` shows pure motion), zero linkage-visible change
(same class, same symbols' semantics), and the single mutation path is preserved by construction
since the transaction/log/result/emit plumbing never leaves `MoshOps.cpp`.

**(b) Table-driven dispatch — REJECTED because** it is not code motion: the 16
`broadcastStructuralIfActive`-wrapped entries and the `MOSH_HAVE_ANIRA` block force lambdas into
the table (a real semantic surface, not a mechanical rewrite); it breaks all three external
parsers named above *in the same PR* as the risk they exist to guard; and the if-chain is already
hidden behind `execute()`, so a map adds indirection without removing any depth a caller can see.

**(c) Per-domain handler classes — REJECTED because** `MoshOps.h` shows the handlers would share
essentially the entire private estate (engine, pluginHost, jobManager, lockManager, pendingSwaps,
~50 helpers). A handler context object widens the interface instead of narrowing it —
pass-through shallow modules, the Ousterhout anti-pattern.

## Decision

Option (a): partial-class file split, pure verbatim motion of `cmd*` bodies into the ten
per-domain TUs, `executeImpl` untouched, cross-TU anonymous-namespace helpers promoted to a
private `MoshOpsInternal.h` as `inline`, all transaction/log/result/emit plumbing remaining in
`MoshOps.cpp`.

## Migration / PR plan

1. **A-PR0 — guards first.** Make the three external parsers glob-aware
   (`src/moshops/MoshOps*.cpp`), proven a no-op against the current single file. Change-class per
   [`classify.sh`](../../scripts/auto-loop/classify.sh): touches `ui/` + `tests/` + `scripts/` →
   **native** (tests are outside the cheap set), owner-merge per program routing.
2. **Three motion PRs**, each moving a batch of domains: 12k → ~9k → ~5.5k → ~2.5k LOC remaining
   in `MoshOps.cpp`. Change-class: `src/moshops/*` → **native**; full-gate, owner-merge.
   **Rule per PR:** `git diff` on `MoshOps.cpp` shows **zero dispatch-line changes** — deletions
   of moved bodies only.

## Verification

- **Gate lane:** full native gate per PR (build from committed source — never verify a native
  change with a pre-existing binary).
- **Oracles:**
  - `Mosh --selftest` **×3**, tallies equal to a base-commit build **on the same machine**
    (counts are environment-dependent, so same-machine base comparison is the oracle — never an
    absolute number).
  - `coverage_check.py`, model lint, and `commands.contract.test.ts` green after A-PR0 and after
    every motion PR — these are the drift guards that would catch a body lost in motion.
  - `git diff --color-moved` review per motion PR: every hunk is a move, no hunk is an edit.
- **RED-proofs (A-PR0):** each glob-aware parser is sabotaged (e.g. a command body hidden in a
  file the glob misses) and must go red naming the gap; sabotage with absolute paths, verify the
  restore, `grep SABOTAGE` before landing.

## Status log

- 2026-07-28 — accepted (owner approved the program plan).
- 2026-07-29 — implementation gated + hostile-reviewed, **queued for owner merge**: #489 (guards, no-op globs + golden ledger) → #501 (Lyrics/Notes) → #502 (Clips/Tracks/TempoProject) → #506 (Plugins/Mixer/Generative/Multiplayer/ProjectIo). `MoshOps.cpp` 12,049 → **2,453 LOC**; every motion PR byte-proven and selftest-oracle green ([2037,2037,2037] == base each time). Two RFC deviations recorded by the implementers: undo/redo/batch stay in the core, and the ~694-LOC MIDI/beat lane stays too (this RFC assigned it no TU). Review nits deferred to the post-merge follow-up (see [POST-MERGE.md](POST-MERGE.md)): a `DrumPattern.h` comment still points `kDefaultKit` at `MoshOps.cpp`, `MoshOpsInternal.h`'s comment over-generalizes why `isSerumPlugin` was promoted, and `MoshOps.cpp` keeps includes that may now be dead (deletion-only discipline left them).
