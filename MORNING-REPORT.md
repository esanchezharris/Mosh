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

<!-- GATE_RESULT -->

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

## Where things are

- Package: `~/Library/Mosh/produce-ab/2026-09-02/` (audition.html,
  verdict.json, MORNING-REPORT-produce.md, runs/<id>/{run.json, template.json,
  brain-replies.jsonl, program.jsonl, *.mosh, mix.wav, swap/}).
- App instance from this worktree is left RUNNING (lab feed on 47873, pid in
  `runs/app.pid`) so you can type the same ask in-app; quit it with
  `kill -TERM $(cat ~/Library/Mosh/produce-ab/2026-09-02/runs/app.pid)`.
  The shim is running too (`~/Library/Mosh/brain-shim/shim.pid`).
- Branch `claude/music-generation-workflow-19ca09` (PR #680) carries all
  commits; no merges, no pushes to shared branches.
