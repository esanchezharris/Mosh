# LoRA Rack — v1 design (runtime load / stack / strength-mix, SA3/MLX)

*Approved 2026-07-16. Productizes the `~/mosh-loras/` taste-adapter lab: the owner's
trained SA3 adapters (kxc, micz, brozr, emzr…) become first-class, stackable "LoRAs"
inside Mosh's generative tier. v1 is runtime-only; in-app training is v2 (the existing
`src/training/` scaffold is untouched — a finished v2 training job will simply drop its
`.safetensors` into the watched folder).*

## Product decisions (owner)

- **"LoRA" is the product name everywhere.** The files are DoRA-rows format internally;
  that precision lives only here and in `service/sa3/lora_runtime.py`.
- **NO budget rule.** No Σ clamp, no per-adapter cap, no adapter-count limit, no Lab
  gating. The UI shows a subtle informational `Σ` readout; nothing ever blocks. (The
  parked mud-threshold experiment informs docs/defaults only.)
- **Progressive disclosure.** Trigger tokens (e.g. `kxc`) auto-inject into the prompt
  server-side — visible only in the adapter tooltip, never typed. Empty rack = one quiet
  `+ LoRA…` affordance; empty library = a one-line "drop .safetensors in
  ~/Library/Mosh/loras" hint.
- **Playback contract.** Rack changes never touch playback: the existing reactive loop
  re-renders in the background, and the finished render swaps in **at a musical
  boundary** (loop wrap when looping, else next bar — P5 below). Mix params (track
  VST3s/faders) live downstream of the render and never re-render; generation params
  (prompt/seed/colors/loras) do, against the cache.

## Architecture

**Library** = the watched folder `MOSH_LORA_DIR` (default `~/Library/Mosh/loras`), same
posture as `~/AI/rave-models`. `service/loras/registry.py` (pure stdlib — imports under
the fake-only venv) scans `*.safetensors`, reads ONLY the safetensors header (rank /
alpha / adapter_type from the `lora_config` metadata), caches sha256 by
(path, size, mtime_ns), merges `<stem>.json` sidecars `{displayName, trigger, notes}`,
and lists unsupported/corrupt files as `valid:false` rows. `GET /loras` mirrors
`/colors`; `MOSH_ENABLE_LORAS=0` is the kill switch (pinned in `--selftest`, with
`MOSH_LORA_DIR` double-locked to a temp empty dir).

**Merge runtime** (`service/sa3/lora_runtime.py`) = **merge-at-rack-change**: adapters
merge into the MLX DiT weights once per rack change; renders then run at full native
speed (no per-step LoRA matmuls, zero edits to the carved MLX model code). The math is
the exact upstream `LoRAParametrization.dora_forward` with **chained** composition in
rack order — the code path the owner's stacking experiments validated
(`load_and_apply_loras` + `set_lora_strength`):

```
s == 0:  W' = W                       (exact short-circuit — 0 means "removed")
else:    V  = W + (alpha/rank)·s·(B@A)
         V̂  = V / (‖V‖_row + 1e-12)
         W' = m ⊙_row V̂               (per-output-row trained magnitude)
```

Chained = adapter k's forward receives adapter k−1's output as its "W" (order-dependent;
the delta-sum alternative `merge_loras_into_base_model` is deliberately not implemented —
`compose_chain` is the single seam if that ever changes). Key mapping pytorch→MLX:
strip `model.` / `.parametrizations.weight.0.*`, `to_local_embed.{0,2}` →
`.seq.{0,2}`, convs permuted through the torch 2D domain `[out, in·k]` (where the
magnitudes were trained). Pristine base streams per-key from `dit_medium_f16.npz`
(nothing pinned in RAM); updates apply in 64-tensor batches; the engine caches a rack
signature (`sha256:strength;…` ordered) so identical racks re-merge nothing, and an
emptied rack restores only previously-touched keys (bit-identical, proven). Non-DiT
adapter targets (ken-sa3's pre-`--exclude` seconds_total embedder) skip with a note;
DiT-path misses fail loudly (wrong base model).

**Measured on this Mac (M-series, real adapters):** merge 1/2/4 adapters =
2.5s / 4.0s / 7.2s; restore 0.6s. `lora_merge_ms` rides the render manifest — the
honest "cost of stacking" signal in place of the dropped budget rule.

**Native surface**: `set_render_param {loras: [{name, value}]}` (ordered, unbounded,
undoable, marks dirty, arms the reactive loop); read-only `list_loras`; the snapshot
carries `renderLayer.loras`. The cache fingerprint gains a `lorasKey` —
`name=value@sha12:trigger;` per active row, **resolved at render time** via `/loras`
(never cached at set time), so a retrained same-name file or a sidecar trigger edit is a
cache MISS and an unknown name errors before any job submit. The fake adapter echoes
`manifest.loras` + `loras_applied:false` (hermetic honesty); the SA3 adapter applies the
rack + injects triggers + reports `loras / triggers_injected / lora_merge_ms`.

**P5 — boundary-quantized swap** (all in-place renders, not just LoRA-driven): a render
finishing while the playhead is inside the target clip defers its swap to the next
musical boundary — the transport loop wrap when looping, else the next bar
(`tempoSequence.toBarsAndBeats/toTime`) — polled at 30 Hz, epoch-guarded, landing
immediately on transport stop. Headless and sing-mode land instantly (hermetic);
`MOSH_SWAP_QUANTIZE=0` is the escape hatch.

## Deliberate non-choices

- `loras` / `list_loras` are **not in the agent catalog** — same posture as `colors` /
  `list_transform_targets`; the agent styles renders through `compile_render`.
- No new mutation commands (the transform-mode precedent): the rack rides
  `set_render_param` + the existing render loop.
- The training scaffold's `list_lora_adapters` / `activate_lora_adapter` (JSON-stub
  lane) are untouched and remain a separate namespace.
- The layer cache stays depth-1 (returning to a previous rack re-renders — existing
  contract, same as colors).

## Verification

Upstream-pinned golden fixture (`scripts/loras/gen_dora_golden.py`, run once under
torch → `service/scripts/golden/lora_dora_fixture.npz`): `lora_merge_math_test.py`
proves the numpy runtime fp32-exact vs upstream, **including order-sensitivity** (locks
chained semantics) and the s=0 short-circuit. `lora_registry_test.py` covers the watched
folder (38 checks). Catch2: LORAS round-trip + RED-proven fingerprint divergence.
`--selftest`: 21 rack checks (state spine, snapshot, manifest echo, MISS/HIT/MISS,
undo) — 1277/1277 ×3 deterministic. vitest 967 (mock parity), e2e 126 (rack flow,
isolated config), tsc clean. Real path: `scripts/verify-hardware/lora_check.py`
(registry listing, base-vs-kxc diff-RMS, trigger injection, merge no-op + cache HIT,
same-name-swap MISS, empty-rack restore) + owner by-ear.

## Follow-ups (named, not v1)

Streaming lookahead (generate the next 4/8 bars ahead of the playhead); v2 in-app
training (real backend behind the scaffold, output lands in the watched folder);
ACE-Step as adapter #4 (native multi-adapter support maps onto the same rack UI);
mud-threshold sweep (docs/defaults only — no clamp exists to tune).
