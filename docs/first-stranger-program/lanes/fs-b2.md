# FS-B2 — Demo-derived skills (blocked transaction prerequisite)

*Lane plan, prerequisite-only. Master spec: `docs/first-stranger-program/SPEC.md` §7.B2.
Backlog row: `docs/first-stranger-program/backlog.jsonl` id `FS-B2`. Written 2026-07-13.*

## Status

**BLOCKED. Do not implement or select the ~10 skills yet.** O2 (the owner-authored demo script) is
still required. In addition, the native engine transaction contract below must land before B2 can
claim that a multi-command skill never leaves partial mutations. FS-B1 supplies the typed catalog
and mock harness, but its conservative `rolledBack: false` result after an ambiguous transport loss
is intentionally not the missing engine guarantee.

This document defines the prerequisite; it does not implement engine code, change the master spec,
change the backlog state, or unblock B2.

## Verified gap

The current native seam cannot identify or safely resolve an ambiguous skill transaction:

- `MoshOps` stores only a process-local `bool inBatch` between `batch_begin` and `batch_end`.
- `batch_begin` opens an undo transaction and `batch_end` only clears `inBatch`; neither returns a
  transaction id, revision, command ledger, or durable status.
- Retrying `batch_begin` after a lost response only reports "a batch is already open". It cannot
  prove whether that open batch belongs to the retrying skill.
- A command response can be lost after the command mutated the edit. The UI then cannot distinguish
  "not executed" from "executed but response lost", and cannot safely decide whether to retry.
- The only rollback surface is generic `undo`. A boolean `undone` result does not prove which
  transaction was undone, and an intervening local or remote mutation could make it target the
  wrong edit.
- There is no engine-owned allowlist proving that every command admitted to an agent transaction
  is synchronous and wholly undoable. The TypeScript command catalog is not authoritative for
  engine rollback safety.

Therefore a blind retry can double-apply, and a blind undo can undo unrelated work. Both violate
§0's sole-mutation-seam rule and §7.B2's "never partial mutations" gate.

## Required native contract

Extend the existing MoshOps batch seam; do not add a second mutation path. The names below are the
contract to implement unless an engine review finds a strictly equivalent shape.

### Identity and manifest

The caller creates a UUID `transactionId` before its first bridge call. It expands and validates the
entire skill template first, then calls:

```json
{
  "command": "batch_begin",
  "args": {
    "transactionId": "uuid",
    "name": "skill name",
    "commands": [
      {"index": 0, "requestId": "uuid", "command": "set_track_volume"},
      {"index": 1, "requestId": "uuid", "command": "set_track_mute"}
    ]
  }
}
```

`batch_begin` must atomically validate the complete manifest against an **engine-owned**
`transactionSafe` registry before opening the Tracktion transaction. Every admitted command must
be synchronous, mutate only through MoshOps, register all mutations with the same UndoManager
transaction, and have no non-undoable side effects. Transport, recording lifecycle, file/project
replacement, device/preference, async render, `undo`/`redo`, nested batch, and unknown commands are
rejected before mutation.

Calling `batch_begin` again with the same `transactionId` and semantically identical manifest is
idempotent and returns the existing status. Reusing the id with different metadata is a hard error.
Starting any other transaction while one is unresolved is a hard error.

Each command continues through `execute_command`, with transaction metadata beside (not mixed into)
the handler's existing args:

```json
{
  "command": "set_track_volume",
  "args": {"trackId": "...", "db": -6},
  "transaction": {"transactionId": "uuid", "requestId": "uuid", "index": 0}
}
```

While a batch is open, every mutation must carry matching metadata and match the next manifest
entry. Untagged UI mutations, relay mutations, out-of-order calls, and extra calls are refused
without mutation. Read-only snapshot/status calls remain available. A repeated `requestId` with an
identical envelope returns the recorded result with `replayed: true`; a repeated id with different
content is rejected. This makes a command retry non-duplicating.

### Authoritative status

Add read-only `batch_status({transactionId})`. It returns a shaped result including:

- `found`, `transactionId`, and one of `open`, `failed`, `committed`, `rolled_back`, or
  `needs_recovery`;
- the pre-transaction edit revision and current revision;
- manifest count and, for every index, `pending`, `applied`, or `failed` plus the original result
  envelope (never raw command args or secrets);
- whether commit or rollback is currently legal; and
- a stable failure code suitable for user-facing refusal copy.

The status is the authority after any rejected promise, bridge disconnect, timeout, or duplicate
call. `found: false`, malformed status, revision mismatch, or `needs_recovery` is never treated as
"nothing happened"; it stops the skill and routes to human recovery.

The bounded transaction ledger and boundary/result records must be written through the existing
MoshOps JSONL seam under `~/Library/Mosh/`, with mode-appropriate local storage and no secrets.
After process restart, an unresolved transaction must surface as `needs_recovery` and block further
skills until T2's snapshot+journal recovery has proved either the complete pre-transaction or
complete post-transaction state. B2 may not call a crash-interrupted edit clean merely because the
in-memory `inBatch` flag disappeared.

### Commit and exact rollback

`batch_end({transactionId})` is the commit operation. It succeeds only when every manifest entry is
recorded `applied`, none failed, the edit revision matches the transaction ledger, and no foreign
mutation occurred. Repeating it is idempotent. A lost response is resolved with `batch_status`; it
is never followed by a blind second mutation.

Add `batch_rollback({transactionId})` as the only automatic skill rollback operation. It must:

1. accept only the identified open/failed transaction;
2. prove that transaction owns the current UndoManager head and that no local, relay, or async
   mutation intervened;
3. undo exactly that transaction;
4. verify the edit revision and a deterministic rollback fingerprint against the captured
   pre-transaction state; and
5. return and persist `rolled_back` only after those checks pass.

Rollback is idempotent when status is already `rolled_back`. A committed transaction, unknown id,
wrong undo head, foreign revision, incomplete undo, or unverifiable fingerprint returns
`needs_recovery`/`needs-human` and performs no generic undo. The UI must never fall back to
`undoAgentBatch()` for an ambiguous transaction.

### Harness protocol

The real-engine B2 harness must use this order:

1. Validate slots, preconditions, expanded calls, and engine `transactionSafe` eligibility without
   mutation.
2. Generate transaction/request ids and call idempotent `batch_begin` with the full manifest.
3. Execute each manifested command. After any transport rejection, query `batch_status` and either
   consume the recorded result, retry the same request id, or stop on an unprovable state.
4. If any resolved command fails, call exact `batch_rollback`; report `rolledBack: true` only when
   authoritative status is `rolled_back` and the pre-state fingerprint matches.
5. Read the resulting snapshot **while the transaction remains open** and evaluate the skill
   postcondition. On failure, use exact rollback as above.
6. Only after the postcondition passes, call `batch_end`. Resolve a lost commit response through
   `batch_status`; `committed` is success, while every other unresolved state is a refusal.

Keeping the transaction open through postcondition evaluation eliminates the current race in which
a generic undo is attempted after `batch_end`. The engine's short mutation exclusion window is
bounded to one synchronous skill run; read-only snapshot/status work may continue.

## Required failure behavior

| Failure | Required result |
|---|---|
| Validation/precondition/manifest rejection | No batch opens; user-legible refusal. |
| Resolved command failure after earlier applies | Exact rollback; success only if status becomes `rolled_back`. |
| Lost command response | Query status; idempotently replay the result or retry the same request id; never double-apply. |
| Lost begin/end/rollback response | Query by caller-owned transaction id; never infer from a rejected promise. |
| Postcondition failure | Roll back the still-open identified transaction and verify the pre-state. |
| Local/relay mutation during an open batch | Refuse the foreign mutation without changing transaction state. |
| Revision, undo-head, ledger, or fingerprint mismatch | Perform no generic undo; mark `needs_recovery` and stop. |
| App exit/crash with an unresolved transaction | T2 recovery proves pre- or post-state; skills remain disabled until then. |

Refusal copy must say whether no edit was made, the identified edit was restored, or the edit state
could not be proven and needs recovery. It must not say "rolled back" based only on a requested
undo or a transport success.

## Acceptance gates for the owner-routed engine slice

The prerequisite is complete only when all of these pass against the native engine, not only the
browser mock:

- response-loss injection after `batch_begin`, every manifested command, `batch_end`, and
  `batch_rollback`; retries never double-apply and status always names the exact transaction;
- a two-command transaction whose second command fails: one exact rollback restores the canonical
  semantic pre-state fingerprint (excluding declared volatile telemetry) and reports both command
  outcomes;
- a deliberately false postcondition rolls back while the transaction is open and restores the
  exact pre-state;
- untagged local and simulated relay mutations are rejected during an open transaction, then work
  normally after commit/rollback;
- duplicate transaction/request ids are idempotent only for identical envelopes and fail closed
  for mismatches;
- non-undoable, asynchronous, lifecycle, nested-batch, and unknown commands are rejected at
  manifest preflight;
- stale undo head, revision mismatch, malformed/missing ledger, and restart with an unresolved
  transaction all route to `needs_recovery` without a blind undo;
- JSONL transaction records contain ids/status/outcomes but no command secrets or owner-home data;
- focused native undo tests and the full unchanged local gate pass, including deterministic
  `--selftest` x3 with zero failures/assertions; and
- one B2 reference skill passes the same harness against both the mock and a real engine, including
  all injected failure cases.

The engine implementation touches `src/**` and is therefore **owner-routed**. It must arrive as its
own lane/worktree and draft PR, use the existing `scripts/auto-loop/gate.sh`, and never auto-merge.
This document-only prerequisite does not authorize that implementation.

## B2 unblocking checklist

FS-B2 remains blocked until all are true:

- O2 exists and supplies the actual demo beats;
- FS-B1's schema/harness is merged;
- the owner-routed native transaction slice above is merged and green;
- T2 can resolve a crash-interrupted open transaction without accepting partial state; and
- the first real-engine skill run proves exact commit and exact rollback behavior.

Only then should the backlog status change and the demo-derived skill list be written. Clearing O2
alone is not sufficient.

---

# Addendum 2026-07-28 — the skill CONTENT landed; the lane's gate did NOT

*Appended, not replacing the above. The prerequisite in this document is unmet and remains
binding. An earlier version of this session overwrote this file and flipped the backlog row to
`done` — both wrong, and the checklist above says exactly why: "Clearing O2 alone is not
sufficient."*

## What changed above the line

**O2 was withdrawn** (owner, 2026-07-28: "we're not doing a demo anymore"), so checklist item 1
— *"O2 exists and supplies the actual demo beats"* — can never be satisfied as written. The owner
chose a replacement source: the mined library as evidence, the shipped catalog as the home.
Item 2 (FS-B1 merged) is satisfied — it landed as PR #324. **Items 3, 4 and 5 are still open.**

## What was built

Five multi-command workflow skills in `ui/src/agent/skills.ts` (8 → 13), plus 19 behavioural
tests in `skillsFsB2.test.ts`:

| Skill | Commands | Mined evidence |
|---|---|---|
| `prepare_drum_track` | `set_track_type` + `load_drum_kit` | `set-track-type-load-drum-kit`, provenance 23 |
| `send_to_bus` | `add_send` + `set_send_level` | collapses **6** `create-bus-add-send*` variants |
| `record_take` | `arm_track` + `set_input_monitor` + `set_transport` | `arm-track-set-transport` |
| `keep_last_take` | `stop_recording` + `keep_take` | `stop-recording-keep-take` |
| `add_builtin_effect` | `load_builtin` + `set_plugin_param` | collapses **3** variants |

Selection rule: **≥2 commands that genuinely go together.** Provenance alone is a bad rule — the
mined library's biggest entry (`assign-sample`, 51 rows) wraps one command 1:1, and 22 of the 36
mined entries are such wrappers. Per [SKILL_CATALOG_BOUNDARY.md](../SKILL_CATALOG_BOUNDARY.md),
`library.jsonl` is mined and must not be hand-authored, so it was read as evidence only.

## Why option 1 (mine from real session logs) is impossible

- `mosh-log.jsonl` has **no natural language** — across 2,840 records the key set is exactly
  `{ts, seq, command, args, ok, undoable, error}`. A skill needs a description and triggers.
  **Running more sessions would not change this.**
- `service/skills/mine.py` does not read session logs; it mines
  `service/sft/a3b-r4-cuda_next_run_examples.rendered.jsonl` (189 SFT rows).
- Volume fails separately: 79% of the log is 11–13 June 2026 dev traffic, and 61 entries call
  `add_neural_insert`, deleted 2026-06-21.

The enabler is teaching the JSONL writer to record the utterance; spun off as its own ticket.
*(Trap: `mine.py --help` ignores the flag and re-runs the miner, overwriting `library.jsonl`.
Deterministic, so harmless — but a footgun.)*

## Not portable — schema limits, not oversights

- **Anything needing an id returned by an earlier command.** The template language is declarative,
  so `create_bus` → `add_send(bus: ?)` cannot chain. `send_to_bus` therefore targets an existing
  bus; `add_builtin_effect` makes the chain `index` an explicit slot both commands read.
- **`add-note-pattern` / `add-note-from-note-names`** (provenance 20 each) need `list<note>` slots;
  `SkillSlot` is string/number/boolean only.

## Verification

```
tsc clean · skills+harness+contract 196 · skillsFsB2 19 · full vitest 2044 passed, 1 skipped
skillCatalogBoundary.test.ts 12/12 (main's FS-B1a guard, pulled into a scratch copy with the
  moshops_catalog.py projection fix it validates, then restored — re-run after merge)
grep SABOTAGE clean
```

All five preconditions RED-proved. **The contract test earned its keep:** the first
`add_builtin_effect` template put `set_plugin_param` under a flat `if_present("paramIndex")`,
leaving optional `value` unguarded — a caller passing only `paramIndex` would have emitted an
unbound arg. Fixed by nesting.

## Status: still BLOCKED

These five skills are the same shape as the eight that already ship — `arrange_beat` is already
four commands — so they inherit FS-B1's documented, conservative `rolledBack: false` on ambiguous
transport loss and make nothing worse. But the gate above ("never partial mutations") is **not**
met, and the honest reading is:

- item 3 — the native transaction slice is **unmerged** (branch `codex/fs-b2-transaction-prereq`);
- item 4 — crash-interrupted open transactions are not resolved by T2;
- item 5 — no real-engine run has proved exact commit and exact rollback.

Backlog row therefore returns to `blocked`, on the transaction prerequisite rather than on O2.
