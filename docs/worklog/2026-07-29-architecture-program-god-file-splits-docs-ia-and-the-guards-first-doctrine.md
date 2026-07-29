# The architecture program — god-file splits, a docs IA, and the guards-first doctrine (2026-07-29)

An overnight architecture-improvement pass run as fanned-out agent waves: explore → design →
implement in isolated worktrees → hostile review → local gate → merge or route to the owner.
Method vocabulary is Ousterhout's (deep modules: small interfaces hiding large implementations);
the go-forward decisions live in [`docs/rfc/`](../rfc/INDEX.md), which this program also created.

## What landed on main (14 PRs)

**Docs information architecture** — one obvious place per kind of truth. `docs/CURRENT_STATUS.md`
is now the single rolling status doc (#492); `docs/PROGRESS.md` is retired with a pointer, and the
fitness-check probe that measured its staleness was repointed at `docs/worklog/` freshness so the
weekly audit doesn't flag forever (#490); the worklog INDEX was repaired (+2 missing notes) and is
now guard-enforced by a vitest that runs in every gate (#486); `ARCHITECTURE.md` absorbed everything
since 2026-07-07 with every claim re-measured or cited (#503); `docs/rfc/` exists with RFCs 001–005
(#487, #496).

**UI structure** — `Rack`/`GenDrawer` extracted out of the classic-named `Dock.tsx` so that file
leaves the v2 module graph (#494); PluginBrowser's duplicated entry-dispatch and height effect
deduped (#491); the store's 16 event-rail handlers extracted to `store/events.ts` (#493) and the
store then composed from `telemetry`/`mp`/`jobs`/`catalogs` slices with **no consumer import
changed** (#498). A classic-shell audit (#495) inventoried what classic uniquely still provides —
the answer is views and gestures, not commands, since the reachability ratchet is at 0 — and RFC
005 frames the freeze-vs-port decision for the owner.

**Infrastructure** — the native gate now de-symlinks `ui/node_modules` before building (#504),
after the same failure hand-healed three times in one night; and an e2e spec that had been failing
about one run in six under load was root-caused to a real 2.6s drawer auto-collapse race rather
than retried away (#499).

## What is queued for the owner (byte-proven, gated, hostile-reviewed)

`MoshOps.cpp` **12,049 → 2,453 LOC** across three motion PRs (#501, #502, #506) on top of the
guards PR (#489), plus the SelfTest split (#507 scaffolding, #508 chapters 1/2) and the manifest
corrections (#505). Merge order matters and is recorded on each PR.

## The doctrine that made it safe

**Guards first.** Three tests parse the god-files by literal path —
`ui/src/agent/commands.contract.test.ts`, `tests/test_multiplayer_lock_manager.cpp`, and
`scripts/daw-conformance/coverage_check.py`. Splitting the files without touching them first would
have either reddened the gate or, worse, silently degraded a guard while looking green. So the
first native PR made all three glob-aware as a **provable no-op** (the globs matched exactly the
one old file), and added a 209-row golden lock-scope ledger whose review *is* the classification
audit. A new MoshOps command now needs **four** registrations, not three.

**Identity oracles, not opinions.** Every motion PR had to produce a `Mosh --selftest` tally
identical to the base commit's on the same machine, three runs (2037/2037 every time). For the
SelfTest split — where the harness is the thing being moved — the oracle is stronger: the full
stderr transcript, normalized only for timing values, pid/tid and the per-run session leaf, must be
**byte-identical** to a base-branch build's transcript. That oracle was itself RED-proven against a
one-line perturbation before being trusted.

**Hostile review as a first-class stage.** Every PR got a reviewer whose instruction was to refute
it, not bless it. They earned it: one caught that a helper had been promoted to a shared header
despite having exactly one real consumer (its other two "uses" were comments) — a violation of the
PR's own stated promotion rule, fixed at the stack tip. Another rebuilt a guard in an isolated
mirror and sabotaged it five ways, two of which the implementer hadn't claimed. A third flagged
that a transcript oracle described in prose isn't evidence, so the normalization patterns are now
attached to the PR verbatim.

## Things that were true yesterday and are not true today

- CLAUDE.md's gotcha said an unclassified command means **unguarded** in a session. The code says
  otherwise: `LockManager.cpp:108` fails **closed** to `SessionGlobal`. A written reason is a claim
  about the code, and this one had aged wrong — in the very file that warns about exactly that.
- Nine of the old `UI_REACH_GAPS` entries described assumptions rather than the tree; the same class
  of drift appeared here in a stale `PluginBrowser.tsx` header comment claiming a shared surface
  that v2 does not use, and in an e2e helper doc-comment naming the wrong default shell.
- `ui/src/v3` does not exist on main — that lane lives only on an unmerged branch
  (`claude/daw-ui-upgrade-317ab2`), parked by the owner on 2026-07-16.

## Cost notes for the next pass

The e2e suite flakes one random spec under concurrent native-build load (five instances in one
night, five different specs, always 255/256, always green standalone). The merge driver's policy —
retry a prepare **only** when the sole failing gate step is `e2e`, so a real regression still fails
all three attempts — kept the queue moving without weakening it; #499 fixes the worst offender for
real. Two other traps cost real time: the native build runs `npm install` inside CMake, which
destroys a worktree's `node_modules` symlink (now self-healed by #504), and `merge-one.sh` invokes
scripts from the **main seat's working tree**, so a just-merged gate fix stays inert until someone
pulls the seat.
