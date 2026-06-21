# Route B — Tier‑B transform adapter (fake‑first) Implementation Plan

> **For agentic workers:** implement task‑by‑task with TDD. Steps use `- [ ]` for tracking.

**Goal:** add a `transform` render mode (input audio → timbre/style‑transformed audio) as a native Tier‑B render layer, proven with a deterministic fake adapter, all offline/test‑green; the real RAVE/MelodyFlow model swaps in behind the identical contract later.

**Architecture:** new `transform` adapter id that degrades to a deterministic fake (mirrors `stable_audio3 → fake`); a `mode:"transform"` render layer with two new params `target` (string) + `strength` (0–100); reuses RenderLayer / full‑fingerprint cache / async job / accept‑reject → Neural Renders lane / QA. UI: a second "+ Transform" create button + a transform body (target picker + free‑text + strength slider). A read‑only `list_transform_targets` command mirrors `list_colors` for discovery.

**Tech Stack:** Python stdlib (service), C++/JUCE/Tracktion (engine), React/TS/Zustand (UI), Catch2 + vitest + Playwright (tests).

## Global Constraints (verbatim from spec)
- No new **mutation** MoshOps commands; reuse `create_render_layer`/`set_render_param`/`render_layer`/`accept_render`. (`list_transform_targets` is read‑only, mirrors `list_colors`.)
- Fake is the default, stdlib‑only, reachable with zero install; manifest envelope `{ok, adapter, mode, target, strength, duration_s, sample_rate, channels, pq, pq_base, flags}`.
- I/O shape identical to re‑imagine: `input.wav → output.wav` + manifest; same duration; silence‑in → silence‑out.
- `target` + `strength` MUST be in the cache fingerprint.
- Default test suite stays green offline (no real model, no venv).

## File structure
- `service/adapters/transform_adapter.py` (new) — fake transform `render()` + `available()`/`backend_name()`.
- `service/server.py` (modify) — `_adapter_for("transform")`, cheap‑progress branch, `/transform_targets`, capabilities/health advertise.
- `src/state/Ids.h` (modify) — `target`, `strength` ids.
- `src/state/RenderLayer.h` (modify) — defaults + fingerprint.
- `src/moshops/MoshOps.{h,cpp}` (modify) — `cmdSetRenderParam` reads target/strength; `cmdRenderLayer` forwards them; `cmdListTransformTargets` (+ dispatch); `GenerativeJobManager::listTransformTargets`.
- `src/generative/GenerativeJobManager.{h,cpp}` (modify) — `listTransformTargets()` (GET).
- `src/multiplayer/LockManager.cpp` (modify) — `list_transform_targets` → Unguarded.
- `src/app/SelfTest.cpp` (modify) — transform section.
- `tests/test_renderlayer.cpp` (modify) — fingerprint includes target/strength.
- `ui/src/types.ts`, `ui/src/store.ts`, `ui/src/bridge.mock.ts`, `ui/src/ui/Dock.tsx`, `ui/src/agent/commands.ts` (modify).
- `ui/src/ui/transformBody.test.ts` or `bridge.mock` test (new), `ui/e2e/transform.spec.ts` (new).

---

### Task 1 — Service: fake transform adapter + dispatch + discovery
**Files:** Create `service/adapters/transform_adapter.py`; Modify `service/server.py`.
**Produces:** adapter `render(input_wav, output_wav, params)->manifest` with `mode:"transform"`; `GET /transform_targets`; `_adapter_for("transform")`.

- [ ] `transform_adapter.py`: stdlib `wave` WAV read→floats / floats→16‑bit write (self‑contained, mirror `fake_adapter`'s codec). `render`: read `target=str(params.get("target",""))`, `strength=float(params.get("strength",65))/100`, `seed`. Deterministic per‑target character: derive a stable int from `hash`‑free `sum(ord(c)*…)` over `target` (avoid Python salted `hash`); pick a spectral tilt + band emphasis + saturation from it; wet‑mix by `strength`. Silence‑in → silence‑out. Return manifest `{ok:True, adapter:"transform", backend:"fake", mode:"transform", target, strength:round(strength,3), pq, pq_base, flags, duration_s, sample_rate, channels}`. `available()->False` (no real backend yet) / `backend_name()->"fake-transform"`.
- [ ] `server.py` `_adapter_for`: add `if adapter_id == "transform": from adapters import transform_adapter as ad; return ad`.
- [ ] `server.py` `_run_job`: change cheap stepped‑progress guard to `if adapter_id in ("fake", "transform"):`.
- [ ] `server.py` `do_GET`: add `elif path == "/transform_targets": self._send(200, {"ok": True, "targets": ["violin","flute","choir","strings","orchestra","synth pad","music box","brass"], "freeText": True})`.
- [ ] `server.py` `/health` + `/capabilities`: append `"transform"` to the adapters list shown.
- [ ] **Verify:** `python3 -c` smoke — write a 0.2s sine WAV, run `transform_adapter.render`, assert output exists, non‑silent, differs from input, manifest mode=="transform". Re‑run with a different `target` → different bytes.

### Task 2 — Schema: ids + RenderLayer defaults + fingerprint (TDD)
**Files:** `src/state/Ids.h`, `src/state/RenderLayer.h`, `tests/test_renderlayer.cpp`.
**Produces:** `ids::target`, `ids::strength`; params carry them; fingerprint folds them in.

- [ ] Test first (`tests/test_renderlayer.cpp`): build two nodes via `RenderLayer::create`, set PARAMS `target`/`strength` differently on one, assert `fingerprint(...)` differs; set identical, assert equal.
- [ ] Run tests → FAIL (ids/fields absent).
- [ ] `Ids.h`: add `MOSH_DECLARE_ID (target)` and `MOSH_DECLARE_ID (strength)` in the params group.
- [ ] `RenderLayer::create`: `params.setProperty (ids::target, "", nullptr); params.setProperty (ids::strength, 65.0, nullptr);`.
- [ ] `RenderLayer::fingerprint`: append `params[ids::target].toString()` and `params[ids::strength].toString()` to `parts`.
- [ ] Run `MoshTests` → PASS.

### Task 3 — Commands: set/forward target + strength
**Files:** `src/moshops/MoshOps.cpp` (`cmdSetRenderParam`, `cmdRenderLayer` job‑params).
- [ ] `cmdSetRenderParam`: after the `nl` line add `if (args.hasProperty ("target")) params.setProperty (ids::target, args.getProperty ("target", ""), &undoManager()); if (args.hasProperty ("strength")) params.setProperty (ids::strength, args.getProperty ("strength", 65.0), &undoManager());`.
- [ ] `cmdRenderLayer`: in the job‑params var (read the exact block ~4165–4230), add `mode` (`node[ids::mode]`), `target` (`params[ids::target]`), `strength` (`params[ids::strength]`) alongside prompt/seed/nl/cfg/steps/colors/lab.
- [ ] Covered by Task 4 selftest.

### Task 4 — Selftest: transform end‑to‑end (default build)
**Files:** `src/app/SelfTest.cpp` (new section after the Stage‑5 fake generative section).
- [ ] Add: create_track + add a wave clip (reuse the Stage‑5 helper pattern) → `create_render_layer{clipId, adapter:"transform", mode:"transform"}` → `set_render_param{target:"flute", strength:70}` → `render_layer{wait:true}` → `check ok`, output exists/non‑silent, **differs from source**; identical `render_layer` again → `cache=="hit"`; `set_render_param{target:"violin"}` then render → `cache=="miss"`; `accept_render` → a clip lands on the "Neural Renders" lane. Mirror the existing fake‑render checks' structure.
- [ ] **Verify:** `Mosh --selftest` passes (count rises), 0 failed.

### Task 5 — Discovery command: list_transform_targets (mirror list_colors)
**Files:** `GenerativeJobManager.{h,cpp}`, `MoshOps.{h,cpp}`, `LockManager.cpp`.
- [ ] `GenerativeJobManager::listTransformTargets()` — GET `/transform_targets` (copy `listColors()`).
- [ ] `MoshOps::cmdListTransformTargets` + dispatch `if (name == "list_transform_targets") return cmdListTransformTargets (args);` (copy `cmdListColors`; return `{targets, freeText}`).
- [ ] `LockManager.cpp`: add `"list_transform_targets"` to the `unguarded` set.
- [ ] **Verify:** builds; not agent‑exposed (contract guard unaffected).

### Task 6 — UI types + store
**Files:** `ui/src/types.ts`, `ui/src/store.ts`.
- [ ] `types.ts`: `RenderLayer` += `target?: string; strength?: number;`. Add `export type AvailableTransformTarget = { name: string };`.
- [ ] `store.ts`: state `availableTransformTargets: AvailableTransformTarget[]` (init `[]`) + `transformFreeText: boolean`; action `loadTransformTargets()` (copy `loadColors`, command `"list_transform_targets"`, set from `res.data.targets` mapped to `{name}` + `transformFreeText`).

### Task 7 — UI bridge.mock: transform handling + list_transform_targets
**Files:** `ui/src/bridge.mock.ts`.
- [ ] `create_render_layer`: when `args.adapter==="transform"` set `renderLayer.mode="transform"`, default `target:""`, `strength:65`.
- [ ] `set_render_param`: handle `args.target`/`args.strength`.
- [ ] `render_layer`: already fakes a ready artifact — ensure it sets `hasArtifact` + a `transform` QA manifest when mode==="transform".
- [ ] add `case "list_transform_targets": return ok(command, { targets: [...], freeText: true });`.

### Task 8 — UI Dock: + Transform button + TransformBody
**Files:** `ui/src/ui/Dock.tsx`.
- [ ] Rename the existing create button label to **"+ Re‑imagine"** (behavior unchanged).
- [ ] Add **"+ Transform"** → `exec("create_render_layer", { clipId, adapter:"transform", mode:"transform" })`; call `loadTransformTargets()` in the drawer effect.
- [ ] In `GenBody`, branch: `rl.mode === "transform"` → render `<TransformBody>` (target `<select>` from `availableTransformTargets` + a free‑text `<input>` that overrides, both writing `set_render_param{target}`; one strength ASTD `<input type=range 0..100>` writing `set_render_param{strength}`); else the colors UI. Keep status/seed/Lab/progress/QA/actions shared.

### Task 9 — UI agent catalog
**Files:** `ui/src/agent/commands.ts`.
- [ ] `set_render_param` entry: add `S("target", false, "transform target instrument or free-text")` and `N("strength", false, "0-100 transform strength")` to its args. (Backend reads both — contract guard stays green.)

### Task 10 — UI tests
**Files:** `ui/src/bridge.mock.transform.test.ts` (new) or extend an existing mock test; `ui/e2e/transform.spec.ts` (new).
- [ ] vitest: create transform layer via mock → set target/strength → render → expect `renderLayer.mode==="transform"`, `hasArtifact`, target/strength echoed.
- [ ] e2e: select track w/ wave clip → "+ Transform" → pick a target → Render → Accept → assert a new clip on the Neural Renders lane (mirror the producer‑loop accept assertion).

### Task 11 — Offline render‑to‑WAV check (verify‑hardware)
**Files:** `scripts/verify-hardware/` (a transform JSONL script + assertion).
- [ ] Add a `--run-script` JSONL: create track → import/test‑tone clip → create_render_layer transform → set target/strength → render_layer wait → export_audio; numpy assert output ≠ input, non‑silent, deterministic. (Mirror the existing harness entries.)

## Verification (end of plan)
- `cmake --build --preset macos-arm64-release-app` + `-tests`; `Mosh --selftest` ×3 deterministic, 0 failed.
- `MoshTests` (Catch2) pass. `cd ui && npm run build && npx tsc --noEmit && npx vitest run && npm run test:e2e`.
- Python smoke for the fake transform (Task 1). Offline render‑to‑WAV (Task 11).

## Self‑review notes
- Spec coverage: §1 adapter/dispatch/targets→T1,T5; §2 schema/fingerprint→T2,T3; §3 commands→T3,T5,T9; §4 UI→T6,T7,T8; §5 tests→T4,T10,T11; §6 real‑model seat = documented only (not a task). ✓
- Type consistency: `target:string`/`strength:number` used identically across schema, commands, mock, types, catalog. ✓
- One added read‑only command (`list_transform_targets`) — deliberate, mirrors `list_colors`; not in the agent catalog so the contract guard is unaffected. ✓
