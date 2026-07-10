# Complete Finish-My-Song — ACE-Step Cover spike gates the integration

## Context

FMS Phases 1–2 are shipped and Phase 3 Stages 1–2 (skeleton promotion + SoulX sing adapter, fake-first) are on main. What's missing is the endgame: an **owner-ear-validated own-voice render** of real material. The Used2 lane is that proving ground — its current best guide (Voicebox-cloned TTS lexical guide) got an owner verdict of "close but revise" (classification: timing; "the lexical control text-to-speech voice is really throwing us off… need to be based on the actual raw mumble").

ACE-Step 1.5 Cover is the candidate fix: the **raw take supplies structure, the 16 asserted words supply lyrics**. Initial ad-hoc evidence (seed 42 on disk; three more seeds run but never persisted) shows the phrase mostly preserved but never exactly transcribed — so the spike needs controlled batching, lexical + contour diagnostics, and owner listening, not faith.

Decisions locked with the owner:
1. **Staged plan: the spike gates the integration.** Stage A = Used2 ACE-Cover spike (8 seeds, diagnostics, owner listen) as go/no-go evidence. Stage B = product work, shaped by the verdict.
2. **Stage B is verdict-dependent** (decision matrix, not both lanes): PASS → promote ACE cover-guide + voice conversion toward the product sing pipeline; FAIL → SoulX PC bring-up is the path, ACE stays the roadmap's generic-voice scratch mock.
3. **Rescue first**: the asserted-proof toolkit (18 files) is untracked in the Codex checkout at `~/Documents/ClaudeMosh-used2-asserted-render-proof/scripts/fms-killshot/` (iCloud-synced path — the same hazard class that already ate a git store). Copy verbatim into this worktree's `scripts/fms-killshot/`, commit as a rescue commit, then extend here.

Ground truth verified this session:
- ACE-Step 1.5 install at `~/AI/ace-step-1.5-mac` (git `6d467e4`, MLX/MPS, venv Python 3.11). **Turbo DiT only** (4.5G; task types text2music/repaint/cover/cover-nofsq, 8 steps). No base checkpoint ⇒ no lego/complete/extract locally; ~13 GiB disk free ⇒ the 8 GiB guard is live and "no new model downloads" is forced.
- Evidence lane at `~/mosh-fms-ksb/used2/asserted-proof/opening/`: `raw.wav` = the exact 0.35–7.90 s owner take (7.55 s, 24 kHz mono); 16-word asserted map with measured spans/phonemes/MIDI; manifest + owner-verdict + review page (`index.html`, served on :8189) all working.
- Only **seed 42** exists as a labeled candidate (`ace-step-spike/cover-seed42-opening.wav` + ASR). Four unlabeled UUID wavs are unattributed legacy. Seeds 7/73/271 must be regenerated deterministically.

## Durable goal (recreated from the Codex thread)

> Deliver and owner-ear validate a pitch-faithful asserted-lyrics re-sing of Used2's corrected first half, beginning with an ACE-Step Cover opening proof, and rejecting the lane if eight seeds cannot preserve intelligible asserted words and raw-take contour.

This goal stays active until the owner passes the continuous first half; second-half invention does not resume inside this loop.

## Stage 0 — Rescue + scaffolding (repo work)

1. Copy the 18 untracked toolkit files from the Codex checkout into `scripts/fms-killshot/` in this worktree, byte-identical. Commit: `rescue(fms): asserted-proof toolkit from codex/used2-asserted-render-proof (untracked WIP)`.
2. Run the existing toolkit test (`asserted_proof_plan_test.py`) to prove the rescue is healthy in its new home.
3. Commit this design (Stage A spec below) to `docs/superpowers/specs/2026-07-09-used2-ace-cover-spike-design.md` per brainstorming convention.

## Stage A — ACE-Step Cover spike (the gate)

All new code lands in `scripts/fms-killshot/` following the toolkit's flat `asserted_proof_*` conventions. Canonical output folder: `~/mosh-fms-ksb/used2/asserted-proof/opening/ace-step-cover/`; per-candidate artifact naming `seed-<N>-{full,opening,asr,align,f0,eval,receipt}.{wav,json}`. The old ad-hoc `ace-step-spike/` dir is legacy source material only.

Reuse (verified, do not reimplement): `asserted_proof_metrics.compare_audio` (envelope corr, RMS, **silenceBleedMs already exists**), `asserted_proof_worker.py` `align` (MMS_FA CTC, skeleton venv) and `f0` (**RMVPE via the SoulX bridge, 20 ms frames — the lane's existing pitch truth; do NOT switch to FCPE**, whose voicing is unusable), `asserted_proof_runtime` constants (`WHISPER_PY`/`SKELETON_PY`/`SOULX_PY`, `run`, `run_json`, `convert_audio`), `asserted_proof_verdict` hash binding, `asserted_proof_provenance.receipt_is_current`, `asserted_proof_plan.build_manifest`.

### Verified ACE-Step facts (file:line-checked against `~/AI/ace-step-1.5-mac` @ `6d467e4`)
- **Cover's source carrier is `src_audio`** (required; errors without it). `reference_audio=None` is exactly "no voice identity" — when None the handler substitutes zeros; also `process_reference_audio` samples RANDOM 10 s segments, so None is required for determinism too.
- **LM is hard-skipped for cover** (`skip_lm_tasks` includes cover) — worker passes `llm_handler=None`, records `thinking=False` + all `use_cot_*=False` for honesty.
- **`shift=3.0` must be explicit** — the dataclass default is 1.0; 3.0 is only the CLI's turbo default. **Turbo coerces `guidance_scale` to 1.0** — record 1.0.
- **The instruction string must be pinned** to `TASK_INSTRUCTIONS["cover"]` ("Generate audio semantic tokens based on the given conditions:") — the dataclass default is the text2music instruction and nothing auto-swaps it for explicit cover.
- **The 10 s minimum is NOT enforced on the cover path** (cover locks duration to source length). Padding to 10 s is kept as recorded *policy* (parity with the ad-hoc seed-42 run), not a code constraint.
- **Output filename uuid = SHA256 of the sorted params JSON** — which is what the 4 UUID wavs in `ace-step-spike/` are. Seed determinism = `GenerationConfig(seeds=[N], use_random_seed=False)` → per-sample `manual_seed`.
- Audio ingest resamples anything to stereo 48 kHz; outputs are 48 kHz.

### A1. Isolated ACE worker (generation)
- New `ace_cover_worker.py`, executed as `~/AI/ace-step-1.5-mac/.venv/bin/python ace_cover_worker.py --request <in.json> --output <out.json>` with `cwd=<ace root>` (file-in/file-out because ACE logs freely to stdout; same shape as the SoulX bridge invocation). No ACE deps enter Mosh's Python; no toolkit imports enter the worker.
- Worker: asserts `git rev-parse HEAD == expectedGitRev` (fail-closed), inits `AceStepHandler` once (`config_path="acestep-v15-turbo"`), loops seeds calling `generate_music(dit_handler, None, params, config, save_dir=…)`; per-seed failures recorded without aborting the batch.
- Pinned params (full dict snapshotted in `request.json`): `task_type="cover"`, cover instruction pinned, `src_audio=<padded source>`, `reference_audio=None`, `lyrics` = verbatim `lyrics.txt` (validated word-for-word against the plan's 16 asserted words before any generation), `vocal_language="en"`, `inference_steps=8`, `shift=3.0`, `guidance_scale=1.0` (coerced anyway), `audio_cover_strength=1.0`, `cover_noise_strength=0.0`, `duration=-1` (cover locks to source), `thinking=False`, seeds via `GenerationConfig`.
- Input prep: `raw.wav` → `source-padded-10s.wav` (ffmpeg `apad=whole_dur=10`, stereo 48 kHz PCM16); each generated 48 kHz full render → `seed-<N>-full.wav`, then trimmed to 0–7.55 s and converted to 24 kHz mono PCM16 → `seed-<N>-opening.wav` (matches `raw.wav`, satisfying `compare_audio`'s equal-rate requirement). Pad/trim parameters recorded in `request.json` + receipts. Extend `convert_audio` with optional `channels`/`sample_rate`/`pad_to_s` kwargs (defaults preserve current behavior).
- Fail-before-generate guards: ACE venv + turbo checkpoint files present, git rev readable, free disk ≥ 8 GiB (currently ~13 GiB — passes but tight; owner informed), `raw.wav` + `asserted-render-plan.json` + whisper/skeleton/SoulX venvs present, lyrics gate passes. **No model downloads ever.**

### A2. `ace-cover-spike` subcommand (batch + idempotency)
- New subcommand on `used2_asserted_proof.py` with `--dry-run` (match-arm + `build_page` refresh like every other command); orchestration in new `asserted_proof_ace_cover.py`.
- `request.json`: asserted text, verbatim lyrics + sha, source window (0.35–7.90 s), source hashes, pad/trim params, ACE runtime (root, git rev `6d467e4…`), checkpoint identity (config + model.safetensors sha256, size+mtime fast-path cache excluded from the hash), full pinned params, seed list, `requestSha256`. Root-relative paths only.
- Idempotency: a seed is skipped iff its ledger entry matches the current `requestSha256` AND its receipt is current (`receipt_is_current`). Re-runs regenerate nothing when config is unchanged; any param/lyrics/source drift regenerates everything.
- Seeds: **7, 73, 271 regenerated deterministically** under the pinned config + **509, 911, 2027, 4099** new = 7 generated; **seed 42 imported** from `ace-step-spike/cover-seed42-opening.wav` as `provenance:"imported-ad-hoc"`, `requestSha256:null` (its generation params are unproven; its ASR/F0/metrics are RE-derived under this pipeline — the old asr json kept only as a legacy record). Total 8 evaluated candidates. The 4 UUID wavs + `source-10s.wav` are ledgered under `legacy.unattributed` with hashes — **no seed guessing**, never ranked, never on cards.
- `ledger.json`: per candidate — seed, provenance, files, ASR summary, alignment evidence, contour metrics, rank, status, verdict, timeCosts; plus the `legacy` block. Ledger + verdict files are deliberately EXCLUDED from the spike manifest (avoids hash circularity).
- One worker invocation for all missing seeds (single model init, ~1.7 s load amortized).

### A3. Diagnostics (lexical + timing + F0)
- `asserted_proof_cover_lexical.py` (pure): normalized-token `SequenceMatcher` opcodes over expected-vs-heard; per-word classes `hit / near_miss (phonetic_sub ≥0.6 char-ratio | boundary_merge | alias) / substitution / miss` (+ insertions, multiword-garble handling). `lexicalScore = (hits + 0.5·nearMisses)/16`. Seed-42's real ASR becomes the fixture (invincible→invisible = phonetic_sub; night→nightly = boundary_merge; "we got hella close"→"I had a close" garble). **ASR ranks; it can never declare success.**
- `asserted_proof_cover_metrics.py` (pure): `compare_f0_contours` — frame-level, plain time-aligned (NO DTW: timing fidelity is itself under test; informational `envelopeLagMs` reported but never used to shift metrics), voiced overlap, contour correlation on the voiced intersection in semitone domain, signed median register offset, median/p95 abs pitch error (uncorrected — register is truth), longest contiguous octave-error run (|err| ≥ 11.5 st, the toolkit's existing band). Empty intersection ⇒ `None` fields, never fake zeros. `attack_errors_from_alignment` — candidate attack = MMS word starts, trusted only at alignScore ≥ 0.2, aggregates need ≥ 8/16 usable words. `evaluate_candidate` + `ranking_key` (tuple sort: **lexical first** — misses, substitutions, −hits, −seqRatio — then attack, contour, register, envelope, bleed, seed — **never one collapsed score**) + `effective_status` + `THRESHOLDS` (single source of truth).
- Evaluation pipeline (in `asserted_proof_ace_cover.py`): per candidate → convert/verify → whisper ASR (`WHISPER_PY`, model small) → MMS align (skeleton venv, 16 plan words over the whole 7.55 s clip, via ffmpeg→16 kHz temp) → RMVPE F0 (SoulX venv) → `compare_audio` → `seed-<N>-eval.json` + receipt → spike manifest regeneration. One-time `ensure_raw_clip_f0` → `ace-step-cover/raw-clip-f0.json` (extract from `raw.wav` directly — don't slice the global contour; 0.35 s is off the 20 ms grid).

### A4. Review page: Local Model Spike section
- `_ace_cover_section` in `asserted_proof_page.py` (modeled on `_expansion_sections`; returns `""` when the spike dir is absent, so the page is byte-identical pre-spike): raw reference first, asserted text, then the **3 highest-ranked CURRENT candidates** — each card: seed, heard transcript with per-word lexical chips, contour MetricStrip with per-gate pass/fail, autoStatus pill, per-candidate VerdictPanel. Quarantine/current via `receipt_is_current`; metrics never imply owner approval (design-doc rule). Add the `CandidateCard` primitive to `ASSERTED_PROOF_DESIGN.md`.
- Verdict JS: factor the existing wiring into a reusable `initVerdictPanel(...)`; the opening panel keeps its endpoint untouched.
- `preview_server.py`: `GET/POST /used2/asserted-proof/api/verdict/ace-cover/<seed>` beside the existing endpoint; 409 `{stale:true}` on manifest-hash mismatch; seed whitelisted to current candidates.

### A5. Statuses + verdict binding
- Auto: `invalid` (duration off by >0.25 s, undecodable, ASR/align failure, voiced ratio <0.05) / `diagnostic` (default) / `shortlisted` (ALL gross gates pass + lexical floor: 0 misses, ≤2 substitutions, ≥10 hits). Shortlisting is triage only.
- Owner-only (verdict UI): `owner_pass` / `owner_fail`; "close but revise" leaves auto status standing. No code path writes `owner_*` into eval JSON — it's an overlay computed from (eval, verdicts, current hash).
- **Candidate verdicts bind to the spike's OWN manifest** (`ace-step-cover/manifest.json`), not `opening/manifest.json` — so spike regenerations can never stale the owner's existing opening verdict ("close but revise", already saved). Payload = existing verdict shape + `clip:"ace-cover"` + `seed`; stored at `ace-step-cover/verdicts/seed-<N>-verdict.json` + copied into `verdict-history/`. Stale hash ⇒ verdict ignored + server refuses (same semantics as today). Regenerating any candidate changes the spike manifest hash ⇒ all candidate verdicts intentionally reset. Existing `owner-verdict.json` / `expand-first-half` mechanics untouched.

### A6. Owner gate + stop conditions
- Stop states written ONLY by an explicit `ace-cover-stop --reason {lexical,prosody} --rationale …` command (never auto-declared), to `ace-step-cover/lane-status.json` following the `raw-prosody-experiment.json` precedent, validated against recorded owner verdicts:
  - `ace_cover_lexical_blocked` — every verdicted candidate owner-failed on `words`; zero passes; ≥1 verdict recorded.
  - `ace_cover_prosody_blocked` — zero passes; ≥1 owner fail classified `timing`/`pitch/register` on a candidate that met the lexical floor.
- If eight seeds fail: ACE Cover is rejected for this goal — no seed-lottery extension, no other model downloads.
- If one guide passes words+contour: voice-convert ONLY that candidate (existing Voicebox/SVC path) → second owner verdict on timbre. Only then expand to middle/Truman-lead/continuous first half.

### Stage A ordered tasks
1. Rescue commit (Stage 0) → `pytest scripts/fms-killshot/asserted_proof_plan_test.py` green in the new home.
2. `asserted_proof_cover_lexical.py` + tests (pure, seed-42 fixture) — fastest feedback, no venvs.
3. `asserted_proof_cover_metrics.py` (`compare_f0_contours`, `attack_errors_from_alignment`, `evaluate_candidate`, `ranking_key`, `effective_status`, `THRESHOLDS`) + edge-case tests.
4. `ace_cover_worker.py` → `py_compile` under the ACE venv; wrong-git-rev request → structured failure without model load.
5. `asserted_proof_ace_cover.py` pure core (request build/hash, seed planning, ranking, manifest, verdict application) + tests.
6. Verdict + preview-server extension + staleness tests.
7. Subcommand wiring; `ace-cover-spike --dry-run` prints guards + planned seeds `[7,73,271,509,911,2027,4099]` + seed-42 import plan.
8. Page section + design-doc addendum; `review` regenerates; section absent pre-spike, opening section byte-identical.
9. **End-to-end batch run** (7 generations + seed-42 import + legacy registration), immediate re-run proves idempotency ("0 seeds to generate"), browser QA on :8189, one verdict round-trip incl. 409-stale check.
10. Owner listens → verdicts → either `ace-cover-stop` or proceed to voice conversion. (Informal determinism check: compare regenerated seed-42-equivalent vs the imported ad-hoc one.)

## Stage B — Verdict-dependent product integration (decision matrix)

### If the opening gate PASSES (words + contour by owner ear)
1. Voice-convert only the passing candidate (existing Voicebox/SVC path) → second owner verdict on timbre.
2. Expand the same pinned configuration to middle + Truman-lead; continuous first half only after all three known-lyric chunks pass (`expand-first-half` precedent).
3. Product promotion (own brainstorm → spec → plan cycle, not built blind here): `service/adapters/acestep_adapter.py` behind the existing render-layer contract — `create_render_layer {adapter:"acestep", mode:"sing"}`-shaped, fake-first pin (`MOSH_ENABLE_ACESTEP=0`), isolated venv worker (the Stage-A worker is the seed of it), cache fingerprint = upstream hash · runtime rev · checkpoint rev · params · seed · linesJson. SoulX PC bring-up stays parked as the fallback lane.

### If the gate FAILS
- `ace_cover_lexical_blocked` or `ace_cover_prosody_blocked` recorded in the ledger; ACE Cover is **rejected for this goal** — no seed-lottery extension, no new model downloads.
- SoulX Stage 3 (PC bring-up per `service/soulx/PC_RUNBOOK.md`) becomes the own-voice path; ACE remains the roadmap's "scratch mock" (generic-voice preview) only.
- Optional bounded follow-up audit (from the Codex follow-ups): whether ACE flow-edit (`flow_edit_morph`) could preserve the raw take more closely — audit only, not a new lottery.

## Test & acceptance

- Unit tests (in `scripts/fms-killshot/`, following `asserted_proof_plan_test.py`): request construction, seed reuse/idempotency, lexical ranking (seed-42 ASR as a real fixture), contour-metric edge cases, deterministic ordering, manifest-quarantine + hash-stale verdict rejection.
- Integration: one real ACE batch producing 8 ledger entries; a re-run regenerates nothing (idempotent).
- Browser QA on :8189: all displayed files current + playable (HTTP range requests), labels correct, verdict controls hash-bound.
- Gross technical limits (shortlist only, never auto-pass): median attack ≤ 80 ms, p95 ≤ 150 ms, silence bleed ≤ 100 ms, median voiced-pitch error ≤ 1.5 st, no contiguous octave error > 100 ms.
- Opening acceptance = owner ear: intelligible asserted words, recognizably preserved raw phrasing/register, no broken/static vocal quality.

## Verification

- `pytest scripts/fms-killshot/asserted_proof_plan_test.py scripts/fms-killshot/asserted_proof_ace_cover_test.py` (+ the lexical/metrics test files) green **×3 deterministic** (house style).
- `python3 scripts/fms-killshot/used2_asserted_proof.py ace-cover-spike --dry-run` → guards + seed plan; then the real run end-to-end on this Mac (ACE venv, MPS); immediate re-run → "0 seeds to generate" (idempotency proof).
- `… review` + `preview_server.py` → browser QA on :8189: candidates playable (range requests), labels/chips correct, verdict 409 on a deliberately-staled hash.
- Owner listens; verdicts saved through the hash-bound panel; gate outcome recorded (pass → voice-convert one candidate; fail → `ace-cover-stop`).
- Repo hygiene: no ACE deps in Mosh's Python; `--selftest`/Catch2/vitest untouched (all work is `scripts/` + external artifacts); nothing under `~/mosh-fms-ksb` enters git.
