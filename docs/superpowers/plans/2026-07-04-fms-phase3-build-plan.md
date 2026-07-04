# Finish-My-Song Phase 3 — build plan (DRAFT for owner review)

> **Status: draft, 2026-07-04.** Both kill-shots returned GO (`../specs/2026-07-02-fms-killshot-{a,b}-verdict.md`). This sequences the build. Each stage ships value alone and gates before the next; the engine spine (MoshOps / snapshot / RenderLayer / tier wall) is untouched throughout.

## Stage 1 — skeleton promotion (Mac, product code)

Promote the kill-shot-proven segmentation from `scripts/fms-killshot/segment_v2.py` into the product:

- **`service/skeleton/core.py`**: add the v3 pruner (`prune_v1_nuclei` — gap/note/dip evidence, 16th snap with 8th preference) + melisma grouping (`articulation_groups`). Stdlib-pure stays stdlib-pure: the `/skeleton_spec` route computes the energy envelope in-process (stdlib `wave`; **guard fmt-tag==1** — the WAVE_EXTENSIBLE/py≤3.11 gotcha) and passes it in. Degradation ladder extends, never breaks: no readable audio → today's v1 behavior; no F0 → onsets-only (unchanged).
- **Persist the render-ready score**: articulation groups *with per-note segments* (start/duration/pitch/melisma) land as a per-line `lyricScore` JSON blob — additive optional property (no format/snapshot bump per Migrations' own rule). This is the `RhythmicSkeleton` the external proposal called for; the grid editor and `confirm_skeleton` flow are unchanged.
- **Optional ASR budget (v4)**: when the whisper venv is present, `/skeleton_spec` may consume *ungated* words as per-phrase syllable budgets (`fuse_asr_budget`, per-PHRASE only). The 0.6 confidence gate for lyric anchors is untouched. Absent venv → no-op.
- **Gates**: skeleton goldens extended with the pruner/grouping cases (no-audio path pinned byte-identical); Catch2 `lyricScore` round-trip; `--selftest` stays hermetic (no service spawn); vitest/e2e unchanged.

## Stage 2 — SoulX Tier-B adapter, fake-first

Exactly the transform-mode precedent: **zero new MoshOps commands.**

- `service/adapters/soulx_adapter.py` with `mode:"sing"`: params carry the target score (accepted lyric lines + `lyricScore` → SoulX target JSON — the `score_author.py` mapping, phonemes via the phonology core, melisma segments → `note_type 3`), the voice reference, and seed. Full fingerprint comes free.
- **Fake backend** (reachable with zero install): the harness's legato-beep score renderer — deterministic, score-faithful, honestly audible. Real backend gated behind env, SA3-posture.
- **Enrollment asset**: `~/Library/Mosh/voice/` holds ONE reference (own-10s/own-30s slices + cached SoulX transcription metadata). **Consent wall v0: locked-to-self** — a single enrolled voice per install, explicit UI copy; watermarking is a ship-gate decision logged now, implemented before any public release.
- UI: a `SingControls` branch in the generative drawer (pick lyric sheet → render); accept lands on Neural Renders as ever.
- **SVC variant stays parked** until its 2×-length/clipping bug is understood (KS-A r7).

## Stage 3 — GPU brokering

- **v0 DECIDED (owner, 2026-07-04): the owner's PC** (the Windows + NVIDIA box, over SSH on the local network). Beats the batch-RunPod recommendation on every axis that matters here: voice data NEVER leaves his own hardware (the strongest privacy posture — no cloud consent wall needed), $0/render, and the envs persist so there is no ~90 s spin-up. The adapter seam is identical either way (shell out to a remote runner, pull the WAV back): `remote/runpod_ksa.sh`'s render step is re-targeted at a fixed host, minus provision/terminate; the PC env comes from the already-written `KSA_RUNBOOK_WINDOWS.md` setup.
- Fallbacks (revisit triggers): **batch RunPod spin-up** (the KS-A-proven shape — if the PC is off/away and a render is wanted NOW; keeps the explicit cloud-consent wall); persistent endpoint (only if volume ever justifies it); **mlx-community SoulX ports** (if vetted, collapses the remote dependency entirely — the roadmap §5 trigger).

## Parked follow-ups (labeled, not lost)

ASR *seeding* for Basic-Pitch under-detection (soft/echoed sections — needs its own registered eval); SVC debug; RMVPE comparison only if FCPE proves the bottleneck on real product usage; YingMusic-Plus fallback (licensing corrected: Stability-encumbered, not MIT).

## Verification ladder (per repo conventions)

Stage 1: goldens 3×, Catch2, `--selftest` ×3 deterministic, vitest/e2e, adversarial review. Stage 2: fake-adapter loop in `--run-script` (render→accept→fingerprint HIT/MISS), drawer e2e. Stage 3: one real cloud render end-to-end with consent flow + termination proof. Human taste gate at each stage: the owner renders one of his own sheets and calls it.
