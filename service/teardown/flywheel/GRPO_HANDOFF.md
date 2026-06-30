# §12 → GRPO handoff — the activated audio-taste reward

The teardown→reward flywheel is **activated**: a validated composite reward (raw-MuQ timbre + a
learned timing head) is wired into the live scoring path, the scrape scales, and this is the bridge
the **external** GRPO trainer imports. The GRPO trainer itself (the loop that optimizes the
command-emitting agent) lives outside this lane and is owner/consult-gated — this doc is the contract
it consumes; it does not launch the trainer.

## 1. The activated reward (the `MOSH_RL_REWARD=audio` seam)

```python
from teardown.flywheel.grpo_bridge import make_reward
reward, info = make_reward()        # info: {kind: "composite"|"floor-only", has_pull, version}
# per policy rollout: render the emitted MoshOps program to a WAV (y, sr), then:
scores    = reward.score_audio(y, sr)     # {pq, clean, pull}
scalar    = reward.composite(scores)      # the [0,1] reward to maximize
```

- `make_reward()` returns a §12 `Reward` whose `pull` is the **CompositeRewardHead** when
  `composite_reward.pt` + the MuQ venv are present (the activated path), else a **floor-only** Reward
  (never crashes the trainer). `info["kind"]` says which.
- **The pull** = `α·(timbre proximity to good-music exemplars in raw-MuQ space) + (1-α)·(timing
  proximity in the learned φ-projection space)`, `α=0.5`. Exemplars (21 real project-groove mixes)
  are baked into `composite_reward.pt`. Validated to beat raw CLAP on timbre + isolated-timing +
  in-mix-timing, held-out-by-source, source-clustered CI, artifact-controlled
  (see `VERIFY_REAL.md` rows `11-keystone-v3/v4`).

### The clean gate (now GRADED) + two honest caveats
`Reward.composite = clean·(0.5·pq/10 + 0.5·pull)`. `clean` is now **GRADED [0,1]** (was binary): genuinely
BROKEN audio (silence/clipping/empty) hard-gates to 0, but merely-imperfect audio degrades smoothly
(each PQ flag costs 0.2, floored at 0.2) — so the validated `pull` is **no longer masked** on sparse/
drum-only renders (a flagged-but-valid drum loop now flows, e.g. composite 0.56 instead of 0.0).

**Caveat 1 — the floor can't reject noise.** Audiobox PQ rates white noise "clean" (~7.2), so the floor
doesn't separate noise from music; only the `pull` does, and weakly in the sparse regime. Net composite:
good real mix **0.89** > sparse good music **0.56** > white-noise **~0.51** > silence **0** — correct
ordering, wide for full arrangements, thin in the sparse regime. (Fine in deployment: the policy emits
musical PROGRAMS from PromptFeed, not white noise.)

**Caveat 2 — exemplar coverage is narrow.** The pull is validated on ablation ORDERING (relative);
as an ABSOLUTE reward it measures proximity to the **21 (trap/lofi) real-anchor exemplars**, so
off-style good music (e.g. a house mix) scores as low as noise. This is **matched** to the trap/lofi
tutorial scrape (the policy's rollouts are trap-ish), but to reward broader genres, rebuild
`composite_reward.pt` with more diverse real anchors (more genres in `td-anchors-real`). Do **not** sharpen
the pull distance to "fix" the noise gap — it amplifies this narrowness (off-style music drops below noise).

## 1b. The RECIPE reward (the `MOSH_RL_REWARD=recipe` seam) — deterministic, no render, VALID

The owner's reframe (2026-06-29): the agent's real output is a **recipe** (the symbolic command
program / musical DNA — notes, pitches, grid, key, parts), not the rendered audio. Because we built
the engine, grade the recipe with **rules** — no render, no GPU, no venv. This sidesteps the audio
reward's fatal flaw: the rating probe found the §12 `pull` does **not** track owner taste (ρ≈0), so
optimizing it is optimizing the wrong thing. The recipe verifier is a **valid** target instead.

```python
from teardown.flywheel.grpo_bridge import score_program_recipe
# per policy rollout: the emitted MoshOps program (no WAV needed)
scalar = score_program_recipe(program)["recipe_reward"]   # [0,1], the reward to maximize
```

- It is a faithful Python port of the **hardened** TS verifier (`ui/src/agent/recipeVerifier.ts`):
  10 dims, with `dynamics·variation·contour` as **multiplicative gates** so a clean-but-robotic /
  copy-paste / atonal beat can't win. Survived a 6-lens / **24-exploit red-team** (every Goodhart
  attack scores <0.7). Parity vs the TS verifier is **pinned bit-for-bit** by `recipe_verifier_test.py`
  (worst Δ 0.00 over all 25 reference recipes + dims) → the Python reward == the validated verifier.
- **Valid + non-zero gradient, proven** (`recipe_verifier_test.py::test_program_reward_gradient`):
  good `0.935` ≫ degraded `0.081` ≫ empty-skeleton `0.061` (spread 0.87). Contrast §7's `proveGradient`:
  the beat-build fix restored the gradient, but its variance lived in the *invalid* audio `pull`. The
  recipe reward keeps the gradient **and** makes the target valid.
- `recipe_from_program(commands)` reconstructs the recipe from the rollout (run-script `capture`/`${var}`
  refs or raw ids). `score_program_recipe` imports **zero audio deps** (numpy/oracle.score are lazy).
- GEPA prompt-evolution already optimizes the beat-build directive against this same verifier
  (`ui/scripts/optimizeBeatPrompts.mts`): held-out baseline `0.79` → optimized `0.97` (Δ+0.18, n=18/side).
  The GRPO weight-training loop now has the matching reward via this seam.

## 2. PromptFeed — the policy's prompt distribution

```python
from teardown.flywheel.grpo_bridge import seed_promptfeed, save_promptfeed
pf = seed_promptfeed(programs)     # programs = list of §9-compiled MoshOps command sequences (renderable)
```
PromptFeed serves guaranteed-renderable, teardown-seeded command sequences (from §9 `compile_recipe`) —
fixes the handoff's "mixing ops on empty tracks render to silence". Build it from real teardowns
(`grpo_bridge.py --results ...`) or from any list of compiled programs.

> ⚠️ **Do NOT use `seed_promptfeed` to build a GRPO prompt's `startCommands`.** It *flattens* a list of
> programs into one loose command list that does not render as a coherent sequence, and the scrape's
> thin compiled programs don't render to audio on their own anyway (the scrape's rewards came from
> rendering the **full reconstructed recipe with stems**, not the stored program — they are NOT
> program-reproducible). The activated audio-RL loop instead uses **whole-sequence, audio-bearing seed
> templates** — see §7.

## 3. rewards.jsonl — reward-labelled rollouts (offline warm-start / logging)

One JSON line per rollout:
```json
{"id":"…","program":[{"command":"create_track","args":{…}}, …],
 "reward":0.89, "components":{"pq":7.85,"clean":1.0,"pull":1.0,"composite":0.89},
 "has_pull":true, "reward_version":"composite-muq-large-mean-v1-v1", "source":"<url>"}
```
`reward` is the gated composite (the scalar to maximize); `components` exposes the raw signals.

## 4. Scaling the scrape (produces the training-data stream)

CC-preferred, transient-media-cache, local-only. **Discovery/queue is metadata-only (no downloads);**
only `orchestrate` downloads media (one transient file per URL, removed after).

```bash
source service/teardown/.teardown.env
DB=~/teardown-catalog.db
# 1) discover (scale knob: --max per query; CC-filtered backend auto-selected)
"$TEARDOWN_PY" service/teardown/sourcing/cli.py discover --db "$DB" \
    --query "trap beat tutorial from scratch" --query "lofi hip hop beat tutorial" --max 50
# 2) prescreen → yield.predicted   3) queue the top N (scale knob: --n)
"$TEARDOWN_PY" service/teardown/sourcing/cli.py prescreen --db "$DB" --batch 500
"$TEARDOWN_PY" service/teardown/sourcing/cli.py queue --db "$DB" --n 50
# 4) per queued URL: teardown + render + score (ACTIVE composite reward), then clean the media cache
MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh \
"$TEARDOWN_PY" service/teardown/orchestrate/cli.py --url "<queued url>" \
    --out /tmp/td-run --index /tmp/td-reward-index --render
# 5) assemble the GRPO bridge from the run results
"$TEARDOWN_PY" service/teardown/flywheel/grpo_bridge.py --results /tmp/td-run/*.json --out ~/grpo-bridge
rm -rf /tmp/td-run/.media-cache          # transient-cache posture: remove downloaded media promptly
```
Proven bounded run (this pass): 18 CC tutorials discovered → 12 kept → top 5 queued
(`creativeCommon`, yield 0.74–0.78). Turn `--max`/`--n` up to scale; that (and bulk downloading
copyrighted media) is the owner's cost/posture decision.

## 5. What's external / gated
- The **GRPO trainer** (policy optimization over the prompt distribution against this reward) is the
  external audio-taste RL system — it imports `make_reward()` + `PromptFeed`; running it is owner +
  consult-gated, not launched from here.
- Real RAVE/SA3-class weights, the live `--render` binary, and the MuQ venv are environment-gated;
  the bridge degrades to floor-only / metadata-only when absent.

## 6. Rebuild the reward artifact
```bash
"$TEARDOWN_PY" service/teardown/flywheel/build_composite_reward.py /tmp/td-anchors-synth /tmp/td-anchors-real
# → service/teardown/flywheel/composite_reward.pt  (proj + ex_timbre + ex_timing + meta)
```

## 7. The activated audio-RL loop (rl-audio-v1) — PROVEN

The GRPO trainer (worktree `funny-mendel-aeca12`, branch `claude/funny-mendel-aeca12`) now gets a
**real, non-degenerate audio-reward gradient** against the composite reward — **with ZERO change to the
trainer's logic** (a new `--rl-data` prompt set + env only).

**Why the first wiring got reward μ=0 (the diagnosis):** the policy's old prompts (`rl-v1`) were
*single micro-edits* ("set the tempo to 142"). The policy correctly emits one command; `+export_audio`
→ an **empty edit → no audio → reward 0**. And `grpo.py` zeros a whole group's advantage when reward
**std < 1e-6** — an all-silent group gives literally **no gradient**. So the fix is the *prompt
distribution*, not the reward or the renderer (the renderer is real: `Oracle.render` → `Mosh
--run-script` → decode, hard-fails on empty WAV; no fake path).

**The seed strategy (edit-on-top of a NON-SILENT base):** `ui/scripts/rl/buildRlAudioPrompts.mts`
emits trap/lofi `EvalExample`s whose `startCommands` build a non-silent base (a drum pattern with
inline `notes`, a `add_test_tone_clip`, or a melody) — so **every rollout renders** and the group gets
reward *variance* (good edits > no-ops > broken edits) instead of an all-zero collapse. The edits are
**content-changing only** (add a melody/drums/tone layer): the reward loudness-normalizes (the
"can't-win-by-getting-louder" guard), so **volume/gain/mute edits are reward-INVARIANT** → they give
zero within-group variance → they don't belong in this RL set. Tier-B (empty-seed "build a beat from
scratch") is the curriculum graduation, mixed in via `--tier-b` once Tier-A converges.

**A reward bug this surfaced + fixed:** `oracle/score.py:loudness_normalize` guarded clipping to peak
≤ **1.0**, but the floor rejects peak > **0.999** as broken — so RMS-normalizing transient-heavy audio
(drums, crest ≳ 10) landed at peak 1.0 → flagged "clipped/broken" → `clean=0` → **every legitimate
non-silent render scored 0**. Fixed: guard to a ceiling of **0.99** (headroom). No-op for real-music
mixes (crest < 9.9) and the existing test fixtures (crest 3.66) → validated pull/keystone unchanged;
`verify.py` ALL GREEN.

**Run it (env only — no trainer code change):**
```bash
cd <funny-mendel worktree>
# 1) build the audio-bearing prompt set (Tier-A; add --tier-b --variants N to scale/curriculum)
cd ui && npx tsx scripts/rl/buildRlAudioPrompts.mts --out ../service/sft/.rl-data/rl-audio-v1 --variants 3 && cd ..
# 2) train against the ACTIVATED composite reward
MOSH_RL_REWARD=audio  MOSH_RL_REWARD_MODE=musical \
MOSH_ACTIVATED_TEARDOWN=<sleepy-euler>/service  TEARDOWN_PY=<sleepy-euler teardown venv> \
MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh \
service/sft/.venv/bin/python service/rl/grpo.py --rl-data service/sft/.rl-data/rl-audio-v1 \
  --sft-adapter service/sft/.adapters/v2 --out /private/tmp/rl-audio --smoke   # drop --smoke + add --iters N to scale
# 3) gate (proves the gradient): reward μ>0 AND signal>0
TEARDOWN_PY service/rl/verify_audio_gradient.py --log <grpo.log> --work /private/tmp/rl-audio/_work/audio
```

**Proven (smoke, real composite reward):** every rollout rendered (0→few fails), reward μ 0.21 → 0.30,
signal in 8 groups, determinism from PCM-identical renders. Cost note: ~8 min/step with the real MuQ
reward (≈20 rollouts/step; `score_audio_cli` reloads MuQ per step). Gate verifier:
`service/rl/verify_audio_gradient.py` (in the trainer worktree).

### ⚠ HONEST SCOPE — what this gradient IS and IS NOT (adversarial review, 2026-06-29)
The gradient is **non-degenerate and real**, but it is **renderability-dominated, NOT yet a musical-taste
gradient**. From the smoke's per-rollout decomposition: successful renders mostly score **identically**
(e.g. all 0.437), so the within-group variance that drives GRPO is overwhelmingly **emit-a-renderable-
program (reward 0) vs fail/defer (reward 0)** — only ~1 of 4 groups showed a genuine edit-quality margin
(0.125 vs 0.502). Two structural causes:
- **Pull contributes little to the reward *spread*.** `composite = clean·(0.5·pq/10 + 0.5·pull)`; the
  learned musical `pull` varies only ~0.52–0.58 across rollouts, so cleanliness/Audiobox-`pq` + the
  clean gate dominate the *variance*. The policy is pushed toward "render clean audio," not "match the
  trap/lofi taste."
- **Edit-on-top banks the seed floor.** The rollout = seed (non-silent) + the policy's edit; a no-op or
  mildly-bad edit still collects the seed's ~0.29–0.44 → the policy can win by "not breaking it."

So the smoke proves the *machinery* (a real gradient flows end-to-end) and the current scaled run is best
read as a **stage-1 "learn to emit renderable programs" curriculum** — useful (the prior policy emitted
degenerate programs) but not the musical-taste objective.

**DELTA-reward — BUILT (trainer commit `e7b7c808`, env `MOSH_RL_REWARD_DELTA=1`):** reward =
`composite(seed + edit) − composite(seed alone)` — banking the seed → ~0, improvement → +, breakage → −.
`buildRenderProgram` emits the seed-alone program (cached, rendered once/prompt); `score_audio_cli --delta`
subtracts it; the verifier is delta-aware.

**What delta REVEALED (the honest finding — the bottleneck moved from the reward to the POLICY):** on a
delta smoke, deltas were **mostly exactly 0** (the edit renders the same composite as the seed = a no-op),
with occasional **negative** (the edit broke the seed); **no rollout produced a positive delta**. The reward
is now correct, but **this single-edit SFT policy almost never makes an audible improvement** the reward can
reward. Two compounding causes: (1) policy capability — "add a melody on a new track" needs create_track +
add_midi_clip + *notes* (multi-step), which a single-command emitter rarely produces; (2) reward sensitivity
— the achievable simple edits (a bare 4OSC tone / test-tone) don't sound trap/lofi, so they don't raise the
trap-exemplar `pull` even when they DO add audio. The delta gate FAILS honestly (signal too sparse, no
positives) — correctly refusing to call this a trainable musical gradient yet.

**Realistic paths to a positive musical gradient (owner's call):** (a) a more capable policy (SFT on
multi-step content building / few-shot exemplars / higher exploration) so improving edits get sampled and
GRPO can reinforce them; (b) edits the reward CAN reward — load real instruments/drum-kit samples (VST3 /
the bundled kit) so a successful edit sounds trap-like and lifts the pull; (c) build-from-scratch framing
(policy's whole output = the music) — same policy-capability concern applies. Validation = **held-out
re-score** of trained vs SFT baseline on fixed prompts (greedy), comparing composite + pull — NOT a
training-μ delta.
