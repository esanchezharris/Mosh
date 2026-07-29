# One session renderer — closing the single-shot prompt's master/key/tempo-map blind spot

**Date:** 2026-07-28
**Status:** design, approved for planning
**Fixes:** MoshAgentBench `master-trim` 0/10 on `--runner single` (5/5 on `--runner loop`)

---

## 1. The problem

There are two session renderers, and the shipped single-shot path uses the poorer one.

| | `richSessionBlock` (loop) | `compactSnapshot` (single-shot, shipped) |
|---|---|---|
| module | `ui/src/agent/loop/loopPrompt.ts:42` | `ui/src/agent/brainCore.ts:15` |
| tempo + time sig | yes | yes |
| tempo map, with the indices `remove_tempo_change` takes | yes | **no** |
| session key | yes | **no** |
| master volumeDb / pan / chain | yes | **no** |
| buses | yes | **no** |
| per-track pan, sends | yes | **no** |
| sections, tracks, clips (quoted ids) | yes | yes |

`richSessionBlock` is a strict superset of `compactSnapshot`. There is no field the
compact renderer shows that the rich one does not.

The measured cost: the native master fader defaults to **−3 dB**. Asked to "pull the
master down a couple dB", a single-shot model cannot see the current value, so it emits
an absolute `set_master_volume` chosen as if the fader sat at 0 — which grades as moving
*up*. The bench note is literally `master volumeDb Δ1.0 not down within [1,6]`.

This is a **prompt visibility bug, not a model failure**, and it is distinct from the
builtin-vocabulary fix that already landed. The loop path scores 5/5 on the same task
with the same models, which is the control.

The blind spot is wider than master. The pin fixture in
`loopPrompt.test.ts` carries `key: { tonic: "C", mode: "major" }` — the shipped
single-shot prompt drops the key on a session that has one.

## 2. Why this was left alone

Moving `compactSnapshot` is not a local edit. Three things are coupled to its exact bytes:

1. **`ui/src/agent/loop/loopPrompt.test.ts:146`** carries a sha256 pin of
   `systemPrompt(FIXTURE)`. It is deliberately a tripwire on the shipped
   SFT/GEPA/bench prompt surface.
2. **`service/sft/build_add_note_corrective.py:187`** hand-mirrors `compactSnapshot` in
   Python as `render_session()`. It parses `commands.ts` for the catalog (so the catalog
   cannot drift) but **hand-copies the session render** — so a session-render change is
   precisely the change that requires editing the Python.
3. **189 rows of checked-in SFT corpora** have the compact render baked into their
   `system` field: `add_note_corrective.jsonl` (40), `assist_demonstrations.jsonl` (35),
   `r5_train_additions.jsonl` (105).

None of these are reasons not to fix it. They are the work.

## 3. Design

### 3.1 One renderer, in its own module

Create **`ui/src/agent/sessionRender.ts`** exporting `renderSession(snap: Snapshot): string`
— the current `richSessionBlock` body, moved **verbatim**.

Both prompt builders import it:

- `loopPrompt.ts` deletes its local copy and imports `renderSession`.
- `brainCore.ts` deletes `compactSnapshot` and imports `renderSession`.

Every single-shot consumer picks the change up with no call-site edit: the app
(`brain.ts`), the bench (`bench/singleShotRunner.ts`), `gepa/metric.ts`,
`sft/buildDataset.ts`, and the probe/harvest scripts.

**Why a new module rather than exporting from `brainCore`.** `brainCore.ts` is the
byte-frozen serving core — its header says so, and the pin exists to keep it that way.
A dedicated, named module makes "one renderer" a property of the import graph rather
than a convention, and gives the Python mirror a single unambiguous file to point at.
`loopPrompt.ts` already imports from `brainCore` (`INTENTS`), so either direction is
acyclic; this is a clarity call, not a correctness one.

**Moved verbatim.** `richSessionBlock` casts `t as { sends?: ... }` even though
`Track.sends?: Send[]` exists on the real type (`ui/src/types.ts:364`). Cleaning that up
is a separate, type-level change; keeping the move byte-verbatim keeps the loop path's
output provably unchanged.

### 3.2 The pin moves deliberately

Update the hash at `loopPrompt.test.ts:146`, following the convention already in that
file: new hash, a `Previous pin:` line carrying the old one, and a written reason
recording that the session render was unified and what that adds.

**Add a behavioural assertion beside it.** A moved hash proves *something* changed, not
that the right thing did — and this repo's recurring failure mode is verification that
cannot fail. Assert directly on the shipped prompt:

```ts
expect(systemPrompt(fixture)).toContain("master: 0dB pan 0 chain:[empty]");
expect(systemPrompt(fixture)).toContain("key: C major");
```

For the pin fixture (master `volumeDb: 0`, `pan: 0`, no plugins, key C major, no tempo
map, no buses) the diff is exactly two added lines. The rest of the prompt is untouched.

### 3.3 The Python mirror gets synced *and* a parity test

`render_session()` in `build_add_note_corrective.py` is updated to mirror
`renderSession` for the one-track/one-MIDI-clip fixture shape it targets.

Then **add the parity check that does not exist today.** The docstring's "kept in sync
by hand" is a claim about two files staying equal with nothing enforcing it — the exact
shape of assertion this repo's worklog says ages into a lie. The check renders the same
fixture through both implementations (Python directly, TypeScript via `tsx`) and asserts
byte-equality, so the next person to touch either renderer is told immediately.

**It lives in vitest** (`ui/src/agent/sessionRender.parity.test.ts`), shelling out to
`python3` for the Python render — not on the Python side beside the mirror, which is the
tempting placement and the wrong one.

The reason is which direction drift actually travels. The renderer is TypeScript; the
Python is the copy. Drift happens when someone edits the TypeScript and forgets the
mirror — which is exactly what this whole spec is repairing. The cheap gate's Python
suite is path-scoped to `service/`, so a guard living there would stay silent for
precisely the edit that breaks it. In `ui/`, a TypeScript renderer change trips it.

This is the durable part of the change. The renderer fix is worth ~1 bench category; the
parity test is worth every future session-render edit.

### 3.4 SFT corpora

- **Regenerate** `add_note_corrective.jsonl` and `assist_demonstrations.jsonl`. Both come
  from deterministic builders with no model calls (`build_add_note_corrective.py`,
  `build_assist_sft.mts` over checked-in fixtures + ledger), so the regeneration is
  verifiable by re-running and byte-diffing.
- **Leave `r5_train_additions.jsonl` (105 rows) alone**, with a documented staleness note
  for the next local-seat training run. It has no builder — a hand rewrite of the system
  field would be mechanical but unverifiable, which is worse than a known-stale file.

This leaves the corpora in a mixed state, deliberately and in writing. The consumer is
the local r5 seat, a research lane with no training run pending; the shipped seat is a
cloud model that reads the prompt live.

### 3.5 Docs

`docs/agent-bench/README.md` ("Reading results honestly") and
`docs/agent-bench/BASELINE_2026-07.md` §2 both currently assert the blind spot exists and
tell the reader to discount master/tempo-map failures. Both become **wrong** on landing.
Update them to record that the blind spot is closed, when, and what the measurement showed
— keeping the baseline's historical numbers intact as history.

## 4. Verification

Ordered, and no step is allowed to stand in for another.

1. `cd ui && npm run typecheck && npm test` — green, with the vitest count reported.
2. **RED-prove the parity test**: perturb one renderer, confirm the parity check fails,
   restore, confirm it passes. A sync guard that has never been seen to fail is not a
   guard. Sabotage via absolute path; `grep SABOTAGE` before landing.
3. **RED-prove the behavioural pin assertions** the same way — they must fail against the
   pre-change renderer.
4. Regenerate both corpora; re-run the builders and byte-diff to confirm determinism.
5. Bench, per §5.

## 5. Measurement

Per-task grading is binary, so a single run over a 3-task category can only ever score
0/33/67/100% — one run proves nothing.

**Primary — the targeted claim.** 10 repetitions:

```
cd ui && npm run agent-bench -- --claude-cli --model claude-sonnet-5 --runner single \
  --tasks master-glue,master-eq-before-comp,master-trim --tag <tag> --no-render \
  --bin /Users/emiliosanchez-harris/Mosh/build-macos-arm64-release/Mosh_artefacts/Release/Mosh.app/Contents/MacOS/Mosh
```

Baseline to beat (single runner, 10 reps/arm, after the vocabulary fix):
**master-glue 10/10 · master-eq-before-comp 8/10 · master-trim 0/10.**

**Secondary — regression sweep.** 3 full 34-task single-runner sweeps. The single-shot
prompt changes for *every* task, not just these three; a targeted-only measurement is
structurally blind to collateral damage. 3 reps will not resolve a small per-task shift,
and the report must say so rather than implying it clears the suite.

**Every repetition gets a DISTINCT `--tag`.** The bench derives its engine session dirs
from the tag (`ab-<tag>-<task>-s<step>`); a reused tag makes concurrent or repeated runs
clobber each other's artifacts mid-run.

## 6. Out of scope

- Any change to `LOOP_RULES`, `DEFAULT_RULES`, or the command catalog.
- Re-optimizing GEPA against the new prompt.
- Retraining the local r5 seat.
- Dropping the `sends` cast (§3.1).

## 7. Risks

| Risk | Mitigation |
|---|---|
| The longer prompt shifts unrelated bench categories | The §5 regression sweep, reported honestly including its low power |
| Python/TS mirrors drift again later | §3.3 parity test — the point of the change |
| Trained local seat now mismatches the serving prompt | Documented in §3.4; the shipped seat is unaffected |
| Larger prompt at high track counts (~103 chars/track today) | The added lines are per-session, not per-track; per-track growth is pan/sends only, both conditional |
