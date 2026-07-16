# FS-T2 — Autosave + crash recovery

**Lane:** T (Trust — "never lose their song") · **Spec:** SPEC.md §4 T2 · **Registered bucket:**
owner-merge (backlog: `files:["src/engine/","src/app/"]`) · **First-session verdict (2026-07-12):
GAP PARTIALLY OPEN.** The autosave + JSONL-replay-recovery *core* is already built, tested, and
merged to `origin/main`. The genuine remaining work is a **narrow slice**: (1) a
relaunch-after-plugin-crash **safe mode** ("open without third-party plugins" via `block_plugin`),
(2) a **true `kill -9`, ×3-deterministic** crash-recovery gate (today's gate uses a soft `__crash`
break and runs once), and (3) a **plugin-induced-abort** recovery test. This doc registers those
against existing gates.

---

## Context

T2's acceptance (§4 T2) is: *interval snapshot + JSONL replay-from-snapshot (`mosh-log.jsonl` the
primitive); recovery prompt on unclean relaunch; save-on-quit / unsaved-changes prompt;
relaunch-after-plugin-crash additionally offers "open without third-party plugins" (safe mode) with
the suspect quarantined via the existing `block_plugin` lever.* Gates: *`kill -9` mid-edit →
recovered state matches the pre-kill snapshot+replay to the last logged command, deterministic ×3, in
a harness gate; recovery works after a plugin-induced abort; no audio-thread allocations/locks.*

Per §0 (*"Verify the gap before building it… If a gap is already closed, report and stop"*), the
first act is verification. The June-2026 `CLAUDE.md` "A1/A2/A3 hardening pass" notes claim autosave,
save-on-quit, the unclean-shutdown sentinel, and (as a **deferred** item) full JSONL-replay recovery.
Those claims were checked against the **current tree and `origin/main`** — and the A3 replay work has
since **shipped and merged**, so the deferred note is stale.

### Verification evidence (2026-07-12, current worktree == `origin/main`, byte-identical)

`git diff --stat origin/main` is **empty** for `src/moshops/MoshOps.{cpp,h}`, `src/engine/
MoshEngine.cpp`, `src/Main.cpp`, and `scripts/verify-hardware/verify.py` — everything below is
**already on `main`**, not worktree-local.

| T2 acceptance element | Status | Evidence in tree |
|---|---|---|
| Interval snapshot (autosave) | ✅ DONE | `src/Main.cpp:316-321` — GUI `AutoSaveTimer` fires every 30 s → `engine->saveIfDirty()`; `MoshEngine.cpp:372` `saveIfDirty() = dirty ? save() : false`. |
| JSONL replay-from-snapshot | ✅ DONE (dedicated `recovery-journal.jsonl`, **not** `mosh-log.jsonl` — see nuance) | `MoshOps.cpp:780-781` single journal chokepoint in `execute()` (skipped during replay); `:9250-9265` `isReplayableCommand` allowlist; `:9271-9295` `journalCommand` records assigned ids (`"r"`) for id-rebinding; `:9295-9331` `cmdRecoverSession` replays with `replayingRecovery_` guard; `MoshEngine.cpp:362` truncate-on-save. Decl `MoshOps.h:536-548`. |
| Recovery prompt on unclean relaunch | ✅ DONE | `MoshEngine.cpp:76` ctor latches `uncleanAtStartup` from the `session.running` sentinel; `MoshOps.cpp:8361-8366` snapshot exposes `recoveryAvailable`; `:9240` `recoverableCount`; UI `ui/src/ui/RecoveryNotice.tsx` (Recover → `recover_session`, Dismiss → `discard_recovery`); `types.ts:495-497`. |
| Unclean-exit sentinel | ✅ DONE | `MoshEngine.cpp:377/378` `markSessionRunning`/`clearSessionRunning`; `Main.cpp:314` mark-after-load, `:341` clear-LAST-on-clean-quit (after the final save). |
| Save-on-quit | ⚠️ PARTIAL — **silent auto-save**, not a *prompt* | `Main.cpp:340` `saveIfDirty()` on shutdown; UI advises "unsaved changes (auto-saved)" (`TopbarTools.tsx:174`, `FileOptions.tsx:101`). No modal "save before quit?" prompt. (Arguably a superset — never lose work — but the §4 wording says "prompt.") |
| Relaunch-after-plugin-crash → "open without third-party plugins" (safe mode) | ❌ **MISSING** | Only the **scan-time** dead-mans-pedal (`PluginHost.cpp:94/138`) + manual `block_plugin` (`:493`) exist. No **project-load-time** breadcrumb naming the plugin being instantiated during Edit load, and no safe-mode load path that skips third-party instantiation + quarantines the suspect. `grep` for any load-time safe-mode symbol returns nothing. |
| `kill -9` ×3-deterministic harness gate | ⚠️ PARTIAL | `verify.py:746-793` `check_crash_recovery` proves the full cross-restart replay + id-rebinding round-trip **but** (a) crashes via the `__crash` pseudo-command (`SelfTest.cpp:6197-6206` — sets the sentinel then a clean C++ `break`, **not** a real SIGKILL mid-command) and (b) runs **once** (gate.sh runs `verify.py --gate` once at `:220`; only `--selftest` runs ×3). The hermetic `--selftest` A3 section (`SelfTest.cpp:4134-4159`) covers only journal *mechanics* (allowlist + truncate-on-save), not the replay round-trip. |
| Recovery after a **plugin-induced** abort | ❌ NOT tested | No harness path exercising recovery when the crash originated in a hosted plugin. |
| No audio-thread allocations/locks | ✅ by construction (needs a written review) | `journalCommand` runs only inside `MoshOps::execute()` (message thread), never in `applyToBuffer`/RT code; the file append is off the audio path. Requires an explicit RT-safety review note in the PR per the gate. |

### Verdict: **gapExists = true** — but the lane is far smaller than its backlog `size:"L"`.

The core ("never lose their song" through autosave + JSONL replay + a recovery prompt) is **done and
merged**. Do **not** rebuild it (§0). The net-new work is the three narrow items below.

### Nuance recorded, deliberately NOT "fixed"

§4 says *"`mosh-log.jsonl` is the primitive."* The shipped design instead uses a **dedicated
`recovery-journal.jsonl`**. This is the *correct* resolution of the exact wrinkles the old A3-deferred
note flagged: `mosh-log.jsonl`'s `seq` is per-session (not monotonic) and `logLine` doesn't carry
result ids, so it can't drive id-rebinding. The dedicated journal is a **strict superset** (allowlist
of replayable commands + captured assigned ids + truncate-on-save) that makes the round-trip
deterministic. Treat §4's phrasing as directional; the primitive requirement (an append-only JSONL of
post-save mutations, replayable to the last logged command) is **satisfied**. No change warranted.

---

## Scope of THIS lane (net-new only)

1. **Plugin-crash safe mode** (primary): on relaunch after an unclean exit whose suspect was a hosted
   third-party plugin, offer **"open without third-party plugins"**; the suspect id is quarantined
   via the existing `block_plugin` lever so it is not re-instantiated.
2. **True `kill -9`, ×3-deterministic crash-recovery gate** faithful to the literal §4 gate, plus a
   **plugin-induced-abort** recovery variant.
3. **RT-safety review note** covering any engine-adjacent code touched.

**Explicit non-goals (§4 Non-goals — do NOT build):** cloud backup, project
portability/consolidation, a Recent list (only if free), out-of-process plugin hosting. Also
out-of-scope: reworking the already-merged autosave/journal/recovery-notice core.

---

## Implementation approach (guidance for the executing session — not a mandate to over-build)

Stay inside the prime directives. The safe-mode path is a **load-time policy**, and it must remain
MoshOps-mediated (one mutation seam):

- **Load-time suspect breadcrumb (mirror the scan-time dead-mans-pedal).** During project load, before
  instantiating each saved plugin, write a small breadcrumb file under `~/Library/Mosh/` (e.g.
  `session/plugin-loading.txt` naming the plugin id being brought up) and clear it after the instance
  is wired. `te::loadEditFromFile` (`MoshEngine.cpp:94/526/581`) re-instantiates saved plugins as part
  of the load, so the breadcrumb must bracket that path. If the breadcrumb survives alongside the
  `session.running` sentinel at the next launch, the named plugin is the crash suspect.
- **Safe-mode load = skip third-party plugin nodes.** Expose safe mode as an argument on the existing
  open path (e.g. `open_project`/`reload {safeMode:true}`) OR a thin dedicated MoshOps command — do
  **not** add a second load path outside MoshOps. Safe mode opens the project with third-party plugin
  nodes left un-instantiated (built-ins stay), and calls the existing `block_plugin` on the suspect so
  it stays quarantined. Prefer a pre-load `ValueTree` scrub of the plugin nodes over "load then remove"
  (loading is what crashes). Built-in Mosh plugins (spectral tap, RAVE-if-present) are NOT third-party
  and are unaffected.
- **Surface it in the recovery prompt.** Extend `RecoveryNotice.tsx` so that when the snapshot flags a
  plugin-suspected crash (a new advisory field, e.g. `session.pluginCrashSuspect`), it offers **"Open
  without third-party plugins"** alongside Recover/Dismiss. Pure UI over the snapshot+command seam; no
  Tracktion concepts leak into the frontend.
- **RT-safety.** The breadcrumb write happens on the load/message thread, never in `applyToBuffer`.
  Keep it that way; state it in the PR review note. No new locks or allocations on any RT path.

Keep the change surgical: the autosave/journal/recovery-notice core is load-bearing and must stay
byte-behaviour-stable.

---

## Gates that will PROVE this lane (reuse existing; extend, don't reinvent)

The forbidden-file rule (§0 / loop rulebook) means **`scripts/auto-loop/gate.sh` may NOT be edited.**
`gate.sh` already (a) runs `--selftest` ×3 (`run_selftest_x3`, `:63-113`) and (b) runs
`python3 scripts/verify-hardware/verify.py --gate` once (`:220`). Both `SelfTest.cpp` and `verify.py`
are editable — so all new gate coverage lands **inside those two files** and is picked up by the
existing `gate.sh` invocations with **zero rulebook edits**.

1. **`Mosh --selftest` — extend the existing A2/A3 sections** (`SelfTest.cpp:4087` A2, `:4134` A3).
   Add a **plugin-safe-mode** subsection: build an edit that references a (harness-controlled/fake or
   dead-mans-pedal-simulated) plugin, drive the load-time breadcrumb + unclean sentinel, `open_project
   {safeMode:true}`, assert the third-party node is NOT instantiated and the suspect id is on the
   `block_plugin` blocklist (`get_plugin_blocklist`), and that built-ins survive. This runs **×3
   deterministically** for free via `gate.sh run_selftest_x3` → satisfies the "deterministic ×3"
   clause hermetically. Preserve the ≈1254–1260 ×3 baseline (§0) — new checks add to it.
2. **`verify.py check_crash_recovery` — extend** (`verify.py:746-793`, already in `OFFLINE_CHECKS`).
   (a) Wrap the existing round-trip in an **internal ×3 loop asserting byte-identical recovered
   snapshots** across the three runs (faithful to "deterministic ×3" for the real replay round-trip,
   inside the file `gate.sh` already calls once). (b) Add a **plugin-induced-abort** variant: the
   crashed run's tail includes a plugin op / the suspect breadcrumb is set, and run 2 recovers to the
   safe-mode state with the suspect blocklisted. Runs under `--gate` via the existing `gate.sh:220`.
3. **True `kill -9` harness (new standalone script, faithful to the literal §4 gate).** Add
   `scripts/verify-hardware/crash_recovery_kill9.sh`: N mutations under `MOSH_RUNSCRIPT_KEEP_SESSION`,
   send a real `SIGKILL` to the `Mosh` process **mid-edit**, relaunch, `recover_session`, assert the
   recovered snapshot == the pre-kill snapshot to the last logged command; loop **×3**. This
   complements the hermetic `__crash` path with a real-signal path. It lives under `scripts/` (NOT the
   forbidden `scripts/auto-loop/`) and is owner/CI-runnable; do **not** wire it into `gate.sh`
   (forbidden) — reference it from this doc + the PR.
4. **vitest — `RecoveryNotice.test.ts`** (`ui/src/ui/RecoveryNotice.test.ts`): extend the pure
   visibility/action tests to cover the new "Open without third-party plugins" affordance. Preserve
   the ≈874 vitest baseline. `tsc` clean.
5. **Build recipe (§0):** `cmake --preset macos-arm64-release`
   `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache`
   `-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.

**Baselines to keep green (§0):** `--selftest` ≈1254–1260 ×3 deterministic, Catch2 ≈494, vitest ≈874,
Playwright e2e 125/125 (use `ui/playwright.isolated.config.ts` / port 5191 if `:5173` is owned),
`tsc` clean.

---

## Files

**Change (net-new safe-mode + gate extensions):**
- `src/engine/MoshEngine.cpp` — load-time plugin breadcrumb bracketing `te::loadEditFromFile`
  (`:94/526/581`); safe-mode load variant (pre-load third-party-node scrub); a `pluginCrashSuspect`
  accessor. (owner-merge trigger.)
- `src/moshops/MoshOps.cpp` / `.h` — `safeMode` arg on `open_project`/`reload` (or a thin dedicated
  command) that opens skipping third-party plugins + `block_plugin`s the suspect; expose
  `session.pluginCrashSuspect` in `snapshot()`. Must stay the sole mutation seam.
- `src/plugins/hosting/PluginHost.{cpp,h}` — reuse `blockPlugin`/`blocklist` for the load-time
  suspect (the lever already exists; wire the load-time producer).
- `src/app/SelfTest.cpp` — extend A2/A3 sections with the safe-mode subsection (runs ×3).
- `scripts/verify-hardware/verify.py` — ×3 wrap + plugin-abort variant of `check_crash_recovery`.
- `scripts/verify-hardware/crash_recovery_kill9.sh` (new) — true-SIGKILL ×3 harness.
- `ui/src/ui/RecoveryNotice.tsx` + `RecoveryNotice.test.ts`; `ui/src/types.ts` (add
  `session.pluginCrashSuspect?`).

**Present, load-bearing — do NOT rebuild (verified already merged):** `src/Main.cpp` (autosave timer,
save-on-quit, sentinel), the `MoshOps` journal/`recover_session`/`discard_recovery` core,
`MoshEngine` sentinel + truncate-on-save, `verify.py check_crash_recovery` base round-trip, the
`RecoveryNotice` Recover/Dismiss core.

---

## §0 rules binding this lane

- **One lane per worktree** — this session writes exactly ONE file (this plan); no code touched. The
  build lane stays scoped to autosave/crash-recovery only; do not fold in T1/T3/S work.
- **MoshOps is the sole mutation seam** — safe-mode load MUST be a MoshOps command/arg (no second load
  path); `block_plugin` (already a command) quarantines the suspect; no direct Tracktion mutation from
  UI or engine outside `execute()`.
- **One undo system** — recovery replay and safe-mode load are load-time/system operations, not user
  edits; they must not spawn a shadow UndoManager (the existing replay already routes through
  `execute()` with `replayingRecovery_`).
- **Swappable seam** — the "Open without third-party plugins" affordance is pure UI over
  snapshot+`execute_command`; no Tracktion/audio concept enters the frontend.
- **Tier wall / threading / RT-safety** — no model on the audio thread (N/A here); the load-time
  breadcrumb + journal writes stay on the message/load thread; **no allocations or locks on any RT
  path** — carry an explicit RT-safety review note in the PR (gate requirement).
- **Nothing a build reads lives under `~/Documents`** — the breadcrumb + journal + sentinel all live
  under `~/Library/Mosh/session/` (already the case for the existing sentinel/journal); keep new
  artifacts there.
- **Info.plist TCC keys intact (`MoshFixInfoPlist`)** — no packaging/plist change in this lane.
- **Do not touch parked threads** (arena/, SA3 LoRA branch, FMS spike worktrees, PROGRAM_STAGE1) —
  N/A.
- **Never edit the loop rulebook / specs 00–06 / `cmake/Dependencies.cmake` + pins / `.github/**`** —
  in particular **`scripts/auto-loop/gate.sh` is off-limits**; all new gate coverage lands in
  `SelfTest.cpp` + `verify.py`, which `gate.sh` already invokes.

---

## Merge BUCKET

**owner-merge.** The safe-mode work touches `src/engine/`, `src/moshops/`, `src/plugins/hosting/`, and
`src/app/SelfTest.cpp` (native C++, outside the safe allowlist of `ui/` + `docs/` +
`service/**.py`). Matches the backlog registration (`FS-T2 … files:["src/engine/","src/app/"]`, note
*"Touches MoshEngine → owner-merge bucket"*). Only this plan doc (`docs/first-stranger-program/lanes/`)
is safe-bucket; it merges on its own if landed separately.

---

## BLOCKED-ON-OWNER

**None hard.** §4 T2 lists no owner blocker and the backlog carries no `blockedOn`. One **owner
micro-decision** (not a blocker — proceed with the default): §4 says "save-on-quit **prompt**," but the
shipped behavior is **silent auto-save on quit** (never loses work). Default = keep silent auto-save
(superset of "prompt"; a modal that can be dismissed *loses* work, which contradicts the lane's
"never lose their song" thesis). If the owner wants an explicit unsaved-changes prompt, it is a small
UI add — record the decision; do not build the prompt speculatively.

---

## Deferred (optional, NOT required by the gate)

- **Recent-projects list** — §4 marks it "nice-to-have only if free." Not required; skip unless it
  falls out for free.
- **Reusing `mosh-log.jsonl` as the journal** — explicitly NOT done; the dedicated
  `recovery-journal.jsonl` is the better primitive (see nuance above).
- **Tightening the autosave interval / snapshot cadence** — the 30 s timer + pre-risky-op
  `saveIfDirty` already bound loss well; the JSONL replay closes the residual ≤30 s window to the last
  logged command. No change warranted.
