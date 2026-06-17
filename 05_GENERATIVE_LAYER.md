# 05 — Tier B: The Generative Layer (adapter + job service)

> **Status:** Design spec — source of truth for *how* this subsystem was built (v0, gate PASSED). New to the repo? Start with [ARCHITECTURE.md](ARCHITECTURE.md); build status is in [CLAUDE.md](CLAUDE.md).

*Scope: the offline, non-destructive generative layer. A model-neutral `GenerativeModelAdapter` behind a proper job service; the RenderLayer flow (render a region → audition → accept as a reversible take); a `FakeAdapter` for bring-up and a `StableAudio3Adapter` as the first real adapter (colors, two control vocabularies, re-imagine, init-latent cache, judge QA, composition cap). All invoked through MoshOps commands (`02`).*

**Depends on:** `01` (RenderLayer model, render/playback exclusivity), `02` (the generative commands), `06` (service packaging). **Consumed by:** `03` (the generative drawer / Color Rack).
**Effort:** native side = engine render + a job client + the adapter/service; the SA3 brains are **carved from existing research**, not written from scratch.
**Primary references:** the SA3 research master record (the user's `SA3_MASTER.md`, §1–§8, App. A/B); Tracktion `Renderer`, the takes/`CompManager` system.

> **Two big shape changes from the prior draft (adopted in review):** (1) the model is behind a **model-neutral adapter** — SA3 is the first adapter, not the architecture; (2) the service is a real **job service** (submit/status/progress/cancel + lifecycle), not bare request/response, with audio moving over **files + manifests**. Build the **`FakeAdapter` first** and prove the entire orchestration before the heavy model.

---

## 1. The wall (why a job, not an insert)

A generative diffusion model is a **job**: hand it a region, wait (seconds), audition, cache, re-render when the source changes. It can't keep up with the audio clock and is never a live downstream insert (the dependency rule: a live source upstream of it loses its live feel because you can't hear the final output until it re-renders — perform/capture first, transform after, put hands-on real-time DSP downstream). Because the real-time tier is in-process (`04`), this is the **only** out-of-process component, reached through the job manager over a local file/manifest protocol.

---

## 2. The model-neutral adapter

```
GenerativeModelAdapter
    id                      // "fake" | "stable_audio_3" | "stable_audio_open_small" | ...
    version
    generation_modes        // any of: text_to_audio · audio_to_audio · inpaint · continue · streaming
    conditioning_inputs     // any of: prompt · init_audio · style_audio · negative_prompt · midi · lora
    duration_limits         // {min, max} seconds  (e.g. SA3 Medium ≤ 380s; SA3 Small ≤ 120s)
    sample_rates            // surfaced rates + channel modes  (SA3 family: stereo 44.1 kHz)
    runtime_requirements    // any of: cpu · apple_mlx · cuda · tensorrt   (v0 = apple_mlx)
    packaging_mode          // embedded_cpp · python_service · torchscript · onnx · mlx_bundle
    supports_seed
    supports_semantic_controls
    license_meta            // recorded for awareness only (private research → not gating; see 07)
```

- **`FakeAdapter`** — returns deterministic placeholder audio fast (e.g. a filtered/gain-shifted copy of the input, seeded). It exercises the *entire* pipeline — job submit, progress events, cache, RenderLayer states, accept/reject, the taste log — with no model. Build it first.
- **`StableAudio3Adapter`** — wraps the carved SA3 service (§5–§7). `generation_modes = [text_to_audio, audio_to_audio, inpaint, continue]`; `conditioning_inputs` includes `prompt, init_audio, negative_prompt, lora`; `runtime_requirements = [apple_mlx]`; `duration_limits` Medium ≤ 380s / Small ≤ 120s; `sample_rates` stereo 44.1 kHz; `supports_semantic_controls = true`.
- **`StableAudioOpenSmallAdapter`** *(optional bring-up rung)* — a real-but-light, CPU/MLX-capable adapter (~11s) usable as an intermediate between `FakeAdapter` and SA3 Medium. Optional for this project specifically, since the MLX SA3 port already runs locally and the `FakeAdapter` already de-risks orchestration — include only if a real-but-cheap render helps shake out the service before the heavy path.

The product owns this abstraction so that a smaller local model (SAO-Small), a near-real-time model, or the existing research service can each slot in without touching the DAW.

---

## 3. The RenderLayer flow (native side, via commands)

Non-destructive mechanism: **render the source region offline → submit to the adapter/service → audition the result as a take → accept (or reject) → params persist in the `MOSH_RENDERLAYER` tree (`01 §4`).**

1. **`create_render_layer`** on a clip/region → a `MOSH_RENDERLAYER` node (`status="empty"`), params editable via `set_render_param`.
2. **`render_layer`** → render the source region to a temp WAV **offline, off the audio thread, Edit detached** (avoid the "rendering whilst attached" assert, `01 §5`):
   ```cpp
   te::Renderer::Parameters r (edit);
   r.destFile = tempWav; r.audioFormat = engine.getAudioFileFormatManager().getWavFormat();
   r.sampleRateForAudio = 44100; r.bitDepth = 24; r.time = sourceRegionRange;
   r.tracksToDo = bitsetForTracks({ sourceTrack }); r.allowedClips = { sourceClip };  // be explicit
   r.realTimeRender = false;
   te::Renderer::renderToFile ("Mosh source render", r);   // background EditRenderJob
   ```
   Then submit a **job** (§4) to the adapter; emit `layer_status`/`layer_render_progress` events; return a job id in the command `data`.
3. **`accept_render`** → land the returned WAV non-destructively (default: as an alternate take on the source clip — see the landing model below); set `userKept=true`, `status="ready"`. **`reject_render`** discards. `bypass_layer`, `freeze_layer`, `bounce_layer_to_clip` as additional commands.

### 3.1 Landing model (default + setting + fallback)

Re-imaginations and generated renders land **as alternate takes on the source clip by default** — the cleanest non-destructive UX: A/B is take-switching, lineage is native, and the `MOSH_RENDERLAYER` already parents under the clip (`01 §4.2`). A **per-project setting** `neural_render_landing = "take" | "new_clip"` flips landing to **a new `WaveAudioClip` on a dedicated "neural" lane** (lineage preserved via the RenderLayer link; A/B via mute/solo). `accept_render` takes an optional `landing` arg that overrides the project setting per call.

> **Terminology:** Tracktion takes belong to a **clip**, not a separate track — there is no "take track." The takes live *inside* the source clip; you switch or comp between them. So the default is "alternate takes on the source clip," and the RenderLayer parents under that clip.

**The `// VERIFY` that decides whether the default is trivial or hard.** Tracktion's takes/comp system (`CompManager`/`WaveCompManager`; takes in a `TAKES` child) was built primarily for *record-time* comping (loop a section, each pass auto-creates a take). **Injecting an externally-generated WAV as a take and promoting it from C++ is off the beaten path** — confirm the public API supports clean external take injection against the pinned clone.
- **If it does:** the take path is the default (audition = add as an additional take; accept = promote; the source take always survives → reversible via undo + take switching).
- **If it's opaque or tangled in the recording machinery:** the **new-clip-on-neural-lane path is the guaranteed fallback** — and because it's already a user-selectable mode via the setting above, it ships as a legitimate feature, not a defeat. Flip the project default to `"new_clip"` and keep the take path as a later enhancement.

---

## 4. The generative job service (files + manifests)

The model runs in a separate process (`service/`). The native **Generative Job Manager** (`src/generative/`) talks to it over a **local job protocol** (HTTP/JSON is fine for v0 *for control*; **audio moves as files + manifests**, never giant JSON).

**Protocol:**
```
submit_job · get_job_status · stream/log progress · cancel_job · pause_queue · resume_queue ·
get_capabilities · get_model_versions · get_result_manifest
```
**Lifecycle (the manager owns these):**
```
warmup · heartbeat · crash-restart · model-version check · capability handshake ·
GPU/CPU availability · disk-cache location · cancel-on-project-close
```
**On-disk job (per render):**
```
input.wav · input_manifest.json · job_request.json · progress.jsonl · output.wav · output_manifest.json
```
Renders are slow/expensive, so **orchestration is half the UX**: async (playback never stalls — the source take plays while a render runs), debounced (fire on knob-release, not per-tick), region-scoped invalidation, cancellable, queueable. Map service progress → `layer_render_progress` events (`02 §4.2`).

---

## 5. The full cache fingerprint (do not shortcut)

Reuse `MOSH_RENDERLAYER.cacheArtifact` only when the fingerprint matches (`01 §4.3`): upstream audio/MIDI/plugin-state hash · clip range · tempo/key · sample-rate/channel layout · `modelAdapter` · `modelVersion` · `adapterVersion` · prompt/semantic controls · seed · sampling hyperparameters · `safetyMappingVersion` · service build/version. Any mismatch → `status="dirty"` → re-render. (This is the defense against wrong-cache-reuse bugs.) The SA3 adapter additionally caches **init-latents** keyed by the source-audio hash so changing only colors/seed/nl skips the VAE encode (§6).

---

## 6. StableAudio3Adapter specifics

The adapter exposes SA3's controls as **two clearly-separated vocabularies** (the structure the product is built around):

1. **Semantic knobs (colors):** paraphrase-gate-validated steering directions — `grit`, `air`, `brightness`, `aggression`, `distortion`, `epic`, plus the hero independents `drum_aggression`, `grid_tightness`. Each is an **ASTD-clamped 0–100 slider**; the service's `/colors` (or capability handshake) returns each color's `astd_max` collapse clamp (e.g. `air` = 0.08). The shared ASTD module (`04 §6`) maps 0–100 → raw α in `[0, astd_max]`, so a color can't be driven into quality-collapse. **Lab mode** unlocks beyond the clamp behind a warning (same mechanism as Tier A).
2. **Sampling hyperparameters:** `seed`, `cfg`, `steps`, and (re-imagine) `init_noise_level` — the diffusion controls, surfaced as a distinct "advanced/engine" cluster, not mixed with the colors.

**Two modes:**
- **generate:** text → audio (prompt + colors + sampling params).
- **re-imagine (audio2audio — the creative core):** encode the source loop, re-noise `noise = init_latents·(1−σ) + pure_noise·σ`, denoise **with steering**. `init_noise_level ≤ 0.5` keeps it recognizably the same song; different seeds at fixed nl = usably different takes; paraphrase-robust colors color it best.

**Composition cap:** ≤3 active colors, ordered, earlier-layer dominates later (enforced in `01 §4.4` + UI).

**Carve-out (App. B):** parameterize the two hardcoded paths as env vars (`SA3_MLX_DIR`, `COLORRACK_DATA`); keep the engine-thread-owns-model + priority-queue concurrency (renders jump ahead of background mints); external deps (MLX SA3 port, judge venv, CLAP checkpoint) stay external and pointed-at. Do **not** reimplement SA3, steering, or the judges.

---

## 7. The judge panel as QA (reused infrastructure)

The panel (CLAP + MuQ-MuLan + Audiobox-Aesthetics + MERT-FAD + IR/acoustic proxies) exists. Expose it as a **QA signal on every render**: the `output_manifest.json` carries `pq` (Audiobox production quality) vs `pq_base` and any `flags`; the UI shows a subtle quality readout so a producer sees when a transform degrades the mix. **Generalize it (platform):** the same panel calibrates ASTD collapse points for *both* tiers (`04 §6`) and can score any neural output. In v0 it's QA + ASTD calibration only — no learning. (Post-v0, accept/reject from the MoshOps log + these scores feed the taste flywheel.)

---

## 8. Deferred research tracks (NOT v0 — record only)

Architecture must not preclude these; do not build them:
- On-device tier: SAO-Small (341M) for local re-imagine; open question whether steering vectors transfer Medium→Small (mint/validate on Medium, bake/transfer onto Small).
- LoRA-base + vector-knobs layering (genre LoRA holds the on-manifold base; vectors ride on top).
- Timestep-scheduled steering (quality + render-cost win; path to a live generative tier).
- Held-out generalization + blind listener test (gates *trusting library expansion*, not shipping the ear-confirmed colors); rotate one judge out of any discovery loop to avoid oracle-overfitting.

---

## 9. Verification gates

- **Stage 5 (Fake):** full loop via commands — `create_render_layer` → `render_layer` (job submitted, progress events) → audition → A/B vs source → `accept_render`/`reject_render`; cache hit/miss correct against the fingerprint; source change → `dirty` → re-render; the JSONL log records accept/reject as taste labels; playback never stalls during a render.
- **Stage 5 (SA3):** swap in `StableAudio3Adapter`; a real `grit` color and a real re-imagine (`nl ≤ 0.5`) commit as an auditionable take with a quality readout; `/colors` drives knobs + ASTD clamps; Lab mode unlocks; init-latent cache reports a hit on seed-only change.

## 10. Honest gaps / `// VERIFY`

- Takes/comp add+promote API — `CompManager`/`WaveCompManager`; new-clip-on-new-track fallback if thin.
- `Renderer::Parameters` field names + `renderToFile` overload (esp. `tracksToDo` bitset, `allowedClips`).
- Render-to-file (preferred) vs render-to-buffer.
- Carve-out: confirm external deps present and the two hardcoded paths parameterized (App. B).
