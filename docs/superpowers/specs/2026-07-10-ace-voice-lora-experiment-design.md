# ACE-Step voice/style LoRA — bounded experiment design

*Status: SPEC ONLY (owner-approved to draft in parallel with the Used2 key-corrected cover round; execution gated on a cover guide passing words+contour by owner ear).*

## Purpose

The owner, after hearing the first 8-seed ACE Cover batch: *"if we get the key correct then these seeds can be really helpful, especially if we train a voice LoRA for the user."* This experiment answers ONE question, kill-shot style:

> Does an ACE-Step LoRA trained on the owner's own catalog make the SAME cover render (same seed, same pinned config) sound recognizably like the owner, without degrading the words/contour that passed the gate?

It does NOT decide product architecture. If GO, the LoRA becomes the ACE lane's voice-identity layer (potentially replacing the Voicebox/SVC conversion step); if NO-GO, conversion stays the identity step and the LoRA idea is parked with evidence.

## Ground truth (verified against the local ACE install @ `6d467e4`, its own docs)

- **Hardware (corrects the earlier research note):** `docs/en/LoRA_Training_Tutorial.md` says **16 GB VRAM minimum, 20 GB+ recommended** (~17 GB typical during training; long songs OOM at 16). The owner's 4070 Super is 12 GB ⇒ **local PC training is NOT the safe path**. Primary compute = KS-A-style ephemeral RunPod (RTX 4090 24 GB / A100 class, ~$1–2 total at KS-A rates), auto-terminated, artifacts destroyed after pull.
- **Data per song:** audio (`.mp3/.wav/.flac/...`) + `{name}.lyrics.txt` (accuracy matters) + `{name}.json` with `{caption, bpm, keyscale, timesignature, language}`. Annotation MUST come from traditional detectors/tools (the tutorial's own guidance; LM-generated metadata hallucinates). `scripts/lora_data_prepare/` exists in the ACE repo.
- **Reference scale:** the official demo LoRA = 13 tracks, 500 epochs, batch 1.
- **Trainer:** Side-Step (`docs/sidestep/Training Guide.md`) — **LoRA (PEFT) in "Corrected" mode is the recommended path** (continuous logit-normal timestep sampling + 15% CFG dropout, standalone); LoKR is experimental. Train against **`model-variant base`**.
- **Inference plumbing exists:** `generate_music` already threads `lora_loaded / use_lora / lora_scale / lora_weights_hash` into the output params (and the audio-key hash), so LoRA state is fingerprint-visible for the spike's provenance scheme for free.

## VERIFY items (resolve before training, in order)

1. **Turbo × LoRA:** the tutorial trains against `base`; our spike renders with `acestep-v15-turbo` (8-step). Verify whether a base-trained LoRA loads/applies on the turbo checkpoint (community LoRAs like RapMachine suggest yes; confirm in `acestep` LoRA-loading code or a 1-render smoke on the pod). If NO: the A/B must render with `base` (50 steps) for both arms — still a valid experiment, slower renders.
2. **Cover × LoRA:** confirm LoRA weights apply on the cover task path (not just text2music) with a 1-render smoke.
3. **Disk on the pod only** — no new local model downloads (the Mac has ~13 GiB free; the 8 GiB guard stays).

## Data plan (owner's catalog, owner's hardware for prep)

- 8–15 finished owner tracks (the demo used 13). Prefer tracks with the owner's lead vocal prominent; include Used2's genre neighborhood.
- Lyrics: owner-provided or Whisper-transcribed then owner-corrected (accuracy explicitly matters per the tutorial).
- Annotations via traditional detectors, reusing what this repo already has: **key via `asserted_proof_key.py`** (K-S melody + chroma, agreement rule — the same code that just pinned Used2 = B minor), **bpm via librosa** (transcribe venv), timesignature owner-stated, language "en", caption = 1-line owner/Claude-written style description (NOT LM-auto).
- Voice-data hygiene = KS-A precedent verbatim: data uploaded to an ephemeral pod, pod auto-terminated, remote artifacts destroyed after the adapter is pulled + sha-verified locally (adapters land at `~/AI/adapters/`, like the SFT pulls).

## Training plan

- Side-Step, **LoRA (PEFT), Corrected mode**, `model-variant base`, batch 1, epochs ~500 (demo parity; checkpoint every ~100 epochs so under/over-fit is auditable).
- Pod bring-up scripted like `scripts/fms-killshot/remote/runpod_ksa.sh` (new sibling script; same lifecycle discipline: create → verify → train → pull → TERMINATE, receipts at each step).

## A/B gate (the only acceptance that counts)

- Take the cover candidate that passed (or is closest to passing) the Used2 opening gate; render the **same seed under the identical pinned request** twice: LoRA OFF vs LoRA ON (`lora_scale` at 2–3 levels, e.g. 0.6/0.8/1.0 — small grid, ≤6 renders total).
- Diagnostics rerun on every arm (the spike's existing lexical/contour/attack pipeline — regression guard: LoRA must not break words or contour; gates shortlist only).
- **Owner blind listen** (KS-A style, shuffled): rates voice resemblance + quality per arm.
- **GO** = at least one LoRA arm sounds recognizably like the owner AND still meets the lexical floor + contour gates. **NO-GO** = resemblance absent or words/contour degrade at every scale ⇒ park the LoRA lane with the evidence ledger; Voicebox/SVC remains the identity step.

## Cost & bounds

- One pod session (hours, not days); ≤ ~$5 at KS-A-observed rates. No retraining loops inside this experiment — a failed run gets a diagnosis note and a NEW spec revision, not a silent retry.
- No new MoshOps commands, no product code: everything lives in `scripts/fms-killshot/` + `~/AI/adapters/`, exactly like the spike.

## Relationship to Stage B

If the Used2 opening gate passes AND this experiment GOes, the product promotion spec (ACE adapter behind the render-layer contract) gains a `loraWeightsHash` field in its cache fingerprint (the plumbing already exists in ACE's output params) and the enrollment story becomes "train your voice LoRA once" — closing the loop the owner sketched in the verdict notes.
