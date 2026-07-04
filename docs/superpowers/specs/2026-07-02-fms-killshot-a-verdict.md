# FMS kill-shot A — SoulX-Singer English + zero-shot own-voice (pre-registered)

**Status: criteria REGISTERED 2026-07-02, before any rendering. Do not edit §1–§3 after renders begin; results go in §4 only.**

Decides whether SoulX-Singer is the Phase-3 render anchor (`docs/FINISH_MY_SONG_ROADMAP.md` §3). Runs standalone on the CUDA box — zero Mosh integration.

## 1. Facts the criteria rest on (researched + license-verified 2026-07-02)

- **License:** Apache-2.0, weights + code (HF card metadata + README verbatim + GitHub LICENSE; independently re-verified). Caveat: the weights repo carries no LICENSE *file* — posture rests on card metadata + README sentence. The eval **dataset** is CC-BY-NC — never ship it.
- **Variants:** `model.pt` (SVS: score/melody-conditioned synthesis) + `model-svc.pt` (SVC: transcription-free timbre conversion, target audio + F0 in).
- **Input contract (SVS):** custom JSON metadata per clip — `text`, `phoneme` (`en_`-prefixed ARPAbet-style), `note_pitch` (MIDI, 0=rest), `duration` (per-note seconds), `time` (ms), `note_type`, optional `f0`; plus `--prompt_wav_path` (timbre reference, WebUI caps 30 s) **and the reference's own metadata JSON** (the reference must be transcribed — their preprocess pipeline: Mel-RoFormer separation, RMVPE F0, Parakeet English ASR, ROSVOT notes; their README recommends manual correction in their MIDI editor).
- **Known risks (community issues):** #37 sustained notes re-articulate instead of holding; #33 melody mode unreliable → **run score mode**; fragile deps (`transformers` pins, NeMo ASR, `setuptools<82`); paper English WER 0.151 vs Mandarin 0.065; 24 kHz mono output; ~12 GB VRAM practical floor.

## 2. Render grid (registered)

Score mode only. Reference slices from the owner's clean a cappella: **10 s and 30 s** (30 s = WebUI cap). Targets: **2–3 hand-authored scores of 8–16 bars** using accepted lines from the owner's own lyric sheets, each with at least one sustained (≥1 beat) note — the #37 probe. Grid ≈ 2 refs × 3 scores = **6 renders minimum**, plus one SVC-mode render (owner take in, owner timbre prompt) as a bonus identity probe.

## 3. GO / NO-GO bars (registered — do not move after rendering)

- **English bar:** on first listen without reading along, the owner correctly hears the lyrics on **≥ half** of the grid renders.
- **Own-voice bar:** **≥ 1** grid config is rated "recognizably me" in an A/B against the real a cappella.
- **Timing bar (diagnostic, not gating):** sustained notes hold rather than re-articulate on ≥ half of renders containing them; log per render.
- **Verdicts:** both bars pass → **GO** (SoulX anchors Stage 3). English passes, voice fails → run the registered fallback probe: **RVC (MIT — verified: code + lj1995 bases + ContentVec all MIT)** conversion over SoulX base-voice output, trained on ~10 min of the owner's clean voice; re-apply the own-voice bar. English fails → **NO-GO**; next-in-line is **YingMusic-Singer-Plus** *with corrected licensing* (weights CC-BY-4.0 **except VAE under Stability AI Community License** — SA3-class encumbrance, NOT the MIT the roadmap claimed; it also wants a sung melody clip, not a score — a different, mumble-native shape). Mac-local mock lane regardless of verdict: **ACE-Step 1.5 (MIT, MLX)** for "is this line worth finishing".
- **Rating discipline (VocalFinisher rule):** keep/undo recorded only after real listening; no fake labels; blind ordering where practical.

## 4. RESULTS (fill after rendering; do not touch §1–§3)

- [x] **Setup log (2026-07-03):** RunPod Secure Cloud RTX 4090 24 GB, driver CUDA 12.4, ~2 h total incl. debugging (≈ $1.40). Automation: `scripts/fms-killshot/remote/` (`runpod_ksa.sh up` end-to-end; pod auto-terminated after pull — voice data destroyed). Dependency findings, all codified: image lacks rsync; **NeMo (English ASR) is not in SoulX's requirements and is pin-incompatible with its inference env** (needs torch ≥2.3/cu-matched torchaudio/nltk tagger data) → dedicated `env-pre` preprocess env, cu124 torch 2.6 pair; inference env stays on SoulX pins (torch 2.2/transformers 4.41/numpy<2) and its install smoke passed 2× (incl. after NeMo pollution + repair).
- [x] **Registered deviation:** reference metadata came from the auto preprocess pipeline **without the recommended manual MIDI-editor correction pass.** Audit of the returned transcriptions: coherent English lyrics recognized from the take (`own-30s`: 93 notes; melisma continuations properly repeated) — quality judged usable for the kill-shot; a hand-corrected re-run remains the escalation if renders fail oddly.
- [x] **Renders:** grid 6/6 (`own-{10s,30s}` × `score{1-flame,2-tone,3-gold}`), 24 kHz mono, exact score durations, healthy levels, no clipping. SVC probe rendered but suspect (50 s from a 25 s target; peak 1.0 — listen skeptically; excluded from the bars). Blind rating set (deterministic shuffle, real slice hidden as anchor): `~/mosh-fms-ksb/ksa-blind/` → http://127.0.0.1:8189/ksa-blind/ ; key at `~/mosh-fms-ksa-results/blind-key.json`.
- [x] **Ratings (owner, blind, 2026-07-04):** r1=10s×score1: "exactly like me," lyrics near-exact, notes held. r2=REAL anchor: correctly identified ("just my original take") — and no render was mistaken for real. r3=30s×score3: "just like me," 13/14 words ("third"→"late"). r4=10s×score3: ≈r3. r5=30s×score2: "like me but like a mumble take," all words (last uncertain: "tone/tomb"). r6=30s×score1: **lyric quoted VERBATIM**, "sounds like me." r7=SVC probe: "horrifying, demonic" (pre-flagged suspect, excluded per §4 registration). r8=10s×score2: r5's twin, "no huge difference."
- [x] **English bar: PASS 6/6** (bar: ≥3 of 6).
- [x] **Own-voice bar: PASS** — multiple "sounds just/exactly like me"; 10 s reference ≈ 30 s reference.
- [x] **Timing (#37 probe): PASS** — sustained notes held on every grid render; no re-articulation complaints.
- [x] **Verdict: GO. SoulX-Singer anchors Phase 3 (Stage-3 render).** SVC mode needs its own debugging before use (2× length + clipping — not part of the bars). Per the decision gate: next is the Stage-1 extension plan (persist score + melisma + edit pass) and the SoulX Tier-B adapter behind the existing seam, fake-first.
