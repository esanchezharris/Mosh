# Moshi Trajectory Format — Phase 0 (harvester + verifier)

The closed-loop dataset Moshi trains on is a stream of **`(snapshotBefore, utterance,
command-sequence, snapshotAfter, outcome)`** tuples distilled from the app's MoshOps
JSONL command log. This doc is the source of truth for the tuple format, the turn
marker it depends on, the outcome-inference rules, and the verifier verdict.

Code: [`ui/src/harvest/`](../ui/src/harvest/) — `tupleSchema.ts`, `verifier.ts`,
`harvester.ts`, `outcome.ts`, `cli.ts`. All TypeScript, runs headless (no native
build, no audio, no Python) over the JS mock backend ([`bridge.mock.ts`](../ui/src/bridge.mock.ts)).

---

## 1. The log-shape question — resolved (Branch B)

**Q: does each logged command already carry a turn/utterance id?** No. Each line of
`~/Library/Mosh/session/mosh-log.jsonl` is `{ts, seq, command, args, ok, error?,
undoable}` (writer: [`MoshOps::logLine`](../src/moshops/MoshOps.cpp)), with no field
linking a command to the utterance that triggered it, and no agent-vs-human marker.

This is **Branch B** (flat stream, no turn linkage) — but the minimal fix needs **zero
C++ change**:

- Agent turns are already bracketed by `batch_begin` / `batch_end`.
- `cmdBatchBegin` reads only `name` but **logs the whole `args` var verbatim**.
- So the TS executor enriches `batch_begin`'s args with provenance, which rides the
  **existing log path**. It is **not** a new MoshOps command, **not** a second log,
  **not** a change to the seam.

Direct-manipulation (human UI) commands are never wrapped in a tagged batch, so the
agent-vs-human split stays clean.

### Turn marker contract

`runAgentBatch(label, calls, meta?)` ([`executor.ts`](../ui/src/agent/executor.ts))
emits:

```json
{ "command": "batch_begin",
  "args": { "name": "<undo label>",
            "turn_id": "<uuid>",
            "utterance": "<user text>",
            "source": "brain_chat" | "voice" | "fastpath" } }
```

`turn_id` is a fresh UUID per turn. `utterance` defaults to `label`. `source` defaults
to `brain_chat`. Wired callers (in [`AgentComposer.tsx`](../ui/src/ui/AgentComposer.tsx)):
the LLM/brain path tags `brain_chat` with the typed/spoken text; the text fast-path tags
`fastpath`; the hands-free path tags `voice` (its transcript isn't threaded yet, so the
utterance falls back to the action label — a documented v1 gap).

> Turns logged **before** this marker shipped have a `batch_begin` with no `turn_id`.
> The harvester treats them as legacy/untagged: their commands still advance replay
> state but they produce **no tuple**. The moat data accumulates cleanly from the
> marker onward.

---

## 2. Tuple schema (v1)

`TUPLE_SCHEMA_VERSION = 1`. One JSON object per JSONL line.

```ts
{
  schemaVersion: 1,
  kind: "imitation",                 // SFT / behavioral-cloning — NOT verified-reward RL
  turnId: string,
  utterance: string,
  source: "brain_chat" | "voice" | "fastpath" | "unknown",
  ts: number,                        // wall-clock ms of the turn's batch_begin
  seq: { begin: number, end: number },
  snapshotBefore: Snapshot,          // reconstructed via replay (see §4)
  snapshotAfter:  Snapshot,
  commands: [
    { command, args, ok, error?, agentCallable }   // ok = the live (log) outcome
  ],
  outcome: {
    appliedClean: boolean,           // every command returned ok in the live run
    replayClean:  boolean,           // every command cleanly validated + applied on replay
    undone: boolean,                 // reverted by a later undo (net of redo)
    taste: [ { kind: "accept_render" | "reject_render", clipId?, seq } ]
  },
  provenance: { logPath: string, harvestedAt: string }
}
```

`kind: "imitation"` is explicit per the spec: importer- and log-derived trajectories are
behavioral-cloning data, not reward-grade rollouts. The verifier (§5) produces reward
signal separately.

---

## 3. Outcome inference

- **`appliedClean`** — AND of the `ok` flags the live run recorded for the turn's commands.
- **`replayClean`** — every command in the turn cleanly **validates** (agent allowlist +
  arg types) and **applies** (returns ok) when replayed through the mock. This diverges
  from `appliedClean` when the mock can't reproduce a command that succeeded live (e.g. a
  render on a clip that only exists in the native session) — an honest fidelity signal,
  not a crash.
- **`undone`** — the log is append-only, so we model Tracktion's undo stack at the log
  level ([`outcome.ts`](../ui/src/harvest/outcome.ts)): each completed turn is one undo
  unit; each standalone undoable command outside a batch is its own unit; `undo` pops the
  most-recent unit, `redo` re-applies, a new unit clears redo. A turn is `undone` iff its
  unit ends the session popped. (So an `undo` after an interleaved manual edit reverts the
  manual edit, **not** the earlier turn.)
- **`taste`** — `accept_render` / `reject_render` are explicit user taste labels carrying a
  `clipId`. Each is associated with the most-recent preceding turn that referenced that
  `clipId`.

---

## 4. Snapshots — reconstructed via replay

The live log stores commands, not snapshots. The harvester replays the **whole** log once
through a freshly-seeded mock backend (O(n)), applying every command — including untagged
human commands and undos, to keep state faithful — and captures `snapshot()` at each
turn's `batch_begin` (→ `snapshotBefore`) and `batch_end` (→ `snapshotAfter`).

**Fidelity caveats:** the mock's seed (3 demo tracks) is not the native session's initial
state, and engine-assigned ids/peaks differ from native. Snapshots are therefore
*mock-relative and structural*, not byte-identical to native. For SFT the load-bearing
signal is the utterance + command sequence; the snapshots are context. The structural
diff (`snapshotDiff`) ignores volatile keys (`id`, `logicalId`, `ts`, `peaks`, `levels`)
so re-runs and mock-vs-native noise don't read as real changes.

---

## 5. Verifier verdict

[`replay(commands, opts?)`](../ui/src/harvest/verifier.ts) → the deterministic rollout/eval
substrate reused by GEPA/SFT/GRPO:

```ts
{
  cleanValidate: boolean,   // every command passes the agent allowlist + arg-type check
  cleanApply:    boolean,   // every applied command returns ok
  perCommand: [ { idx, command, validate: "ok"|<reason>, apply: "ok"|"error"|"skipped", error? } ],
  finalSnapshot: Snapshot,
  diff?: { equal, changes }  // present when opts.target is supplied
}
```

Invalid commands are `skipped` (never sent to the seam, mirroring `runAgentBatch`).
`opts.startCommands` seeds a prefix; `opts.target` adds a structural diff vs a goal
snapshot. `batch_begin`/`batch_end` bypass the allowlist check (structural) but still apply.

---

## 6. Running it

```sh
cd ui

# Harvest the live session log → versioned tuples (defaults to
# ~/Library/Mosh/session/mosh-log.jsonl when no path is given)
npm run harvest -- [<mosh-log.jsonl>] -o tuples.jsonl

# Verify a command sequence: [ {command,args}, ... ] or { commands, target? }
npm run verify -- <commands.json> [--target snapshot.json]
#   exit 0 = clean-validate + clean-apply (+ diff.equal if a target was given), else 1

# Tests
npm test            # vitest: harvest suites + the rest of the UI
npm run typecheck   # tsc (src) + tsc (e2e)
```
