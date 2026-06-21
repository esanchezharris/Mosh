# Route C — real RAVE/MelodyFlow transform backend + real-time anira insert

**Date:** 2026-06-21
**Status:** Design approved (standing authorization); C.1 implementing, C.2 scoped.
**Context:** Route B shipped the Tier-B `transform` render mode with a deterministic **fake**
adapter behind the model-agnostic contract. Route C swaps in the **real** model — first as an
offline Tier-B backend (C.1), then as a real-time Tier-A insert (C.2). Both behind the existing
`transform` id / surface (`target`+`strength`), so no schema/UI churn.

## Model choice: RAVE (primary)

**RAVE** (IRCAM ACIDS) is the pick: general timbre transfer (any sound), pretrained models export to
**TorchScript `.ts`** loadable with plain `torch.jit.load` (no training stack), runs offline file-based
AND embeds in C++ for real-time via LibTorch/anira — so the **same model family serves both C.1 and
C.2**. MelodyFlow (= gary4juce `terry`, text-prompt transform via audiocraft) is a viable **second
adapter** behind the same id later; it does not change this design.

## C.1 — real Tier-B RAVE backend (isolated venv, env-gated)

Mirror the **transcribe** carve-out exactly (dedicated venv + a CLI subprocess + a `.env` that
`run.sh` sources + graceful fallback). The fake stays the default; the real path activates only when
installed — identical posture to SA3.

- **`service/transform/setup-transform.sh`** (mirror `transcribe/setup-transcribe.sh`): create
  `service/transform/.venv`, `pip install torch torchaudio` (inference only — NOT the full
  `acids-rave` training stack), validate `import torch`, write `service/transform/.transform.env`
  exporting `TRANSFORM_PY="$VENV/bin/python"` and a default `RAVE_MODEL_DIR`. Idempotent. Prints how
  to drop `<target>.ts` RAVE models into `RAVE_MODEL_DIR`.
- **`service/transform/transform_cli.py`** (runs UNDER that venv, subprocessed by the adapter; stdout
  carries ONLY the JSON result, all torch noise → stderr): argv `<input.wav> <output.wav> <target>
  <strength> <seed>`. Resolve `RAVE_MODEL_DIR/<target>.ts` (slugified); `torch.jit.load`; decode the
  audio to a mono/stereo tensor at the model's SR (`model.sr` / resample via torchaudio); `z =
  model.encode(x); y = model.decode(z)`; wet-mix `out = (1-α)·x + α·y` with α from `strength`; write
  `output.wav`. Emit `{"ok":true,"model":"<target>","backend":"rave","sr":N}`.
- **`service/adapters/transform_adapter.py`** (extend): `available()` → True iff `TRANSFORM_PY` exists
  AND `RAVE_MODEL_DIR` holds ≥1 `.ts`. `render()` → when available, subprocess `TRANSFORM_PY
  transform_cli.py …`, parse JSON, build the manifest (`backend:"rave"`, `mode:"transform"`,
  `target`, `strength`, pq from a simple readout); **else the existing inline fake** (unchanged). I/O
  shape and manifest envelope identical to the fake, so RenderLayer/cache/UI need NO change.
- **`service/run.sh`**: source `transform/.transform.env` (one line, mirrors the transcribe source).
- **`/transform_targets`**: when the real backend is available, list the installed `.ts` model names;
  else the curated fake list. `freeText:false` for RAVE (targets are concrete models).
- **Fingerprint:** already includes adapter+serviceBuild+target+strength; add the model file's
  identity to the service build / target so a model swap is a cache MISS. (`target` already keys it.)

**Verification (C.1):** fake path stays green offline (no venv → `available()` False → fake) — the
existing selftest/vitest/e2e/`verify.py` transform checks are unchanged and must stay green. The REAL
RAVE render is **gated like SA3**: proven by running `setup-transform.sh` + dropping a `.ts` model,
then `verify.py` (a new `--rave` check) shows `backend:"rave"`, non-silent, differs-from-input. Attempt
the real install opportunistically this session; if the torch download is impractical headless,
document the gated runbook (the deliverable is the scaffolding + graceful fallback, exactly as SA3
shipped gated).

## C.2 — real-time RAVE insert (Tier-A, via anira) — scoped, heavy follow-on

A new `src/plugins/transform/RaveInsertPlugin.{h,cpp}` — a `te::Plugin` running a RAVE `.ts` via
**anira** (the C++ inference engine already pinned behind `MOSH_ENABLE_ANIRA`) on LibTorch. anira owns
the background inference thread + RT-safe ring buffers so `applyToBuffer` never blocks (satisfies the
threading prime directive). Reuse the proven patterns from the removed neural insert (git history):
true-latency `getLatencySeconds()` (RAVE has real block latency → PDC must be exact), dry/wet,
atomic model swap, `describe()`. Commands `add_rave_insert`/`set_rave_param`/`load_rave_model` mirror
the old neural command shape; a rack card mirrors the old NeuralBody. Re-introduce `MOSH_ENABLE_ANIRA`
(clean) gated so the default build stays light. **This is a large, high-risk sub-project** (LibTorch is
~hundreds of MB + a long build; anira integration is new) — it gets its own spec/plan + an explicit
go-ahead before pulling LibTorch into the build. C.1 delivers real transform value without it.

## Risks / mitigations
- **Heavy torch install** → C.1's deliverable is the gated scaffolding (fake stays default); the real
  install is opt-in via `setup-transform.sh`, mirroring SA3. No default-path regression possible.
- **RAVE model I/O variants** (`encode/decode` vs `forward`, mono-only models) → the CLI probes the
  scripted methods and falls back to `forward`; mono models get the input down-mixed then re-spread.
- **stdout discipline** → torch/JIT chatter must go to stderr (transcribe_cli pattern) or it corrupts
  the JSON result.
- **Determinism** → set `torch.manual_seed(seed)`; RAVE decode is largely deterministic. The cache
  tolerates minor nondeterminism (artifact is cached on first render; re-render only on fingerprint
  change).

## Out of scope
MelodyFlow/audiocraft adapter (future, same id); the full C.2 LibTorch build (separate go-ahead);
training/exporting RAVE models (users bring `.ts` files).
