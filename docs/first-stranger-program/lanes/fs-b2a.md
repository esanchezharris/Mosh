# FS-B2a — Turn provenance in `mosh-log.jsonl` (the ask, not just the commands)

**Lane:** B (Brain/skills) · **Prereq for:** FS-B2 real-session skill mining · **Registered
bucket:** owner-merge (touches `src/app/SelfTest.cpp`) · **First-session verdict (2026-07-28):
GAP PARTIALLY CLOSED — the seam exists and is committed; three real holes remain. Do not rebuild
the seam.**

---

## Context

The task as briefed: *"`mosh-log.jsonl` records every MoshOps command but never records what the
user ASKED for… Fix the log so the ask is recoverable."*

Per SPEC §0 (*verify the gap before building it*), the first act was verification, not building.
**The mechanism the brief asks for is already merged.** The briefed evidence — 2,840 records whose
top-level key set is exactly `{ts, seq, command, args, ok, undoable, error}` — is accurate but does
not say what it looks like it says: `args` is a top-level key, and the utterance rides *inside*
`args` on `batch_begin`. That session's log has **zero** `batch_begin` lines
(`grep -c '"batch_begin"' ~/Library/Mosh/session/mosh-log.jsonl` → `0`), i.e. the agent path was
never exercised in it. It is a log of direct manipulation and harness runs, which is exactly what
an honest log of direct manipulation should look like.

### Verification evidence (2026-07-28, current tree)

| Briefed requirement | Status | Evidence |
|---|---|---|
| Utterance arrives through the command envelope, not a side channel | ✅ present | `ui/src/agent/executor.ts:118-123` puts `turn_id` / `utterance` / `source` in `batch_begin`'s args; `ui/src/agent/loop/taskExec.ts:80-85` does the same for the agentic loop. |
| Written by `MoshOps::execute`'s JSONL path | ✅ present | `MoshOps::cmdBatchBegin` (`src/moshops/MoshOps.cpp:4189`) calls `logLine("batch_begin", args, …)`, and `logLine` (`:11884`) stores `args` **verbatim**. No new command, no second log. |
| Rides the existing `batch_begin`/`batch_end` markers (no new command) | ✅ present | No new MoshOps command exists or is needed — so the three-registration rule (dispatch / AL-011 lock scope / catalog-or-classification) does not apply. `batch_begin`/`batch_end` are already registered in all three (`LockManager.cpp:35`, `commandClassification.ts:42-43`). |
| Absent for direct UI actions | ✅ present | A drag/trim/mixer move never calls `runAgentBatch`, so it never emits a marker. |
| Consumer exists | ✅ present | `ui/src/harvest/harvester.ts` groups a turn as the span between a `batch_begin` carrying `turn_id` and its `batch_end`; `liveHarvest.ts` reports per-turn by utterance. |
| Telemetry does not widen | ✅ present | `CrashReportFormatter.cpp:51-57` emits command **names only**, re-sanitised per name; the `get_command_log` inspector projection (`MoshOps.cpp:615-629`) deliberately **drops `args`**. Neither reads the utterance. |

**Verdict: `gapExists = true`, but narrowly.** The transport is built and correct. What is missing
is (1) any proof that it survives the native round-trip, (2) honesty when there is no real
utterance, and (3) coverage of the turns that matter most to mining.

---

## The three holes

**H1 — the round-trip is unproven.** Every guard on this feature is a vitest against a *mocked*
`exec` (`executor.test.ts:68`). Nothing asserts the utterance reaches `mosh-log.jsonl` on disk.
`grep -rn "utterance\|turn_id" src/ tests/` returns **zero** hits outside an unrelated comment. This
is the repo's signature failure mode: a guard that cannot observe the thing it claims to guard.

**H2 — the log fabricates utterances.** `utterance: meta.utterance ?? label` (`executor.ts:121`,
`taskExec.ts:83`) mints an utterance from the change-set *label* when no transcript was threaded —
and `executor.test.ts:93` currently locks that in. The label is Moshi's own output (`reply.say`, a
fast-path caption, `"voice"`). A miner reading `{source:"voice", utterance:"add a lead"}` cannot
tell a real ask from a synthesized caption, so the FS-B2 lane would learn trigger phrases from the
model's own words. That is data poisoning of exactly the corpus this work exists to enable, and it
contradicts the brief's own honesty constraint (*"absent, not empty-string"*). The hands-free voice
path is the live instance: `AgentComposer.tsx:53` passes `{source:"voice"}` with no utterance
because the transcript "isn't threaded here" — but `handsFree.ts:70` **has** the transcript.

**H3 — unserved asks vanish.** `runAgentBatch` opens the batch only `if (allowed.length > 0)`
(`executor.ts:117`), and the brain-chat path only calls it `if (reply.commands.length > 0)`
(`AgentComposer.tsx:209`). So a turn where the brain planned nothing, or every call failed
validation, or the destructive screen blocked the lot, or a section rework resolved empty, leaves
**no trace at all**. Those are the highest-value rows for skill mining: the asks the system could
not serve are what tell you which skills are missing.

---

## Plan

**P1 — prove the round trip natively (`AGT-PROV` in `--selftest`).** Run a real
`batch_begin{turn_id,utterance,source}` → mutating command → `batch_end`, then read
`mosh-log.jsonl` back off disk and assert: the `batch_begin` line carries the utterance verbatim;
the mutating command's *own* line carries no utterance; and a direct (non-batch) command emits a
line with neither `utterance` nor `turn_id`. RED-prove each assertion.

**P2 — stop fabricating.** Omit the `utterance` key entirely when no transcript exists (key absent,
not empty-string), in both `executor.ts` and `taskExec.ts`; invert `executor.test.ts:93` to assert
absence. Thread the real transcript through `handsFree.dispatch` → `FastDeps.runBatch` so a
hands-free voice turn carries what was actually said.

**P3 — record the unserved ask.** Add `logAgentTurn(meta)` to `executor.ts`: the same
`batch_begin` → `batch_end` pair with nothing between, so the ask lands in the log with zero
commands. Safe against the empty-transaction hazard — `UndoManager::beginNewTransaction` only sets
a flag (`juce_UndoManager.cpp:223-227`); no `ActionSet` is created until a `perform()`, so an empty
pair adds nothing to the undo stack. Called from the three *addressed-ask* sites: zero-allowed in
`runAgentBatch`, zero-commands in the brain-chat reply, and the empty section rework.

**P4 — pin the privacy boundary.** A guard test that fails if the `get_command_log` projection or
the crash-report formatter ever starts carrying `args`. Note the local-only utterance in
`docs/PRIVACY.md`.

### Deliberately NOT done

- **Hands-free `onUnknown` is not logged.** It is overheard speech that was never addressed to
  Moshi (the always-on matcher drops it). Persisting every non-command phrase the hot mic hears
  would be a real privacy expansion for a marginal mining gain. Only *addressed* asks — typed,
  hold-to-talk, matched hands-free — are logged.
- **No log schema version bump.** FS-T3's machinery versions the `MOSH_PROJECT` ValueTree
  (`moshFormatVersion`, `src/state/Migrations.h`) — the project/session *state file*.
  `mosh-log.jsonl` is a separate append-only journal, and this change adds **no top-level key**:
  the utterance lives inside per-command `args`, which is already free-form and per-command shaped.
  Readers (`harvester.ts:parseLog`) already tolerate absent fields. SPEC §1.6's sequencing gate is
  about state fields and does not fire here.
- **No new MoshOps command**, per the brief's preference and because the markers already carry it.

## Acceptance — met (2026-07-28)

| Gate | Result |
|---|---|
| `--selftest` ×3, isolated sessions | **2059/2059 ×3**, deterministic |
| `--selftest-undo` | 18/18 |
| ctest / Catch2 | 1/1 suite — **2316 assertions in 230 cases** |
| `npm run typecheck` | clean (`tsc` + e2e tsconfig) |
| `npm test` (vitest) | **2018 passed**, 1 skipped |
| e2e (`playwright.isolated.config.ts`) | **255 passed**, 8 skipped |
| `grep SABOTAGE` over `src/ tests/ ui/src/` | clean |

### RED-proofs (every new guard falsified, then restored)

Native — three independent sabotages in `MoshOps` in one build: `batch_begin` logging empty args;
the `get_command_log` projection re-adding `args`; `logLine` injecting an utterance onto every
non-marker line. **All ten new native checks went RED** (9 × `AGT-PROV` + `get_command_log projects
NO args`), then 2059/2059 after restore — `git diff src/moshops/` empty.
`tests/test_telemetry.cpp`'s new case RED-proved separately by removing the formatter's
`sanitizeCommandName` call. TS — the four executor guards and three harvester guards each RED-proved
by reverting the specific behaviour they assert.

One real bug was caught by an *existing* test during the work: the first cut of the unserved-ask
marker fired on a `remember_preference`-only turn, which AGT-MEM M3 requires to open no transaction
at all. That turn was in fact *served* (the preference was written), so the marker now counts only
seam-bound calls.

### The round trip, on disk

From an `--selftest` run's real `mosh-log.jsonl`:

```
batch_begin  args:{"name":"make the drums hit harder","turn_id":"agt-prov-turn-1",
                   "utterance":"AGT-PROV make the drums hit harder","source":"brain_chat"}
create_track args:{"name":"Prov Agent"}      ← the turn's own command: no utterance
create_track args:{"name":"Prov Direct"}     ← a DIRECT UI action: no utterance, no turn_id
batch_begin  args:{"name":"no idea what you mean","turn_id":"agt-prov-turn-2",
                   "utterance":"AGT-PROV make it sound purple","source":"brain_chat"}  ← unserved
```
