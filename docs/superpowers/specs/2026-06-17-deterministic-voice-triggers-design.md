# Deterministic voice triggers + performer mode — design

*Status: design (brainstormed 2026-06-17). Next: implementation plan via writing-plans.*

## Context & motivation

The agentic-composing work (knowledge flywheel, mining) is paused. The near-term role for the agent is **simple, fast, hands-free control of the DAW**. Today every spoken/typed utterance goes to the LLM brain (`brain.ts` → API, ~2–5 s, costs a key). But a large class of commands are **unambiguous** — "start recording", "let me hear that again", "keep that take", "undo" — and should fire **instantly, locally, with no API call**.

The motivating workflow is a **hands-free take-recording loop** for a performer (recording **audio** through a mic/interface): *put me in → perform → (engage Moshi) → hear it back → do it again → keep that take.* Recording is a **mode** you're "in" until you re-engage Moshi.

This design is directly inspired by the owner's prior project **DAWN** (`~/Downloads/DAWN 2/`, a REAPER voice assistant): a state-aware command FSM + fuzzy phrase matching + filler normalization. We adopt that backbone and improve it for Mosh (live snapshot state instead of a tracked FSM; MoshOps commands instead of simulated keystrokes; a dependency-free TS matcher).

## Goals

- Known, unambiguous phrases (typed or spoken) fire DAW actions **before** the LLM, with **no API call**.
- A hands-free **take-recording loop**: arm → record multiple takes → audition → "keep that take".
- **Robust to STT noise** (fuzzy match + filler stripping) but **safe**: anything ambiguous falls through to the LLM unchanged.
- **Additive & TS-first**; the only backend work is ~5 small MoshOps commands exposing Tracktion's existing take system.

## Non-goals (v0)

- Verbal "Moshi" wake-word to exit recording — **deferred** (v0 exits via the talk button). Designed-for, built next.
- MIDI takes (audio only for v0), comp-section editing (splice), and track-name-targeted commands ("mute the bass" stays with the LLM).

## Architecture

Two layers and one small state machine.

### 1. The fast path (TS, runs before the LLM)

`AgentComposer.run(text)` ([ui/src/ui/AgentComposer.tsx](../../../ui/src/ui/AgentComposer.tsx) ~line 66) currently calls `brain.send(text)` immediately. We insert:

```
const fast = matchFastPath(text, ctx);   // ctx = { mode, snapshot, focusedTrackId }
if (fast) { await handleFast(fast); return; }   // executed locally, no API
const reply = await brain.send(text);     // unchanged fallthrough
```

`handleFast` reuses the **entire existing downstream** — `runAgentBatch` → `executeCommand` → MoshOps, plus the Moshi earcon (`pushAgentUtter`). The fast path just produces the same `BrainReply`-shaped result locally.

`brainMock.ts` stays as the **offline fallback** (separate concern: degrade when the proxy is down). The fast path is the new, intentional "skip the LLM for known phrases" layer.

### 2. The matcher — `ui/src/agent/fastPath.ts` (new, pure)

`matchFastPath(text, ctx): FastAction | null`. Pure, unit-tested, no DOM/bridge. Pipeline:

1. **Normalize** — lowercase; strip filler (`uh|um|like|okay|please|alright|just|so|yeah` — except where context-significant); collapse whitespace; strip trailing punctuation. (DAWN `normalize_command`.)
2. **State-gate** — select the candidate rules valid in the current `mode` (see FSM). A phrase like "yeah" is only a candidate in `reviewing`.
3. **Score** — for each candidate rule, a `tokenSetScore(normalized, phrase)` in [0,1] (a dependency-free port of fuzzywuzzy's `token_set_ratio`: sort+dedupe tokens, intersection-weighted similarity). Keep the best, with **exact-match priority** and **longest-phrase tiebreak** (DAWN's logic).
4. **Threshold = the LLM gate** — if best score < `THRESHOLD` (~0.75), return `null` → the utterance goes to the LLM. This is what keeps "play the drums and add reverb" out of the fast path while "play it" stays in.
5. **Parametrize** — extract a bar/measure number if the matched rule wants one ("from bar 5", "put me in at 8"; digits or spelled small numbers → number → seconds via snapshot tempo/time-sig).

`FastAction` is one of:
- `{ kind: "commands", commands: AgentCommandCall[], intent, say? }` — execute + Moshi reply.
- `{ kind: "enterRecord" | "stopRecord" | "keepTake" | "navTake", delta?: ±1, bar?: number }` — mode/take transitions handled by `handleFast`.

### 3. The mode FSM (a small store slice)

State is **derived from the live snapshot wherever possible** (no desync), plus one UI-local flag for "a take decision is pending":

| mode | when | what the talk-button / phrases do |
|---|---|---|
| `idle` | not recording, no pending take | "put me in"→record; "play"/transport/undo/save; "from bar N"→move |
| `recording` | `snapshot.transport.recording` is true | recognizer idle (hands on instrument); **holding the talk button → stopRecord** (lands takes → `reviewing`) |
| `reviewing` | just stopped recording; focused clip has takes (UI flag `takeDecisionPending`) | "keep that"/"yeah"/"that's good"→keepTake; "nah"/"again"/"do that again"→re-record; "let me hear that"/"next take"/"previous take"→audition; idle phrases still work |

`recording` and the transport bits come from the snapshot; `takeDecisionPending` is set by `stopRecord` and cleared by `keepTake` / a new record / moving on. Short affirmations (`yeah`/`nah`/`no`) are **only** candidates in `reviewing`, which neutralizes their ambiguity.

### 4. C++ take commands (expose Tracktion's existing system)

Recording already works (`arm_track`, `set_transport{record}`, `stop_recording` — all shipping). Tracktion already stores/loop-records/comps takes. We expose the missing read+select+keep, following the established MoshOps handler pattern (validate → `beginTxn` → Tracktion call → emit → JSONL → result) and the catalog↔`MoshOps.cpp` contract test:

- `list_takes { clipId }` — read-only; `WaveAudioClip::getTakes/getTakeDescriptions/getCurrentTake`.
- `set_current_take { clipId, takeIndex }` — `WaveAudioClip::setCurrentTake` (undoable).
- `keep_take { clipId }` — flatten to the current take via `deleteAllUnusedTakes(deleteSourceFiles=false)` (**undoable, files preserved**).
- **Snapshot:** extend wave-clip serialization with `takes`, `currentTakeIndex`, `numTakes` so the UI/fast-path know the take context.

`keep_take` deliberately does **not** delete source files, so Tracktion's UndoManager can restore the other takes.

## The command vocabulary (state-aware, DAWN-style aliases)

Each intent has many aliases (fuzzy-matched). Representative set; the table lives as data in `fastPath.ts`.

**Record / take loop**
- record (`idle`/`reviewing`): "put me in", "come in", "let's go", "start recording", "record", "i'm ready", "punch in"
- record-at-bar (parametrized): "put me in at <bar>", "let me go in at <bar>"
- keep (`reviewing`): "keep that take", "keep that", "keep it", "save that", "that's the one", "that's good", "that's a keeper", "yeah"
- redo / another take (`reviewing`): "do that again", "let me do that again", "try that again", "again", "one more", "another take", "nah", "no"
- audition current (`reviewing`): "let me hear that again", "play that back", "run it back", "let me hear that", "playback"
- audition other takes (`reviewing`): "next take" / "the next one" → navTake(+1)+play; "previous take" / "go back a take" → navTake(−1)+play

**Transport (global)**
- play: "play", "play it", "play that" → `set_transport{toggle}`
- stop: "stop", "that's enough", "cut", "hold on", "wait" → `set_transport{stop}` (or `stopRecord` if recording)
- from the top: "from the top", "take it from the top", "back to the start" → `set_transport{to_start}`
- from a bar (parametrized): "play from <bar>", "go to bar <bar>" → move + play
- loop: "loop it", "turn on looping" → `set_transport{loop:true}`

**History / save (global)**
- undo: "undo", "undo that", "scratch that" · redo: "redo" · save: "save", "save it", "save the project"

## Data flow — the performer loop

1. **"put me in"** → `matchFastPath` (idle) → `enterRecord`: arm the focused audio track (graceful no-op + Moshi "can't, no input" if no device), set/keep the loop region, `set_transport{record}` → snapshot shows `recording` → mode `recording`, Moshi "in" earcon. Recognizer idle.
2. *(perform; hold the talk button when done)* → button handler sees `recording` → `stopRecord` (`stop_recording` lands take(s)) → `takeDecisionPending=true` → mode `reviewing` → recognizer listens.
3. **"let me hear that again"** → play the current take from its start.
4. **"next take"** → `set_current_take(+1)` + play (audition the stack).
5. **"do that again"** → `enterRecord` again → a take stacks on the same clip/region → back to `recording`.
6. **"keep that take"** → `keep_take` → flatten to the current take (undoable), `takeDecisionPending=false`, Moshi confirm.

## Error handling

- **No input device** (headless / no interface): `arm_track` returns `applied:false` → fast path surfaces a Moshi "can't — nothing to record into" (intent HUH-ish), never a silent failure.
- **Matched-but-inapplicable** ("keep that take" with no takes): a friendly Moshi no-op earcon — do **not** fall to the LLM (intent was clear, just nothing to act on).
- **No match / below threshold**: fall through to the LLM unchanged (the safe default).
- **Ambiguous-by-design** (track-targeted, fuzzy intents): never fast-pathed; always the LLM.

## Testing

- **`fastPath.test.ts`** (pure, fast): each intent's aliases → expected `FastAction`; **state-gating** (e.g. "yeah" → keepTake only in `reviewing`, → null in `idle`); **anti-false-match** ("play the drums louder" → null → LLM); **threshold** behavior; **bar extraction** ("put me in at bar eight" → 8). The matcher is the highest-value unit to cover.
- **`tokenSetScore` unit tests**: exact=1, filler-tolerant, token-order-invariant, below-threshold on unrelated text.
- **mode FSM**: `stopRecord` → `reviewing`; `keepTake`/new-record clears it; button-stops-recording.
- **C++ take commands**: extend `Mosh --selftest` (the command-surface harness) — `list_takes`/`set_current_take`/`keep_take` dispatch + the snapshot `takes` field; the catalog↔`MoshOps.cpp` contract test covers the new args. (Live capture stays headless-gated, as today.)
- No `npm test` regressions; `tsc` clean.

## Risks / to verify in implementation

- **Take-stacking trigger** — confirm whether Tracktion stacks takes on linear re-record over a clip's region, or requires loop-record-enabled. If the latter, `enterRecord` sets loop-record on the region. (The one engine behavior to verify first.)
- **`deleteAllUnusedTakes` vs `CompManager::flattenTake`** — pick whichever cleanly keeps the current take + preserves source files for undo.
- **Focused-track resolution** — "put me in" needs a target track; use the UI's focused/selected track, else the first armed audio track, else first audio track; Moshi asks if none.
- **Matcher precision** — tune `THRESHOLD` so STT slop is tolerated without false-firing; the anti-false-match tests are the guardrail.

## Build order (for the plan)

1. `tokenSetScore` + `matchFastPath` + the rule table (TS, pure, TDD) — the heart, fully testable offline.
2. mode FSM slice + `handleFast` + the `AgentComposer.run` hook + talk-button-stops-recording.
3. C++ take commands + snapshot field (+ selftest + contract test).
4. Wire the take/record actions end-to-end; verify the performer loop on the real app (or the command harness where capture is headless).

*Reference: `~/Downloads/DAWN 2/{state_machinefuzzy,state_machine,main}.py` — the FSM + fuzzy-match + filler-normalize + push-to-talk-auto-pause logic this design adapts.*
