# Re-imagine "keep ↔ re-imagine" dial + Lab-aware nl guard — design

*2026-07-17. Surface the SA3 re-imagine `init_noise_level` (`nl`) as a clearly-labelled 0–100
"keep original ↔ re-imagine" control in the generative drawer, keep the whole-clip/stitch
default noise ≤ 0.5 so long-clip re-imagines don't pulse, and make the existing
`NL_MIN`/`NL_MAX_RECOGNIZABLE` clamp a Lab-defeatable guard (mirroring the colours ASTD clamp).*

## Background / measured facts

- `nl` (init_noise_level) is the SA3 re-imagine dial: **low = keep the source, high = re-imagine.**
- The service adapter (`service/adapters/stable_audio3_adapter.py`) rejects `nl < NL_MIN` (0.01)
  and clamps `nl ≤ NL_MAX_RECOGNIZABLE` (0.5). The clamp is currently **unconditional** — it does
  not read `lab`, so `nl` can never exceed 0.5 today.
- The RenderLayer default (`src/state/RenderLayer.h`) is `nl = 0.4` (already ≤ 0.5).
- The C++ job builder already passes both `nl` and `lab` to the service
  (`MoshOps.cpp` ~6828 / ~6854); the snapshot already exposes `renderLayer.nl` and
  `renderLayer.lab` (~9463). `nl` is a **raw float** everywhere — baked into the cache
  fingerprint (`RenderLayer.h` ~109) and into many `--selftest` literals (`nl:0.4/0.3/0.45/0.42`).
- **MEASURED 2026-07-17** (agent memory `sa3-onset-prior-chunk-artifact`): the model's onset/intro
  prior (a stronger opening that then settles) is **suppressed at nl ≤ 0.5** and **reasserts at
  nl ≥ 0.7**, where in a whole-clip stitch it becomes a per-window loudness pulse.
- **OWNER TASTE VERDICT 2026-07-17** (auditioned `bkh_sa3_r2/chunk_test`): given
  **A = misaligned 5.5-bar / 8.68 s windows** (= the current `coverage.py` legacy stitch) vs
  **B = bar-aligned 8-bar / 12.63 s windows**, the owner **prefers A** — "too many interesting
  things happening" — over B — "weird constrained sounding generation." At noise 0.5 both are
  pulse-free (A 1.02–1.05×, B ~1.0×); bar-alignment only tames the pulse at noise 0.7
  (legacy 1.66× → bar 0.91×). The "interesting vs constrained" axis is **window length / seam
  frequency**, not alignment.

## Decisions

1. **Keep `nl` a raw float; do the 0–100 ↔ float mapping in the UI.** (Owner-chosen fork.)
   The render param, cache fingerprint, service contract, and every `--selftest` `nl:` literal
   stay byte-identical. The user sees a 0–100 dial, never a raw 0.4. Lowest blast radius.
2. **Default whole-clip / stitch noise stays ≤ 0.5 → no pulse by default.** `nl = 0.4` is
   unchanged; `coverage.py` passes it to every stitch window unchanged. This is a *confirm*, not
   a change.
3. **Keep the current legacy / misaligned stitch as the default (setting A). Do NOT adopt
   bar-aligned windows as the default.** `coverage.py` already does A (fixed `eng.SECONDS`
   windows) — no code change. This retires the memory note's "bar-align follow-up as *the* fix":
   the chosen pulse fix is **noise ≤ 0.5**, and bar-alignment is a **deferred, opt-in-only** option
   relevant only if a Lab user pushes noise ≥ 0.7 and wants the pulse tamed. Never forced.
4. **Make the `NL_MIN`/`NL_MAX_RECOGNIZABLE` clamp a Lab-defeatable guard**, mirroring the colours
   ASTD clamp (`astd_max` normal → unlocked in Lab). Normal mode keeps the 0.5 recognizability cap.
   **Lab removes the upper clamp entirely** (owner request) — the guard passes the raw value through;
   only the `< NL_MIN` degenerate-floor remains in both modes. The service adapter is the
   **authoritative** guard (an agent can call `set_render_param nl=0.9` directly); the UI dial maps
   to the same normal ceiling for round-trip consistency.
   - **Why 1.0 is the real edge (not an invented cap):** engine line 244 blends
     `noise = init_lat·(1 − nl) + pure·nl`. At `nl = 1.0` the source term is zero → identical to
     text→audio `generate()` (which pins `init_noise_level = 1.0`). At `nl > 1.0` the source term goes
     negative (source subtracted, noise over-scaled) → out-of-schedule/degenerate. So the Lab *slider*
     tops at 1.0 = "fully re-imagined = generate from scratch"; the *guard* no longer clamps in Lab,
     so a raw/typed value above 1.0 is allowed (experimental, at the user's risk — the ASTD "unlock
     the raw range" posture).

## Mapping (the runtime.py analogue, in TS)

`nl` is a **unidirectional** keep→reimagine ramp — *not* colours' centered ±ceil. Same structure
(0–100, clamp, Lab unlock), different curve. The slider's Lab range top is `NL_GENERATE = 1.0`
(= full re-imagine / generate); it is only the *slider display range*, not a guard clamp — the Lab
guard is uncapped (Decision 4).

```
ceil        = lab ? NL_GENERATE (1.0) : NL_MAX (0.5)     // slider display range only
amountToNl(a, lab) = NL_MIN + (clamp(a,0,100)/100) · (ceil − NL_MIN)   // 0 → NL_MIN, 100 → ceil
nlToAmount(nl, lab) = round( clamp((nl − NL_MIN)/(ceil − NL_MIN), 0, 1) · 100 )   // nl>ceil shows 100
```

- Constants mirror the Python source of truth (comment cross-references
  `stable_audio3_adapter.py`): `NL_MIN = 0.01`, `NL_MAX = 0.5`, `NL_GENERATE = 1.0` (slider Lab top).
- amount 0 → `NL_MIN` (accepted minimal-change floor; the adapter rejects `< NL_MIN`, so 0 must
  floor to `NL_MIN`, never 0).
- The stored default `nl = 0.4` reads **~80** on the normal dial (strong re-imagine, still
  recognizable) — coherent with the "re-imagine" headline and the owner's "interesting" preference.
- **Accepted minor behavior:** toggling Lab rescales the dial position (the float is fixed, the
  ceiling widened) — an honest "Lab added headroom above" signal. Unavoidable given `nl` is stored
  as the float (colours don't show this because they store 0–100).

## Components

### A. Service adapter — `service/adapters/stable_audio3_adapter.py`
- Add a **pure, module-level** `clamp_nl(nl: float, lab: bool) -> float` (importable without MLX —
  module top imports are only `os`, `wave`): raise `ValueError` if `nl < NL_MIN`; **Lab → return
  `nl` unchanged (no upper clamp)**; normal → `min(nl, NL_MAX_RECOGNIZABLE)`. A comment notes that
  `nl > 1.0` is degenerate (source subtracted in the line-244 blend) but permitted in Lab.
- `_render_window` replaces the inline `min(nlv, NL_MAX_RECOGNIZABLE)` with `clamp_nl(nlv, lab)`
  (`lab` is captured from `render()`'s scope, which already parses it at ~line 75). No `NL_MAX_LAB`
  constant — Lab is uncapped by construction.

### B. UI mapping helper — new `ui/src/ui/reimagineAmount.ts`
- Constants + `amountToNl` / `nlToAmount` per the Mapping section.

### C. Generative drawer — `ui/src/ui/Dock.tsx` (`GenBody`)
- Add one labelled 0–100 `nparam` slider, **reimagine mode only** (skip transform → `strength`,
  skip sing → `SingControls`), placed above the colours block, shown for both wave and MIDI/drum
  re-imagine.
- Label "keep ↔ re-imagine" (aria-label "re-imagine amount"); value =
  `nlToAmount(rl.nl ?? 0.4, labMode)`; `onChange` → `exec("set_render_param", { clipId, nl:
  amountToNl(Number(v), labMode), lab: labMode })`. Reads `labMode` from the store (same source as
  the colours Lab toggle).
- **Must send `lab: labMode` with the `nl` write.** `setLab` is UI-only (`store.ts:844`) —
  `params.lab` otherwise persists only when colours change. Without it, a Lab user dragging to 100
  sends `nl = 1.0` while stale `params.lab = false` clamps it back to 0.5 in the service. Sending
  `lab` with the write keeps the mapping ceiling and the guard ceiling coherent — mirroring how
  `setColors` already sends `lab`. (The pre-existing gap — toggling Lab without touching any param
  doesn't persist — is unchanged and out of scope.)

### D. Mock parity — `ui/src/bridge.mock.reimagine.test.ts` (+ mock as-is)
- The mock already echoes `nl` in `set_render_param` and stays a raw float — this matches C++
  `set_render_param` (which stores raw; the service is the guard). No mock logic change.
- Add a test: the dial round-trips through the mock (`amountToNl` → snapshot `rl.nl` →
  `nlToAmount`), and in Lab a high amount yields `nl > 0.5` while normal caps at 0.5.

## Testing

- **Python golden** `service/adapters/stable_audio3_adapter_test.py` (3× deterministic):
  `clamp_nl` non-Lab 0.7 → 0.5; **Lab 0.7 → 0.7; Lab 1.5 → 1.5 (uncapped pass-through)**; 0.005
  raises (both modes). *This is Decision 2's regression guard.*
- **vitest** `reimagineAmount.test.ts`: round-trips; 100 → 0.5 (normal) / 1.0 (Lab); 0 → NL_MIN;
  0.4 → ~80 normal; an `nl > 1.0` maps to amount 100 (display clamp). Plus the mock-parity test in
  `bridge.mock.reimagine.test.ts`.
- **C++**: comment-only (a cross-reference at the `RenderLayer.h` default). `--selftest` count
  unchanged; run it to prove byte-stability. `tsc` clean. e2e unaffected (reuses the existing
  `set_render_param` path).

## Non-goals / deferred

- Bar-aligned (`bar_seconds`) whole-clip coverage — **deferred, opt-in only** per Decision 3. If
  built later it is a *coverage* option, never the default, and its only justification is taming
  the pulse when a Lab user pushes noise ≥ 0.7.
- Changing the stored `nl` default from 0.4, or moving the 0–100 value into the tree (the rejected
  fork).
