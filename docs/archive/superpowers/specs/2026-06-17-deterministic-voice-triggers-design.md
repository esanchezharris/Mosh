# Deterministic voice triggers + performer mode — design

*Status: design (brainstormed 2026-06-17). Branch: `claude/voice-triggers` off `main`. Next: implementation plan via writing-plans.*

## Context & motivation

The agentic-composing work (knowledge flywheel) is paused. The near-term role for the agent is **fast, hands-free control of the DAW**. Today every utterance goes to the LLM brain (`brain.ts` → API, ~2–5 s, costs a key). But a large class of commands are **unambiguous** — "start recording", "let me hear that again", "keep that take", "undo" — and should fire **instantly, locally, with no API call**.

The motivating workflow is a **hands-free take-recording loop** for a performer recording **audio** (mic/interface): *put me in → perform → (engage Moshi) → hear it back → do it again → keep that take.* Recording is a **mode** you're "in" until you re-engage Moshi.

Inspired by the owner's prior **DAWN** REAPER assistant (`~/Downloads/DAWN 2/`): a state-aware command FSM + fuzzy phrase matching + filler normalization. We adopt that backbone and improve it for Mosh (live snapshot state vs a tracked FSM; MoshOps commands vs simulated keystrokes; a dependency-free TS matcher).

## Goals

- Known, unambiguous phrases (typed or spoken) fire DAW actions **before** the LLM, **no API call**.
- A hands-free **take-recording loop**: arm → record takes onto **separate take lanes** → audition → "keep that take".
- **Robust to STT noise** (fuzzy + filler stripping) but **safe**: ambiguous input falls through to the LLM unchanged.

## Non-goals (v0)

- Verbal "Moshi" wake-word to exit recording — **deferred** (v0 exits via the talk button). Built next.
- MIDI takes (audio only), comp-section *splicing* (we keep/flatten whole lanes), track-name-targeted commands ("mute the bass" stays with the LLM).

## Branch-base reality (main)

Built off `main`, which has the base voice/agent UI **and** the recording C++ (`arm_track`, `stop_recording`, `set_input_monitor`, `undo`, `redo`, `save`, and an **action-based** `cmdSetTransport` — `action` ∈ play/toggle/stop/record/to_start/to_end + `loop`). But main's **TS agent catalog (`ui/src/agent/commands.ts`) is the old narrow one**: `set_transport` is declared `{playing, position}` and there's no `arm_track`/`undo`/`save`. So part of this feature is **widening the TS catalog to match the C++ that already exists** (mechanical; arg names verified against `src/moshops/MoshOps.cpp`). Only the **take commands** are genuinely new C++.

## Architecture

Two layers and one small state machine.

### 1. The fast path (TS, runs before the LLM)

`AgentComposer.run(text)` ([ui/src/ui/AgentComposer.tsx](../../../ui/src/ui/AgentComposer.tsx):34) currently calls `brain.send(text)` immediately. Insert:

```
const fast = matchFastPath(text, ctx);   // ctx = { mode, snapshot, focusedTrackId }
if (fast) { await handleFast(fast); return; }   // local, no API
const reply = await brain.send(text);     // unchanged fallthrough
```

`handleFast` reuses the existing downstream — `runAgentBatch` ([executor.ts](../../../ui/src/agent/executor.ts):14) → `exec` → `executeCommand` → MoshOps, plus Moshi's earcon (`pushAgentUtter`). The fast path produces the same `BrainReply`-shaped result locally. `brainMock.ts` stays as the **offline** fallback (separate concern).

### 2. The matcher — `ui/src/agent/fastPath.ts` (new, pure)

`matchFastPath(text, ctx): FastAction | null`. Pure, unit-tested, no DOM/bridge:
1. **Normalize** — lowercase; strip filler (`uh|um|like|okay|please|alright|just|so`); collapse whitespace; strip trailing punctuation (DAWN `normalize_command`).
2. **State-gate** — only rules valid in the current `mode` are candidates (so "yeah" is a candidate only in `reviewing`).
3. **Score** — `tokenSetScore(normalized, phrase)` ∈ [0,1], a dependency-free port of fuzzywuzzy `token_set_ratio` (sort+dedupe tokens, intersection-weighted). Best wins, with **exact-match priority** + **longest-phrase tiebreak** (DAWN).
4. **Threshold = the LLM gate** — best score < `THRESHOLD` (~0.75) ⇒ return `null` ⇒ the LLM handles it. Keeps "play the drums and add reverb" out while "play it" stays in.
5. **Parametrize** — extract a bar number when the matched rule wants one ("put me in at 8", "play from 5"; digits or spelled small numbers → bar → seconds via snapshot tempo/time-sig).

`FastAction` = `{ kind:"commands", commands, intent, say? }` or a transition `{ kind:"enterRecord"|"stopRecord"|"keepTake"|"navTake", delta?, bar? }`.

### 3. The mode FSM (small store slice; state derived from the live snapshot)

| mode | when | behavior |
|---|---|---|
| `idle` | not recording, no pending take | "put me in"→record; "play"/transport/undo/save; "from bar N"→seek |
| `recording` | `snapshot.transport.recording` | recognizer idle (hands on instrument); **holding the talk button → stopRecord** (lands the take lane → `reviewing`) |
| `reviewing` | just recorded; focused clip has take lanes (UI flag `takeDecisionPending`) | "keep that"/"yeah"→keepTake; "nah"/"again"/"do that again"→re-record; "let me hear that"/"next take"/"previous take"→audition; idle phrases too |

`recording` comes from the snapshot; `takeDecisionPending` is set by `stopRecord`, cleared by `keepTake`/new-record. Short affirmations (`yeah`/`nah`/`no`) are candidates **only** in `reviewing` — neutralizing their ambiguity.

### 4. Take **lanes** (engine work)

**Takes go on separate lanes, not stacked into one clip** (owner's explicit preference). Each pass records as its own clip on its own lane so they're all visible and individually auditionable; "keep that take" keeps one lane and removes the rest (undoable).

- **First implementation question to resolve (read Tracktion + Mosh's clip/lane model):** the cleanest "separate lanes" mechanism — Tracktion's take tree surfaced as lanes, vs recording each take to a dedicated take-lane (sub-)track grouped under the armed track. Pick the one that's clean in *both* the engine and Mosh's arrangement UI. This is the riskiest unknown — settle it before the rest of the C++.
- **New MoshOps commands** (established handler pattern: validate → `beginTxn` → Tracktion call → emit → JSONL → result; + the catalog↔`MoshOps.cpp` contract test):
  - `list_takes { clipId }` — read-only.
  - `set_current_take { clipId, takeIndex }` — select/solo a lane for audition (undoable).
  - `keep_take { clipId }` — keep the current lane, remove the others (**undoable; preserve source files**).
- **Snapshot:** expose `takes` / `currentTakeIndex` / `numTakes` (or the lane structure) on the relevant clip so the UI/fast-path know the take context.
- **Catalog widening (TS):** add to `commands.ts` (handlers already in main's C++): action-based `set_transport` (`action`, `loop?`, `position?`), `arm_track`, `stop_recording`, `undo`, `redo`, `save`, plus the new take commands — args verified against `MoshOps.cpp`.

## The command vocabulary (state-aware; DAWN-style aliases — table lives as data in `fastPath.ts`)

**Record / take loop**
- record (`idle`/`reviewing`): "put me in", "come in", "let's go", "start recording", "record", "i'm ready", "punch in"
- record-at-bar: "put me in at <bar>", "let me go in at <bar>"
- keep (`reviewing`): "keep that take", "keep that", "keep it", "save that", "that's the one", "that's good", "yeah"
- redo / another take (`reviewing`): "do that again", "try that again", "again", "one more", "another take", "nah", "no"
- audition current (`reviewing`): "let me hear that again", "play that back", "run it back", "playback"
- audition lanes (`reviewing`): "next take"/"the next one" → navTake(+1)+play; "previous take"/"go back a take" → navTake(−1)+play

**Transport (global)**
- play: "play", "play it" → `set_transport{action:"toggle"}`
- stop: "stop", "that's enough", "cut", "hold on", "wait" → `set_transport{action:"stop"}` (or `stopRecord` if recording)
- from the top: "from the top", "take it from the top", "back to the start" → `set_transport{action:"to_start"}`
- from a bar: "play from <bar>", "go to bar <bar>" → seek + play
- loop: "loop it", "turn on looping" → `set_transport{action:"toggle", loop:true}` (or the loop-set form)

**History / save (global)**
- undo: "undo", "undo that", "scratch that" · redo: "redo" · save: "save", "save it"

## Data flow — the performer loop

1. **"put me in"** → `matchFastPath`(idle) → `enterRecord`: arm the focused audio track (graceful no-op + Moshi "can't, no input" if no device), set the take-lane record over the loop region, `set_transport{record}` → snapshot `recording` → mode `recording`, Moshi "in" earcon. Recognizer idle.
2. *(perform; hold the talk button when done)* → button sees `recording` → `stopRecord` (`stop_recording` lands the take on its lane) → `takeDecisionPending` → `reviewing` → recognizer listens.
3. **"let me hear that again"** → play the current take lane from its start.
4. **"next take"** → `set_current_take(+1)` + play (audition the lanes).
5. **"do that again"** → `enterRecord` again → another take on a **new lane**.
6. **"keep that take"** → `keep_take` → keep the current lane, remove the others (undoable), `takeDecisionPending=false`, Moshi confirm.

## Error handling

- **No input device** (headless / no interface): `arm_track` → `applied:false` → Moshi "can't — nothing to record into" (never silent).
- **Matched-but-inapplicable** ("keep that take" with no takes): friendly Moshi no-op earcon — do **not** fall to the LLM.
- **No match / below threshold**: fall through to the LLM unchanged.
- **Ambiguous-by-design** (track-targeted, fuzzy intents): never fast-pathed.

## Testing

- **`fastPath.test.ts`** (pure): each intent's aliases → expected `FastAction`; **state-gating** ("yeah"→keepTake only in `reviewing`, →null in `idle`); **anti-false-match** ("play the drums louder"→null→LLM); threshold; **bar extraction** ("put me in at bar eight"→8).
- **`tokenSetScore` tests**: exact=1, filler-tolerant, order-invariant, below-threshold on unrelated text.
- **mode FSM**: `stopRecord`→`reviewing`; `keepTake`/new-record clears it; button-stops-recording.
- **catalog contract**: the widened catalog args match `MoshOps.cpp` (the existing parser test if present on main, else a new one).
- **C++ take commands**: extend `Mosh --selftest` — record→lanes→`set_current_take`→`keep_take`; snapshot take field. (Live capture stays headless-gated.)
- No `npm test` regressions; `tsc` clean.

## Risks / verify first

1. **Take-lane mechanism** (the big one) — resolve how Tracktion + Mosh's UI represent separate take lanes before building the take C++ (see §4). Owner's directive: separate lanes, not stacked.
2. **Catalog ↔ C++ arg names** — main's C++ is action-based; verify each widened catalog entry's args against `MoshOps.cpp` so the executor's `validateCommand` doesn't reject valid calls.
3. **Matcher precision** — tune `THRESHOLD`; the anti-false-match tests are the guardrail.
4. **Focused-track resolution** — "put me in" target: focused/selected track, else first armed audio track, else first audio track; Moshi asks if none.

## Build order

1. **`tokenSetScore` + `matchFastPath` + rule table** (TS, pure, TDD) — the heart, fully offline. *(No branch-base dependency; start here.)*
2. **Catalog widening** (`commands.ts`) to expose main's existing transport/record/history C++ + a contract check.
3. **Mode FSM slice + `handleFast` + the `AgentComposer.run` hook + talk-button-stops-recording.**
4. **Resolve the take-lane mechanism**, then the take C++ commands + snapshot field (+ selftest + contract).
5. **Wire end-to-end**; verify the performer loop on the real app (or the command harness where capture is headless).

*Reference: `~/Downloads/DAWN 2/{state_machinefuzzy,state_machine,main}.py` — the FSM + fuzzy-match + filler-normalize + push-to-talk-auto-pause logic this design adapts.*
