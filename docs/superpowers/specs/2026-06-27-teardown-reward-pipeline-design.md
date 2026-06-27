<!--
TRACKED DESIGN DOC — git-versioned snapshot of the teardown→reward pipeline spec.
Origin: the working file `mosh-teardown-reward-pipeline-FINAL.md` in the repo root checkout.
This snapshot (2026-06-27) incorporates the §8 reframe + new §5b (synth-GUI patch reader),
the build-order demotion of §8, and the measurement-checkpoint gate. Build plan:
docs/superpowers/plans/2026-06-27-teardown-reward-pipeline.md.
-->

# Tutorial Teardown → Reward-Learning Pipeline — Final Build Spec

*Definitive, consolidated spec. Supersedes the two-part draft (`tutorial-teardown-pipeline.md` and `…-part2.md`) — merge those into this. Audience: Claude Code. Target repo: the Mosh DAW (`service/` = the Python Tier-B job broker). Companion context: [ARCHITECTURE.md](ARCHITECTURE.md), [CURRENT_STATUS.md](CURRENT_STATUS.md), and the audio-taste RL handoff (`Mosh — Audio-Taste RL`). Updated 2026-06-27.*

---

## The system in one paragraph

Find tutorials that actually show their work → tear each one down into a structured **Recipe** → reconstruct it as a real Edit (which, as a side effect, extracts your *own* drum samples and matches the synths) → the reconstructions become a labeled **anchor corpus** → an **ablation engine** turns that corpus into paired data that isolates *musical* choices from production surface → a **learned similarity/reward head** trained on that data → which becomes the **"pull" reward in a GRPO loop** that tunes the command-emitting agent to produce music that sounds good. That last agent is the one the whole project was for. Everything here is reward *production and interface*; the GRPO *consumption* loop lives in the RL handoff and plugs into §12.

```
 SOURCING(§3) ─queue→ ORCHESTRATOR(§10) drives, per video:
   VIDEO→SKELETON(§4) → { MIDI-FROM-SCREEN(§5) + GUI-PATCH-READ(§5b) | EXTRACTION(§7) } → DRUM-MATCH(§1) + SYNTH-REFINE(§8)
        → RENDER(§9) ─► playable Edit + yield.actual + isolated reconstruction stems
             → FLYWHEEL(§11): anchors + ablation engine ─► learned reward head + paired data
                  → RL BRIDGE(§12): floor+pull reward ─► GRPO loop ─► taste-tuned command agent
   spine: RECIPE(§0) threads through all of it.
   shared: vision detectors(§2) · embedder(§1) · render-and-compare ORACLE(§6) · catalog(§3) · anchor store(§11)
```

## Invariants (hold across every agent)

- **Tier-B, offline, out-of-process.** All nine agents are pure Python under `service/teardown/`. Only §9's executor crosses into the engine, and only via **MoshOps commands** — nothing touches Tracktion/JUCE or the audio thread directly (the load-bearing seam from ARCHITECTURE.md §3).
- **A missing field is `null`/`unknown`, never a failure.** Partial recipes are first-class; the system degrades gracefully.
- **Confidence + evidence travel with every inferred value.** This is what lets downstream stages (and the reward loop) trust or distrust each piece.
- **Verification mirrors repo culture.** Each agent ships a small labeled eval set + its metric; stochastic checks run 3× and assert stability (`mosh-verification-conventions`); `Recipe` output is schema-linted the way `commands.contract.test.ts` pins the command catalog. All offline Python — no audio-hardware or plugin-hosting gates except where §9 executes.

## New MoshOps primitives this system requires

Both are small; flagged again inline where used. Confirm they exist or add them before §6/§9.
- `insert_audio_clip(track, path, start)` — place an existing audio file as a clip. (Capability index lists clip ops + import/export but no explicit insert-from-path.) Needed by §1, §7, §9.
- `render_track_offline(track, range) -> wav` **and** a rollout CLI `Mosh --render-rollout <commands.json> --out <wav>` — faster-than-realtime bounce of a single track/patch *and* of a full command sequence, alongside the existing `--selftest`/`--demo` harness, using Tracktion's offline bounce (not realtime). The **oracle (§6), §8, §9 QA, §11 reward, and the §12 RL loop all depend on this.** It is the single most load-bearing new surface — build it early.

---

## §0. The contract — the `Recipe`

The spine. Every agent reads/writes a subset. Implement as a pydantic model in `service/teardown/recipe.py`; export a JSON Schema (`recipe.schema.json`) for the contract test.

```jsonc
{
  "recipe_id": "uuid4",
  "schema_version": "2.0",

  "source": {
    "platform": "youtube", "video_id": "string", "url": "string", "title": "string",
    "channel": "string", "duration_s": 0,
    "license": "youtube | creativeCommon | unknown",   // YouTube Data API exposes this
    "retrieved_at": "iso8601", "content_hash": "sha256" // provenance + dedup; transient-cache key
  },

  "meta": {
    "daw":            { "value": "fl_studio|ableton|logic|other|unknown", "confidence": 0.0 },
    "tempo_bpm":      { "value": 140, "confidence": 0.0, "evidence": ["shot_id@t"] },
    "key":            { "value": "F# minor", "confidence": 0.0, "evidence": [] },
    "time_signature": { "value": "4/4", "confidence": 0.0 }
  },

  "arrangement": { "sections": [ { "name": "intro|verse|hook|...", "start_s": 0, "end_s": 8, "confidence": 0.0 } ] },

  "elements": [{
    "element_id": "string",
    "role": "kick|snare|hat|clap|perc|808|bass|lead|pad|pluck|fx|vocal|other",
    "label": "string",
    "audio_ref": "assets/stems/elem_03.wav | null",

    "midi": { "status": "extracted|partial|absent|unknown", "midi_ref": "…/elem_03.mid | null",
              "note_count": 0, "confidence": 0.0 },

    "sample_match": { "status": "matched|candidate|none", "matched_path": "library/kicks/x.wav | null",
                      "distance": 0.0, "alternates": [ { "path": "string", "distance": 0.0 } ] },

    "synth_patch": {
      "status": "params_visible|matched|substituted|unavailable|unknown",
      "plugin": { "name": "Serum|Vital|…", "available_locally": true },
      "params": { },                                    // when readable/recovered
      "match":  { "target_audio_ref": "string", "method": "sound_match", "confidence": 0.0 },
      "substitute": { "plugin": "Vital", "preset_ref": "string", "note": "approximation" }
    },

    "evidence": [ { "type": "screenshot", "ref": "assets/shots/elem_03_synth.png", "t_s": 73.4, "ocr_text": "string" } ],
    "confidence": 0.0
  }],

  "unresolved": [ { "issue": "string", "element_id": "string|null", "suggested_action": "string" } ],

  "reconstruction_class": "deterministic | inferred | partial",  // §11 anchor gating keys on this
  "yield": {
    "predicted": { "drums": 0.0, "midi": 0.0, "synth": 0.0, "arrangement": 0.0, "overall": 0.0 },  // §3 writes
    "actual":    { "drums": 0.0, "midi": 0.0, "synth": 0.0, "arrangement": 0.0, "overall": 0.0 }    // §9 writes
  }
}
```

`reconstruction_class` is the one schema change vs the draft: `deterministic` = built from screen-read MIDI (§5) + screen-read params (§5b) at high confidence (regime-1; gold anchor for §11), `inferred` = leaned on §7 extraction or §8 refinement/substitution, `partial` = holes. The flywheel only treats `deterministic` as ground truth.

**Asset folder** (one per recipe): `<recipe_id>/recipe.json` + `assets/{stems/, midi/, shots/, transcript.json}`. The `Recipe` is shaped to **compile to MoshOps** (each element → `create_track` + content + plugin commands) — keep field names role-oriented, never DAW-specific.

---

## §1. Drum sample vector-space matcher  *(build first)*

Highest value-to-effort, useful standalone (an in-app "find me a kick like this"), and it builds the embedding + ANN infrastructure the rest reuses. Zero dependency on video/synth work.

**Purpose.** Embed the user's local one-shot library into a vector space; given a query one-shot (or an extracted hit from §7), return the perceptually nearest samples the user *owns* — so recipes reference samples you have, never the tutorial's copyrighted audio.

**Pipeline.** (1) Scan & normalize: decode (soundfile + ffmpeg fallback), resample 44.1k, mono-sum, peak-normalize, trim silence; tag anything >~3 s or sustained as `kind=loop` and exclude from the one-shot index. (2) **Embed** behind `Embedder.embed(audio)->np.ndarray`: default a pretrained general-audio encoder (CLAP audio tower / OpenL3 / PANNs) on a fixed 1 s log-mel front end; **also implement an engineered-feature baseline** (MFCC stats, spectral centroid/rolloff/flatness, onset envelope, log-attack-time) and benchmark — the baseline is often competitive on one-shots and is the fallback. Leave a `finetune/` hook. (3) **Index**: FAISS/hnswlib, cosine on L2-normalized vectors; persist + a manifest (`path, content_hash, role_guess, kind, embedder_version`); re-embed only on hash/version change. (4) Optional cheap **role classifier** (`kick/snare/hat/…`) for role-filtered queries. (5) **Query** → ANN → top-k; write best as `matched` below a distance threshold else `candidate`, plus `alternates`.

```python
class DrumMatcher:
    def build_index(self, library_root: Path) -> IndexStats: ...
    def query(self, audio: Path | np.ndarray, role: str|None=None, k: int=10) -> list[Match]: ...
    def match_into(self, recipe: Recipe, element_id: str) -> None: ...
```
**Module layout.** `service/teardown/drummatch/{embed.py, index.py, roles.py, cli.py}`. Keep import-clean of JUCE so it can later back a backend-only MoshOps query (e.g. `find_similar_sample`) for the in-app UI.

**Acceptance.** Build a labeled eval set (≥10 groups of perceptually-similar one-shots); report **precision@5 / recall@10** (target set with owner after a baseline). Determinism: identical query → identical ranking ×3. Ingests a messy real library (mixed rates/bit-depths/formats) with **zero crashes** (odd files flagged, not fatal). Warm query <50 ms on a 5k index.

**Failure modes.** Loops mis-ingested (kind tag); near-dup flooding top-k (hash dedup + min-distance collapse); silent/corrupt files; level differences (hence peak-norm pre-embed); filename role mislabels.

---

## §2. Shared vision package  *(detectors — build before §3/§4/§5)*

One package, three reused detectors, so they don't get implemented three times and drift.

- `daw_detect(frame) -> {daw, confidence}` — which DAW (FL/Ableton/Logic) via toolbar/chrome classifier.
- `piano_roll_present(frame) -> bool` + region localizer — used by §4 (flag shots), §5 (consume regions), §3 (yield signal).
- `synth_gui_present(frame) -> {plugin?, bool}` — Serum/Vital/etc. recognizer; used by §3 (yield) and §4 (evidence).

**Module layout.** `service/teardown/vision/{daw.py, pianoroll.py, synthgui.py}`. Lightweight classifiers (or template matching) on sampled frames; ship per-class accuracy on a small labeled frame set.

---

## §3. Sourcing / scouting agent  *(+ research posture)*

**Purpose.** Discover beat tutorials at scale and **score each by predicted recipe yield** — how much of the `Recipe` we'll be able to fill — so §10 pulls the richest, most complete tutorials first. Complete > partial, but partial is kept and graded. The agent is a cheap pre-filter that predicts achievable `yield.predicted` *before* an expensive teardown, and (per §12) corpus **breadth and volume here is the diversity insurance for the eventual reward model** — not just "more data."

**Pipeline.** (1) **Query-template bank** over owner-maintained taxonomies (genres, artists, plugins, DAWs), editable not hardcoded. (2) **Discovery via the YouTube Data API** (the sanctioned path — search + metadata, not scraping): `search.list` over templates, channel mining (good tutorial channels are dense veins), related expansion; pull duration, description, chapters, caption availability, and **`status.license`** (`youtube` vs `creativeCommon`); respect quota with batching/backoff. (3) **Cheap metadata pre-screen** (no download): title/description/tag NLP (is it a from-scratch tutorial? genre? named plugins/DAW?), chapters/timestamps = strong structure signal, caption availability = transcript without audio, duration bands; drop obvious non-matches. (4) **Sparse visual verification** on survivors — pull a handful of frames, run §2 detectors (DAW visible? which? piano roll in any frame? synth GUI? mixer?). (5) **Recipe-yield score** = aggregate into `yield.predicted` per field (`drums/midi/synth/arrangement/overall`), each 0–1 with the signals that drove it. (6) **Catalog + ranked queue** feeding §4.

**Catalog** (`service/teardown/sourcing/catalog.sqlite`): `videos(video_id PK, url, title, channel, duration_s, license, metadata_json, prescreen_score, yield_json, status[discovered|screened|queued|torn_down|failed|skipped], content_hash, discovered_at, screened_at)`.

```python
class Scout:
    def discover(self, templates: list[str], max_results: int) -> int: ...
    def prescreen(self, batch: int) -> None: ...
    def visual_verify(self, batch: int) -> None: ...
    def queue(self, n: int, min_overall: float = 0.0) -> list[VideoRef]: ...
```

**Research posture** (`service/teardown/sourcing/posture.py`) — true by construction, not asserted: discovery through the official Data API; media via yt-dlp treated as a **transient, hash-recorded analysis cache**, not a retained/redistributed corpus; provenance + license on every row (flows into each `Recipe.source`); **weight `creativeCommon` up** where quality is comparable; local-only; dedup by `content_hash`. (Plain-English, not legal advice: non-commercial research strengthens a fair-use / text-and-data-mining posture but doesn't make rights irrelevant, and downloading implicates platform ToS independent of copyright — the hygiene above is what keeps it clean and costs almost nothing.)

**Acceptance.** On a held-out set the owner fully tears down, **`yield.predicted` correlates with `yield.actual`** (Spearman ρ, overall + per-field — the agent is only useful if high-predicted videos are really richer). Pre-screen throughput within quota with no overruns; no duplicate `video_id`s (planted-dup test); `license` populated 100%, CC rank-boosted (planted-pair ordering assert); face-cam/non-English/fast-cut inputs score *low*, don't crash.

**Module layout.** `service/teardown/sourcing/{discover.py, prescreen.py, verify.py, score.py, catalog.py, posture.py, cli.py}`.

---

## §4. Video → recipe-skeleton agent

**Purpose.** Turn a tutorial into a `Recipe` skeleton + populated asset folder: tempo/key/DAW where visible, section arrangement, a word-timed narration transcript, and a sparse set of keyframes (esp. cropped transport / piano-roll / synth-GUI shots) that §5/§7/§8 consume.

**Pipeline.** (1) **Acquire** via yt-dlp to the transient cache (hash → `source.content_hash`); pull video + best audio + captions. (2) **Demux/normalize** (ffmpeg). (3) **Shot segmentation** (PySceneDetect) + fixed-cadence keyframe sampling (1–2 fps) inside long static screen-capture stretches. (4) **Narration transcript** (`faster-whisper` / `whisper.cpp` local) → word-timestamped JSON. (5) **OCR pass** (Tesseract/PaddleOCR) over keyframes focused on transport/title/plugin-header regions → tempo, key, plugin names, labels; each value → `evidence` with shot+timestamp. (6) **DAW detection** via §2 → `meta.daw`. (7) **Section segmentation** combining audio novelty (librosa self-similarity) + transcript cues. (8) **Emit skeleton**: create elements where evidence supports them; **always schema-valid even on partial failure** (nulls + `unresolved`). If you run §7 separation to populate `stems/`, gate it behind a flag and remember "other" is a soup — don't overstate `audio_ref` fidelity. Record model+version on every derived artifact.

**Acceptance.** On ~20 labeled tutorials: tempo OCR within ±1 BPM on ≥90% where transport visible; section boundaries within ±1 bar (target with owner); DAW accuracy per class; **100% schema-valid output** incl. talking-head inputs (graceful nulls); transcript WER acceptable on clear narration.

**Failure modes.** No on-screen DAW → near-empty skeleton + high `unresolved`; rapid cuts (sample more frames, OCR-vote); non-English (Whisper lang-detect, flag); webcam occlusion; absent captions (local STT fallback).

**Module layout.** `service/teardown/video2recipe/{acquire.py, segment.py, transcribe.py, ocr.py, assemble.py, cli.py}` (DAW detect from §2).

---

## §5. MIDI-from-screen extraction

**Purpose.** Where a piano roll is visible (located by §4, or pointed at manually), reconstruct note data → `.mid`, fill the element's `midi`. This is the **highest-fidelity MIDI source** and the producer of `deterministic` (gold-anchor) reconstructions — prioritize it.

**Pipeline.** (1) **Locate & rectify** the piano-roll region (usually axis-aligned; handle zoom/scroll). (2) **Pitch axis**: detect the on-screen keyboard gutter → absolute y→MIDI-pitch (anchor on octave-C labels via OCR). (3) **Time axis**: detect bar/beat grid + playhead → x→time; tempo from `meta.tempo_bpm` → ticks; handle static-roll-with-moving-playhead vs scrolling-roll (track grid motion, stitch). (4) **Detect notes**: filled rectangles via connected-components/contour after masking grid+playhead; robust to per-track coloring / velocity shading via saturation-value thresholds, not fixed colors → (pitch, start, end). (5) **Velocity** best-effort from fill shade / velocity lane, else default + lower confidence. (6) **Quantize candidate + export** `.mid`; set `status` (`extracted` clean / `partial` stitched-or-occluded), `note_count`, `confidence`.

**Generalization:** generic CV core **+ per-DAW skin profiles** (`profiles/{fl_studio,ableton,logic}.yaml`: gutter location, grid colors, playhead style, note-corner radius, velocity-shading on/off). Adding a DAW = adding a profile.

**Acceptance.** **Note-level F1** (onset-within-tolerance + correct pitch) vs hand-annotated clips, **per DAW profile** (target after the FL profile); no octave errors on eval clips; a scrolling clip stitches to match a static-view ground truth; degrades to `partial` + `unresolved` rather than emitting garbage under occlusion/zoom.

**Failure modes.** Mid-clip zoom/scroll (segment+stitch); cursor/webcam occlusion; dense chords (overlap-split heuristics); unrecoverable velocity (default+flag); preview vs committed notes.

**Module layout.** `service/teardown/midi_from_screen/{locate.py, axes.py, notes.py, profiles/, export.py, cli.py}`.

---

## §5b. Synth-GUI patch reader  *(the primary patch route — read the picture)*

**Purpose.** Where a synth GUI is visible (flagged by §2's `synth_gui_present`, pointed at manually, or surfaced by §4 keyframes), read it into `synth_patch.params` — the cheap, primary route to a patch. This is to synth params what §5 is to MIDI: a "read pixels → structured data" CV pass, run *before* the expensive §8 optimizer. Output is **approximate** (knob angles, graphic envelopes carry error bars) — exactly what §8 refines and the §6 audio check verifies.

**Why it's a distinct vision problem.** OCR (§4) lifts *labeled numeric text* ("12.5k"). §5b lifts what OCR can't: continuous **knob/slider angles** → values, **envelope/LFO curve graphics** → ADSR/shape, **selected wavetable / warp mode / unison voicing** → enum + count, and the **mod-matrix** routing grid. Every value carries `{value, confidence}`.

**Pipeline.** (1) Locate & identify the plugin window (reuse §2 `synth_gui_present` → plugin id). (2) Load the matching **per-synth skin profile** (control map: each control's bbox, type [knob|slider|menu|toggle|graph], range, knob angle-sweep). (3) Per control: knobs → indicator angle → normalized value; menus/labels → OCR; toggles → state; envelope/wavetable graphs → shape descriptors (best-effort, low confidence). (4) Emit `synth_patch.params` + per-param confidence + `status=params_visible`; unreadable controls → omitted + `unresolved`.

**Generalization:** generic CV core **+ per-synth profiles** (`profiles/{serum,vital,...}.yaml`). Adding a synth = adding a profile — mirrors §5's per-DAW skin-profile design.

**Acceptance.** On hand-labeled synth-GUI frames (Serum + Vital first): knob value within ±X% on ≥Y% of controls; menu/wavetable names correct on clear frames; **graceful low-confidence** on graphic-only params rather than confident-wrong values; 100% schema-valid (omit + `unresolved` under occlusion/zoom). The honest yardstick is the **measurement checkpoint (§13)**.

**Failure modes.** Skin/theme variants (profile per theme or normalize); window zoom/scroll; knob-indicator ambiguity (LED-ring vs pointer); animated/modulated knobs (read the *set* value, flag); graphic params fundamentally approximate (low confidence → §8).

**Module layout.** `service/teardown/synth_from_screen/{locate.py, controls.py, profiles/, export.py, cli.py}` (vision from §2).

---

## §6. The render-and-compare oracle  *(shared — build before §8/§9/§11/§12)*

The single most-shared back-half component: render audio from params or a recipe, embed it, score it against a target. Used by **§8 optimization, §9 QA, §11 reward, and the §12 RL loop.** One interface:

```python
class Oracle:
    def render(self, spec: ParamSpec | CommandList, range_s: float = 10.0) -> AudioBuffer: ...   # via render_track_offline / --render-rollout
    def score(self, a: AudioBuffer, b: AudioBuffer) -> float: ...                                 # embedding distance; reward model when available
    def render_and_score(self, spec, target: AudioBuffer) -> tuple[AudioBuffer, float]: ...
```

Rules baked in here so every consumer inherits them: **loudness-normalize to a fixed LUFS before scoring** (closes the cheapest reward hack), default **~10 s** render window, **cache by rendered-WAV hash** (identical rollouts never re-render/re-score), and a **versioned scorer** (swapping the embedding/reward model re-scores consistently). The scorer starts as CLAP/MERT cosine and is later replaced in-place by §11's learned head — every consumer upgrades for free.

**Module layout.** `service/teardown/oracle/{render.py, score.py, cache.py}`. SMART's result is the tractability proof for this whole approach: 64 renders × 200 iterations in ~50 min on one consumer GPU — **rendering is not the bottleneck** at RL scale.

---

## §7. Audio extraction & isolation lane  *(regime-3 + audio→MIDI fallback)*

The honest hard lane — used when the screen *doesn't* hand you the info. Everything here is lossy and **confidence-tagged below §5's screen-read fidelity**; it feeds §8 and the §5 fallback, never pretends to be ground truth, and its outputs are tagged `inferred` (never gold anchors).

**Pipeline.** (1) **Separation** behind `Separator.split(mix)->{drums,bass,vocals,other}`: default `htdemucs_ft` (~9.2 dB SDR, MIT); swap a RoFormer-family model where it wins on drums/vocals. **`"other"` is a melodic soup, not an instrument** — tag low confidence, never auto-promote. (2) **Drum one-shots** from the drums stem: onset/transient slice → role-classify (reuse §1) → write per-hit one-shots → **query §1 for owned matches** (recipe ends up referencing samples you have). (3) **Bass/808** from the bass stem: monophonic pitch tracking (CREPE/pYIN) → MIDI (reliable — monophonic). (4) **Melodic MIDI fallback** (only if §5 produced nothing): polyphonic transcription on `other` via `basic-pitch` (light default) or MT3 (heavier) behind a `Transcriber` interface; `status=partial`, low confidence — dense pads transcribe badly and that must be visible. (5) **Monophonic tone extraction for §8**: where a clean single voice is isolable (separation + transient gate + mono window), emit a short isolated tone — this is the **rate-limiter on §8 quality**, so §10 prefers elements where §5 gave MIDI and only timbre is missing.

**Acceptance.** Separation runs without OOM (segment-guarded); drum slices' onset recall ≥ target and round-trip sensibly through §1; bass MIDI note-F1 high vs hand-annotation; melodic fallback emits schema-valid MIDI on dense material **correctly flagged low-confidence** (assert the tagging); provenance on every output.

**Failure modes.** `other`-soup mistaken for an instrument; stem bleed; transients lost on slow-attack pads; transcription octave/voicing errors; reverb smearing onsets (optional de-reverb, flag).

**Module layout.** `service/teardown/extract/{separate.py, drum_slice.py, pitch.py, transcribe.py, mono_tone.py, cli.py}`.

---

## §8. Synth patch-matching & substitution agent  *(refinement + substitute layer)*

**Position (changed from the draft).** §8 is **not** a competing path to reading the screen — it is the **error-correction on the visual read (§5b) and the fallback for plugins you can't read or don't own.** "Patch shown on screen" hands you a *picture*, not the ~200 real parameter values: wavetable selection, warp mode, unison voicing, envelope/LFO *curve shapes* (drawn as graphics), and the mod matrix are not text OCR can lift. §5b reads that picture *approximately* (knob angles, envelope graphics have error bars); §8 **renders the candidate with the real synth and closes the error against the target audio.** So the cheap GUI read comes first; §8 fires only when (a) the read is approximate and worth refining, or (b) the plugin is unreadable / unavailable / sample-based.

**The unfair advantage — render-in-the-loop with the real hosted synth.** You host Serum and Vital as real VST3s (offline render via `bounceClipToWav`/§6), so the real synth is a **live verification oracle**: render candidate params over a few notes, embed, compare to the target tone, step. The plugin is ground truth — not a differentiable toy.

**v1 — CMA-ES against the oracle (the only mode you build first).** Seed CMA-ES (black-box, no VST gradients) from §5b's GUI read when present, else a sensible default patch; objective = perceptual distance between the target tone and the **real synth's render** of candidate params in the §6 embedding space (shares §11's reward head once it exists); iterate render→embed→compare→step. This is the whole correctness story.

**v2 (DEFERRED — pure speed optimization, do not build until render budget forces it).** An **amortized estimator** `audio→params` (CNN/AST on log-mel, one per synth, trained on the synth's own renders) gives a warm-start patch in ms instead of cold CMA-ES. It is the heaviest, most research-risky piece and buys *speed, not correctness* — defer it behind a flag until §6 render throughput is measured against §10 batch volume and shown to be the bottleneck.

**Substitute logic** (unavailable / sample-based plugins — no params to recover): run the same CMA-ES matcher with Serum/Vital as the *target search space* → nearest achievable approximation; `status=substituted`, name it, `note="approximation"`, lower confidence. Pareto: nail the common-synth head, substitute the long tail.

**Acceptance.** **Self-test:** known patch → render → CMA-ES match → recovered render's embedding distance to original below threshold on ≥X% of held-out patches (perceptual match, *not* exact-param recovery). **Refinement test:** §8 measurably beats §5b's raw GUI read (closer embedding distance) on a held-out set where both exist — *this is what justifies running it at all.* Substitute path produces a schema-valid, audibly-reasonable approximation; confidence reduced. Fixed seed → bounded optimizer variance ×3. *(The v2 estimator's "estimator+refine beats estimator-alone" test ships with v2.)*

**Failure modes.** Polyphonic/chordal target (gate on §7 mono quality; refuse/flag dense input); heavy FX not in the synth (note residual; optional FX-match stretch goal); modulation/automation a static patch can't capture (flag); GUI-read seed wrong enough to trap CMA-ES in a local minimum (multi-restart; fall back to cold start).

**Module layout.** `service/teardown/synthmatch/{optimize.py, substitute.py, cli.py}` (oracle from §6; `corpus.py`/`estimator.py` deferred with v2).

---

## §9. Render agent  *(Recipe → MoshOps)*  — the loop-closer

Turns a `Recipe` into an ordered MoshOps command sequence that builds the beat, then QA's it. This is the step that makes the extraction *playable* and that produces the reconstruction audio + stems the flywheel anchors on.

**Compilation — element → commands** (emit in dependency order: meta → tracks → inserts/params → content → mix):

| Recipe field | MoshOps emitted |
|---|---|
| `meta.tempo/key/time_signature` | `set_tempo`, `set_key`, `set_time_signature` |
| each new `element` | `create_track` (named by role/label) |
| `sample_match.matched_path` | `insert_audio_clip(track, path, start)` per placement *(needs the primitive)* |
| `synth_patch` (`params_visible`/`matched`/`substituted`) | `load_plugin`/`load_builtin` + `set_plugin_param`×N (retain `note` for substitutes) |
| `midi` (`extracted`/`partial`) | `add_midi_clip` + `add_note`×N (+ `quantize_notes` if requested) |
| `synth_patch` `unavailable`/`unknown` with no params | **fallback:** `create_render_layer` + `set_render_param` → Tier-B generative layer fills the slot (lands on "Neural Renders" lane) |
| per-element level/pan (if captured) | `set_track_volume`, `set_track_pan` |

**Key decisions.** Single-undo-txn discipline is automatic (each command is one MoshOps txn). **Dry-run/plan mode** persists the full command list *before* executing, so §10 can gate on it and re-runs are idempotent on a fresh project. **Graceful holes:** any `null` element → skipped track + `unresolved`, or the render-layer fallback — never a crash, never a silent drop.

**Reconstruction QA (writes `yield.actual` + sets `reconstruction_class`).** After execution: `render_track_offline` per element + full-mix `export_audio` → embed reconstruction and source in the §6 space → per-element + overall similarity → `yield.actual.*`. Set `reconstruction_class=deterministic` only if every scored element came from §5 MIDI + visible/recovered params with high confidence; else `inferred`/`partial`. **This number is the label the flywheel keys on.**

**Acceptance.** Golden `Recipe` → expected command list (golden-file test on emitted JSON). Execution on a fresh project → playable Edit with correct structure (assert via `snapshot()`). QA produces `yield.actual` for every element incl. holes; a deliberately-incomplete recipe renders without error, reports low actual yield. Idempotent: byte-stable command list ×3.

**Failure modes.** Missing `insert_audio_clip` (hard dep — flag early); param-name mismatch (validate against the plugin's exposed params, fall back to substitute/render-layer); §5 quantization timing drift (offer `quantize_notes`); plugin load failure (in-process hosting risk — `block_plugin` lever + render-layer fallback).

**Module layout.** `service/teardown/render/{compile.py, emit.py, execute.py, qa.py, cli.py}`. `compile.py` stays import-clean of JUCE (produces command *data*); `execute.py` is the only seam-crossing part.

---

## §10. Orchestration agent  *(the conductor)*

The "agent that follows a tutorial" from the original vision — designed honestly as a **staged, confidence-gated pipeline with escalation and optional human checkpoints**, not a magic end-to-end agent. Drives one video (or a §3-queue batch) through §1–§9, checkpointing to the `Recipe` at every step.

**Control flow (per video).** (1) Pull highest-predicted-yield from §3 queue. (2) **§4** skeleton → checkpoint. (3) Per element, **route by evidence** (the regime gradient): piano-roll visible → §5; else audio → §7 fallback → checkpoint. (4) Synth elements with a visible GUI → **§5b reads the patch** (the primary route) → checkpoint. Only elements whose read is approximate/low-confidence, or whose plugin is unreadable/unavailable, escalate to **§8** (gated on §7 mono-tone quality so §8 isn't fed garbage) → checkpoint. (5) Drum elements → §7 slice → §1 match → checkpoint. (6) **§9** compile (dry-run) → optional human review → execute → QA → write `yield.actual` + `reconstruction_class`. (7) Mark catalog `torn_down`; below a confidence/yield floor → `partial` with `unresolved` for a later pass.

**Agentic decisions use the Moshi LLM** (`src/brain`/BrainProxy already exists): element labeling/role disambiguation, section naming from transcript, choosing among substitute candidates, writing `unresolved.suggested_action`. Bounded LLM calls with **structured output validated against the schema** — the LLM proposes, MoshOps + the schema dispose.

**Confidence gating & escalation.** A policy config sets thresholds: below `X` → attempt the next-best extraction route; below `Y` overall → stop and queue for human review rather than emit a confident-but-wrong recipe. Escalation is explicit and logged.

**Job model.** Fits the existing Tier-B shape — async jobs analogous to `GenerativeJobManager` (spawn/health/submit/poll/cancel); a batch teardown is a monitorable/cancellable queue; **resumable from the last `Recipe` checkpoint** (crash mid-teardown resumes, doesn't restart).

**Acceptance.** A *complete* (regime-1) tutorial → high-`yield.actual` recipe + playable Edit, no human intervention. A *partial* tutorial → partial recipe with correct `unresolved` and `partial` status — **never a false-confident full recipe** (assert yield honesty). Resumable from checkpoint. Batch mode drains the queue with per-job cancel/monitor.

**Honest limits.** Full autonomy over a 20-min mixed-content video is the ambitious part — expect human checkpoints to earn their keep on regime-2/3. Per-stage confidence is independent and surfaced, so a bad §4 section doesn't silently corrupt §9.

**Module layout.** `service/teardown/orchestrate/{pipeline.py, policy.py, decisions.py, jobs.py, cli.py}`.

---

## §11. Training flywheel  *(reward production)*  — UPDATED

The payoff: generate enormous *labeled* paired data and train a **musically-grounded reward model** to drive it — without the circularity of bootstrapping a similarity model purely from a similarity model.

**The crux it's built to solve — production quality ≠ musical taste.** Off-the-shelf audio reward models (Audiobox, raw CLAP/MERT) have *the ears of a mastering engineer, not an A&R*: they read the production *surface* (clean? full-spectrum? loudness-sane? artifact-free?) — real and learnable — but are **structurally blind to the musical idea** (interesting vs clichéd chords, melodic shape, groove, development), because (a) "average rating" has no center for subjective taste (→ blandness), (b) every predictor sees only ~10 s (→ blind to form), and (c) it's a surface statistic, not understanding. Run a boring 4-chord loop and a brilliant one through the same mix chain and they score about the same. **The resolution: don't measure taste, demonstrate it** — reward proximity to a *distribution of real music we consider good* (DRAGON's exemplar-set result: ~61% human-voted quality win, **zero** preference labels). Distribution-matching is harder to hack than maxing a number, and a **broad** exemplar set buys "general" without collapsing to bland-average.

**The escape from circularity — the anchor corpus.** Every `reconstruction_class=deterministic` reconstruction (§9 built it from §5 MIDI + visible params) is a case where you *know* you matched the target, no model needed. Those are ground-truth positives. You can't honestly learn musical similarity from CLAP cosine alone — you'd learn to game CLAP. The gold anchors are what make a *better* reward trainable.

**The load-bearing mechanism — the ablation engine (this is the update).** From a reconstructed beat with isolated element stems, generate paired data by **controlled edits that change one musical decision while holding the production surface roughly constant**: swap the kick for a §1 near-neighbor, change a §8 patch, move/replace the bassline, mute a layer. Each edit has a *known* relationship to the original (closer/farther, which dimension moved). This is precisely the lever that forces the reward to become **sensitive to the musical axis Audiobox is blind to** — because the negatives differ *only* in a musical choice, not in loudness/spectrum/fidelity, the model can't satisfy the objective by reading the surface. This is the partial fix to the mastering-vs-A&R problem that the off-the-shelf metrics (and SMART's single-Audiobox reward) have no answer for. Partial, honestly: it still can't see 3-minute structure and is still bounded by the ~10 s embedding window — but it's a real lever on the hardest part.

**Components.**
1. **Anchor store** — persist `(source_audio, reconstruction_audio, recipe, per-element stems)` for high-`yield.actual` reconstructions; only `deterministic` ones are gold positives.
2. **Ablation/swap engine** — the controlled-edit generator above; output graded triplets/tuples with known similarity ordering; **constrain the edit space to stay musically coherent.**
3. **Reward-head training** — start from CLAP/MERT (use the music-native **MuQ/MERT** encoder for the music-quality role, not Audiobox — it's a speech encoder, ~r=0.20 on music); fine-tune with contrastive/triplet loss using anchors as positives and graded ablations as structured negatives; consider separate heads for global-vibe vs per-element similarity (§1's two-space point).
4. **Reward interface** — wrap as a **versioned** `score(a,b)` / `score_against_exemplars(audio)`; this *is* the §6 scorer's upgrade and the §12 "pull" reward; §8/§9/§12 all upgrade in place when the version bumps.

**The breadth knob (resolves the general-vs-reference tension).** Same machine, one dial: a **broad** anchor/exemplar corpus (hundreds of tutorials across genres) → a *general* distribution-matching reward (the RL handoff's Stage-1 "pull"); a **narrow** one-artist corpus → *reference-anchored* refinement (the handoff's deferred Stage-3). The flywheel isn't a competing plan — it builds *both* of the handoff's deferred reward pieces, with a slider between them. This is why §3's emphasis on **sourcing volume and variety is diversity insurance for the reward**, not just more data.

**Acceptance.** Anchor store separates `deterministic` from `inferred` (only gold used as positives — assert). **Keystone test:** on held-out anchors, the trained head preserves the ablation engine's *known* ordering (original vs one-swap vs two-swap) **better than raw CLAP** — this is the headline result, and it's the same target §6's scorer-upgrade and §12's "pull" slot were aiming at. Reward interface stable and versioned (§8/§9/§12 reproduce scores given a version). **Hold out by *source video*, not by clip** — the real risk is overfitting to anchors rather than recognizing novel good music. Cold-start runs with a handful of anchors (lower quality, flagged) and improves measurably as anchor count grows (chart it).

**Failure modes.** Quality gated on anchor volume (→ gated on §3/§10 sourcing complete tutorials — the whole front-half prioritization exists for this). Incoherent ablation edits (constrain the space). Reward overfitting to your reconstructions (video-level hold-out). Diversity collapse — the shared tripwire with §12. The terminal generative payoff is several validated steps away; **a good reward model + a growing anchor corpus is the real near-term deliverable.**

**Module layout.** `service/teardown/flywheel/{anchors.py, ablate.py, train_sim.py, reward.py, cli.py}`.

---

## §12. The reward → RL bridge  *(NEW — where production hands off to consumption)*

This is the seam between this pipeline and the GRPO loop in the audio-taste RL handoff. **This document owns reward *production and the interface*; the handoff owns the GRPO *trainer*.** §12 specs only the contract between them and the integration wins the handoff left open.

**Reward architecture — floor + pull** (the handoff's §5, with the flywheel filling the open slot):

```
 FLOOR (keeps audio from being broken/amateur)            PULL (drags toward "sounds like good music")
 ─────────────────────────────────────────────           ────────────────────────────────────────────
 • clean-apply verifier   → hard validity GATE            • §11 learned reward head  ← the open slot,
 • Audiobox PQ/CE         → production-quality score        now filled: exemplar/similarity proximity,
 • MuQ/MERT music head    → music-quality score             trained via the ablation engine so it reads
 • DSP guards             → loudness/clip/silence          the MUSICAL axis, not just the surface
 • CLAP score             → one ensemble member (never alone)
```

**Three integration points this pipeline fills for free:**
1. **The "pull" slot.** The handoff's reward was floor + an off-the-shelf CLAP/MuQ-to-set "pull." §11's learned head **drops straight into that slot** — and §11's keystone acceptance test ("beat raw CLAP at preserving known similarity ordering") was already its qualification exam.
2. **Renderable prompts.** The handoff's §6.2 flags a real problem — *mixing ops on empty tracks render to silence and have nothing to score*. §9 emits full command sequences that render to actual beats, so the teardown corpus **seeds the RL prompt distribution with guaranteed-renderable, musically-meaningful sequences** as a side effect.
3. **The render step.** The GRPO loop's "render each completion ~10 s and score it" *is* the §6 oracle. Build it once; the RL loop reuses it. SMART proves it's tractable at scale (rendering not the bottleneck).

**The GRPO loop (the consumer — spec'd in the handoff; reproduced here as the contract):**
```
[mlx-lm Qwen3-4B policy] sample group of N=8–16 completions/prompt (MoshOps JSON)
   └ [GATE: clean-apply verifier] invalid → reward 0, no render
   └ valid → [ORACLE §6: apply to fresh Edit, offline ~10 s bounce, LUFS-normalize]
              └ [floor+pull reward] → scalar
   └ GRPO update: group-relative advantage (no critic), β≈0.04 KL to SFT π_ref, early-stop ~200 iters
```

**Always-on safety rails** (the handoff's hard-won list — any consumer of the reward must honor them): KL leash on (β≈0.04); **ensemble ≥2 reward models** with conservative/worst-case aggregation; loudness-normalize *before* scoring; **render short**; **early stop**; periodically **retrain the reward head on fresh policy samples** to close blind spots the policy discovers; keep a fixed **golden listening set** the owner personally re-rates each milestone.

**Tripwires (log every iteration):** reward (mean/max/min over group), KL to π_ref, **gradient norm** (rising = hacking signature), **output diversity** (distinct-n / mean pairwise edit distance over command sequences — collapse = hacking). **Diversity collapse is the shared failure across the flywheel and the RL loop, and the flywheel's only real defense is anchor breadth** (§3/§11), which is why sourcing variety is reward insurance.

**Staging.** Validate the loop first with the handoff's **Stage-0 probe** (single Audiobox-CE reward, the SMART port) — it proves *the loop moves the policy and whether it cheats*, independent of this pipeline. **Then replace Audiobox-CE's role with §11's floor+pull reward** once §11 passes its keystone test. The flywheel is aimed precisely at SMART's weak link: same loop, harder-to-hack reward.

**Interface contract (what this pipeline must expose to the RL trainer):**
```python
# service/teardown/flywheel/reward.py — the only surface the GRPO loop imports
class Reward:
    version: str
    def score_audio(self, audio: AudioBuffer) -> dict[str, float]: ...     # floor scores + pull score, per-axis
    def composite(self, scores: dict[str, float]) -> float: ...            # standardized, conservative aggregation
class PromptFeed:
    def renderable_prompts(self, n: int) -> list[Prompt]: ...              # guaranteed-renderable teardown-seeded sequences
```

**Honest transfer caveat.** SMART rendered *solo piano through a soundfont* and scored 10 s — a far cleaner signal than "is this trap beat good." It proves the loop mechanics, **not** that the reward transfers to dense multitrack material; the ~10 s structural blindness hits this effort equally. Treat the encouraging numbers (SMART, DRAGON, MusicRL) as proofs of concept in adjacent settings, not guarantees for the MoshOps command-agent setting.

---

## §13. Build order & shared infrastructure  *(the actionable spine — read this first)*

**Shared infrastructure — build once, reused everywhere:**
- **`Recipe` package (§0)** — freeze before §3/§4/§9.
- **Vision detectors (§2)** — used by §3/§4/§5/§5b.
- **`Embedder` (§1)** — template for §7 classification, §8 distance, §11 reward.
- **Render-and-compare oracle (§6)** + the **two new MoshOps primitives** — used by §8/§9/§11/§12. *The single highest-leverage shared build; do it early.*
- **Catalog (§3)** and **anchor store (§11)** — the two persistent stores.
- **Reward interface (§11/§12)** — versioned; the one surface the RL trainer imports.

**Order:**
```
═══ PHASE 1 — standalone value + infra ═══
 1. Recipe contract (§0)
 2. Drum matcher (§1)             ← ships a real feature day one; builds the embedding infra
 3. Vision package (§2)           ← unblocks sourcing + extraction
 4. Render-and-compare oracle (§6) + the 2 MoshOps primitives   ← unblocks the entire back half
═══ PHASE 2 — front half (sourced video → Recipe) ═══
 5. Sourcing (§3)                 ← parallel to 2–4; feeds §4
 6. Video→skeleton (§4)
 7. MIDI-from-screen (§5)         ← produces the `deterministic` gold anchors
 8. Synth-GUI patch reader (§5b)  ← the PRIMARY, cheap patch route; read params off the screen
 ── MEASUREMENT CHECKPOINT ──     ← pull ~50 top-yield tutorials; measure the fraction whose every
                                    element's patch is cleanly readable by §5b. ≥~80% → §8 is a
                                    deferrable footnote (lean on §9's render-layer for stragglers);
                                    ~40% → §8-substitute is core. This number sets §8's scope.
═══ PHASE 3 — back half (Recipe → playable + matched) ═══
 9. Render (§9)                   ← compiles §5/§5b/§1 into a playable Edit; holes → substitute /
                                    Tier-B render-layer fallback. Needs neither §7 nor §8.
10. Extraction lane (§7)          ← the lossy regime-3 fallback for when the screen gave nothing
11. Synth match (§8)             ← AFTER the checkpoint; refines §5b reads + substitutes unowned plugins
12. Orchestrator (§10)           ← ties §1–§9/§5b together; batch over the queue
═══ PHASE 4 — reward + handoff ═══
13. Flywheel (§11)                ← once reconstructions exist to anchor on
14. RL bridge (§12)               ← flywheel reward → the handoff's GRPO loop
```
Every phase ships something independently useful: §1 is a feature alone, a §10 orchestrator over partial recipes is useful before §8 exists, and a good reward head (§11) is valuable before the RL loop is even wired.

---

## §14. Honest risk register

None is a blocker; all are reasons to keep confidence/evidence first-class and let the easy regime carry the system.
- **Regime-3 isolation is lossy** — separation gives stems not isolated notes; dense transcription is rough. → prefer screen-visible tutorials (§3), tag low confidence, never auto-promote `other`-stem audio, tag `inferred`.
- **Synth match is perceptual, not exact**, weak on polyphonic/sample-based/modulated sources. → **read the GUI first (§5b); refine/substitute with §8 only when needed**; render-in-the-loop oracle, mono-gating, substitute path, Pareto on common synths. The §13 measurement checkpoint decides how much §8 must carry *before you build it*.
- **Piano-roll CV is brittle** across DAWs/zoom/scroll. → per-DAW skin profiles, `partial` status, stitching.
- **Production quality ≠ taste** (the §11 crux): any embedding-based reward, including the flywheel's, reads the surface by default. → the ablation engine is the only thing forcing musical-axis sensitivity, and it's a *partial* fix (bounded by the ~10 s window, blind to 3-min form).
- **The reward generalizes or overfits** — does the head recognize *novel* good music or just memorize anchors? → hold out by source video not clip; retrain on fresh policy samples.
- **The flywheel + RL loop share a tripwire: diversity collapse.** → anchor breadth (§3/§11) is the defense; this reframes sourcing volume/variety as reward insurance.
- **Reward hacking is the central RL risk** — a single learned reward likely gets gamed within a few hundred GRPO steps. → KL leash, ensemble ≥2 with conservative aggregation, early stop, golden listening set (§12).
- **Everything caps at ~10 s** — absolute reward is local production quality + (via ablation) some musical-choice sensitivity; long-range form is out of scope (§15).
- **Full autonomy (§10) is the ambitious part** — expect human checkpoints on regime-2/3; per-stage confidence is surfaced so partial failures don't silently corrupt output.
- **Encouraging numbers come from adjacent settings** (SMART = solo-piano soundfont; DRAGON = diffusion text-to-music; MusicRL = industrial scale) — proofs of concept, not guarantees for the command-agent setting. Several cited 2026 sources are unreviewed preprints; treat specific numbers as preliminary.
- **Research posture (§3):** official-API discovery, transient media cache, CC-preferred, local-only, nothing redistributed — built in, not bolted on. (Not legal advice.)

---

## §15. Deferred / explicitly out of scope  *(do not scope-creep)*

- **The generative model itself.** §11+§12 produce *data + a reward + a tuned command agent*; the generative model (your SA3 Tier-B service, the type-beat-LoRA scaffold in `src/training`/`service/training`/`docs/type-beat-trainer.md`) is the **downstream consumer**, not part of this build.
- **The GRPO trainer internals.** Spec'd in the RL handoff; §12 only defines the reward + prompt interface it imports.
- **Human A/B calibration** (the handoff's Stage 2) — only if §11/§12 plateau or hack: Bayesian active learning (BAL-PM), ~3–9 raters/pair, small reward head on a frozen encoder, periodic retrain. *Labels last, by owner preference.*
- **Reference-anchored taste as a separate effort** — it isn't separate; it's the **narrow-corpus setting of §11's breadth knob.**
- **Long-range structure / arrangement reward** — no current predictor sees beyond ~10 s; rewarding musical form is an open problem, out of scope here.

---

## §16. Sources & prior art

*Grounded in this project's research (turns + the audio-taste handoff). arXiv IDs for lookup; recent 2026 preprints are unreviewed — verify numbers against your own renders.*

**Embeddings / similarity:** CLAP (LAION `larger_clap_music`, Microsoft MS-CLAP) · MERT · MuQ/MuQ-Eval (arXiv:2603.22677) · SongEval (arXiv:2505.10793). **Separation:** Demucs v4 / `htdemucs_ft` (~9.2 dB SDR, MIT) · BS-/Mel-Band RoFormer · ONNX-Demucs-in-C++ (Mixxx GSOC 2025, for native use). **Transcription:** `basic-pitch` · MT3 · CREPE/pYIN. **Synth matching:** InverSynth (arXiv:1812.06349) · SerumRNN · Sound2Synth · DiffMoog (arXiv:2401.12570) · AST sound-matching (arXiv:2407.16643) · evolutionary recovery. **Reward / RL (from the handoff):** SMART (arXiv:2504.16839, the closest analog) · DRAGON exemplar-set reward (arXiv:2504.15217) · MusicRL (arXiv:2402.04229) · Audiobox-Aesthetics (arXiv:2502.05139, `pip install audiobox_aesthetics`, CC-BY-4.0) · Resonate (arXiv:2603.11661) · Audiobox-on-music r≈0.20 (arXiv:2504.21815) · overoptimization scaling laws (Gao, arXiv:2210.10760) · reward ensembles (Coste arXiv:2310.02743; Eisenstein arXiv:2312.09244) · BAL-PM (arXiv:2406.10023).
