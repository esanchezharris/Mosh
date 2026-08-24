# FS-B2a — The native batch-transaction contract (FS-B2's engine prerequisite)

**Lane:** B (Brain) · **Spec:** `docs/first-stranger-program/SPEC.md` §0, §7 B2 · **Prerequisite
spec:** [`fs-b2.md`](fs-b2.md) "Required native contract" — *that document is the specification;
this one is the build plan for it* · **Registered bucket:** **owner-merge** (touches
`src/moshops/`, `src/multiplayer/`, `src/app/`) · **First-session verdict (2026-07-28): GAP OPEN —
build warranted. No implementation exists anywhere, including on the branch that claims to hold
it.**

Backlog: FS-B2 stays `blocked`. This lane is the third item of B2's own unblocking checklist
(*"the owner-routed native transaction slice above is merged and green"*), not B2 itself. Nothing
here flips a backlog status.

---

## Context

`fs-b2.md` (2026-07-13) is a document-only prerequisite: it defines a native transaction contract
and explicitly *"does not authorize that implementation."* This lane is that authorization being
exercised. The contract in `fs-b2.md` §"Required native contract" is implemented **as written** —
identity + manifest, an engine-owned `transactionSafe` registry, authoritative `batch_status`,
exact commit, exact rollback, the durable ledger, and the 6-step harness protocol. Where the
implementation deviates, the deviation is named and justified in
[§Deviations from the letter of the contract](#deviations-from-the-letter-of-the-contract) below —
there are four, all narrow, and one of them is a **correction to the contract**, not a shortcut.

### Gap verification (SPEC §0 — confirmed OPEN, 2026-07-28)

- `src/moshops/MoshOps.cpp:4182-4201` — `cmdBatchBegin` is nine lines: reject if `inBatch`, name the
  undo transaction, set `inBatch = true`, log, return bare `ok`. `cmdBatchEnd` is five: reject if
  `!inBatch`, clear the flag, log, invalidate, return bare `ok`. **No transaction id, no manifest,
  no per-command identity, no recorded results, no durable status, no rollback.**
- `src/moshops/MoshOps.h:747` — `bool inBatch = false;` is the entire state. It is process-local and
  disappears on exit, so a crash mid-batch is indistinguishable from no batch at all.
- `grep -rn "batch_status\|batch_rollback\|transactionSafe\|transactionId" src ui/src` → **zero
  hits.** No engine-owned allowlist, no status surface, no exact rollback.
- `ui/src/agent/skillHarness.ts:188-196` — the FS-B1 conservative branch is present and is exactly
  what B2 said it was: a rejected batch promise returns `rolledBack:false` with *"Mutation state is
  unknown; automatic rollback was not attempted."* Correct as a refusal; not the engine guarantee.
- `ui/src/agent/executor.ts:158-167` — `undoAgentBatch()` is a bare `exec("undo")`. Its `boolean`
  result cannot name which transaction it undid, which is precisely the ambiguity B2 refuses to
  build on.
- **The branch `codex/fs-b2-transaction-prereq` contains no implementation.** Its single own commit
  (`595a447c`, 2026-07-13) adds `docs/first-stranger-program/lanes/fs-b2.md` and nothing else
  (1 file, +213). That file is byte-identical to the copy already on `main`
  (`git diff main:…/fs-b2.md branch:…/fs-b2.md` is empty), and
  `git diff main...branch -- src ui` is empty. The branch is also ~30 commits behind `main`, which
  is the only reason a naive two-dot diff looks enormous. Nothing to salvage; it can be deleted.

**Conclusion: `gapExists = true`** for every clause of the contract.

### Three corrections to the task framing, recorded because they change the work

1. **`fs-k2.md` does not exist.** The lanes directory holds `fs-b0/b1/b2/k3/k4/t2/t3`. House style
   is taken from `fs-k3.md` (verdict header → context → gap verification → gates → files → §0 rules
   → bucket → blocked-on-owner) and `fs-b1.md` (acceptance-evidence table).
2. **`send_to_bus`, `prepare_drum_track` and `record_take` do not exist, and there are 8 skills, not
   13.** `SKILL_CATALOG` (`ui/src/agent/skills.ts:926`) is `set_track_level`, `arrange_beat`,
   `build_drum_pattern`, `add_vocal_with_lyrics`, `reimagine_clip`, `host_plugin`,
   `warp_loop_to_grid`, `automate_parameter`. The fixtures with the requested *shapes* do exist and
   are used instead: **`set_track_level`** (2 commands, one behind an `if_present` branch) and
   **`build_drum_pattern`** (2 commands) for the two-command cases, **`host_plugin`** (3 commands)
   for the three-command case.
3. **Two new dispatch names, not three.** `batch_status` and `batch_rollback` are new;
   `batch_begin`/`batch_end` are extended in place and are already registered in all three places.
   So the three-registrations rule applies twice, not three times — 2 × (dispatch + `LockManager`
   scope + `UI_ONLY_COMMANDS`).

### The finding that matters most to FS-B2 — surfaced, not worked around

**Only 4 of the 8 catalogued skills can be transactional at all, and that is a property of the
commands, not of this contract.** Mechanically checked (handler calls `beginTxn`, `logLine`'s
`undoable` argument is `true`, no `std::thread`/`callAsync`/`jobManager` in the body):

| Skill | Commands | Transactable |
|---|---|:--:|
| `set_track_level` | `set_track_volume`, `set_track_mute` | ✅ |
| `build_drum_pattern` | `add_drum_pattern`, `set_track_mute` | ✅ |
| `host_plugin` | `load_plugin`, `set_plugin_param`, `bypass_plugin` | ✅ |
| `automate_parameter` | `set_track_automation_mode`, `write_automation_curve`, `set_plugin_param` | ✅ |
| `arrange_beat` | … + **`set_metronome`** | ❌ — `cmdSetMetronome` calls **no** `beginTxn` and logs `undoable=false`: an engine/device preference, not an Edit write. Rolling back the rest would leave the metronome changed. |
| `warp_loop_to_grid` | **`detect_clip_bpm`**, `stretch_clip`, `rename_clip` | ❌ — `cmdDetectClipBpm` is a read/analysis with no transaction at all. |
| `reimagine_clip` | `create_render_layer`, `set_render_param`, **`render_layer`**, `accept_render` | ❌ — `cmdRenderLayer` is **asynchronous** (9 `jobManager`/`callAsync` sites) and `undoable=false`. |
| `add_vocal_with_lyrics` | `create_lyric_sheet`, `set_lyric_line`, `set_lyric_constraint` | ✅ (all three are `beginTxn` + `undoable=true`) |

This is the correct outcome — `fs-b2.md` requires exactly these rejections ("Transport, recording
lifecycle, file/project replacement, device/preference, async render … are rejected before
mutation"). But it has a consequence B2 must absorb: **§7 B2's gate ("each skill … never partial
mutations") is unachievable as written for any skill containing an async render or a
non-undoable preference**, so B2 must either (a) restrict its ~10 skills to transactable commands,
or (b) define a second, human-gated route for generative skills. That is an owner/B2 decision, not
this lane's to make. It is recorded as a `BLOCKED-ON-OWNER` note and pinned in code by
`SKILL_TRANSACTABILITY` (below) so the classification cannot drift silently.

---

## Design

### 1. `inBatch` is kept, and a *separate* transaction is added beside it

`inBatch` is load-bearing for two things this lane must not break: `beginTxn`
(`MoshOps.h:687`) skips `beginNewTransaction` while it is set, which is what makes a batch one undo
step; and two internal composites — `cmdSketchBeatbox` (`MoshOps.cpp:7009`) and
`cmdGenerateBeatRecipe` (`:7140`) — set and clear it themselves via an `ownBatch` pattern and then
re-enter `execute()` for each of their own steps.

So `inBatch` keeps its exact present meaning (undo coalescing) and the agent transaction is new,
separate state:

```cpp
struct AgentTxn {
    juce::String id, name, label, status, failureCode;
    juce::String manifestDigest, preFingerprint;
    juce::int64  revisionAtBegin = 0;
    int          nextIndex = 0;
    struct Entry { juce::String requestId, command, state, envelopeDigest; juce::var result; };
    std::vector<Entry> entries;
};
std::unique_ptr<AgentTxn> txn_;   // at most one, message thread only
```

An open agent transaction implies `inBatch`; the converse is false. The composites therefore keep
working unchanged, and their nested `execute()` calls are exempt by the re-entrancy rule below.

### 2. The guard: only the OUTER `execute()` is governed

`execute()` is re-entered from inside handlers in four places (`MoshOps.cpp:695`, `:3595`, `:7173`,
`:11996`). A depth counter incremented in `execute()` means the transaction guard fires **only at
depth 1**, so a manifested composite command's internal steps are not each required to carry
transaction metadata. Recovery replay (`replayingRecovery_`) is exempt for the same reason.

At depth 1, with a transaction `open`:

| Incoming call | Behaviour |
|---|---|
| read-only (`batch_status`, and the existing read-only command set) | allowed, unchanged |
| `batch_end` / `batch_rollback` for **this** id | allowed |
| a manifested command with matching `transaction` metadata, correct next index | admitted |
| a repeated `requestId`, identical envelope digest | **no mutation**; the recorded result is returned with `replayed: true` |
| a repeated `requestId`, different envelope | refused, `request_envelope_conflict` |
| out-of-order index, unknown requestId, extra call | refused, `manifest_mismatch` |
| **any untagged mutation** — UI, relay (`applyingRemote_`), or agent | refused, `transaction_in_progress` |

The untagged-mutation refusal is what `fs-b2.md` requires ("Untagged UI mutations, relay mutations
… are refused without mutation"). Its cost is real and is stated in Deviations #4.

### 3. Revision and the two structural proofs

- **Revision.** `juce::int64 editRevision_`, bumped in `beginTxn()` (the single chokepoint every
  mutating command already goes through) and in `cmdUndo`/`cmdRedo`. Monotonic, per-process,
  reported by `batch_status` as `revisionAtBegin` / `revision`.
- **Undo-head ownership.** `batch_begin` names the transaction `"agent-txn:<id>"`. JUCE's
  `beginNewTransaction` is **lazy** (`juce_UndoManager.cpp:223` sets a flag; the `ActionSet` is
  created on the first `perform`), so ownership is provable exactly:
  `getNumActionsInCurrentTransaction() > 0 && getUndoDescription() == label`.
  **This is the guard that makes rollback exact rather than a blind `undo()`** — and it is the same
  hazard as the G14 empty-transaction class: with zero actions in the current set, `undo()` reaches
  back and destroys the *previous* edit. Rollback refuses to call `undo()` unless it owns a
  non-empty head.
- **Fingerprint.** `AgentTxn::fingerprint(snapshot)` — MD5 over a canonical serialization
  (recursively key-sorted) of `ops.snapshot()` with a **declared** volatile key set removed
  (`transport`, `levels`, `recoveryAvailable`, `recoverableCount`, `serviceStatus`-class fields).
  The anti-vacuity requirement on this is explicit in the gates: it must be **stable** across a
  transport seek and **different** after a one-property mutation. A fingerprint that excluded too
  much would pass the first and fail the second.

### 4. The ledger — a dedicated versioned JSONL, per FS-T3's own rule

`~/Library/Mosh/session/agent-transactions.jsonl` (i.e. `eng.sessionDir()`, so
`MOSH_SELFTEST_SESSION` isolates it), append-only, one record per boundary
(`begin`/`applied`/`failed`/`committed`/`rolled_back`/`needs_recovery`), each carrying `"v": 1`.

- **Why not `mosh-log.jsonl`.** Boundary and result records *do* also go through `logLine` (the
  existing seam) exactly as today. But restart detection needs to *read back* an unresolved
  transaction, and `mosh-log.jsonl` has no per-record schema version and no id-keyed structure.
  This is the identical reasoning FS-T2 recorded for `recovery-journal.jsonl` and deliberately did
  not "fix" — a dedicated versioned journal is a strict superset.
- **FS-T3 (SPEC §1.6).** This is new *state*, so it carries its own version field rather than
  riding an unversioned one. It does **not** bump `kMoshFormatVersion`: the ledger is not in the
  project `ValueTree`, and `Migrations.h:21-25`'s rule is that only a forward-incompatible change
  to a Mosh-owned node needs a bump. No `src/state/` change; no snapshot-schema change.
- **Contents.** Ids, index, command *name*, status, failure code, revision, fingerprints, and the
  recorded result envelope. **Never** raw command args (they carry file paths, lyric text, track
  names) and never a home path — asserted by a gate.

### 5. Restart → `needs_recovery`, resolved only by T2

On construction, MoshOps reads the ledger; any id whose last record is `begin`/`applied`/`failed`
is unresolved. Then:

- `batch_status({transactionId})` for that id returns `needs_recovery`;
- **`batch_begin` refuses** (`needs_recovery`), so no further skill can run;
- the block clears only when **T2's existing human-gated commands** resolve the crash tail:
  `recover_session` (post-state proved by journal replay) or `discard_recovery` (pre-state
  accepted). Each appends a terminal ledger record naming which was proved.

This coordinates with FS-T2 rather than duplicating it: this lane adds no recovery mechanism, it
adds a *block* that T2's mechanism releases. FS-T2's live safe-mode work touches
`cmdRecoverSession`/`cmdDiscardRecovery` in the same file — a merge-order note for the owner, not a
conflict of design.

### 6. `transactionSafe` — engine-owned, and its claims are machine-checked

`src/moshops/TransactionSafe.h` (engine-free, so `MoshTests` can test it) holds the allowlist and
`classifyForTransaction(name)` → `Safe | NonUndoable | Async | Lifecycle | Nested | Unknown` with a
reason string for the refusal copy. Membership is derived, not asserted: a candidate is admitted
only if its handler calls `beginTxn`, passes `undoable=true` to `logLine`, and contains no
`std::thread`/`callAsync`/`jobManager`/`Thread::launch`. `ui/src/agent/txnSafeRegistry.test.ts`
re-derives that from `MoshOps.cpp` at test time and fails on any entry whose claim has rotted —
the same idiom as `commands.contract.test.ts`, and the reason a "written reason ages" here becomes
a build failure rather than a comment.

### 7. TypeScript: one planner, two consumers

- `ui/src/agent/skillTransaction.ts` — **pure**. `planSkillTransaction(skill, slots, ids)` →
  `{transactionId, manifest, steps}`; plus `SKILL_TRANSACTABILITY` (the table above, in code).
- `ui/src/agent/skillHarness.ts` — rewritten to `fs-b2.md`'s 6 steps. The FS-B1 `rolledBack:false`
  on ambiguous transport loss is **replaced** by: query `batch_status`, then consume the recorded
  result, retry the same `requestId`, or stop with `needs_recovery`. `rolledBack:true` is returned
  only when authoritative status is `rolled_back` **and** the returned fingerprint equals the
  pre-state fingerprint.
- `ui/src/store.ts` — `exec` grows an optional third argument that rides through as the
  `transaction` sibling of `command`/`args`. `WebBridge.cpp:178` passes `args[0]` whole, so the
  field survives to `executeImpl` untouched.
- `ui/src/agent/executor.ts` — **untouched.** `runAgentBatch` remains the legacy brain-chat path on
  the legacy (id-less) `batch_begin`/`batch_end`. Only the *skill* harness is transactional. This
  keeps the executor's baselines green and the diff honest about what changed.
- `ui/src/bridge.mock.ts` — the mock gains the same semantics, so "the same harness against both the
  mock and a real engine" is literally true of one code path.

### 8. Backward compatibility is the safety property of this whole design

`batch_begin`/`batch_end` **without** a `transactionId` behave **exactly as today**. Every existing
caller — `runAgentBatch`, both internal composites, the existing `--selftest` batch section — is
untouched. The transactional contract is reached only by presence of `transactionId`. That is what
keeps a ~2045-check selftest baseline and a 2056-test vitest baseline from moving for any reason
other than the checks this lane adds.

---

## Deviations from the letter of the contract

1. **`batch_end`/`batch_begin` keep a legacy id-less mode** (§8). `fs-b2.md` describes the
   transactional shapes only; it does not say the old shapes are removed, and removing them would
   rewrite `runAgentBatch` and two engine composites in a lane whose subject is not those.
2. **The manifest's per-entry `requestId` is authoritative; `index` is checked, not trusted.**
   `fs-b2.md` shows both. Ordering is enforced against `nextIndex`, and a mismatched `index` in the
   envelope is itself a `manifest_mismatch` — so both fields are validated, but the id is what
   identifies an entry for replay.
3. **`batch_status` reports the *result envelope* and the command name, never args.** The contract
   says "never raw command args or secrets"; this makes the exclusion structural rather than
   filtered.
4. **A relay mutation arriving during an open transaction is refused, not queued.** This is the
   contract as written ("Refuse the foreign mutation without changing transaction state") and it is
   implemented as written — but stated plainly: in a live multiplayer session the peer's op is
   **dropped**, not deferred. The exclusion window is one synchronous skill run (single-digit
   milliseconds for the transactable skills), and `MultiplayerSession`'s poll loop re-reads
   authoritative state, so the practical exposure is small. **Flagged for the owner** as the one
   place where this contract makes multiplayer strictly worse rather than strictly better.

---

## Exact gates that prove this lane

All local (SPEC §0). New coverage lands in files the existing gate already runs — `SelfTest.cpp`,
`tests/`, `ui/src/**`, `scripts/verify-hardware/verify.py` — so **`scripts/auto-loop/gate.sh` is not
edited** (forbidden file).

1. **Catch2 `[agenttxn]` — `tests/test_agent_txn.cpp` (NEW), engine-free.** The pure layer:
   canonical fingerprint (key-order independence, volatile-key exclusion, sensitivity to a real
   change), manifest/envelope digests, ledger record round-trip, `unresolvedIdsIn(lines)` over
   synthesized ledgers (including a truncated final line and an interleaved two-id ledger), and
   `classifyForTransaction` for one command of every rejection class. **Unit-testing the pure
   helper is also how the restart path is proven without a real crash** — the JUCE-ignores-`$HOME`
   lesson.
2. **Catch2 `[multiplayer][lock]` — extended.** `batch_status`/`batch_rollback` assert
   `Scope::Unguarded`; the AL-011 drift guard then passes by construction.
3. **`Mosh --selftest` — new `TXN-*` sections** (real engine, deterministic, ×3 via the existing
   `run_selftest_x3`). One section per acceptance bullet of `fs-b2.md`:
   - `TXN-COMMIT` — a 2-command manifest (`set_track_level`'s shape) commits; snapshot read **while
     open** matches the postcondition; `batch_status` says `committed`.
   - `TXN-ROLLBACK` — a 2-command manifest whose second command fails: one `batch_rollback`
     restores the fingerprint **exactly**, both command outcomes are reported, status is
     `rolled_back`.
   - `TXN-POSTCOND` — a deliberately false postcondition rolls back the still-open transaction.
   - `TXN-REPLAY` — response-loss injection after `batch_begin`, after each manifested command,
     after `batch_end`, and after `batch_rollback`: the retry returns `replayed: true`, the state
     is asserted **unchanged** (`replayed` is worthless without that), and status always names the
     exact id.
   - `TXN-FOREIGN` — an untagged local mutation and a simulated relay apply are refused mid-
     transaction and work normally after commit; transaction state is unmoved by the refusal.
   - `TXN-IDENTITY` — same id + identical manifest is idempotent; same id + different manifest is a
     hard error; a second id while one is unresolved is a hard error.
   - `TXN-PREFLIGHT` — `set_metronome` (non-undoable), `render_layer` (async), `open_project`
     (lifecycle), `batch_begin` (nested), and `no_such_command` are each rejected at manifest
     preflight **with no mutation and no open transaction**.
   - `TXN-HEAD` — a stale undo head, a revision mismatch, and a malformed ledger each produce
     `needs_recovery` and **no** `undo()` call; proven by asserting the *previous* transaction is
     still undoable afterwards (the G14 shape).
   - `TXN-3CMD` — `host_plugin`'s 3-command shape, commit and rollback.
   - `TXN-LEDGER` — the JSONL carries ids/status/outcomes and contains **no** `"args"` key and no
     `/Users/` string.
4. **`Mosh --selftest-undo`** — unchanged, must stay green (it is the existing focused undo pass).
5. **vitest** — `skillTransaction.test.ts` (planner + transactability table), rewritten
   `skillHarness.test.ts` / `skillHarness.failure.test.ts` (the 6-step protocol and every failure
   row of `fs-b2.md`'s table against the transactional mock), `txnSafeRegistry.test.ts` (§6),
   `bridge.mock.txn.test.ts`. `commands.contract.test.ts` and `uiReachability.test.ts` must pass
   **unchanged** — which they only do if the two new commands are classified, so they are part of
   the proof, not bystanders.
6. **`verify.py` — `check_skill_transaction_real_engine` (NEW, offline).** Runs the **committed
   goldens** (`tests/golden/txn/*.jsonl`, generated by `planSkillTransaction` with fixed ids and
   pinned by a vitest) through `Mosh --run-script` and asserts the printed result lines: commit
   reaches `committed`; the rollback golden's `batch_status` returns `currentFingerprint ==
   preFingerprint`; the mid-transaction status returns a fingerprint that **differs** (the
   anti-vacuity leg); the replay golden double-sends one command and gets `replayed: true` with an
   unchanged fingerprint. Run from the **repo root** — `GenerativeJobManager` resolves
   `service/server.py` CWD-relative.
   `--run-script` currently drops any field other than `command`/`args`
   (`SelfTest.cpp:9568-9570`); forwarding `transaction` is a 3-line change and is what makes this
   gate possible.
7. **UI-REACH.** `batch_status`/`batch_rollback` are agent-*internal plumbing*, not producer
   actions: they join `UI_ONLY_COMMANDS` beside `batch_begin`/`batch_end` ("the executor opens/
   closes the agent's own undo batches — the model never manages transactions"). They are therefore
   **never in `AGENT_COMMANDS`**, so `uiReachability.test.ts` does not apply to them and
   `UI_REACH_GAPS` **stays at 0**. Confirmed by reading the test: it iterates
   `AGENT_COMMANDS.map(c => c.command)` only (`uiReachability.test.ts:127`).
8. **Baselines to hold** (measured on this worktree before the first edit, not copied from a doc):
   `--selftest` **2045** ×3 deterministic, vitest **2056**, Catch2, Playwright,
   `tsc` clean. New checks add to the selftest and vitest counts; nothing else may move.
   `MOSH_SELFTEST_BASELINE` is **not** hard-coded to a locally observed number.

### Anti-vacuity protocol for this lane

Vacuous verification is this repo's recurring failure mode, and this lane is unusually exposed: a
guard that *suppresses* a mutation looks identical to a guard that does nothing when the fixture
had nothing to suppress. So, for every new guard:

- **RED-prove it.** Sabotage the guard, watch the specific new check fail, restore, re-run.
- **Anchor the sabotage on something unique and assert the occurrence count is 1** before editing —
  the 2026-07-28 lesson: a sabotage that hits the wrong occurrence is indistinguishable from a test
  that cannot fail. Use absolute paths; verify the restore with `git diff --stat`.
- **Every suppression fixture must carry the thing being suppressed.** `TXN-FOREIGN` asserts the
  untagged mutation would *otherwise succeed* (it runs the same call after commit and checks it
  landed). `TXN-LEDGER` asserts the transaction it inspects had args worth leaking. `TXN-REPLAY`
  asserts state is unchanged, not merely that a flag came back.
- **`grep -rn SABOTAGE` before finishing**, and `git diff` reviewed line by line.

---

## Files

| Path | Change |
|---|---|
| `src/moshops/AgentTxn.h` | **NEW.** Engine-free: record/entry shapes, canonical fingerprint + declared volatile set, manifest/envelope digests, ledger serialize/parse, `unresolvedIdsIn`. |
| `src/moshops/TransactionSafe.h` | **NEW.** Engine-free: the `transactionSafe` allowlist + `classifyForTransaction` with per-class refusal reasons. |
| `src/moshops/MoshOps.h` | `txn_` state, `editRevision_`, depth counter, the four new/extended handler decls, ledger file handle. |
| `src/moshops/MoshOps.cpp` | The guard in `executeImpl`; `cmdBatchBegin`/`cmdBatchEnd` extended (legacy mode preserved); `cmdBatchStatus`/`cmdBatchRollback` new; revision bump in `beginTxn`/`cmdUndo`/`cmdRedo`; ledger init + writes; `cmdRecoverSession`/`cmdDiscardRecovery` resolve an unresolved id. |
| `src/multiplayer/LockManager.cpp` | `batch_status`, `batch_rollback` → the `unguarded` set. |
| `src/app/SelfTest.cpp` | The ten `TXN-*` sections; `--run-script` forwards the `transaction` field. |
| `tests/test_agent_txn.cpp` + `tests/CMakeLists.txt` | **NEW** Catch2 `[agenttxn]`. |
| `tests/test_multiplayer_lock_manager.cpp` | Two `Scope::Unguarded` assertions. |
| `tests/golden/txn/*.jsonl` | **NEW** run-script goldens (commit / rollback / replay). |
| `ui/src/agent/skillTransaction.ts` | **NEW** pure planner + `SKILL_TRANSACTABILITY`. |
| `ui/src/agent/skillHarness.ts` | Rewritten to the 6-step protocol. |
| `ui/src/agent/skillHarness*.test.ts` | Rewritten/extended for the new semantics. |
| `ui/src/agent/skillTransaction.test.ts`, `txnSafeRegistry.test.ts`, `bridge.mock.txn.test.ts` | **NEW.** |
| `ui/src/agent/commandClassification.ts` | Two `UI_ONLY_COMMANDS` entries. |
| `ui/src/store.ts`, `ui/src/bridge.mock.ts` | Optional `transaction` argument; mock transactional semantics. |
| `scripts/verify-hardware/verify.py` | `check_skill_transaction_real_engine`. |
| `docs/first-stranger-program/lanes/fs-b2a-transaction-contract.md` | This plan + its close-out. |

**Explicitly NOT touched:** `scripts/auto-loop/*` (rulebook), `cmake/Dependencies.cmake` + pins,
`.github/**`, specs `00`–`06`, `CLAUDE.md`, `src/state/` (no schema bump — §Design 4),
`ui/src/agent/executor.ts`, `arena/`, the SA3 LoRA branch, FMS spike worktrees, `PROGRAM_STAGE1`.

---

## §0 rules binding this lane

- **One lane per worktree.** FS-B2a only. (Also: one worktree, one agent — PR #424 shipped
  `return 0; // SABOTAGE` because two agents shared one.)
- **MoshOps is the sole mutation seam.** This lane *strengthens* it: no second mutation path, and
  untagged mutations are refused rather than silently coalesced into someone else's transaction.
- **One undo system.** Tracktion's `UndoManager` remains the only undo implementation. Rollback is
  `undoManager().undo()` gated on proven head ownership — no shadow model, no second stack.
- **Swappable seam.** The frontend gains `transactionId`/`requestId`/`batch_status` — protocol
  identifiers, not Tracktion or audio concepts. No engine type crosses the bridge.
- **Threading / RT safety.** All transaction state is message-thread only (same as `inBatch`).
  Nothing new runs in `applyToBuffer`; no new locks; the ledger append is a message-thread file
  write on the existing `logLine` pattern. Carries an explicit RT-safety note in the PR.
- **Nothing a build reads lives under `~/Documents`.** The ledger is under
  `~/Library/Mosh/session/`, inside the `MOSH_SELFTEST_SESSION` isolation boundary.
- **JUCE ignores `$HOME`.** Restart/`needs_recovery` behaviour is proven by Catch2 over the pure
  helper plus a synthesized ledger in the isolated session dir — never by crashing a run against
  the real `~/Library/Mosh`.
- **Never verify a native change with a pre-existing binary.** Every count in the close-out comes
  from a build of committed source in this worktree.
- **Three registrations per new command.** dispatch + `LockManager::classify` +
  (`AGENT_COMMANDS` | `UI_ONLY_COMMANDS`). Both new commands take the `UI_ONLY_COMMANDS` route.
- **`if (auto* p = someVarReturningFn().getArray())` is a use-after-free** — the `juce::var`
  temporary dies at the end of the if-condition. Every manifest/entry array read binds a named
  local first.
- **Playwright:** move `ui/.env.local` aside before any e2e run (a real provider key makes the
  deterministic agent specs fail with plausible-looking wrong text).

---

## Merge BUCKET

**owner-merge.** The diff is native (`src/moshops/`, `src/multiplayer/`, `src/app/`, `tests/`),
which is outside the safe allowlist, and it changes the semantics of the sole mutation seam. The
loop runs plan → implement → full local gate → hostile review, then opens a `needs-owner-merge` PR.
It never auto-merges. GitHub Actions billing recovered 2026-07-27, so a red check on the PR is a
**real** failure, not an outage — read durations before concluding otherwise.

## BLOCKED-ON-OWNER

1. **B2's skill set must absorb the transactability finding.** 4 of 8 catalogued skills contain a
   command that cannot be in an atomic transaction (async render, non-undoable preference, or a
   pure read). B2 either restricts its ~10 skills to transactable commands or defines a second,
   human-gated route for generative skills. **Not blocking this lane** — the contract ships and
   pins the classification; the decision is B2's.
2. **Relay refusal during an open transaction** (Deviation #4) drops a peer's op rather than
   deferring it. Contract-as-written; owner should confirm they want that trade in a live session.
3. **Merge order with FS-T2.** Both lanes touch `cmdRecoverSession`/`cmdDiscardRecovery` in
   `MoshOps.cpp`. Whichever lands second rebases; no design conflict.

---

## CLOSE-OUT (2026-07-28) — built, gated green locally, owner-merge pending

### Measured gate results

Every number below was measured in this worktree from a build of committed source. **All three
baselines the task named were wrong for this tree** — recorded here as measured, not as quoted:

| Gate | Baseline (measured before the first edit) | After | Note |
|---|---:|---:|---|
| `Mosh --selftest` ×3 | **2037** (task said 2045) | **2192** ×3, 0 failed, identical each run | +155 checks, ten `TXN-*` sections |
| `Mosh --selftest-undo` | 18/18 | **18/18** | unchanged, as required |
| Catch2 (`MoshTests`) | 2308 assertions / 229 cases | **2455 / 248** | +147 assertions, `[agenttxn]` |
| vitest | **2012** (2011+1 skipped; task said 2056) | **2120** (2119+1 skipped) | +108 |
| `tsc` (both configs) | clean | **clean** | |
| Playwright (isolated config) | — | **255 passed, 8 skipped** | no `ui/.env.local` present to move aside |
| `verify.py --gate` (repo ROOT) | 28/28 | **29/29** | +`check_skill_transaction_real_engine`; **all 6 golden-audio checksums unchanged**, so the render path is byte-identical |

### Item 5 of B2's checklist — the real gate — is proven

`verify.py`'s new check replays the committed goldens through `Mosh --run-script` against a
freshly-built binary and reads the **engine's own** fingerprints back out of `batch_status`
(no second implementation to disagree):

```
commit      : status=committed, applied=2/2, fingerprint MOVED from preFingerprint
rollback    : pre=7c6c4ad7 → mid=b96b42e8 (a step really applied, one really failed,
              applied=1) → final=rolled_back, fingerprint=7c6c4ad7  ← restored EXACTLY
replay      : exactly one `replayed:true`, applied==manifestCount, no third entry
multi-step  : 5 commands committed; and 4 applied steps reverted by ONE rollback to the
              exact pre-state
restart     : an orphaned transaction survives the process as needs_recovery, BLOCKS the
              next batch_begin with `unresolved_after_restart`, and unblocks only after
              T2's discard_recovery
```

### RED-proofs — 17, every one confirmed, every restore verified byte-identical

Each sabotage anchored on a string whose occurrence count was asserted to be **exactly 1**
before editing (the 2026-07-28 lesson), applied by absolute path, and the restore verified with
`filecmp`, not `git diff` alone.

*Pure layer (Catch2):* volatile set swallowing the arrangement · `session.dirty` not declared
volatile · a torn ledger line aborting the scan · non-terminal treated as resolved · manifest
index ordering unchecked · registry failing **open**.

*Engine (`--selftest`):* the untagged-mutation refusal removed · rollback undoing **blindly**
(the G14 bug reintroduced — and its blast radius showed up in four unrelated sections, which is
exactly what a blind undo does in reality) · a retried `requestId` re-dispatching · manifest
preflight skipped · rollback reporting `rolled_back` without undoing · the ledger recording args
· identity conflict unenforced · commit accepting an incomplete transaction.

*TypeScript (vitest):* rollback's fingerprint verification removed · a malformed status envelope
trusted · the mock ceasing to refuse foreign mutations · an async command added to the registry ·
a stale transactability verdict.

*verify.py:* the engine's rollback stopped undoing → the real-engine check went red on the
rollback leg (`restored_exactly: false`), then passed again after restore + **rebuild**.

**Two of my own tests were vacuous and the RED-proofs caught them.** Recorded because the
pattern is the point, not the individual bugs:

1. **`TXN-REPLAY` could not detect a double-apply.** Every leg used `set_track_volume`, which
   sets an *absolute* value — so re-dispatching it a second time moves neither the fingerprint
   nor the applied count, and the sabotage sailed through. Fixed by adding a leg on
   `create_track`, where a second application **adds a track**: `THE DOUBLE-APPLY CHECK: a
   retried create_track added NO second track`. That check now fails under the sabotage.
2. **"a malformed status envelope is unprovable" passed its sabotage.** It reached
   `needs_recovery` by a different route, so the `found`-typecheck it existed to guard was never
   exercised. Rewritten to force the malformed envelope into the *rollback* path where it would
   let a clean rollback be **believed** — the only place a malformed envelope is dangerous.

`grep -rn SABOTAGE src/ ui/src/ tests/ scripts/` → **clean**. `ui/src/agent/executor.ts` is
untouched, as planned.

### What the build actually decided, beyond the plan

1. **The `RefuseForeignHead` rollback branch is unreachable through the public seam** — while a
   transaction is open MoshOps refuses every untagged mutation, so nothing *can* take the undo
   head from underneath it. Rather than add a test-only backdoor into the `UndoManager` to forge
   it, the decision was extracted as the pure `agenttxn::planRollback` and given an exhaustive
   Catch2 decision table; the **reachable** sibling (the G14 empty transaction) is proven against
   the real engine in `TXN-HEAD`. An untestable guard is the vacuous kind, so this is stated
   rather than hidden.
2. **`resolveUnresolvedTxns` resolves only the STARTUP set, not the live one.** The first version
   also swept in-process ids, and that was wrong: `discard_recovery` drops the journal but does
   **not** reload the edit, so relabelling a live open transaction `rolled_back` would claim a
   restoration that never happened — precisely the class of lie this contract exists to prevent.
   A live transaction resolves through `batch_end`/`batch_rollback`; a live `needs_recovery` one
   resolves through a human, which is what `needs_recovery` means.
3. **The three untransactable skills still run, on a `best_effort` path.** Refusing
   `arrange_beat`, `warp_loop_to_grid` and `reimagine_clip` outright would have deleted working
   behaviour to satisfy a contract that was never able to cover them. They run on the legacy
   batch with FS-B1's confirmed-undo semantics, and every result now carries
   `guarantee: "atomic" | "best_effort"` so no caller can mistake one for the other. **The
   harness refuses to lie about which guarantee it got; choosing which one a B2 skill may use is
   B2's decision.**
4. **`--run-script` dropped the `transaction` field**, so every scripted call read as an untagged
   mutation. Forwarding it (3 lines in `SelfTest.cpp`) is what made the whole real-engine golden
   leg possible.
5. **The multi-step golden is `add_vocal_with_lyrics`, not `host_plugin`.** `host_plugin`'s first
   step is `load_plugin`, which needs a scanned third-party VST3 and is therefore not portable to
   a headless run or a clean CI machine — it failed for exactly that reason on first run. The
   3-command *plugin* shape is still proven against the real engine in `TXN-3CMD`, which can use
   `load_builtin`.
6. **`fs-k2.md` does not exist**, and the task's three fixture skills (`send_to_bus`,
   `prepare_drum_track`, `record_take`) and its "13 skills" do not either — there are 8. The
   requested *shapes* were used instead (see Context).

### Files as built

**28 files, +5201 / −286.**

*14 new* — `src/moshops/AgentTxn.h`, `src/moshops/TransactionSafe.h`,
`tests/test_agent_txn.cpp`, `ui/src/agent/skillTransaction.ts`, `ui/src/agent/txnGoldens.ts`,
three vitest suites (`skillTransaction`, `txnGoldens`, `txnSafeRegistry`), 5 run-script goldens
under `tests/golden/txn/`, and this lane doc.

*14 modified* — `MoshOps.{h,cpp}`, `SelfTest.cpp`, `LockManager.cpp`, `tests/CMakeLists.txt`,
`test_multiplayer_lock_manager.cpp`, `verify.py`, `commandClassification.ts`, `store.ts`,
`bridge.mock.ts`, `skillHarness.ts`, and the three rewritten test suites
(`skillHarness.test.ts`, `skillHarness.failure.test.ts`, `executor.batch-boundary.test.ts`).

`ui/src/agent/executor.ts` and `src/state/**` are deliberately untouched — no legacy batch
change, no schema bump.

---

## FS-B2 unblocking checklist — status after this lane

`fs-b2.md` lists five; **"clearing one is not sufficient"** is a lesson that document has already
had to teach once, so all five are reported explicitly:

| # | Item | After this lane |
|---|---|---|
| 1 | O2 exists and supplies the demo beats | ❌ still owner-blocked |
| 2 | FS-B1's schema/harness merged | ✅ merged (`#469` FS-B1a reconciled it) |
| 3 | The owner-routed native transaction slice merged and green | 🔶 **built and green locally (29/29 verify, 2192 ×3, 2455 Catch2, 2120 vitest, 255 e2e); NOT merged — owner-merge** |
| 4 | T2 can resolve a crash-interrupted open transaction | 🔶 **the block and the release hook are built and proven across a real restart; T2's own safe-mode slice is a separate live lane** |
| 5 | First real-engine skill run proves exact commit and exact rollback | ✅ **proven — `check_skill_transaction_real_engine`, five legs, RED-proved** |

**FS-B2 may not flip, and this lane does not flip it.** Item 1 (O2) is untouched and
owner-blocked; items 3 and 4 need merges outside this session. `backlog.jsonl` is unchanged —
FS-B2 stays `blocked`.

> The lesson that lane doc has already had to teach once — *"Clearing O2 alone is not
> sufficient"* — cuts the other way too: **clearing item 5 alone is not sufficient either.**
> Item 5 is the item this lane can finish by itself, and finishing it is not the same as
> unblocking B2.
