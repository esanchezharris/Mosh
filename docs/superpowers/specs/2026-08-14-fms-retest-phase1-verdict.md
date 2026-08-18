# FMS Retest — Phase 1 Verdict

**Date:** 2026-08-14

**Result: FAIL — terminated by owner ear on the first phrase. Finish My Song is paused indefinitely.**

## What ran

The Phase 1 known-text kill-shot from
[`docs/superpowers/plans/2026-08-14-fms-retest.md`](../plans/2026-08-14-fms-retest.md),
executed on the owner's own Windows/NVIDIA machine (RTX 4070 SUPER, 12 GB —
the actual "local ship" target, not a rented box; $0 spent):

1. **Repo-demo smoke** (YingMusic-Singer-Plus's own curated EN example, seed
   12345): owner verdict — *"track 2 sounds like a real vocal singing the new
   line however one of the notes is a half step off."* Identity and lyric
   intelligibility pass on best-case audio; melody preservation is not exact.
2. **First owner phrase** (stage9orsum, window 0.22–9.71 s, 25 words / 3 lines,
   C# major 145 BPM, flash-attn active, ~1 min/render): melody = the owner's
   mumble take; enrollment = 9.5 s of the owner's finished vocal from after the
   window; target = the owner's own final lyrics. Owner verdict — *"no it
   isn't good enough - unnatural sounding."*

## What this is, formally

An **owner termination after 1 of 12 phrases**, not a formal gate result. The
frozen 9/12 + 11/12 gate was never evaluated; the owner exercised the standing
authority to stop rather than render 11 more phrases against a bar the first
clearly missed. The comparison was the hardest honest one available — the
model's render versus the owner's real finished take of the same window.

## What it establishes

- The install and pipeline were **not** the problem: CUDA render path proven,
  duration-exact output, real levels, seed-pinned, on the ship-target GPU.
- Handing the renderer **perfect words does not fix naturalness.** This closes
  the loop with the 2026-07-19 word-campaign verdict ("words were never the
  binding constraint") from the other side: the word rung failed in August,
  and now the voice rung fails with words removed from the equation entirely.
- Melody fidelity is additionally imperfect (half-step error on the model's
  own demo), but naturalness — not pitch — was the terminating defect.

## Standing state

- **Paused indefinitely**, same bar as before to reopen: a concrete,
  owner-approved reason the *naturalness* problem is fixable — a different
  model class, not more infrastructure. The Phase 2 blind confirmation and
  Phase 3 mumble-interpretation stages were never unlocked.
- The owner's PC was fully unloaded (repo, venv, weights, fixtures, espeak,
  managed Python — verified gone; long-path residue removed with `rd /s /q
  \\?\...`).
- Evidence (demo A/B pair + owner-material triple: mumble / render / real
  take) is owner-local at `~/Library/Mosh/audits/2026-08-14-fms-retest/evidence/`
  with the full run log in `pre-run-test-baseline.md`.
- The Phase-1 tooling on this branch (`scripts/fms-retest/`: fixture freeze +
  fail-closed guards, 15 tests, RED-proved) remains valid for any future
  reopen, as does the [license review](2026-08-14-yingmusic-license-review.md)
  — whose unresolved VAE-provenance question is now moot unless the program
  reopens.

## Cost of the answer

One evening, $0 in GPU rental, ~11 GB of temporary disk (since removed), and
two owner listens. That is what the staged plan was for.
