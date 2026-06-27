# Plan — Tutorial Teardown → Reward-Learning Pipeline

*Build plan for the spec at [`docs/superpowers/specs/2026-06-27-teardown-reward-pipeline-design.md`](../specs/2026-06-27-teardown-reward-pipeline-design.md). Multi-month arc; land in PR-sized increments — each phase ships something independently useful and passes the full gate.*

## Context

Tear down "show-their-work" beat tutorials into structured **Recipes**, reconstruct them as real Edits (which also extracts your own drum samples and matches synths), turn the reconstructions into a labeled **anchor corpus**, ablate that corpus into paired data, train a **musically-grounded reward head**, and use it as the "pull" reward in a GRPO loop that tunes the command-emitting agent. All of §1–§12 is pure Python under `service/teardown/`; only §9's executor crosses the engine seam, and only via **MoshOps commands**.

The §8/§5b reframe (this revision): reading a synth's on-screen patch is a distinct **vision problem** (knob angles, graphic envelopes, wavetable selection — all approximate), so a cheap **§5b GUI patch-reader** is the primary route and **§8** is the render-in-the-loop **error-correction + substitute** layer, demoted behind §5b and a readability **measurement checkpoint**.

## Repo grounding (verified 2026-06-27)

- **No `service/teardown/` yet.** Reusable templates: the carve-out venv pattern (`service/transcribe/`, `service/transform/`: `setup-X.sh` → `.venv` → `.X.env` → `run.sh` sources it → subprocess CLI with stdlib `wave` I/O → graceful 503) and `service/server.py`'s adapter + serialized priority-queue job broker.
- **No CLAP/MERT/MuQ/FAISS/embeddings anywhere.** The only audio judge is the Audiobox-Aesthetics `pq` sidecar (`service/sa3/qa.py`, `service/quality_readout.py`) — the "mastering-engineer ears" §11 moves past. §1's embedder+ANN and §6/§11's scorer are net-new.
- **The "new MoshOps primitives" are smaller than the spec implies.** `import_clip(file,trackId,name,startSeconds)` (`src/moshops/MoshOps.cpp:452`) already does insert-from-path; `bounceClipToWav()` (`MoshOps.cpp:4559`) already does per-clip offline render (just not exposed as a command); `--run-script` (`src/Main.cpp:101`, JSONL replay + `${VAR}` capture + `__wait`) + `export_audio` already gives "command sequence → wav."
- Verification culture: `Mosh --selftest` ×3 deterministic (0 Catch2 assertion failures); `ui/` vitest incl. `commands.contract.test.ts` (text-parses `MoshOps.cpp` — every new agent-catalog arg must be read in the command body); Playwright e2e; `scripts/verify-hardware/verify.py` (drives `--run-script`, numpy WAV analysis).

## Shared infrastructure (do first / alongside Phase 1)

- **Carve-out venv** `service/teardown/`: `setup-teardown.sh` + `.teardown.env` (exports `TEARDOWN_PY`, `TEARDOWN_MODEL_DIR`, `TEARDOWN_LIB_ROOT`) modeled on `service/transcribe/setup-transcribe.sh` and `service/transform/setup-transform.sh`. `run.sh` sources `teardown/.teardown.env`. Deps grow per phase: `numpy`, `librosa`, `soundfile`, `faiss-cpu`, `laion_clap` (or `openl3`/`panns-inference`), `pydantic`; later `yt-dlp`, `faster-whisper`, `demucs`, `basic-pitch`, `pyscenedetect`, `paddleocr`/`pytesseract`, `cma`. Heavy work runs in the subprocess CLI with stdlib `wave` I/O (the transform-CLI lesson). Gated by `MOSH_ENABLE_TEARDOWN`.
- **Primitives — minimize new C++:**
  - `insert_audio_clip` → **reuse `import_clip`**; add an `inPlace` flag only if reference-without-copy is needed.
  - `render_track_offline(trackId, startSec, endSec) -> wavPath` → **expose `bounceClipToWav()`** as a thin command (dispatch table + agent catalog + contract test).
  - `--render-rollout` → **reuse `--run-script` + `export_audio`/`render_track_offline`**; add a thin `Main.cpp` wrapper only for ergonomics.
- **Job broker**: add `/teardown/*` routes to `service/server.py` — sync (like `/transcribe`) for fast ops, async `/submit`+`/status`+`/cancel` for batch teardown (§10). Reuse the serialized priority worker + `available()`/graceful-degradation.

## Phase 1 — standalone value + infra (execution-ready)

1. **Recipe contract (§0)** — `service/teardown/recipe.py` (pydantic v2, `schema_version "2.0"`) + exported `recipe.schema.json`. Encodes the §5b/§8 reframe: `synth_patch.status ∈ {params_visible|matched|substituted|unavailable|unknown}`, `reconstruction_class ∈ {deterministic|inferred|partial}`, per-field `{value, confidence, evidence}`. Schema-lint + round-trip test (mirrors `commands.contract.test.ts` discipline), 3× deterministic. Asset folder `<recipe_id>/recipe.json + assets/{stems,midi,shots,transcript.json}`. **Freeze before §3/§4/§9.**
2. **Drum matcher (§1)** — `service/teardown/drummatch/{embed,index,roles,cli}.py`, JUCE-clean. `Embedder.embed(audio)->np.ndarray` (CLAP audio tower on a 1 s log-mel front end) **+ engineered-feature baseline** (MFCC stats, centroid/rolloff/flatness, onset env, log-attack-time), benchmarked. FAISS cosine on L2-normed vectors + manifest (`path,content_hash,role_guess,kind,embedder_version`); re-embed on hash/version change. Cheap role classifier. In-app: new MoshOps `find_similar_sample` (sync `/teardown/match`) wired into `ui/src/ui/SampleBrowser.tsx`/`sampleBrowserUtil.ts` (reuse `file_peaks`/`audition_file`). Eval: ≥10 perceptual-similarity groups → precision@5/recall@10; ranking deterministic ×3; messy library → zero crashes; warm query <50 ms on 5k.
3. **Vision package (§2)** — `service/teardown/vision/{daw,pianoroll,synthgui}.py`. `daw_detect`, `piano_roll_present`+localizer, `synth_gui_present`→{plugin?,bool}. Lightweight classifiers/template-matching; per-class accuracy on a labeled frame set. Unblocks §3/§4/§5/§5b.
4. **Oracle (§6) + primitives** — `service/teardown/oracle/{render,score,cache}.py`. `render()` shells `--run-script`/`render_track_offline`; `score()` = CLAP/MERT cosine now, swap-in §11's head later (versioned). Baked-in: LUFS-normalize before scoring, ~10 s window, cache by rendered-WAV hash, versioned scorer. Single highest-leverage shared build.

## Phase 2 — front half: sourced video → Recipe (roadmap)

- **§3 Sourcing** `sourcing/{discover,prescreen,verify,score,catalog,posture,cli}.py` — YouTube Data API discovery (`status.license`), metadata pre-screen, sparse §2 verify, `yield.predicted`, `catalog.sqlite`. Posture: transient hash-recorded media cache (yt-dlp), CC-preferred, local-only.
- **§4 Video→skeleton** `video2recipe/{acquire,segment,transcribe,ocr,assemble,cli}.py` — yt-dlp acquire, PySceneDetect + cadence keyframes, faster-whisper transcript, OCR (tempo/key/plugin names → evidence), §2 DAW detect, section segmentation. Always schema-valid.
- **§5 MIDI-from-screen** `midi_from_screen/{locate,axes,notes,profiles/,export,cli}.py` — piano-roll CV → `.mid`; per-DAW skin profiles (FL first). Produces `deterministic` gold anchors.
- **§5b Synth-GUI patch reader** `synth_from_screen/{locate,controls,profiles/,export,cli}.py` — knob-angle / graphic-envelope / wavetable vision → `synth_patch.params` + per-param confidence; per-synth profiles (Serum, Vital). The **primary** patch route.
- **MEASUREMENT CHECKPOINT** — run §5b over ~50 top-yield tutorials; report the clean-readability fraction (≥~80% → §8 a footnote; ~40% → §8-substitute core). Sets §8's scope **before §8 is built.** Land as a `verify.py` report.

## Phase 3 — back half: Recipe → playable + matched (roadmap)

- **§9 Render** `render/{compile,emit,execute,qa,cli}.py` — Recipe → ordered MoshOps (meta→tracks→inserts/params→content→mix). `compile.py` JUCE-clean (data only); `execute.py` the only seam-crosser. Dry-run/plan persisted before execute (idempotent). Holes → substitute / `create_render_layer` Tier-B fallback. QA writes `yield.actual` + sets `reconstruction_class`. **Runs on §5/§5b/§1 alone — needs neither §7 nor §8.**
- **§7 Extraction lane** `extract/{separate,drum_slice,pitch,transcribe,mono_tone,cli}.py` — demucs separation, drum-slice→§1 match, bass pitch→MIDI, polyphonic fallback (basic-pitch), mono-tone for §8. Tagged `inferred`.
- **§8 Synth match** — CMA-ES v1 only, against §6, seeded by §5b; substitute path; estimator deferred. Build *after* the checkpoint, scoped by it.
- **§10 Orchestrator** `orchestrate/{pipeline,policy,decisions,jobs,cli}.py` — confidence-gated staged pipeline, BrainProxy (`src/brain/BrainProxy.h` `chat()`) for labeling/section-naming/substitute-choice with schema-validated structured output, resumable from Recipe checkpoint, async job model like `GenerativeJobManager`.

## Phase 4 — reward + handoff (roadmap)

- **§11 Flywheel** `flywheel/{anchors,ablate,train_sim,reward,cli}.py` — anchor store (only `deterministic` reconstructions as gold positives), ablation engine (controlled musical-only edits → graded negatives), reward head from MuQ/MERT (not Audiobox) via contrastive/triplet, versioned `score()`/`score_against_exemplars()`. Keystone test: beat raw CLAP at preserving ablation ordering on **source-video-held-out** anchors.
- **§12 RL bridge** `flywheel/reward.py` exposes `Reward`/`PromptFeed` to the external GRPO trainer. Floor (clean-apply gate + Audiobox PQ + MuQ head + DSP guards + CLAP-as-one-vote) + pull (§11 head). Renderable prompts seeded from §9 sequences; render step = §6 oracle. Rails: KL leash, ensemble ≥2, LUFS-norm, short render, early stop, golden listening set. Validate via the handoff's Stage-0 single-Audiobox probe first, then swap in §11.

## Verification

- **Per phase:** `Mosh --selftest` ×3 deterministic (0 Catch2 failures), `cd ui && npm test` (incl. `commands.contract.test.ts` for new commands), `cd ui && npm run test:e2e`, and a new `service/teardown/verify.py` (mirror `scripts/verify-hardware/verify.py`: drives `--run-script`, numpy WAV analysis, timeout-guarded, exits 0/1).
- **Each Python component:** small labeled eval set + metric (precision@k, note-F1, OCR ±1 BPM, per-control read error, embedding-distance thresholds); stochastic checks ×3 stable.
- **New MoshOps commands:** contract-test coverage (args read in body), agent-catalog entry, JSONL-logged.
- **E2E smoke (Phase 3):** regime-1 tutorial → high-`yield.actual` recipe → playable Edit (asserted via `snapshot()`) → offline render diffs sensibly from source; deliberately-incomplete recipe renders without error, reports low actual yield.
- **Reward (Phase 4):** the §11 keystone test is the headline gate before §12 wiring.

## Key decisions

- §8 demoted to refinement+substitute; CMA-ES-only v1; estimator deferred to v2 behind a flag.
- New §5b GUI patch-reader is the primary patch route (lettered §5b to avoid renumbering 11 sections).
- Reuse `import_clip` / `bounceClipToWav` / `--run-script`; only `render_track_offline` is genuinely new C++ (a thin wrapper).
- MuQ/MERT (not Audiobox) for the music-quality head; Audiobox stays the production-surface floor.
- §9 sequenced before §7/§8 so the easy (screen-readable) regime carries the system.
