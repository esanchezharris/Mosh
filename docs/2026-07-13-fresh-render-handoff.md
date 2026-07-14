# Handoff — Finish-My-Song product consolidation + fresh owner-ear render (2026-07-13)

Continuing thread from a Claude Code session. **Branch `claude/used2-ace-step-cover-spike-be9519`**,
worktree `.claude/worktrees/used2-ace-step-cover-spike-be9519/`. Everything below is committed
(HEAD `595a889d`); working tree clean.

## What this thread is
Turn a mumbled take into a coherent verse sung in the owner's own voice — the reusable Mosh
feature. This session (a) landed the **product consolidation** (moved the ear-certified recipe
into product code) and (b) proved it end-to-end on **fresh recorded takes**, producing a real
owner-ear render.

## What's DONE (committed)
- **Phase A — `963e12ea`** — product timing-snap in the sing adapter. `soulx/score.word_event_spans`/
  `phrase_windows` + `soulx/perform.snap_render_to_take` (phrase-align + word-snap); `soulx_adapter.render()`
  snaps its output onto the take (`input_wav`) → `timingSnapped`/`sylSnapMedianMs`. `input_wav=""` skips
  snap ⇒ fake render byte-identical.
- **Phase B — `cdf098f1`** — PC-NSF re-vocode post-step, **shipped OFF** (`nsf_available()` gated on
  `MOSH_ENABLE_NSF=1` + venv + checkpoint; CC-BY-NC-SA weights need a self-trained MIT checkpoint).
- **Phase C — `6d9e3113`** — energy-first grid detector `service/skeleton/segment.py` (`gate_events`/
  `dip_events`/`pitch_step_events`/`energy_nuclei`) + `build_skeleton_spec(detector="energy")`. **Default
  stays `"ladder"` → shipped `/skeleton_spec` byte-identical.** `confirm_skeleton` kept.
- **Infra — `595a889d`** — `remote_sing_multi.sh` flash-attn preprocess crash fix (see gotchas) +
  NEW `scripts/fms-killshot/vast_sing_remote.sh` (Vast.ai lane — prefer over RunPod).
- Tests green ×3: `service/soulx/*_test.py`, `service/skeleton/*_test.py` (segment 13, skeleton golden 57),
  adapter-glue/fake/mumble. Pre-existing fail: `service/skeleton/align_test.py` (owner-data KeyError on HEAD too).

## The fresh render (proof on new input)
Ran 4 recorded takes from `~/Desktop/projects/Untitled Project/Samples/Recorded/` through the product
path (energy grid → Grok lyrics → SoulX voice → snap). **t1/t3/t4 = coherent verses sung in the owner's
voice + snapped; t2 self-rejected** (full mix, 0 energy nuclei — correct). Listen:
`http://localhost:8189/used2/asserted-proof/fresh-render.html` (preview server: `python3 scripts/fms-killshot/preview_server.py --port 8189`).

Harnesses + data (durable, NOT git — lives with the rest of the spike under `~/mosh-fms-ksb`):
`~/mosh-fms-ksb/used2/fresh-render/` → `build.py` (extract→energy-grid→Grok→score→stage), `finish.py`
(product snap + A/B page), `wav/`, `sections/`, `stage.json`. Scores staged at
`~/mosh-fms-ksb/used2/asserted-proof/back-half/sing-handoff/scores/{t1,t3,t4}.json`; voice ref reused at
`.../refs/own-30s.wav`.

## THE OPEN DECISION (next step)
Owner picks the best of **t1 / t3 / t4** by ear → **push that one all the way** (the whole take, not a
~25s section). To do it:
1. Edit `TAKES` in `~/mosh-fms-ksb/used2/fresh-render/build.py` to the winner's FULL span (e.g. `{"t1": (0.0, 137.0)}`),
   keep `MOSH_BRAIN_ENV` pointing at `~/Documents/ClaudeMosh/ui/.env.local` (Grok key).
2. `python3 ~/mosh-fms-ksb/used2/fresh-render/build.py` → stages the full score into `sing-handoff/scores/`.
   (Purge stale scores from that dir first — the multi lane renders ALL `scores/*.json`.)
3. Render: **`bash scripts/fms-killshot/vast_sing_remote.sh up`** (Vast — no capacity roulette). Falls back:
   `SING_SCRIPT=$PWD/scripts/fms-killshot/remote/remote_sing_multi.sh KSA_GPUS='["NVIDIA GeForce RTX 4090",...]' bash scripts/fms-killshot/backhalf_sing_remote.sh up` (RunPod, pin off L40S).
4. `python3 ~/mosh-fms-ksb/used2/fresh-render/finish.py` → product snap + page.

## Also open (owner-ear-gated, from the consolidation plan `~/.claude/plans/ok-over-in-codex-functional-manatee.md`)
- **Phase C adoption:** one owner-ear render through the simple grid decides it. On OK: flip `detector`
  default to `"energy"` in `build_skeleton_spec` + delete the ladder (`prune_v1_nuclei`/`articulation_groups`/
  `fuse_asr_budget`) = the net simplification. Enable NSF once a self-trained MIT checkpoint exists.
- Off-main landing (main lacks flow-over-sounds v2, NSF, snap, these cuts) is a later effort.

## GOTCHAs
- **Flash-attn preprocess crash (fixed):** the SoulX reference-preprocess vocal-sep roformer CUDA-crashes
  (`illegal memory access`) in its flash-attention path — regressed onto sm_80+ incl. the **4090** via upstream
  NeMo/torch drift. Fix (in `remote_sing_multi.sh` before the preprocess): a `sitecustomize.py` on the preprocess
  PYTHONPATH (env-pre ONLY) masks `get_device_capability`→(7,5) + disables torch flash SDP. The render succeeds with it.
- **Rented GPU:** prefer **Vast.ai** (`vast_sing_remote.sh`) — RunPod SECURE rejected a fixed-GPU request 8× before
  landing; Vast `search` picks a real available 4090 (~$0.30/hr) instantly. SSH via `~/.ssh/mosh_vast`. Both lanes
  destroy/terminate on exit — but **`vastai show instances` after any run** (a stray RTX 5090 was billing $2.67/hr).
- **Privacy:** the owner chose RunPod SECURE for voice-data privacy; Vast is a marketplace (third-party host) — a
  tradeoff for a 30s clip destroyed after the run. Owner's call.
- **Grok:** the xAI key is in `~/Documents/ClaudeMosh/ui/.env.local` (gitignored); harnesses set `MOSH_BRAIN_ENV` to it.
- Nothing under `~/mosh-fms-ksb` enters git; venvs live at `~/Library/Mosh/venvs/`.
