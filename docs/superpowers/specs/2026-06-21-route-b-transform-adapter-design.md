# Route B — Tier‑B "transform" adapter (fake‑first spine)

**Date:** 2026-06-21
**Status:** Design approved; ready for implementation plan.
**Context:** Phase 1 removed the synthetic Tier‑A neural insert, collapsing Mosh to a single
generative tier. Dramatic timbre/instrument transfer ("turn this into a flute / orchestra") needs a
RAVE/DDSP/MelodyFlow‑class model — a different model class from SA3's text‑to‑audio re‑imagine. Route B
adds that capability **natively** as a new render‑layer **mode**, reusing the entire Tier‑B machinery,
proven first with a deterministic fake (the codebase's "FakeAdapter before SA3" convention) so the
default test suite stays offline and green. The real model swaps in behind the identical contract next
session.

## Goals / non‑goals

- **Goal:** a working, offline, fully‑tested `transform` render mode (input audio → timbre/style‑
  transformed audio of the same duration) driven entirely through the existing MoshOps + snapshot/events
  seam, with a model‑agnostic control surface (`target` + `strength`).
- **Goal:** zero new MoshOps commands; reuse `create_render_layer` / `set_render_param` /
  `render_layer` / `accept_render` / cache / Neural‑Renders landing / QA readout.
- **Non‑goal (this session):** the real RAVE/MelodyFlow backend, model weights, or a new venv. Only the
  documented seat for it (§6).
- **Non‑goal:** changing the re‑imagine path, the colors DSL, or any Tier‑A remnant (already gone).

## Design principle

The transform is a new **`mode`** behind the existing adapter contract
`render(input_wav, output_wav, params) → manifest`. The I/O shape is identical to SA3 re‑imagine
(`input.wav → output.wav` + manifest), so RenderLayer, the full‑fingerprint cache, the async job
protocol, accept/reject → "Neural Renders" lane, and the QA readout are **reused unchanged**. The only
new concepts are: a `transform` adapter id that degrades to a fake (mirroring `stable_audio3 → fake`),
two params (`target`, `strength`), a `/transform_targets` discovery endpoint, and a drawer branch.

## 1. Service / adapter (`service/`)

- **New `service/adapters/transform_adapter.py`** implementing the standard adapter shape
  (`available()` / `backend_name()` / `render(input_wav, output_wav, params) → manifest`), modeled on
  `service/adapters/stable_audio3_adapter.py`. This session it contains **only the deterministic fake
  branch**; the real‑model branch is a documented stub (§6).
- **Dispatch:** extend `_adapter_for(adapter_id)` in `service/server.py` so `"transform"` returns the
  real transform backend **if available, else `transform_adapter`'s fake** — exactly mirroring how
  `"stable_audio3"` falls back to `fake_adapter`. Net effect: a `transform` layer always renders, with
  zero install, via the fake until a real model is present.
- **Fake transform DSP:** deterministic, RNG seeded from `hash(target) ⊕ seed`; wet‑mixed by
  `strength` (0–100 → α, ASTD‑clamped, Lab unlocks). Recognizably alters the input (e.g. a target‑
  dependent spectral tilt + formant‑ish band emphasis + saturation), **same duration**, silence‑in →
  silence‑out. Stdlib `wave` only (matches `fake_adapter`). Writes `output.wav` + a manifest with
  `{ok, adapter, backend, mode:"transform", target, strength, duration_s, sample_rate, channels,
  pq, pq_base, flags}` (the standard envelope; `pq` from the same fake QA path the existing fake uses).
- **Discovery:** new **`GET /transform_targets`** endpoint (mirrors `/colors`) returning
  `{ok, targets: ["violin","flute","choir","orchestra","synth pad", …], freeText: true}`. Advertise
  transform availability in `/capabilities` alongside the adapter list.

## 2. State / schema / fingerprint (`src/state/`, `src/moshops/`)

- `src/state/RenderLayer.h`: `mode` is already a free string, so `"transform"` needs no enum change.
  Add two PARAMS fields with defaults: **`target`** (string, default `""`) and **`strength`**
  (number 0–100, stored as a double like `nl`; default `65`). Add them to `RenderLayer::create()`
  defaults and the serialize/round‑trip.
- `MoshOps::computeFingerprint()`: include `mode`, `target`, and `strength` in the SHA so the cache
  key is correct — identical (clip, mode, target, strength, seed, serviceBuild) → HIT; any change →
  MISS. (`mode` is likely already folded in via the existing fingerprint; verify and add `target`/
  `strength`.)

## 3. Commands (`src/moshops/MoshOps.cpp`) — no new commands

- `cmdCreateRenderLayer`: already accepts `{clipId, adapter?, mode?, modelVariant?}` — the UI calls it
  with `adapter:"transform", mode:"transform"`. No change beyond accepting these values.
- `cmdSetRenderParam`: extend to read **`target`** (string) and **`strength`** (number) and write them
  to PARAMS, setting status `dirty` (as it does for other param changes).
- `cmdRenderLayer`: the job‑param builder must forward `mode`, `target`, `strength` to the service
  (alongside the existing prompt/seed/nl/cfg/steps/colors/lab). No control‑flow change.
- `accept_render` / `reject_render` / `bypass_layer` / `freeze_layer` / `bounce_layer_to_clip` /
  `cancel_render` / `remove_render_layer`: **unchanged.**
- **Agent catalog** (`ui/src/agent/commands.ts`): add `target` (string) and `strength` (number) to the
  `set_render_param` entry so Moshi can drive transform; the backend reads both (above) so the
  `commands.contract.test.ts` guard stays honest.

## 4. UI (`ui/src/ui/Dock.tsx`, `ui/src/types.ts`, `ui/src/store.ts`, `ui/src/bridge.mock.ts`)

- **GenDrawer** (clip has no layer): render two buttons. Rename today's single **"+ Render layer"** to
  **"+ Re‑imagine"** — unchanged behavior: `create_render_layer{adapter: sa3?"stable_audio3":"fake",
  mode:"reimagine", modelVariant}`. Add a new **"+ Transform"** →
  `create_render_layer{clipId, adapter:"transform", mode:"transform"}`. Mode is fixed at creation; to
  switch kinds the user removes + recreates the layer.
- **GenBody** branches on `rl.mode === "transform"`:
  - transform → a **target dropdown** (from `/transform_targets`) + a **free‑text field** (overrides
    the dropdown when filled) + **one strength ASTD slider** (reuse the slider + Lab shapes; the
    free‑text reuses the SA3 prompt‑field styling).
  - re‑imagine → today's colors UI, unchanged.
  - Shared, unchanged for both: status badge, seed, Lab toggle, progress bar, QA readout, and the
    render / cancel / accept / reject / seed / remove actions.
  - Drawer header shows `transform · <target or clip>`.
- **`types.ts`:** `RenderLayer` gains `target?: string` and `strength?: number`; add
  `AvailableTransformTarget` (`{ name: string }`) and a store field `availableTransformTargets` +
  `loadTransformTargets()` fetched from `/transform_targets` (mirrors `availableColors` / `loadColors`).
- **`bridge.mock.ts`:** handle `adapter:"transform"` / `mode:"transform"` in `create_render_layer`,
  `set_render_param` (target/strength), and `render_layer` (produce a deterministic fake transformed
  result + manifest), plus a `transform_targets` reply — so vitest + e2e exercise the path offline.

## 5. Tests (all default / offline‑green)

- **`Mosh --selftest`** (new transform block, mirroring the Stage‑5 fake‑render checks): create a
  transform layer → `set_render_param{target:"flute", strength:70}` → `render_layer{wait:true}` →
  output exists / non‑silent / **differs from input** → identical re‑render is a **cache HIT** →
  changing `target` → **MISS** → `accept_render` lands a clip on the "Neural Renders" lane. Runs in the
  default build (fake is stdlib).
- **vitest:** a `bridge.mock` transform unit (create→set→render→accept) + the existing
  `commands.contract.test.ts` stays green (it now verifies the backend reads `target`/`strength`).
- **e2e (Playwright):** a transform spec — "+ Transform" → pick target → render → accept → a new clip
  appears on the Neural Renders lane.
- **Offline render‑to‑WAV** (`scripts/verify-hardware/`): a transform script proving output ≠ input and
  non‑silent, deterministic across runs.

## 6. Real‑model seat (documented, NOT built this session)

`transform_adapter.py`'s real branch will load RAVE (general timbre transfer, embeddable via the
already‑pinned anira ecosystem / PyTorch‑MPS offline) or MelodyFlow (= gary4juce's `terry`, text‑driven)
in an **isolated venv**, mirroring `service/transcribe/`: `service/setup-transform.sh` → writes
`.transform.env` → `service/run.sh` sources it; env‑gated like SA3 (`MOSH_ENABLE_TRANSFORM` or a model
dir present). The fake stays the graceful fallback. The `target`+`strength` surface already matches both
model families (instrument name *or* free‑text prompt), so no UI/schema change is needed for the swap.

## Risks / mitigations

- **Fingerprint correctness:** if `target`/`strength` aren't in the fingerprint, a changed transform
  silently returns a stale cached artifact. → Add them explicitly + a selftest MISS‑on‑target‑change
  check.
- **Drawer branch complexity:** keep the transform body a separate small component
  (`TransformBody`) rather than inflating `GenBody`, so each mode's UI is independently readable.
- **Mode/adapter coupling at create:** two‑button create avoids needing to swap a live layer's adapter
  (the rejected "mode toggle" alternative); fixed‑at‑create keeps the cache key stable.
- **Contract guard:** adding catalog args without backend reads would fail `commands.contract.test.ts`
  — ensure `cmdSetRenderParam` reads `target` and `strength`.

## Out of scope

Real model weights/venv; MusicGen‑style *continuation* (different I/O shape — duration change, separate
future work); changing re‑imagine/colors; any Tier‑A revival (that's Route C).
