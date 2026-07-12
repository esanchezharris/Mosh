# FS-T3 — Project-file schema versioning (prereq for S1/S2)

**Lane:** T (Trust) · **Spec:** SPEC.md §4 T3, hard-sequenced by §1.6 (T3 → S1/S2) · **Registered
bucket:** owner-merge (touches `src/state/`) · **First-session verdict (2026-07-12):
GAP ALREADY CLOSED — no code change warranted. This doc is the verification record + the
S1/S2 "how to bump" handoff runbook.**

---

## Context

T3 is the **prerequisite** for the two session lanes: §1.6 states *"Schema versioning lands BEFORE
any new multiplayer/session state fields"*, and the T3 gate ends *"MUST merge before S1/S2 add state
fields."* So the only question this first session must answer is: **is a proven, tested
forward-migration + newer-file-refusal mechanism already merged to `main`, ready for S1/S2 to bump
when they add fields?**

Per §0 (*"Verify the gap before building it… Some repo docs are stale… If a gap is already closed,
report and stop — don't rebuild it"*), the first act is verification, not building. The June-2026
"A1 hardening pass" working note in `CLAUDE.md` claims this machinery already shipped. That claim was
checked against the current tree and `origin/main`.

### Verification evidence (2026-07-12, current tree + `origin/main`)

Every FS-T3 acceptance bullet is satisfied by **already-merged, already-tested** code:

| Acceptance bullet | Status | Evidence in tree |
|---|---|---|
| Version int in project/session state | ✅ present | `src/state/Migrations.h:26` `kMoshFormatVersion = 1`; `ids::moshFormatVersion` stamped on the `MOSH_PROJECT` node (`Ids.h:37`). The session persisted at `~/Library/Mosh/session/` **is** this `.tracktionedit`, so "project" and "session" state are the same versioned node — no second unversioned schema exists. |
| Forward-migration scaffold (vN reads vN-1) | ✅ present | `migrations()` registry (`Migrations.h:70`) — ordered, contiguous `v(N)→v(N+1)` `MigrationStep`s, applied by `migrateOrRefuse()` (`Migrations.h:98`). Ships **one real illustrative `v0→v1` step body** (`ensure MOSH_PROJECT exists`), so the hook is proven to *execute a transform*, not just re-stamp. |
| Refuse-with-message on unknown future versions | ✅ present | `migrateOrRefuse()` returns `{ok:false, error:"…made by a newer version of Mosh than this build (v1). Please update Mosh to open it."}` when `fileV > kMoshFormatVersion` (`Migrations.h:103-110`); the tree is left untouched on refusal. |
| vN opens a vN-1 fixture via migration | ✅ proven end-to-end | `src/app/SelfTest.cpp:4066-4077` `PRJ-FMT` — saves a real `.tracktionedit`, **strips `moshFormatVersion` to synthesize a v0/legacy file**, `open_project`, asserts it is accepted and migrated forward to current. Unit-level: `tests/test_migrations.cpp:15` (absent version ⇒ v0 ⇒ migrates to current) + `:67` (the `v0→v1` step body actually ran). |
| Synthetic v(N+1) file fails safely w/ clear message | ✅ proven end-to-end | `SelfTest.cpp:4052-4065` — fabricates a newer file (`moshFormatVersion = current+1`), `open_project` **REFUSES**, error names a newer Mosh version, and the **current project stays loaded** (`eng.editFile() == origFile`). Unit-level: `test_migrations.cpp:40` (refusal + sentinel property survives untouched). |
| Selftest coverage | ✅ present | `PRJ-FMT` section in `--selftest` (`SelfTest.cpp:4030-4081`) + 5 Catch2 cases tagged `[migrations]` wired into `MoshTests` (`tests/CMakeLists.txt:14`). |

**Merged to `main`:** `git cat-file -e origin/main:src/state/Migrations.h` and
`…:tests/test_migrations.cpp` both succeed; the worktree copies are byte-identical to `origin/main`
(empty `git diff --stat`). The load-time gate is wired at **all three** `MoshEngine` load sites
(`MoshEngine.cpp:96` launch-Edit, `:527` `openProject`, `:582` `reload`) and the stamp is written on
every save (`:354`).

### Verdict: **gapExists = false.**

The mechanism T3 was asked to build is present, tested (unit + selftest, deterministic), merged to
`main`, and correctly ordered ahead of S1/S2. **S1/S2 are unblocked on the T3 dependency today.**
No `src/state/` change is warranted; rebuilding it would violate §0.

### One literal-wording nuance (deliberately NOT actioned)

The acceptance says *"opens a **committed** vN-1 fixture."* The shipped selftest **fabricates** the
legacy file at runtime (strips the version attribute from a freshly-saved edit) rather than checking
in a static on-disk fixture. This exercises the **identical** migration path, and a runtime-synthesized
fixture **cannot rot** as the `.tracktionedit` format evolves (a checked-in binary fixture would need
regenerating whenever Tracktion's own edit format changes). This is a test-methodology preference,
**not a capability gap** — the migration path is already proven end-to-end. Adding a frozen fixture is
optional low-value hardening; see "Deferred" below. It is not required to satisfy the gate or to
unblock S1/S2, so under §0 ("don't rebuild it") it is **not** done here.

---

## Gates that ALREADY prove this lane (reuse — do not invent new ones)

No new gates. The existing, deterministic gates below are the proof; the merge sequencing guarantee
they must uphold is that they **stay green as S1/S2 bump the version**:

1. **`Mosh --selftest` `PRJ-FMT` section** (`SelfTest.cpp:4030`) — 10 checks: save stamps current;
   version survives save+reload; synthetic v(N+1) refused with a clear message + current project
   kept; legacy (v0) file migrated forward on `open_project`. Part of the ≈1254 ×3-deterministic
   baseline (§0).
2. **Catch2 `[migrations]`** (`tests/test_migrations.cpp`, 5 cases) — engine-free unit coverage of
   `readFileVersion` / `stampFormatVersion` / `migrateOrRefuse`: v0→current, equal-version no-op,
   newer-version refusal (tree untouched), **registry contiguity invariant** (`0..current`
   unbroken), and the illustrative step body executing. Part of the Catch2 ≈494 baseline.
3. **Build recipe (§0):** `cmake --preset macos-arm64-release`
   `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache`
   `-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.

`Migrations.h` is header-only + `juce_data_structures`-only (engine-free), so the Catch2 layer runs
with zero engine dependency — the cheap gate for any future bump.

---

## Files (present; NO change in this lane)

- `src/state/Migrations.h` — the registry + `migrateOrRefuse` + stamp (the single hook).
- `src/state/Ids.h:37` — `moshFormatVersion` id.
- `src/engine/MoshEngine.cpp` — load-time gate at 3 sites + save-time stamp.
- `src/app/SelfTest.cpp:4030` — `PRJ-FMT` selftest section.
- `tests/test_migrations.cpp` + `tests/CMakeLists.txt:14` — Catch2 `[migrations]`.

---

## §0 rules binding this lane

- **One lane per worktree** — this session writes exactly ONE file (this plan); no code touched.
- **MoshOps is the sole mutation seam** — the load-time migration runs on the freshly-loaded Edit's
  `state` **before** `wireEditResolvers` and before any snapshot/command; save-time stamp rides the
  existing `save` path. No new mutation seam introduced. When S1/S2 add a migration step, it must be
  a **pure `ValueTree` transform** in `migrations()` — never a MoshOps command replay.
- **Nothing a build reads lives under `~/Documents`** — N/A (no new caches/artifacts).
- **Info.plist TCC keys intact (`MoshFixInfoPlist`)** — N/A (no packaging/build change).
- **Do not touch parked threads** — N/A.
- **Never edit the loop rulebook / specs 00–06 / `cmake/Dependencies.cmake` / `.github/**`** — this
  lane touches none of them.

---

## Merge BUCKET

**safe** — the sole artifact is this docs-only closure record (`docs/first-stranger-program/lanes/`),
which is within the safe allowlist (`docs/`) and carries no `ownerMerge` flag.

> Note on the registered bucket: `backlog.jsonl` marks FS-T3 **owner-merge** because the *lane* is
> scoped to `src/state/`. That routing is correct **for a code change** — but this session's finding
> is that **no code change is warranted** (gap closed). The only thing that merges is this doc. If the
> owner ever elects the optional hardening below, that touches `tests/` + `src/app/SelfTest.cpp`
> (outside the safe allowlist) and **routes owner-merge** as originally registered.

## BLOCKED-ON-OWNER

**None.** T3 has no owner blocker, and its own deliverable is complete/merged. Downstream: **FS-S1 /
FS-S2 are no longer blocked on T3** (`backlog.jsonl` lists S1 `blockedOn: FS-T3,FS-S0,O4` and S2 on
`FS-T3,FS-S0`; the T3 leg is satisfiable now — S0/O4 remain their own blockers).

---

## Handoff runbook — how S1/S2 bump the format (the real value of this doc)

This is the pattern S1/S2 (and any future state-adding lane) MUST follow so the machinery keeps
working. It is the reason §1.6 sequences T3 first.

**When you add / rename / restructure a Mosh-owned `ValueTree` node or property that an older reader
would misread:**

1. **Bump** `kMoshFormatVersion` (`src/state/Migrations.h:26`) from `N` to `N+1`.
   - *Adding a NEW optional property with a safe absent-default does NOT require a bump* (see the
     header comment at `:21-25`) — e.g. R2 content-hash fields that default absent can ride the
     existing "additive optional node ⇒ no format bump" rule (same precedent as `MOSH_LYRICSHEET`).
     Only a **breaking/forward-incompatible** change needs a bump.
2. **Append** a migration step to `migrations()` (`:70`): `{ N, N+1, "vN->vN+1: <what>", fn }` where
   `fn` is a **pure `ValueTree& editState` mutation** of Mosh-owned nodes (no engine, no MoshOps, no
   audio-thread work). The contiguity invariant (`test_migrations.cpp:55`) will FAIL the build if the
   chain `0..current` is broken — this is the tripwire that forces step-and-bump to move together.
3. **Freeze a vN fixture BEFORE the bump.** The cleanest way (matching the current selftest idiom):
   in the `PRJ-FMT` selftest, save an edit **at the old schema**, then assert `open_project` migrates
   it to `N+1` and the migrated node has the new shape. If a **committed** on-disk fixture is
   preferred, land it under `tests/golden/` (an existing golden dir) and read it in the migration
   test — but keep the runtime-synthesized path too, since it can't rot.
4. **Extend the gates** (do not add new ones): one `PRJ-FMT` selftest check that the vN→v(N+1)
   transform produces the expected new-shape node, plus one Catch2 `[migrations]` case for the new
   step body (RED-prove it by asserting the pre-migration shape is absent).
5. **Update `kSnapshotSchemaVersion`** (`:32`) **only** if the change also alters the C++→UI snapshot
   wire-contract (a *different* concern: file-format mismatch = refuse-to-open; snapshot mismatch =
   advise-to-update). Mirror it in `ui/src/types.ts` `EXPECTED_SNAPSHOT_SCHEMA` if so.

**Invariant to preserve:** on-disk files are always stamped current (save-time stamp), the load-time
gate refuses strictly-newer files with a user-legible message and keeps the current project loaded,
and the migration registry is a contiguous `0..current` chain. S1/S2 must not weaken any of these.

---

## Deferred (optional, owner-merge, NOT required by the gate)

- **Committed on-disk vN-1 fixture** under `tests/golden/` to match the acceptance's literal
  "committed fixture" wording. Value: catches a regression against a frozen artifact. Cost: must be
  regenerated when Tracktion's own edit format changes; the runtime-synthesized path already proves
  the same migration. Do this only if the owner wants the literal wording honored; it routes
  owner-merge (`tests/` + `src/app/SelfTest.cpp`).
