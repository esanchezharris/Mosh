# RAVE rack "silence under the pinned LibTorch" — diagnosis (2026-07-16)

## Symptom

During FIT-013 PC verification, real rack models (`~/AI/rave-models/*.ts`) loaded
through the RAVE insert (anira 2.1.0 + its pinned LibTorch 2.4.1) but produced pure
silence on inference, while "the same models run fine under python torch 2.11". The
synthetic harness model passed 14/14, so the insert pipeline itself was sound. Working
hypothesis at the time: TorchScript traced with a newer torch than the pinned runtime
loads but silently misexecutes — candidate fixes were (a) re-trace with torch ≤ 2.4 or
(b) bump anira's LibTorch.

## Root cause — the hypothesis was wrong on both ends

**The pinned LibTorch is innocent.** Running the actual rack models under a Python
torch **2.4.1** venv (the exact version anira v2.1.0 pins) produces output
**bit-identical** to torch 2.13.0, block for block. 16 of the 17 Mac rack models are
alive and healthy under 2.4.1.

**The one bad apple is `birds.ts` — and it is bad under EVERY runtime.** Its encoder
state runs away on out-of-domain input (a steady 220 Hz tone, or noise): latent RMS
blows up to ~160 with |z| ≈ 320 (healthy RAVE latents are ~N(0,1)), and the decoder
maps those saturated latents to underflow-to-zero output (max|y| = 3.9e-33 on block 1,
exact 0.0 from block 2 on). A fresh reload restores exactly one audible block before
the state runs away again: 1/50 blocks non-silent on a sustained tone. Identical
behavior under torch 2.4.1 and 2.13.0 — a **model property**, not a runtime one.

## Why it presented as "the insert is silent"

1. `rave_insert_check.py`'s real-model fallback blind-picked the **first sorted .ts**
   in the rack — alphabetically `birds.ts`.
2. The PC rack contained **only** `birds.ts` — the single pathological model of the 17.
3. `RaveEngine` configures anira with `kRaveWarmUp = 5`: five warm-up inferences at
   prepare time consume the model's only audible blocks before any real audio flows.
4. The "runs fine under python" sanity check was a single 2048-sample forward — i.e.
   exactly the one block birds.ts still plays before pinning to zero.

## Fixes landed

- `scripts/verify-hardware/rave_insert_check.py`: real-model mode now iterates rack
  candidates in sorted order, **skipping and reporting** models that are
  silent-on-tone or fail to load, passing on the first healthy one, and failing only
  on genuine pipeline signals (dropped-block gaps, NaN, silent-after-reset, command
  failures, or every candidate dead). `RAVE_INSERT_MODEL` (absolute path or bare rack
  filename) pins one model explicitly — pinned mode never iterates, so a silent pick
  fails hard. Unit-tested in `rave_insert_check_test.py` (fake run_script, no
  torch/binary needed, 3× deterministic).
- `docs/WINDOWS_PARITY.md` FIT-013 row: the known-limitation line rewritten to the
  true story.
- The PC rack gained `pluma.ts` (42 MB, the smallest healthy model) so the real-model
  lane has something responsive to test.

## Verification

- **Mac** (fresh `./run-mosh.sh deploy-anira`, LibTorch 2.4.1 self-contained):
  `verify.py --rave-insert` synthetic lane green; real-model lane
  (`TRANSFORM_PY=/nonexistent`) skips birds.ts with reason `model_silent` and passes
  on `ensembles.ts`; pinning `RAVE_INSERT_MODEL=birds.ts` reproduces the exact PC
  symptom (silence through a healthy insert) on macOS — platform-independence proven.
- **PC** (existing FIT-013 anira build, over SSH): same harness, real-model fallback —
  birds.ts skipped, pluma.ts passes, full `verify.py --rave-insert` green.

## If a genuinely too-new trace ever appears

anira v2.2.1 (2026-07-04) replaced `SetupLibTorch.cmake` with `AniraBackends.cmake`
and pins **LibTorch 2.12.0** (backends release v2.1.1); it also grew per-engine
override knobs (`ANIRA_LIBTORCH_VERSION`, `ANIRA_BACKENDS_VERSION`). Bumping our
`cmake/Dependencies.cmake` anira pin is the route if TorchScript forward-compat ever
bites for real — mind the FIT-013 Windows notes (Release-only preset, `/GL-` on
`RaveEngine.cpp`, the DLL-staging glob `modules/libtorch-*/lib/*.dll` in
`CMakeLists.txt`, which matches the v2.2.x layout too but verify at configure). Not
done now: the evidence says the 2.4.1 pin executes the entire current rack correctly,
and an unforced 8-minor-version runtime jump is its own risk.
