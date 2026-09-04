# Morning report — overnight run 2 (2026-09-02, 02:45 → ~07:30)

Run 1's report (palette-v2, preset seam, produce lane v1) is in git history at
`f18c18ee`. This one covers the produce lane actually producing.

## TL;DR

**The Mosh produce lane completed its first full beat.** Run `live3-sonnet`:
"produce me a dark jerk trap beat at 148 in D minor" → 9 tracks, 9 clips,
all 9 planned steps, 5.3 min, rendered to a 14 s 8-bar loop. The 808 obeys
every flywheel rule (6 pitches in 62-70, zero gaps, A≠B), every synth stays in
its register; the drums used only 4 of the 10 pads (prompt lesson already
promoted, see below). Everything is packaged for your ear at
`~/Library/Mosh/produce-ab/2026-09-02/audition.html`.

Your morning jobs (only you can do these):
1. **Export the corrected Live set** (`cATHARDIC_trap_r0_gen001.als`) as
   `A-flywheel.wav` into `~/Library/Mosh/produce-ab/2026-09-02/` — no bounce of
   it exists anywhere; the package ships the older `release-f0a3f525-final.wav`
   as a provisional A.
2. Open `audition.html`, listen (N next / K keep / Space swaps A↔B at the same
   position), type notes, "Copy verdict" → paste into `verdict.json`.
3. `python3 scripts/produce/capture-correction.py --verdict <path>` writes the
   produce lane's first `docs/produce-corrections/<id>.meta.json` — the
   correction round the contract demands.
4. Veto list: `runs/live3-sonnet/template.json` names the 7 Vital presets and
   10 samples the run used.

## What you will hear (all 148 BPM, 8 bars, same ask)

| File | What it is |
|---|---|
| `B-mosh-live3-sonnet.wav` | Mosh produce lane, Sonnet via `claude -p`, palette-v2 drums + 808, 7 Vital tracks with curated presets |
| `B-labkit-live3-sonnet.wav` | the SAME notes replayed on your Live set's exact samples (jers kick, light/mem/omg snares, law + igdk claps, hatime hat, tred open hat, bestsnap perc, scratch fx, *spice* 808) — isolates arrangement from sound |
| `B-reference-notes-moshsounds.wav` | your corrected reference beat's own notes (MDSL → Mosh converter) on Mosh's palette + Vital sounds — isolates sound from arrangement |
| `B-mosh-live4-opus.wav` | Opus candidate (see status below) |
| `A-release-release-f0a3f525-final.wav` | provisional A (the earlier Mosh release), until you export A-flywheel.wav |

Partial/diagnostic runs (`partial-runs/`): smoke1/2 (mock brain), live1/live2
(stopped after 1 and 3 steps — the compile-reply bug, fixed).

## Why run 1 died, and what landed (14 commits, `92cb6c88..`)

Root causes of the 02:36 failure, all verified from logs/code, all fixed:

1. **Stale service, wrong venv** — the app runs the owner-install service copy
   under the SA3 MLX venv (no pydantic). pydantic installed there; the copy
   restaged additively (its `--delete` would have removed 187 SFT/adapter
   evidence files — skipped on purpose); `/generate_recipe` now also
   dispatches to the teardown venv (`542ea065`).
2. **Recipe path had two more blockers** — `set_track_volume` not in the native
   allowlist, and palette-v2's 808s are role `bass`, never looked up. Fixed;
   live curl shows an `assign_sample` from `palette-v2/808/`.
3. **Brain ceiling** — BrainProxy hard-coded 800 tokens / 30 s. `brain_chat`
   now takes per-call options (produce: 8192 / 180 s), DOSAGE byte-identical;
   `openrouter` is a 4th provider; companion `/command` honours `timeoutMs`
   (`c00b8f97`, `2df8c538`).
4. **`claude -p` shim** (`fe6aa4fd`) — OpenAI-compatible, MCP stripped
   (65k → ~300 input tokens/call), 429/5xx → BrainProxy fallback, sizes-only
   ledger. Live: Sonnet round-trip 2.3 s; a dense drum step ~2 min.
5. **Produce lane v2** (`1bfc2dfc`, `1c35629f`) — the loop model never sees
   command result data, so a deterministic **preflight** lays the template
   before the first model turn: one drum track with 10 pads from
   `list_palette` (new read-only command), a chromatic 808 rooted at
   `rootNote + 36` (so MIDI 62-70 sounds in the sub octave like your Simpler),
   7 Vital tracks with presets from a **curated 60** picked out of your 12,911
   `.vital` files (`~/Library/Mosh/presets/vital/`, provenance.json). The
   prompt is PROMPT-trap-v4 in MoshOps idioms with `// lesson:` provenance;
   your corrected beat is the few-shot (MDSL → Mosh converter + fixture).
6. **Headless driver** (`12d5d6bf`) — runs the *real* loop against the *live*
   engine over the companion lab feed; renders, saves, packages.

Live-run lessons already promoted tonight:
- Sonnet answered 2/4 compile requests with the plan shape (commands nested in
  `plan[i].commands`) → loop accepts exactly-one-carrier; prompt says
  top-level `commands` (`95112b52`, with tests).
- `load_plugin` name match is case-sensitive → `"Vital"` (`7674b4f9`).
- Drums used 4/10 pads → anti-pattern line (`0cc249d0`); not yet re-run on
  Sonnet — the Opus run is the first with it.

## Status of the checks

- MoshTests 424 cases green (new brain/companion cases); `npm run typecheck`
  clean; vitest `src/agent` 1457/1457 (+2 loop tests after).
- Python suites: shim 14/14, generate_cli, recipe_dispatch, venv_locations,
  generate (808 binds), curate_vital 33, mdsl_to_moshops 56 — all pass.
- Full native gate: RUNNING at report time (see "Gate" below for the result
  once it lands). Its memory preflight refused on **your ChatGPT.app Codex
  child count (129 > 64)** — machine state, not resource pressure (86% free,
  no orphans) — so it runs with the same documented one-time
  `MOSH_MAX_CODEX_CHILDREN=256` override as run 1.

**Gate (native, `20cb69e8`, 07:10-07:28):** build_app, build_tests, catch2,
**selftest ×3 = 3341/3341/3341 (0 failed)**, verify_py, daw_conformance,
vitest, replay_e2e, harness/port/plist/patch-stack checks — all `ok`. Three
bookkeeping steps were red and are fixed in the follow-up commit:
`parity_coverage` (all 21 coverage waivers expired on 2026-09-01 — a
calendar event; renewed to 2026-10-02 with a grep-backed re-review note
each, precedent `20772cf5`), and `parity_scoreboard` /
`daw_scoreboard_current` (`docs/FEATURE_AUDIT.md` regenerated: `list_palette`
raised the dispatch surface to 260, 239 covered). Re-run the gate on the
new HEAD before merging; the code-level steps did not change.

## Honest limits

- Nobody has HEARD any of this. RMS says non-silent (−6 to −7 dBFS); Vital
  patch audibility per track is unverified by ear.
- The A/B is incomplete until you export A-flywheel.wav (Live off-limits).
- Only Sonnet has finished a full run at report time; Opus status below.
- The sound-matched replay's picker put *igdk* on the main clap and *law* on
  the layer (reference is the reverse) and used *omg snare* as snare2 /
  *mem snare* as roll — a deterministic-pick ordering detail, not a bug in
  the notes.
- Not tonight: Serum 2 preset loading, velocity layers/envelopes, merges.

## The three complete runs, structurally

| Run | Brain | Wall | Drums | 808 | Synth registers |
|---|---|---|---|---|---|
| `live3-sonnet` | Sonnet (shim) | 5.3 min | 119 notes, **4/10 pads**, 15 hits/bar, all 8 bars | 24 notes, 6 pitches, 0 gaps, A≠B | all in range |
| `live4-opus` | Opus (shim) | 3.9 min | 81 notes, **10/10 pads**, but **bars 5-8 EMPTY** | 24 notes, 5 pitches, 0 gaps | all in range |
| `live5-sonnet` | Sonnet, prompt with both lessons | 4.7 min | 164 notes, 10/10 pads, 18-25 hits in every bar | 40 notes, 5 pitches, 0 gaps | all in range |

Each has a `swap/` twin on your Live-set samples (`B-labkit-<run>.wav`).
`live5` is the one I'd play first; `live4` is the Opus reference point with
its known B-section hole (the lesson it taught is what made `live5` full).
Structure is not taste — the ear verdict is yours; these tables only say the
flywheel rules were obeyed, which is the bar run 1 could not reach.

Costs: all brain calls went through your Claude subscription (`claude -p`);
OpenRouter was never needed (0 calls, $0). Shim ledger:
`~/Library/Mosh/logs/brain-shim.jsonl`.

## Round 2 (owner awake, 11:40 → ~14:40)

**Verdict on round 1: all seven candidates FAIL** (notes verbatim in
`docs/produce-corrections/produce-r1-2026-09-02.meta.json`). What the data
said about each note, and what changed:

| Owner note | Finding | Fix (commit) |
|---|---|---|
| synth part identical across runs; no variation | presets + samples identical in every run — picker seed was constant 0; stab preset was a cowbell, arp a self-sequencing patch | seeded picks per run (`db6928da`); curation excludes sequence/off-role percussive patches, `~/Library/Mosh/presets/vital/REVIEW.md` veto list (`59b46cce`) |
| timing / wrong notes | chords held 8 beats "following" an 808 that moves every 1-2 beats → 47-67% of chord notes clashed with the sounding 808 root; prompt demanded an off-grid note | harmony + re-voicing rules, no forced off-grid; `produceCheck.ts` scores clashes/coverage/B-density (`d42782f9`) |
| falls apart towards the end | the flywheel's recorded "missing B section" mode; nothing checked it | B-section rule + check (`d42782f9`) |
| drums copied from the Ableton session | note-level few-shot of your corrected beat in the prompt | removed; style paragraph instead (`d42782f9`) |
| 808 / low end weak | picked 808 was the 2nd-weakest sub of 17 (−12.6 dB band RMS; best −6.7; your *spice* −3.6) | 808 = most sub energy (`measure_sub.py`), +3 dB, gain map, master compressor (`db6928da`) |
| mix (secondary) | every render clipped at 0 dBFS | gain map + master glue; still no limiter builtin |

Round-2 candidates (same ask, seeds 1/2/3, all with stems in `runs/<id>/stems/`):

| Run | Brain | Wall | Validator after run |
|---|---|---|---|
| `r2-sonnet-s1c` | Sonnet, medium effort | 15.6 min | chords no longer clash; counter/arp/lead did; **the repair pass deleted five clips** (remove_clip) — render is what survived. Guard added after (`fa78d9ee`) |
| `r2-sonnet-s2` | Sonnet | 16.3 min | drone missing → repair added it; counter/arp/stab still clash |
| `r2-opus-s3` | Opus, guard on | 5.9 min | all 9 tracks first try, no invalid commands; lead/chords/counter/arp/stab flagged for clashes; repair declined |

Each has a `B-labkit-<run>.wav` twin on your Live-set samples. Costs: still
$0 (all `claude -p`); OpenRouter fell back twice during a shim timeout and
returned empty content both times — a bug to look at before it is relied on.

Attempts that don't count (in `partial-runs/`): `r2-sonnet-s1` hit the
shim's 170 s per-call timeout on the 200-note drum step (raised to 600 s);
`r2-sonnet-s1b` was progressing and I killed it by mistake, thinking its
`add_note` steps were failing — they weren't. Medium `--effort` on the CLI cut
per-step latency from 1-4 min to 15-60 s with no visible loss in the
validator.

**Honest read:** the validator says the harmonic clash problem is reduced,
not gone (chords fixed; single-line parts still flagged on a strict
chord-tone rule that may itself be too strict for a lead). Nobody has heard
round 2. Your ear is the gate; the stems are there so the next verdict can
name the track.

## Round 3 (same day, ~14:50 → 18:10) — samples + mix on the frozen Opus notes

**Round-2 verdict:** first pass ever — `B-labkit-r2-opus-s3` (Opus's own
notes + same Vital presets + your Live-set samples) = pass_with_notes; the
identical notes on palette samples = fail. Verbatim record:
`docs/produce-corrections/produce-r2-2026-09-02.meta.json`. The twin
isolated it: composition passed; samples + mix were the gap.

What landed (commits `8e17f965..61be2e74`):
- **0 ms onsets**: all 127 palette-v2 one-shots re-trimmed from ~5 ms (layer
  clap 23 ms, fx 25 ms) to 0.5 ms pre-roll, originals kept as `.orig.wav`,
  feature index rebuilt (`service/presets/retrim_onsets.py`).
- **Kit-matched picking**: per lane, the palette sample nearest your 15drtt
  kit in the 55-dim drummatch space (`service/presets/match_kit.py` →
  `~/Library/Mosh/lab-manifests/kitmatch-15drtt-jerk-r0.json`). Cosines:
  hat 0.92, clap2 0.92, fx 0.88, clap 0.84, openhat 0.78, snare2 0.75, perc
  0.75, snare 0.71, roll 0.68 — **kick 0.25**: nothing in palette-v2 resembles
  your jers kick. That is the palette's real hole.
- **Native builtins** `highpass` (Tracktion LowPass in highpass mode, 180 Hz)
  and `softclip` (tanh clipper), selftest section "R3.3", MoshTests green.
- **Preflight mix chain**: highpass on every melodic track; gains drums 0 /
  808 +3 / lead −10 / counter −12 / stab −10 / chords −13 / arp −16 / drone
  −14 / ambient −16; master = softclip → The God Particle (your VST3, this
  Mac only, `MOSH_PRODUCE_MASTER_VST3=1`). Highpass frequency stays at the
  180 Hz default (per-Hz set skipped: normalization unknown).
- Stems on every render incl. headless twins; A-flywheel is a real file.

The two candidates (SAME notes as r2-opus-s3, same presets, same seed):

| File | Samples | peak / RMS / crest (dBFS) | clip |
|---|---|---|---|
| `B-mosh-r3-opus-s3-kitmatched.wav` | palette-v2, kit-matched | −3.1 / −5.7 / 2.6 | 0 % |
| `B-mosh-r3-opus-s3-labkit.wav` | your Live-set kit | −3.1 / −5.4 / 2.3 | 0 % |
| (round 2 `r2-opus-s3` for reference) | palette-v2, seeded | 0.0 / −8.0 / 8.0 | 0.22 % |
| `A-flywheel.wav` (your export) | — | −1.5 / −4.1 / 2.5 | 0 % |

So the physical mix envelope now matches your export; whether it *sounds*
right is yours to say. Package: `~/Library/Mosh/produce-ab/2026-09-02/`
(round-1 fails in `round1-failed/`, round-2 in `round2-judged/`), page at
http://127.0.0.1:8797/audition.html with stems per candidate.

**Reference-project program:** researched shortlist landing in
`docs/references/SHORTLIST-2026-09.md` (trap/jerk/rage/drill/plugg,
R&B, house/tech house, lo-fi, synthwave, pop; BUY-NOW baskets with license
terms; free/CC only where explicit). Findings so far: Splice sells no
project files; jerk and plugg have essentially no project-file market
(direct producer outreach needed); trap, drill, tech house, synthwave and
pop are well served (Abletunes' license explicitly permits deconstruction
for learning; Loopmasters/ModeAudio packs carry 15 Live sets each).

## Round 3 correction (evening) — your "naked sine waves" verdict was two bugs

Verdict recorded verbatim in `docs/produce-corrections/produce-r3-2026-09-02.meta.json`
(both r3 candidates `pass_with_notes`: "presets in the melody are too boring…
naked sine waves"). You were hearing sine waves. Two driver/engine bugs, both
found from the data, both fixed and re-rendered:

1. **Replay addressed the wrong tracks.** `produceReplay.mts --swap` reused the
   round-2 program's numeric track ids verbatim. Round 3's per-track highpass
   shifted every later id by one (1025→1026 …), and MoshOps `add_midi_clip`
   auto-creates a track (default 4OSC = sine, 0 dB) for an unknown id. So
   chords / drone / counter / arp / ambient played as bare sines on "Track
   10–14", the Ambient Pad track played the stab notes, and the real Vital
   tracks were silent. Stem names gave it away; spectral flatness 1e-10
   confirmed it. Fix: ids are remapped by ROLE via the original template.json
   (`produceReplayRemap.ts`, tested), and the replay now fails loudly if the
   track count grows. Round 2's labkit twin was not affected (same preflight
   as its original), so the r2 pass stands.
2. **The highpass was at 4 kHz, not 180 Hz.** The builtin wrote 180 Hz to
   Tracktion's CachedValue; the filter reads the AutomatableParameter, which
   stayed at the 4000 Hz default (probed: 0.1814 normalised). Every melodic
   part in round 3 was highpassed at 4 kHz (drone centroid 229 → 3600 Hz,
   chords stem −22 → −60 dB). "Thin / boring" was partly this. Fix in
   `load_builtin` / `load_master_builtin` (parameter set), selftest now checks
   the parameter (the check that would have been red).

Also fixed while verifying: the R3.3 selftest section left its master
highpass + softclip behind and broke the 11 master-bus checks that follow
(present since 17:33 today, after the 07:28 gate's 3341/3341).

**The corrected pair (r3c) — same notes, same presets, same seed, both bugs out:**

| File | Samples | peak / RMS / crest (dBFS) | clip |
|---|---|---|---|
| `B-mosh-r3c-opus-s3-kitmatched.wav` | palette-v2, 0 ms onsets, kit-matched | −3.1 / −6.2 / 3.1 | 0 % |
| `B-mosh-r3c-opus-s3-labkit.wav` | your Live-set kit | −3.1 / −5.7 / 2.6 | 0 % |
| `A-flywheel.wav` (your export) | — | −1.5 / −4.1 / 2.5 | 0 % |

All nine stems now carry their preset names; melodic stems sit −19 to −47 dB
under a −3 dB peak with the 180 Hz highpass (chords centroid 359 Hz, drone
230 Hz — where round 2 had them). Drum stems are ~4 dB lower than round 2
because the round-3 template also added pad gains (kick −2, second clap −8,
hats −6) — deliberate, but note it when you judge the drums. The flawed r3
and r3b renders are parked in `round3-flawed/`; the page at
http://127.0.0.1:8797/audition.html shows only the r3c pair, stems included.

## Where things are

- Package: `~/Library/Mosh/produce-ab/2026-09-02/` (audition.html,
  verdict.json, MORNING-REPORT-produce.md, runs/<id>/{run.json, template.json,
  brain-replies.jsonl, program.jsonl, *.mosh, mix.wav, swap/}).
- App instance from this worktree is left RUNNING (lab feed on 47873, pid in
  `runs/app.pid`). It was built at 06:46, BEFORE the "Vital" name-case and
  compile-reply fixes, so its in-app produce path is stale — the overnight
  runs drove the loop from Node, not from that bundle. To try the ask in-app:
  `kill -TERM $(cat ~/Library/Mosh/produce-ab/2026-09-02/runs/app.pid)`, then
  `bash scripts/produce-lane/launch-app.sh` (picks up the gate-rebuilt
  binary + bundle), Settings → Moshi → "Produce mode (experimental)", type
  the ask. The shim must be up (`~/Library/Mosh/brain-shim/shim.pid`;
  `bash service/brain_shim/run-shim.sh &` if not).
- Branch `claude/music-generation-workflow-19ca09` (PR #680) carries all
  commits; no merges, no pushes to shared branches.
