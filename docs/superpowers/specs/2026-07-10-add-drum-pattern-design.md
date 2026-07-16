# `add_drum_pattern` — MoshOps composite command (pattern-string DSL) — design

*Owner-approved 2026-07-10. Inspired by opendaw-mcp's pattern-string DSL: lay a whole drum
grid in ONE undoable MoshOps command instead of 16+ `add_note` calls.*

## Decisions (confirmed with the owner)

1. **Targeting:** optional `clipId` with **per-lane replace** — only the lanes named in the
   pattern are cleared, then re-laid; without `clipId` a new clip is created.
2. **Tiling:** a lane string shorter than the total step count **tiles** when its length
   divides evenly (`"x."` → 8th-note hats); otherwise a clear error.
3. **Track policy — auto-fix to drum track:** no `trackId` → create a "Drums" drum track;
   instrument-less track → set `trackType:"drum"` + load the kit in the SAME transaction;
   track with an instrument → left untouched (melodic-808 / custom-kit safe); track holding
   wave audio → error (a front-of-chain sampler silences wave clips).

## Command contract

```
add_drum_pattern {
  pattern,              // REQUIRED — object { kick: "x...x...x...x...", ... }
                        //         OR flat string "kick: x...x...; snare: ....x..."
                        //         (string form is what the agent catalog declares — ArgType
                        //          is only string|number|boolean; the seam accepts both)
  trackId?,             // target track; omitted → create new "Drums" track (type drum)
  clipId?,              // target existing MIDI clip → per-lane replace; trackId ignored
  stepsPerBar? = 16,    // int, validated 1..64
  bars?,                // int 1..16; DEFAULT = max(1, ceil(longestLane / stepsPerBar));
                        // explicit bars smaller than a lane string → error
  velocity? = 100,      // 1..127, velocity of 'x' hits
  start? = 0.0,         // seconds, new-clip position (ignored with clipId)
  name? = "Drums"       // new-clip name (not in agent catalog, like add_midi_clip's name)
}
→ { clipId, trackId, noteCount, steps, bars }     // undoable ✓ · snapshot_invalidated
```

## Pattern DSL

Identical parser semantics in C++ (`src/moshops/DrumPattern.h`) and TS
(`ui/src/ui/drumPatternUtil.ts`), pinned by mirrored golden-vector suites:

- `x` = hit at `velocity`; `X` = accent hit at 127; `.` or `-` = rest
- `|` and whitespace are ignored (cosmetic bar separators); any other char → error naming it
- a lane string tiles to `totalSteps = stepsPerBar × bars` when its length divides evenly,
  else error; a lane longer than `totalSteps` (with explicit `bars`) → error
- an all-rest named lane still registers for per-lane clear, with zero hits
- note length = one step; step start = `step × (beatsPerBar / stepsPerBar)` beats,
  clip-local (mirrors `stepBeats`/`stepStartBeats` in `ui/src/ui/drumGrid.ts`, swing 0);
  `beatsPerBar` = time-signature numerator at the clip start

Lane keys (case-insensitive; spaces/underscores/hyphens stripped) — MUST mirror
`kDefaultKit` (src/moshops/MoshOps.cpp) and `DRUM_LANES` (ui/src/ui/drumGrid.ts):

| key aliases | pitch |
|---|---|
| kick | 36 |
| snare | 38 |
| clap | 39 |
| hat, hihat, closedhat, ch | 42 |
| openhat, oh | 46 |
| lowtom | 45 |
| midtom | 47 |
| crash | 49 |
| integer key 0–127 | raw pitch (custom pads / melodic 808) |

Unknown key (e.g. "cowbell") → error naming it.

## Semantics

- Validate + parse + resolve target + wave-clip scan BEFORE `beginTxn` (clean-error
  discipline); then ONE transaction covers track-create / type-set / kit-load / clip-create /
  lane-clear / all note-adds. No nested `execute()` of other commands.
- clipId path skips all instrument/type policy (mirrors `add_note`) and fires `reactiveTouch`.
- Lock scope: **Track** (it can create clips and mutate track instrument/type). The
  `lockKeyFor` Track branch gains a clipId→clip→track fallback so the clipId-only form
  can't slip past a peer's track lock.
- Result data `{clipId, trackId, noteCount, steps, bars}`; JSONL-logged undoable; emits
  `snapshot_invalidated`.

## Test surface

Catch2 golden vectors (`tests/test_drum_pattern.cpp`) ≡ vitest golden vectors
(`ui/src/ui/drumPatternUtil.test.ts`); behavioural mock suite
(`ui/src/bridge.mock.drumpattern.test.ts`); `--selftest` section "add_drum_pattern (DRM-002)"
(notes at expected beats/velocities, per-lane replace, undo restoring both paths, track
policy incl. melodic-808-untouched and wave-audio-error, error matrix, 3/4-time check);
agent-catalog contract test; e2e smoke on the isolated config.
