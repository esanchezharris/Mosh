# FIT-005: A3 full JSONL-replay crash recovery

_Execution-ready spec authored by the sprint bug-hunt/spec workflow (2026-07-10). feasible=False._

# FIT-005 — A3 full JSONL-replay crash recovery

## Verdict: ALREADY IMPLEMENTED — the lane is stale/misframed (feasible = false)

FIT-005 is **already built and merged**. It landed in **PR #246 / commit `f7e5b37c`** ("feat(robustness): JSONL-replay crash recovery + scoped snapshot invalidation + AU-scan hang guard", 2026-07-07 18:46), which is an **ancestor of this branch's HEAD** (`git merge-base --is-ancestor f7e5b37c HEAD` → yes).

The backlog entry (`docs/auto-loop/backlog.jsonl:51`, `status: "needs-human"`) and the fitness report (`docs/fitness-check/REPORT-2026-07-07.md:19`) that flag FIT-005 as open were both written **hours before** #246 merged **on the same day** (the report reconciles against `origin/main b8065d87 = #241`; #246 is later). They are stale. The report even bundles "scoped snapshot invalidation → FIT-004" and "AU-scan hang → FIT-003", and #246's own title landed all three at once.

Beyond being done, the item is also **misframed**. Its acceptance text ("replay `mosh-log.jsonl` onto the last save… resolving per-session non-monotonic seq, logLine result-id capture [broad signature change], project-switch replay target, value-based id rebinding") describes an approach that was **deliberately not taken**. The shipped design uses a **purpose-built `recovery-journal.jsonl`** that sidesteps every listed wrinkle (mapping in §1). So there is no architectural pass left to do; a session picking up FIT-005 as written would rediscover finished work.

I did find **one genuine, narrow residual defect** in the shipped implementation (nested-array id rebinding — §2/§3), which is the only actionable engineering work and is a small, auto-mergeable follow-up. The rest of this doc (a) proves done-ness with anchors so a reviewer can confirm, and (b) specs that one fix execution-ready.

---

## 1. Problem & current behavior (with code anchors)

**Goal of A3:** after an unclean exit, replay the arrangement work done *since the last save* so autosave's ≤30 s loss window (A2) tightens toward ~0. A2 (`saveIfDirty()` before crash-prone ops + the `session.running` sentinel → `wasUncleanShutdown()`) already bounds loss; A3 is the refinement that recovers the unsaved tail.

**Shipped mechanism (all in `src/moshops/MoshOps.cpp` + `src/engine/MoshEngine.cpp`):**

- **Single journal chokepoint.** `MoshOps::execute()` (`MoshOps.cpp:762-769`) wraps `executeImpl()` and, when not replaying, calls `appendRecoveryJournal(name, args, result)` — one place, so nothing can bypass it.
- **Dedicated journal, not `mosh-log.jsonl`.** `appendRecoveryJournal` (`MoshOps.cpp:9100-9110`) writes `{c: name, a: args, r: result.data}` to `recovery-journal.jsonl` — only for **successful** commands (`result.ok`) that pass an **allowlist** (`isReplayableCommand`, `MoshOps.cpp:9085-9098`). Because it captures `result.data` directly, **engine-assigned ids are journaled** — no `logLine` signature change was ever needed.
- **Allowlist (conservative).** `isReplayableCommand` covers deterministic arrangement mutations (`create_track`, `move_clip`, `split_clip`, `delete_time_range`, `set_track_volume`, `create_section`, `set_tempo`, …). It **excludes** plugin ops (the in-process-crash culprits — replaying one would re-crash), renders, recording, transport, and I/O. Unknown commands are simply not recovered.
- **Startup read + fresh start.** `initRecoveryJournal()` (`MoshOps.cpp:9069-9080`) runs from the ctor (`MoshOps.cpp:431`). If `eng.wasUncleanShutdown()` and the file exists, it reads the crashed tail into `pendingRecovery_` **before** any save can truncate it, then deletes the file to start this session fresh.
- **Snapshot surface.** `snapshot()` sets `session.recoveryAvailable = true` and `session.recoverableCount = pendingRecovery_.size()` on an unclean start (`MoshOps.cpp:8196-8199`); omitted on a clean start.
- **Replay command.** `cmdRecoverSession` (`MoshOps.cpp:9127-9168`, dispatched at `MoshOps.cpp:842`): sets `replayingRecovery_ = true` (guards re-journaling + per-command event emits), replays each entry through `executeImpl`, **halts on the first failure keeping prior recovered work**, rebinds ids via a value-based `idMap` over `idFields {trackId, clipId, newClipId, layerId, busId, groupTrackId, sectionId, annotationId}`, then `markDirty()` + `save()` to persist (which also truncates), emits `snapshot_invalidated`, and returns `{recovered, halted}`.
- **Value-based id rebinding.** `substituteRecoveryIds` (`MoshOps.cpp:9113-9126`) rewrites any **top-level string arg** whose value matches a journaled old id to its freshly-assigned new id.
- **Discard path.** `cmdDiscardRecovery` (`MoshOps.cpp:9171-9178`, dispatched at `MoshOps.cpp:843`) drops the tail.
- **Save truncation (single point).** `MoshEngine::save()` deletes `recovery-journal.jsonl` on a successful save (`MoshEngine.cpp:360-364`) — the saved edit supersedes the unsaved tail. `new_project`/reset also clears it (`MoshEngine.cpp:362-363`).
- **KEEP_SESSION test hooks.** `Main.cpp:151-156` opts a `--run-script` out of the cold-session wipe; `MoshEngine.cpp:61` uses an isolated session dir; `__crash` pseudo-command (`SelfTest.cpp:5966-5973`) sets the sentinel and stops without saving.
- **UI.** `ui/src/ui/RecoveryNotice.tsx` renders the notice from `session.recoveryAvailable`, "Recover" → `exec("recover_session")` (line 26), "Dismiss" → `exec("discard_recovery")` (line 31); `ui/src/types.ts:492-494` carries `recoveryAvailable`/`recoverableCount`.

**How each listed "wrinkle" was resolved (this is why the framing is obsolete):**

| Item's wrinkle | Shipped resolution |
|---|---|
| per-session `seq` is non-monotonic | Irrelevant — the dedicated journal is **line-ordered append**; `seq` is never consulted. |
| `logLine` doesn't carry result ids (broad signature change) | Avoided — a **separate** `appendRecoveryJournal(name,args,result)` captures `result.data` (assigned ids) at the `execute()` chokepoint. `logLine` is untouched. |
| project-switch replay target | The journal lives in the **session dir** and is **truncated on every save / new_project**, so it can only ever replay onto the last-saved edit of the current project. |
| value-based id rebinding | Implemented (`substituteRecoveryIds` + `idMap` over `idFields`), proven by `verify.py check_crash_recovery`. |

---

## 2. Proposed design (the only residual work)

There is **no A3 build left**. The single defensible follow-up is a **narrow correctness fix**:

**Defect — nested id args are not rebound.** `substituteRecoveryIds` (`MoshOps.cpp:9113-9126`) walks only **top-level string** properties. The allowlist includes **`delete_time_range`**, whose `trackIds` arg is an **array of track ids** (read at `cmdDeleteTimeRange`, `MoshOps.cpp:3686-3695`). If a crashed unsaved tail (a) creates a track, then (b) runs `delete_time_range` scoped to that session-fresh track via `trackIds: [<old id>]`, replay rebinds the new track fine but leaves the **array element unrebound** → `findTrack(<old id>)` misses → that track is silently skipped. The command still returns `ok` (it resolves whatever tracks matched, or all tracks when none match — see the `else` branch at `MoshOps.cpp:3696-3701`), so **recovery does not halt and the recovered edit is subtly wrong** (a silent under-application, which is worse than a halt).

`delete_time_range` is the **only** allowlisted command with an array-of-ids arg (`create_group_track` also takes `trackIds` but is **not** in the allowlist; `paste_clip`'s nested `clip` object carries content, not id references, and its `trackId` is top-level so it rebinds fine — `MoshOps.cpp:3791-3855`). So the fix is small and fully bounded.

**Fix:** make `substituteRecoveryIds` also rewrite **string elements inside array-valued args** (one extra branch). Keep it value-based (same idMap semantics), depth-1 arrays only (sufficient for the entire allowlist — no allowlisted command nests ids deeper). This is ~6 lines, no new command, no seam change.

---

## 3. Exact files to add/modify + shape of each change

1. **`src/moshops/MoshOps.cpp` — `substituteRecoveryIds` (~line 9113).** Add an array branch to the property loop:
   ```cpp
   for (auto& p : in->getProperties())
   {
       auto v = p.value;
       if (v.isString())
       {
           const auto s = v.toString();
           if (idMap.contains (s)) v = idMap[s];
       }
       else if (auto* arr = v.getArray())      // NEW: rebind ids nested in array args (e.g. delete_time_range.trackIds)
       {
           auto* out2 = new juce::Array<juce::var>();
           for (auto& e : *arr)
           {
               if (e.isString() && idMap.contains (e.toString())) out2->add (idMap[e.toString()]);
               else out2->add (e);
           }
           v = var (*out2); delete out2;         // or build into a local juce::Array<var> and assign
       }
       out->setProperty (p.name, v);
   }
   ```
   (Adjust to the codebase's existing `juce::var`-array idiom; the array copy must outlive the `setProperty`.)

2. **`scripts/verify-hardware/verify.py` — extend `check_crash_recovery` (~line 746).** Add to `run1`, after the `add_test_tone_clip`, a `delete_time_range` scoped to the fresh track: `{"command": "delete_time_range", "args": {"trackIds": ["${B}"], "start": 0.0, "end": 0.5}}`. Assert post-recover that the deletion applied to the *recovered* Beta (e.g. Beta's clip is trimmed/removed as expected), proving array-element rebinding. Without the fix this assertion fails (the deletion silently no-ops on the rebound track).

3. **`src/app/SelfTest.cpp` — A3 mechanics section (~line 3903).** Add a focused unit assertion that `substituteRecoveryIds({trackIds:[OLD]}, {OLD→NEW})` yields `{trackIds:[NEW]}`. (This needs a tiny test seam: either a `friend`-accessible call or a `__test_substitute_recovery_ids` run-script directive; prefer asserting behavior end-to-end in verify.py per item 2 and keep selftest to the existing allowlist/truncate mechanics if adding a seam is undesirable.)

4. **`docs/auto-loop/backlog.jsonl:51` — bookkeeping (required regardless of the fix).** Flip FIT-005 to `status: "landed"` (or remove), noting "landed in #246 `f7e5b37c`; framing superseded by the dedicated `recovery-journal.jsonl` design." Same for **FIT-004** (scoped snapshot invalidation) and **FIT-003** (AU-scan hang) if their entries are likewise stale — all three shipped in #246.

No changes to `src/state/`, plugins/hosting, deploy, or CI.

---

## 4. Commands/contracts affected (additive?)

**None new.** `recover_session` and `discard_recovery` already exist and are in the mock (`ui/src/bridge.mock.test.ts:25-26`) and contract surface. The fix is **purely internal** to `substituteRecoveryIds` — no arg-shape, snapshot, or event change. Fully backward-compatible; a journal written pre-fix replays correctly post-fix (the array branch only *adds* rebinding).

---

## 5. Test plan

- **verify.py `check_crash_recovery`** (`scripts/verify-hardware/verify.py:746`): extend as in §3.2. Concrete assertions: `before_tracks == 1`, `recoveryAvailable`, `after_tracks == 2`, `recovered_cmds >= 3` (now includes `delete_time_range`), and **the recovered Beta reflects the time-range deletion** (e.g. `beta_clips == 0` or the clip length shortened) — the new assertion that RED-proves the bug pre-fix.
- **`--selftest` A3 mechanics** (`SelfTest.cpp:3903-3931`): unchanged assertions must still pass (`journal empty after save`, `replayable journaled`, `non-replayable NOT journaled`, `save truncates`). Optionally add the direct `substituteRecoveryIds` array assertion (§3.3). Run `--selftest` ×3 for determinism; the count only moves if a check is added.
- **Regression guard, `--selftest` A2** (`SelfTest.cpp:3864-3866`): clean start still omits `recoveryAvailable`.
- **vitest**: `ui/src/ui/RecoveryNotice.test.ts` unchanged (no UI change).
- **No py-golden / no new C++ test file needed** (behavioral coverage lives in verify.py, which is the harness that already owns cross-restart replay).
- **Determinism / RED-first**: land the extended verify.py check first and confirm it FAILS on current `main` (proving the defect is real), then apply the `substituteRecoveryIds` fix and confirm GREEN.

---

## 6. Risks & seam concerns

- **Hard-excluded seams:** the fix touches **`src/moshops/MoshOps.cpp`** (MoshOps command layer) — a sensitive engine-adjacent seam, so per repo policy this wants **human review** even though the change is tiny. It does **not** touch `src/state/`, `src/engine/MoshEngine.*` (the truncation/sentinel already correct), plugins/hosting, deploy, or CI.
- **Blast radius:** `substituteRecoveryIds` runs **only** during `cmdRecoverSession` (never in the hot path), so a regression can only affect crash-recovery replay, which is covered by verify.py.
- **Correctness nuance:** keep the rebinding **value-based and depth-1**. Do not recurse into nested objects speculatively — no allowlisted command needs it, and over-generalizing risks rewriting a coincidental string that equals an old id inside unrelated payloads (the existing top-level code already accepts that small risk by design; match it, don't widen it).
- **Alternative (equally valid):** if the owner judges the `delete_time_range` array case too rare to fix, the correct disposition is **close FIT-005 as landed and do nothing else** — A2 autosave + the existing top-level rebinding already bound loss, and the defect only bites a specific create-then-range-delete-on-fresh-track-in-one-crash sequence.

---

## 7. Acceptance criteria

Given the verdict, acceptance is one of:

**(a) Close-out only (recommended minimum):** `backlog.jsonl` FIT-005 marked landed with the #246 anchor; no code change. Confirmed by: the anchors in §1 exist on HEAD and `--selftest` A3 + `verify.py check_crash_recovery` are green as-is.

**(b) Close-out + residual fix:** all of (a), plus: extended `verify.py check_crash_recovery` **RED on `main`, GREEN after** the `substituteRecoveryIds` array branch; a `delete_time_range` scoped to a session-fresh track id correctly applies to the recovered track after replay; `--selftest` ×3 deterministic (A2/A3 sections unchanged); vitest unchanged.

---

## 8. Rough size & mergeability

- **Close-out only:** **XS**, auto-mergeable (docs/backlog only).
- **Residual fix (§2/§3):** **S** (~6 LOC in one function + one verify.py case). Auto-mergeable *by CI/gate criteria*, but because it edits `src/moshops/`, **treat as needs-human** per the MoshOps-seam review convention (the backlog already tags FIT-005 "human review (engine seam)").
- The **original L-sized "architectural pass"** the backlog scopes is **not real** — that work shipped in #246.
