# r4-cuda gate RERUN — pre-registered amendment record (2026-07-09)

Recorded BEFORE the rerun results are seen (the §P8 honesty discipline).

## What the rerun is
The fix plan's step 4-5: serve the ARCHIVED `a3b-r4-cuda` adapter (unmutated,
sha `2f29b655…`) on a rented pod and re-read the gate surfaces after the
runtime/harness fixes landed on main (P0 #275 window-bug, P1 #283 split-point
normalization). No retraining; weights identical to the original read.

## Amendments (with reasons)

1. **Fixture repair (eval-side bug, not a goalpost move):** `evalA#split_clip#4/#5`
   asked to "split the Sub clip at 4 seconds" while the fixture's Sub tone clip
   spans [0, 3] — the literal correct command CANNOT succeed (P1 diagnosis doc).
   Repaired by extending the Sub fixture clip to 6 s in the floor set
   (`diag_floor4.eval.jsonl`; backup kept as `.pre-fixture-fix`).
2. **Lost rows disclosure:** the canonical 265-row evalA = a 210-row core file +
   a 55-row clip-families extension. The extension file was lost when the
   `ClaudeMosh-sft-cuda-r4-parity` worktree was removed (untracked `.sft-data`
   went with it). Floor coverage is UNAFFECTED: split_clip's 6 canonical rows
   survive verbatim (same ids) in `diag_floor4.eval.jsonl`; assign_sample /
   load_drum_kit / set_track_type live in the 210-row core. The 49 other lost
   rows are non-floor clip families that all scored well in the original read.
3. **Floor read source:** per-command floors for the four missed families are
   re-read from `diag_floor4` (split_clip) + the 210-row evalA core (the other
   three). The aggregate bar is NOT being re-litigated — it passed 0.889 at the
   original read; any rerun aggregate over the surviving subset is reported as
   context only.
4. **§B binary:** grounded apply runs against the current-main build (includes
   P1), not the original binary — that is the point: the fixes are what's
   being validated.
5. **Mock length-fidelity bug (discovered DURING the rerun, recorded before the
   re-read):** the first diag_floor4 pass (tag `a3b-r4-cuda-diagfloor4-rerun`,
   0.789 overall, split_clip 0.333) showed rows #0/#1/#3 rejecting the model's
   `time: 8` against a clip reported as [4, 8] — but the fixture is
   `add_midi_clip {start:4, length:8}` (intended [4, 12]). Root cause: the eval's
   mock engine hardcoded MIDI-clip `length: 4`, IGNORING the argument
   (`ui/src/bridge.mock.ts` add_midi_clip), while the real engine honors
   length-in-seconds (MoshOps.cpp cmdAddMidiClip → insertMIDIClip
   {start, start+length}). The model's literal answer was CORRECT and the
   harness rejected it — this also invalidates the r3/r4 "clip-relative
   emission" diagnosis those rows fed (the 94 offset-corrective v4 rows chased a
   phantom). Fix: mock honors `num(args.length, 4)`; RED-proven new vitest
   (`add_midi_clip length fidelity`), full vitest 840 green; floor re-read under
   tag `a3b-r4-cuda-diagfloor4-rerun2`. Row #2 (deferral on an explicit split
   ask) is unaffected by this bug and stays attributable to the model.

## Decision rule (unchanged from the fix plan)
Floors that clear post-fix ⇒ their misses were runtime/harness-caused, no new
SFT rows for them. Floors that still miss ⇒ genuinely model-caused ⇒ fold the
staged candidate rows (`a3b-r4-cuda_next_run_examples.*`) for those families
into `s2-mix-v5` and launch r5. If ALL floors clear ⇒ r4 effectively meets the
§P8 bar on the existing adapter — report to the owner before any r5 launch
(the pre-registration's "one clean read" language did not anticipate a
harness-bug rerun; the owner adjudicates).

## Rerun read (2026-07-10, recorded after the amendments above)

Pod `8300s0vr5qas70` (A100 80GB PCIe, $1.39/hr; supply unlocked by widening
`allowedCudaVersions` from ["11.8"] to 11.8–12.8 — the 11.8-only host filter was
the sole cause of the 50-minute SUPPLY_CONSTRAINT streak). Adapter uploaded and
sha256-verified vs the archive (`2f29b655…`) before serving.

| surface | original read | rerun | bar |
|---|---|---|---|
| split_clip floor (diag_floor4) | 0.000 | **0.833** | ≥0.5 ✓ |
| set_track_type floor (evalA core) | 0.42 | **0.500** | ≥0.5 ✓ |
| assign_sample floor (evalA core) | 0.33 | **0.333** | ✗ |
| load_drum_kit floor (evalA core) | 0.33 | **0.333** | ✗ |
| evalA (context; 210-row core vs orig 265) | 0.7925 | 0.848 (20 defer) | — |
| frozen300 | 0.9858 | **0.989** (0 defer) | — |
| aggregate(A,C) (context) | 0.889 | 0.919 | ≥0.75 ✓ |
| §B grounded (P1-carrying build-233 bin) | 0.919 (34/37) | **0.892 (33/37)** | ≥0.85 ✓ |

Result tags: `a3b-r4-cuda-diagfloor4-rerun`/`-rerun2`, `a3b-r4-cuda-A-rerun`,
`a3b-r4-cuda-C-rerun`, `sectionB.a3b-r4-cuda.default.json`; durable copies at
`~/Library/Mosh/rescue-20260709/rerun-evals/`.

**Amendment 5 executed mid-rerun:** the first diag_floor4 pass exposed the mock
`add_midi_clip` hardcoding `length: 4` (fixture `{start:4, length:8}` → phantom
[4,8] clip → the model's correct `time: 8` rejected). Fixed + RED-proven on main
as PR #286 before the floor re-read; split_clip 0.333 → 0.833 under the fixed
harness. This also refutes the r3 "clip-relative emission" mechanism — the
model emitted correct absolute times all along.

**Decision (per the rule above):** split_clip + set_track_type floor misses were
harness-caused → no new rows. assign_sample + load_drum_kit are model-caused
(deferrals on explicit asks; dropped set_track_type+load_drum_kit pairing; one
load_builtin misroute) → **informed r5**: 90 engine-validated corrective rows
(`genDrumSampler.mts`, PR #287; 48/21/21) folded with the 15 assist rows into
`s2-mix-v5` (12,994 train / 1,650 valid, 0 length-filtered, train sha
`3c4e2e8b2ecc3562…`). Pre-registration: §P9 in PROGRAM_STAGE1_2026-07.md.
