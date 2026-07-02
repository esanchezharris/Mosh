# Training program — Stage 0/1 execution results (2026-07-01/02)

*Execution session following `docs/plans/moshi-training-audit-2026-07.md`. Everything below ran
headlessly on the real engine unless noted. Spend so far: ≈$0.60 cloud tokens (ceiling $100).*

## The headline discovery: the local-lane numbers were mislabeled

Re-running the frozen 300-case eval under ONE pinned serving stack (mlx_lm 0.31.3, venv unchanged
since Jun 21, `HF_HUB_OFFLINE=1`, model pinned by PATH) reverses the audit's inherited premise:

| model (same frozen 300, same stack, temp 0) | clean-apply | deferrals |
|---|---|---|
| cloud gpt-5.4-mini (recorded June) | **0.875** | 18 |
| **BASE Qwen3-4B-Instruct-4bit — no fine-tune** | **0.714** | 24 |
| fused v2 (the June LoRA fine-tune) | **0.218** | 204 |

- The recorded "local Qwen3-4B LoRA **0.619**" (AUTONOMOUS_SFT.md results, unmerged branch) was
  almost certainly the **BASE model**: its eval requested model id
  `mlx-community/Qwen3-4B-Instruct-2507-4bit`, and this mlx_lm version **routes multi-model by
  request id** — the request loaded the HF-cached base, not the fused weights. Verified live:
  the same deferring prompt answered correctly via the base id and with
  `{"intent":"ACK_GOT_IT","say":"Tempo set to 125 BPM."}` — **claims the edit, emits no
  command** — via the fused path.
- So the **v2 fine-tune DAMAGED the model** (−0.50 vs its own base). Mechanism located: v2 train
  data has exactly two modes (6,960 ACK+commands rows, 355 HUH+say rows); the over-fit LoRA
  (train loss 0.04, 8 utterance shapes) mode-interpolates to ACK+say+no-commands on
  off-distribution phrasings.
- **A completely untrained 4B is only 0.16 behind the cloud brain** on this eval. The local
  lane's bar is now: any fine-tune must beat **0.714**, or don't ship it.
- Provenance rule going forward: any local eval number must record the serving fingerprint
  (mlx_lm version + model resolution mode). Three numbers — 0.889 / 0.619 / 0.218 — were all
  "the local model" in prior records; they were the Huihui-template artifact, the base model,
  and the actual fine-tune.

## Moshi-Bench v0 (execute-graded, real engine, 35 cases)

`ui/scripts/moshiBench.mts` + `ui/src/bench/cases.ts` — NL→command cases graded by executed
STATE (direction+tolerance bands, never exact gold); defer cases; corrective cases render
before/after WAVs to `~/mosh-bench-artifacts/` for the owner's ears.

| arm | score | notes |
|---|---|---|
| cloud gpt-5.4-mini, plain rules | **31/35 = 88.6%** | fails: fx-ott, fx-autotune (deferred — catalog never names builtin types), section-rename (passed section NAME as id — real ids are 32-hex), transport-play (headless grading artifact, case fixed) |
| cloud + worked-examples block | **32/35 = 91.4%** | both fx cases FLIPPED to pass (one composed load_builtin + set_plugin_param); tempo-slang deferred once (new); section-rename still fails |
| cloud + one-shot repair turn | 30/35 = 85.7% | neutral-to-noise on the cloud column: its failures are DEFERRALS, which repair can't touch (repair fires on failed commands — the local column is its real target) |
| cloud plain, run 2 (variance) | **31/35 = 88.6%** | headline identical; 1 model-side case flip (transport-seek) ⇒ single-run noise ≈ ±1 case (±2.9%); persistent failures = section-rename, fx-ott, fx-autotune — exactly the examples-block targets |

| **local base Qwen3-4B, plain** | **19/35 = 54.3%** | the untrained 4B on the production prompt |
| **local base + worked-examples** | **29/35 = 82.9%** | **+28.6 points — the +30pp lever transferred exactly as the knowledge-flywheel A/B predicted (weak +30pp / strong +12pp).** The shipping local config: BASE + examples, ~6 pts behind cloud, zero training |

**Bottom line of the whole run:** scaffolding beats weights at this stage. Both fine-tunes
degraded their base (v2 −0.50, v3 −0.16 on the frozen eval) while a static worked-examples
block bought +28.6 bench points on the same untrained model. `ui/src/agent/fewshot.ts` holds
the block (production adoption of RULES_WITH_EXAMPLES for the brain prompt is now justified by
both columns — cloud +2.8, local +28.6 — and is queued as a follow-up PR since it changes the
shipped prompt).

## Flywheel + turn factory

- **First real tuples in the program's history**: bracketed `--run-script` turns → harvester →
  3/3 tuples with correct labels (proof session `harvest-proof-1`).
- **Confirmed defect**: organic tuples whose commands reference engine ids mock-replay as
  `replayClean:false` with WRONG snapshots (native id 1010 vs mock id 14; mock also seeds
  phantom demo tracks). Organic tuples' commands/utterance/appliedClean/taste are trustworthy;
  their snapshots are not. `scripts/harvest-watch.sh` documents this; factory tuples sidestep it
  entirely (real `__snapshot` grounding).
- **Turn factory** (`ui/scripts/turnFactory.mts`): 41 real-engine tuples from 51 turns across 10
  arcs, 92.7% appliedClean, engine ids verified deterministic across replays. The 10 CLOUD-brain
  deferrals map the few-shot bank's target list (builtin FX, bar-referenced moves, loop/seek,
  compound asks).

## Data fixes + v3 corpus

- Fixed the two measured defects (`ui/src/sft/buildDataset.ts`): absolute-faithful volume/pan
  utterances; NEW true-relative volume tasks (fixed convention: touch=2dB, bit=3dB, "by N"=N);
  HUH slice 5%→1.5%; `autotrain.sh` serve step pinned `HF_HUB_OFFLINE=1`.
- `service/sft/curate_dataset.py` — THE committed curation recipe (v2's was ad-hoc/unreproducible):
  merge by priority (DAW-rich first), leakage-filter vs frozen evals (275 rows dropped, 183
  sources), class caps, content dedupe (12,776 MIDI near-clones collapsed).
- **v3-final: 7,444 train / 1,911 valid** — volume 827 rows (v2-equivalent had the broken 708),
  pan 358, populate/clip capped 2,500 each, 38 factory tuples. Known gaps: only 5 defer rows
  survived dedupe; .flp files skipped (PyFLP venv not set up here — 500 files of future coverage).
- **v3-final LoRA trained clean** (500 iters, lr 1e-5, max-seq 3000, no NaN: train loss 0.213 /
  val 0.252; sft_run.json carries config + dataset sha).
- **v3 VERDICT (pre-committed gate): 0.558 < base 0.714 ⇒ the fine-tune does NOT ship.** The
  local lane ships BASE + prompt work. Diagnostic split: v3 beat base exactly where the fixed
  data aimed — populate 0.309 vs 0.246, add_midi_clip 1.000 vs 0.971, volume 0.188 vs 0.062 —
  but crashed set_tempo 0.421 vs 0.947 and timesig 0.482 vs 0.750 (77 deferrals; dedupe had
  crushed those classes to 111 rows and format drift returned on simple asks). Two fine-tunes
  (v2 −0.50, v3 −0.16) both degraded the base: template-shape corpora keep teaching format
  quirks that break instruction-following. Weight-training resumes only after the corpus has
  real phrasing diversity at scale (turn factory + organic harvest + owner dictation), exactly
  the audit's data-before-training ordering.
- **⚠️ NaN trap found (first attempt diverged, all checkpoints garbage `!!!!`):** the production
  system prompt is ~2,400 TOKENS, and 2,876/7,444 v3 rows exceeded max-seq 2560 (longest 2,914)
  — `--mask-prompt` + truncation into the completion leaves ~zero loss tokens → NaN from iter
  ~100. v2 dodged it only because its snapshots were smaller. Retrained at max-seq 3000 +
  lr 1e-5. RULE: preflight token lengths vs max-seq before any mlx LoRA run (token-accurate,
  with the real tokenizer — a chars/token heuristic mis-filters catastrophically).

## Engine/catalog findings for the follow-up list

- `set_transport` cannot express a loop REGION (boolean + position only) — catalog-extension
  candidate; both cloud and factory turns defer on "loop the first 8 beats".
- `create_track {name, type:"midi"}` drops the name (only "audio"/"drum" are valid types; the
  catalog desc says so, models pass "midi" anyway — worth a validation error or coercion).
- Section ids are 32-hex UUIDs; models (incl. frontier) pass the section NAME. Either accept
  name as a fallback resolver in `rename_section`/`move_section`, or teach harder in the prompt.
- `rename_section` correctly errors on unknown ids (no silent-ok — verified).

## Reward-validity verdict — the panel's #1 experiment, now DONE (owner blind-rated 2026-07-01)

24 ratings + 12/18 A/B picks (6 pairs skipped — every skipped clip was a seed-0 candidate
carrying a loop-start render artifact the owner called "that awful wacky noise"; odd indexes =
seed 0 = all rated 1). Results:

- Headline (all 24): ρ(verifier, rating) = **0.191**; A/B agreement **2/12** (verifier's pick
  LOSES 10 of 12). Script verdict: **🔴 NOT valid — do not optimize the score.**
- The honest cut — artifact-free clips only (n=12): ρ = **0.247** and per-tier mean ratings are
  FLAT: flat 4.33 · flat_clone 4.33 · plain 4.67 · optimized 4.67. A 0.38→0.85 verifier-score
  range buys +0.34 rating points on a 7-point scale. **On clean audio the owner cannot hear the
  verifier's tiers.** The full-pack tier-ordering agreement was mostly the artifact halving.
- Owner caveats recorded: skipped artifact pairs; low confidence on sound-alike pairs (visible
  as a B-position bias in the picks — 9/12 B).
- Standing decision DATA-CONFIRMED: the recipeVerifier stays a validity/competence gate;
  GEPA-against-it stays banned; no learned or rules score is an optimization target for taste.
- **New bug for the generation lane:** the render harness stamps a loop-start artifact on seed-0
  candidates (every `*_0_*` clip). Whatever Gate C pack shares that render path needs checking —
  added to the r8 spec.

## Owner ears queue

1. ~~Rate the validity pack~~ ✅ DONE — verdict above; raw CSVs archived.
2. Blind 10-ask corrective session (pre-registered gate for the scaffolded brain).
3. Corrective before/after renders in `~/mosh-bench-artifacts/` (2 pairs so far).
4. Gate C r8 re-run when the generation thread lands the corpus fix (`docs/plans/r8-corpus-spec.md`).

## Post-audit corrections (2026-07-02 — owner-triggered hostile audit of this whole pass)

The owner caught the sine-wave miss and ordered a full self-audit (4 adversarial auditors over
both merged PRs + every claimed number, plus reproducibility re-runs). Verdict: the substrate
claims held; several verifications were BLUNT-INSTRUMENT class; one shipped artifact was
musically wrong. Everything below is fixed on this branch.

**Found broken → fixed:**
- **Out-of-key renders (critical):** melodic one-shots were bound without knowing their pitch —
  sampler roots off by −5..+5 st PER ELEMENT within one beat. Fix: `SampleMatch.root_note`
  (schema + tests), binding picks the palette sample nearest the phrase center, compiler roots
  the sampler at the SAMPLE'S true pitch. Regression-tested (the audit proved the previous fix
  had zero test coverage).
- **Hard clipping (5/6 renders, up to 7.4% samples):** compile's mix stage now applies a −4.5 dB
  per-track headroom trim (golden updated). Post-fix: 0.0% clipped.
- **RENDER GATE:** audition renders now must pass a chroma key-match (requested key in top-3 of
  24) + <0.5% clipping, with seed-retry and LOUD below-gate labeling — the audio itself is
  checked, not just command success. Residual off-key = wrong inferred source keys in owner
  recipes (r8 item: per-element key verification).
- **Vacuous defer grading:** invalid-only output and brain errors counted as "correct deferrals."
  Honest local-base = **18/35 (51.4%)**, so the worked-examples lever is **+31.4pp** (not +28.6).
  Fixed in moshiBench. Both local arms are bitwise reproducible across runs (0 case flips).
- **Stale-binary trap:** `findBin` preferred a fixed path order (a pre-#190 worktree build that
  silently ignored `mode:"melodic"`); now prefers the NEWEST binary and honors `--bin` strictly.
- **Scrape roles:** 'hat' substring-matched inside "that/hate" (15 melodies shipped as hi-hats);
  the per-project cap dropped HALF the catalog including ALL drum DNA (zero kick/snare recipes —
  generated drums came only from seeds). Fixed: token-boundary roles, role-priority ranked cap
  (808/drums survive first), 2-note floor for drum-named tracks, cross-project content dedupe.
  **Library v2: 384 recipes incl. real owner drums (60×808, 3 kick, 7 snare, 3 clap, 9 hat)** —
  the gated audition now builds beats on the owner's OWN kicks.
- **Palette fragility:** all 2,469 one-shots lived in a disposable worktree; a cleanup would have
  silently reverted every render to sine. Relocated to `~/Library/Mosh/palette-v1/`;
  `load_palette` now loud-fails on missing assets; `load_library` ignores macOS/iCloud
  " 2.json" sync-conflict copies (three checkouts infested — likely iCloud Documents sync).
- **The corrective ears-packs were sine mixes BY DESIGN** (test-tone bench seeds) — RETRACTED
  from the owner's queue; rebuild on recipe-generated sessions is queued.
- **My own verification instrument was invalid:** the ">5kHz = 11–33% vs sine <2%" claim cannot
  separate the old sine set from the fixed set (hats dominate >5kHz in both). Replaced by
  spectral-flatness + narrow-peak-share + envelope CV (tone detection) and the chroma render gate.

**Corrected stats:** validity A/B position bias 10/12 B (was "9/12"); seed-0 clips 10/12 rated 1
(one 2, one 3 — was "all 1"); 34 factory tuples survived curation (38 harvested); corrective
pilot = 16 distinct pairs (fader clamps at +6 dB, its `degradedDb` metadata was wrong above that).
**Two engine follow-ups were misreported:** loop REGIONS already exist in `cmdSetTransport`
(loopStart/loopEnd) — the gap is agent-catalog exposure, not engine work; `create_track` already
validation-errors on `type:"midi"` — the gap is prompt-side.

**What survived the audit intact:** all bench scores recounted from rows; the frozen-eval
0.875/0.714/0.218/0.558 ranking; scrape note extraction byte-exact (12/12 sampled); tempos
verified against the owner's own folder labels (55/56); the validity-pack math exactly; Gate B
×3; the +lever result (now +31.4pp, bitwise stable).

---

## Owner-DNA audition round 1 → 808 register fix (2026-07-02)

**Owner blind ratings (v1 set, `~/mosh-beats/owner-dna/v1/RATINGS-2026-07-02.csv`):** 3/2/2/4/3/3,
**mean 2.83/5** — exactly the old Gate-C `would_keep` bar — with ONE unanimous defect: **"808 too
high" on all six.** (Beat 04 "fire" at ★4; 06's "chill" mood confirmed; 04's "emotional" label
questioned; 05 "messy".)

**Measured root cause (3-agent evidence pass):** 808 medians MIDI 54.5–65 vs the 24–38 sub window —
**0/50 notes in-window**; dominant low peaks 97–220 Hz (should be 32–73 Hz); the melodic sampler
(root 36) repitched bass one-shots +24–29 st. Upstream: `flp_cli.py` never reads the FL channel
sampler root (C5 = raw 60 convention), so the whole owner scrape's 808/bass elements import ~2
octaves high in absolute pitch (element medians center 60.75, 2.6% in-window, vs hand-authored
seeds at 29, 80%) — and no downstream stage ever chose an absolute register.

**Fix (PR: 808 register normalization):** `normalize_808_register` in `service/recipes/generate.py` —
whole-octave fold of the 808/bass phrase so its median lands in MIDI 24–38, applied in `recombine`
after chord binding and before palette binding (pitch classes + contour preserved; nearest-root
sample pick now searches the sub register; `reconstruct` untouched — Gate B(1) stays exact). Plus
`sub_gate` in `scripts/verify-hardware/render_audition.py`: dominant 20–300 Hz peak in [32,73] Hz
AND E(20–60)/E(20–250) ≥ 0.50 AND low-centroid ≤ 90 Hz (Welch 65536/Hann/50%), calibrated so all
six v1 renders FAIL.

**Re-render (same requests/seeds, full key+clip+sub gate):**

| beat | v1 subRatio | v1 lowCentroid | v2 subRatio | v2 lowCentroid | v2 gate |
|---|---|---|---|---|---|
| 01 | 0.079 | 144.5 Hz | 0.859 | 54.4 Hz | PASS (peak 41.7 Hz) |
| 02 | 0.421 | 79.8 Hz | 0.729 | 57.1 Hz | PASS (34.3 Hz) |
| 03 | 0.147 | 154.0 Hz | 0.586 | 59.8 Hz | flagged: peak 25.6 Hz — BELOW the 32 Hz floor (too deep now) |
| 04 | 0.093 | 120.7 Hz | 0.883 | 63.3 Hz | PASS (45.1 Hz) |
| 05 | 0.041 | 144.1 Hz | 0.758 | 84.9 Hz | PASS (39.7 Hz) |
| 06 | 0.090 | 179.7 Hz | 0.828 | 50.6 Hz | flagged: peak 26.2 Hz — deep |

Engine-session ground truth: every v2 beat has exactly ONE melodic track in the sub window (the
808, medians 25.5–34, sampler roots 27/33) — v1 had zero. A/B listening room at
`~/mosh-beats/index.html` (v1-with-ratings vs v2, served 127.0.0.1:8188); owner re-rating measures
the delta vs the 2.83 baseline. Backlog seeded in `docs/plans/r8-corpus-spec.md` items 8–12
(FL channel-root at import, per-element key verify, mood tags, density/"messy", octave-drop
sections).

## Audition round 2 → pitch-truth pass (2026-07-02)

**Owner v2 ratings (`~/mosh-beats/owner-dna/RATINGS-V2-2026-07-02.csv`):** 2/3/3/1/2/2, raw mean
2.17 — **with an explicit owner recalibration: "these all sound better than last round, I was
giving them star rankings based on [an absolute] 5-star beat" scale.** So v1 2.83 vs v2 2.17 is
NOT comparable (scale drift); the notes are the signal: 02 "cool" (clean win); 01 "still too
high — we clearly need to label our individual 808s with their note and octave"; 03 "can't even
rlly hear 808" (the deep flag, audible); 06 "doing too much with the snare"; 04 ★1 after gate
retries re-rolled his ★4 "fire" composition (methodology lesson: A/B must pin composition).

**The owner's diagnosis was right, at scale.** Pitch-truth pass (`service/recipes/
measure_palette_pitch.py`, autocorr f0 cross-checked vs low-band spectral peak, post-attack
window): of 396 pitched palette one-shots, **320 measurable; 294 root_note labels WRONG, 253 by
an octave class** (histogram dominated by −12×162, −11×39, +36×26, +24×11 — heard octave was
effectively random per element). Beat-01 v2 concretely: its 808 label was exact (D#1) but its
PAD was labeled 36 vs measured C4/60 (+24) — the "high" percept. Measurement adversarially
verified before writing: independent HPS re-measurement agreed 13/14 within 1 st; synthetic
ground truth 3/3 (incl. an 808-style pitch-drop attack); the two failure modes found (near-tie
autocorr → fails safe to UNMEASURABLE; >400 Hz melodic fundamentals) were adopted as fixes
(role-aware search band to 1 kHz for melodics; melodic-family 'medium' confidence demoted to
inferred). Manifest corrected in place with backup (`manifest.pre-pitch-20260702.json`), audit
trail per item (`root_note_inferred`, `root_label`, `root_source`, `root_confidence`).

**Generator changes:** binding now prefers `root_source:"measured"` samples over nearer
unverified labels; `normalize_808_register` gained an audibility floor (outlier notes below
lo−3 fold up an octave — v2 beat 03 shipped MIDI 16 ≈ 20.6 Hz). generate_test 38 checks ×3
deterministic. v3 render + A/B room queued for the owner; **rating methodology switched to
side-by-side preference to kill scale drift.**

**Round-3 outcome + one near-miss.** First v3 render came back **byte-identical to v2** — the
corrected manifest wasn't being read: `generate.load_palette()` defaulted to a **gitignored
repo-local duplicate** (`service/palette/palette/manifest.json`) while the corrections went to
the canonical `~/Library/Mosh/palette-v1/manifest.json` (same 2469 items, stale labels). Fixed:
`PALETTE_MANIFEST` resolves env `MOSH_PALETTE_MANIFEST` → home copy → repo file, in that order
(the same class of bug as the stale-binary sine incident: a shadow copy silently serving old
data — always A/B the OUTPUT, which is exactly how this was caught). Adversarial verification
round 2 also contributed a structural guard now in the tool: 'medium'-confidence results must
show direct spectral energy at the candidate f0 (kills confident subharmonic errors); melodic
family searches to 1 kHz and only writes at 'high'. Final manifest: **291 high + 28 guarded-medium
measured, 77 left inferred** (backup kept). Real v3: every bound element plays at its sample's
measured pitch (808s at F1/G#1/A#1 = 34–39 Hz written == heard); renders noticeably fuller
(RMS 0.20–0.26 vs v2's 0.09–0.20); gate 4/6 PASS, 03 (sub 11%) + 05 (sub 2%) ship loudly
flagged bass-light — element-balance, the next lever, alongside r8 item 11 density. A/B room
round 2 vs round 3 served; owner rates by PREFERENCE now (scale-drift-proof).
