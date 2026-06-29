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

### ⚠ The clean-gate caveat (read this)
`Reward.composite = clean·(0.5·pq/10 + 0.5·pull)`. The floor's **binary `clean`** (Audiobox PQ flags)
**zeros the composite for sparse/drum-only renders** even when `pull` discriminates well. So:
- For **full-arrangement** rollouts (the normal GRPO target) `clean→1` and the composite flows.
- For **drum-loop / sparse** rollouts, read `scores["pull"]` (or the `components`) directly instead of
  the gated composite, or soften the gate. The bridge always logs both so the trainer can choose.

Measured discrimination (pull): real good mix **1.00** > non-exemplar synth music **0.69** >
sine/noise/silence **~0.52–0.57** — a real graded signal, not constant.

## 2. PromptFeed — the policy's prompt distribution

```python
from teardown.flywheel.grpo_bridge import seed_promptfeed, save_promptfeed
pf = seed_promptfeed(programs)     # programs = list of §9-compiled MoshOps command sequences (renderable)
```
PromptFeed serves guaranteed-renderable, teardown-seeded command sequences (from §9 `compile_recipe`) —
fixes the handoff's "mixing ops on empty tracks render to silence". Build it from real teardowns
(`grpo_bridge.py --results ...`) or from any list of compiled programs.

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
