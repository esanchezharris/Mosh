# KS-A runbook — SoulX-Singer on a CUDA box

> **Preferred path (2026-07-03): a rented Linux CUDA instance over SSH** — fully automated by
> [`remote/run_ksa_remote.sh`](remote/run_ksa_remote.sh) (Mac side) + [`remote/remote_run.sh`](remote/remote_run.sh)
> (box side): push handoff → env/weights/install-smoke → auto-transcribe the reference slices
> (their preprocess pipeline; the JSONs come back for audit in `ref-transcriptions/`) → render
> grid + SVC probe → pull results → local blind-listening page. The Windows steps below remain
> valid as the manual fallback.

Standalone spike; zero Mosh integration. Criteria are frozen in
[`docs/superpowers/specs/2026-07-02-fms-killshot-a-verdict.md`](../../docs/superpowers/specs/2026-07-02-fms-killshot-a-verdict.md) — read §2–§3 before rendering; results go in its §4.

## 0. Prereqs

- NVIDIA GPU with **≥ 12 GB VRAM** (community-established floor; 6 GB is unusable — 10+ min for an 8 s clip).
- Conda/miniconda, Python **3.10**, git, ~6 GB disk for weights.
- Owner inputs shipped from the Mac (see §2): a cappella reference slices + score JSONs + this file.

## 1. Setup (expect friction — all researched, links in the verdict doc)

```bash
git clone https://github.com/Soul-AILab/SoulX-Singer && cd SoulX-Singer
conda create -n soulx python=3.10 -y && conda activate soulx
pip install "setuptools<82"          # issue #8
pip install -r requirements.txt      # do NOT upgrade transformers past the pin (issues #41/#21)
# Weights (both variants land in one repo):
hf download Soul-AILab/SoulX-Singer --local-dir pretrained_models/SoulX-Singer
# Preprocess models (RMVPE F0, Parakeet English ASR, ROSVOT notes, Mel-RoFormer separation):
hf download Soul-AILab/SoulX-Singer-Preprocess --local-dir pretrained_models/SoulX-Singer-Preprocess
# Gotcha #24: the mel_band_roformer separation checkpoint may need a manual download; #10/#9: NeMo
# ASR install is the flakiest dep — only needed for PREPROCESSING the reference, not for inference.
```

Smoke: run their shipped example first — `bash example/infer.sh` (score mode, `--device cuda`). A working `en_target.json` render proves the install before any custom input.

## 2. Inputs

1. **Reference (timbre):** owner's clean a cappella, sliced to **10 s** and **30 s** (30 s = WebUI cap), WAV.
2. **Reference metadata:** the reference must be transcribed to lyrics+notes JSON. Run their preprocess pipeline on the slice, then **manually correct the alignment** (their own README insists) — easiest in their HF Space MIDI editor (`Soul-AILab/SoulX-Singer-Midi-Editor`) or the local webui.
3. **Target scores:** 2–3 JSONs, 8–16 bars each, adapted from `example/audio/en_target.json` (fields: `text`, `phoneme` `en_...`, `note_pitch` MIDI with 0=rest, `duration` seconds, `time` ms, `note_type`). Lyrics = accepted lines from the owner's Mosh lyric sheets. **Each score must contain ≥ 1 sustained note ≥ 1 beat** (the issue-#37 re-articulation probe).
4. `--control score` always (melody mode is community-flagged unreliable, #33). Use `--auto_shift` if the owner's register mismatches the score.

## 3. Render grid (≈ 6 + 1)

```bash
# per (ref, score) pair (paths per the repo's own example/infer.sh):
python -m cli.inference --device cuda \
  --model_path pretrained_models/SoulX-Singer/model.pt \
  --config soulxsinger/config/soulxsinger.yaml \
  --prompt_wav_path refs/own-30s.wav --prompt_metadata_path refs/own-30s.json \
  --target_metadata_path scores/score1-flame.json \
  --phoneset_path soulxsinger/utils/phoneme/phone_set.json \
  --control score --auto_shift --pitch_shift 0 --fp16 --save_dir out/r30-s1
```

Or run the whole grid in one go with the handoff pack's `tools/render_grid.py`.

Bonus identity probe (SVC — no transcription needed): `model-svc.pt`, target = an owner sung/mumble take, prompt = the a cappella slice.

Output is **24 kHz mono** — fine for judging; don't mix-treat before rating.

## 4. Rate

Copy `out/` back to the Mac. Build the A/B page (blind order, real a cappella interleaved) with `scripts/fms-killshot/make_listening_page.py`, rate against the frozen bars, fill the verdict doc §4. Keep/undo only after real listening — never fake labels.
