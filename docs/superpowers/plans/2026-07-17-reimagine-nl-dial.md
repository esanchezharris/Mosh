# Re-imagine "keep ↔ re-imagine" nl dial — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface SA3's re-imagine `init_noise_level` (`nl`) as a clearly-labelled 0–100 "keep ↔ re-imagine" dial in the generative drawer, and make the noise guard Lab-defeatable (normal caps at 0.5; Lab uncapped).

**Architecture:** `nl` stays a raw float end-to-end (render param, cache fingerprint, `--selftest` literals all byte-identical). The 0–100 ↔ float mapping lives in a new TS helper (mirroring `service/colors/runtime.py`'s clamp structure); the service adapter keeps the authoritative clamp, now Lab-aware. Default `nl=0.4` (≤0.5) and the legacy/misaligned stitch stay the defaults → no per-window pulse by default.

**Tech Stack:** Python 3 (stdlib float math, hermetic golden test), TypeScript/React (Zustand store, vitest), C++ (comment only).

**Spec:** [docs/superpowers/specs/2026-07-17-reimagine-nl-dial-design.md](../specs/2026-07-17-reimagine-nl-dial-design.md)

## Global Constraints

- `nl` MUST remain a raw float in the render param and job contract. Do NOT store 0–100 in the tree; do NOT change the cache fingerprint or any `--selftest` `nl:` literal.
- Constants are duplicated in two places by design (Python guard = authoritative; TS helper = display/write). Keep them in lockstep: `NL_MIN = 0.01`, `NL_MAX_RECOGNIZABLE`/`NL_MAX = 0.5`. Cross-reference each side in a comment.
- Normal mode caps `nl` at 0.5 (recognizability + no-pulse). Lab removes the upper clamp entirely (only the `< NL_MIN` degenerate-floor remains in both modes).
- The `nl` write from the UI MUST also send `lab: labMode` (`setLab` is UI-only; `params.lab` otherwise persists only on colour changes).
- Golden/unit tests must be 3× deterministic. Python goldens are named `*_test.py`.

## File Structure

- `service/adapters/stable_audio3_adapter.py` — MODIFY: add pure `clamp_nl(nl, lab)`; call it in `_render_window`.
- `service/adapters/stable_audio3_adapter_test.py` — CREATE: hermetic golden for `clamp_nl`.
- `ui/src/ui/reimagineAmount.ts` — CREATE: `amountToNl` / `nlToAmount` + constants.
- `ui/src/ui/reimagineAmount.test.ts` — CREATE: vitest for the helper.
- `ui/src/ui/Dock.tsx` — MODIFY: import the helper; add the 0–100 dial in `GenBody`'s reimagine branch.
- `ui/src/bridge.mock.reimagine.test.ts` — MODIFY: add a dial round-trip / Lab-unlock parity test.
- `src/state/RenderLayer.h` — MODIFY: one comment at the `nl` default (no logic change).

---

### Task 1: Service guard — Lab-aware `clamp_nl`

**Files:**
- Create: `service/adapters/stable_audio3_adapter_test.py`
- Modify: `service/adapters/stable_audio3_adapter.py` (constants ~14–15; `_render_window` ~97–104)

**Interfaces:**
- Produces: `clamp_nl(nl: float, lab: bool) -> float` (module-level, pure, importable without MLX). Raises `ValueError` if `nl < NL_MIN`. Returns `nl` unchanged when `lab` is true; else `min(nl, NL_MAX_RECOGNIZABLE)`. Existing module constants `NL_MIN = 0.01`, `NL_MAX_RECOGNIZABLE = 0.5` are reused (no new `NL_MAX_LAB`).

- [ ] **Step 1: Write the failing golden test**

Create `service/adapters/stable_audio3_adapter_test.py`:

```python
#!/usr/bin/env python3
"""Golden tests for stable_audio3_adapter.clamp_nl (05 §6) — HERMETIC: pure float
math, no MLX (the heavy imports live inside render()/available(), not at module top).
3× deterministic.

clamp_nl is the AUTHORITATIVE re-imagine noise guard. It rejects a degenerate
sub-NL_MIN nl (a near-identity no-op) in BOTH modes; clamps to NL_MAX_RECOGNIZABLE
(0.5) in normal mode so a whole-clip re-imagine stays recognizable AND never triggers
the onset-prior per-window pulse (measured 2026-07-17: the pulse reasserts at nl>=0.7);
and in Lab passes the raw value through UNCLAMPED (the ASTD "unlock the raw range"
posture — nl=1.0 == generate-from-scratch; nl>1.0 is degenerate but the user's call).

Run:  python3 service/adapters/stable_audio3_adapter_test.py    (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))   # service/ on the path

from adapters import stable_audio3_adapter as A  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


def _raises(nl, lab):
    try:
        A.clamp_nl(nl, lab)
        return False
    except ValueError:
        return True


# ── normal mode: the 0.5 recognizability / no-pulse guard ─────────────────────
check("normal keeps an in-range nl (0.4 -> 0.4)", abs(A.clamp_nl(0.4, False) - 0.4) < 1e-9)
check("normal clamps nl above 0.5 down to 0.5 (0.7 -> 0.5)", abs(A.clamp_nl(0.7, False) - 0.5) < 1e-9)
check("normal clamps to NL_MAX_RECOGNIZABLE exactly", abs(A.clamp_nl(0.9, False) - A.NL_MAX_RECOGNIZABLE) < 1e-9)

# ── Lab: uncapped pass-through (no 1.0 ceiling) ───────────────────────────────
check("Lab passes 0.7 through unclamped", abs(A.clamp_nl(0.7, True) - 0.7) < 1e-9)
check("Lab passes 1.0 (== generate) through", abs(A.clamp_nl(1.0, True) - 1.0) < 1e-9)
check("Lab does NOT impose a 1.0 ceiling (1.5 -> 1.5)", abs(A.clamp_nl(1.5, True) - 1.5) < 1e-9)

# ── the NL_MIN degenerate floor holds in BOTH modes ───────────────────────────
check("nl below NL_MIN raises (normal)", _raises(0.005, False))
check("nl below NL_MIN raises (Lab)", _raises(0.005, True))
check("nl == NL_MIN is accepted (boundary)", abs(A.clamp_nl(A.NL_MIN, False) - A.NL_MIN) < 1e-9)

# ── determinism ───────────────────────────────────────────────────────────────
check("clamp_nl is deterministic",
      A.clamp_nl(0.7, False) == A.clamp_nl(0.7, False) and A.clamp_nl(1.5, True) == A.clamp_nl(1.5, True))

print(f"\n{'OK' if not fails else 'FAILED'}: {len(fails)} failure(s)")
sys.exit(len(fails))
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python3 service/adapters/stable_audio3_adapter_test.py`
Expected: FAIL — `AttributeError: module 'adapters.stable_audio3_adapter' has no attribute 'clamp_nl'` (non-zero exit).

- [ ] **Step 3: Add `clamp_nl` to the adapter**

In `service/adapters/stable_audio3_adapter.py`, immediately after the two constants (`NL_MIN = 0.01`), add:

```python
def clamp_nl(nl: float, lab: bool) -> float:
    """Authoritative re-imagine noise guard (05 §6). Reject a degenerate sub-NL_MIN value
    (a near-identity no-op) in BOTH modes. Normal mode clamps to NL_MAX_RECOGNIZABLE (0.5):
    above it the render stops resembling the source AND the onset prior reasserts as a
    per-window pulse in whole-clip stitch (measured 2026-07-17). Lab UNLOCKS the raw range
    (no upper clamp): nl=1.0 == generate-from-scratch (the engine blends
    `init_lat*(1-nl) + noise*nl`, so at 1.0 the source is fully gone); nl>1.0 is degenerate
    but the user's call. Kept in lockstep with ui/src/ui/reimagineAmount.ts (NL_MIN/NL_MAX)."""
    nlv = float(nl)
    if nlv < NL_MIN:
        raise ValueError(f"nl={nlv} below {NL_MIN}: degenerate (no audible change)")
    return nlv if lab else min(nlv, NL_MAX_RECOGNIZABLE)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 service/adapters/stable_audio3_adapter_test.py`
Expected: PASS — all `[PASS]` lines, final `OK: 0 failure(s)`, exit 0.

- [ ] **Step 5: Wire `clamp_nl` into `_render_window`**

In `service/adapters/stable_audio3_adapter.py`, inside `_render_window`, replace the inline reject+clamp block:

```python
        nl = p.get("nl", None)
        init_status = "n/a"
        if win_src and nl is not None:
            nlv = float(nl)
            if nlv < NL_MIN:
                raise ValueError(f"nl={nlv} below {NL_MIN}: degenerate (no audible change)")
            nlv = min(nlv, NL_MAX_RECOGNIZABLE)
            init_lat, init_status = init_cache.get_or_encode(eng, in_wav)
            eng.reimagine(prompt, seed, init_lat, init_noise_level=nlv, steers=steers, out_wav=out_wav)
```

with (using `lab`, captured from the enclosing `render()` scope where `lab = bool(params.get("lab", False))`):

```python
        nl = p.get("nl", None)
        init_status = "n/a"
        if win_src and nl is not None:
            nlv = clamp_nl(nl, lab)     # 0.5 cap in normal mode, uncapped in Lab
            init_lat, init_status = init_cache.get_or_encode(eng, in_wav)
            eng.reimagine(prompt, seed, init_lat, init_noise_level=nlv, steers=steers, out_wav=out_wav)
```

- [ ] **Step 6: Re-run the golden 3× to confirm determinism + the wiring didn't break imports**

Run: `for i in 1 2 3; do python3 service/adapters/stable_audio3_adapter_test.py >/dev/null && echo "run $i OK" || echo "run $i FAIL"; done`
Expected: `run 1 OK` / `run 2 OK` / `run 3 OK`.

- [ ] **Step 7: Commit**

```bash
git add service/adapters/stable_audio3_adapter.py service/adapters/stable_audio3_adapter_test.py
git commit -m "feat(sa3): Lab-defeatable clamp_nl guard (0.5 normal cap, uncapped in Lab)"
```

---

### Task 2: UI mapping helper — `reimagineAmount.ts`

**Files:**
- Create: `ui/src/ui/reimagineAmount.ts`
- Create: `ui/src/ui/reimagineAmount.test.ts`

**Interfaces:**
- Produces: `amountToNl(amount: number, lab: boolean) -> number` (0–100 dial → nl float; 0→NL_MIN, 100→0.5 normal / 1.0 Lab) and `nlToAmount(nl: number, lab: boolean) -> number` (inverse, rounded int 0–100). Exports `NL_MIN`, `NL_MAX`, `NL_GENERATE`.

- [ ] **Step 1: Write the failing vitest**

Create `ui/src/ui/reimagineAmount.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { amountToNl, nlToAmount, NL_MIN, NL_MAX, NL_GENERATE } from "./reimagineAmount";

describe("reimagineAmount — 0–100 keep↔reimagine dial ↔ nl float", () => {
  it("amount 0 → NL_MIN (never 0, which the adapter rejects)", () => {
    expect(amountToNl(0, false)).toBeCloseTo(NL_MIN, 6);
    expect(amountToNl(0, true)).toBeCloseTo(NL_MIN, 6);
  });

  it("amount 100 → 0.5 normal, 1.0 in Lab", () => {
    expect(amountToNl(100, false)).toBeCloseTo(NL_MAX, 6);
    expect(amountToNl(100, true)).toBeCloseTo(NL_GENERATE, 6);
  });

  it("round-trips nl→amount→nl within one slider step (0.01 of the range)", () => {
    for (const lab of [false, true]) {
      for (const nl of [0.05, 0.2, 0.4, 0.5]) {
        const rt = amountToNl(nlToAmount(nl, lab), lab);
        expect(Math.abs(rt - nl)).toBeLessThan(0.01);
      }
    }
  });

  it("default nl 0.4 reads ~80 on the normal dial", () => {
    expect(nlToAmount(0.4, false)).toBe(80);
  });

  it("an nl above the Lab slider top clamps the DISPLAY to 100 (guard is uncapped service-side)", () => {
    expect(nlToAmount(1.5, true)).toBe(100);
  });

  it("clamps out-of-range amounts to [0,100]", () => {
    expect(amountToNl(150, false)).toBeCloseTo(NL_MAX, 6);
    expect(amountToNl(-10, false)).toBeCloseTo(NL_MIN, 6);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd ui && npx vitest run src/ui/reimagineAmount.test.ts`
Expected: FAIL — cannot resolve `./reimagineAmount`.

- [ ] **Step 3: Implement the helper**

Create `ui/src/ui/reimagineAmount.ts`:

```ts
// Maps the re-imagine "keep ↔ re-imagine" dial (0–100 UI) to SA3's init_noise_level (nl).
// nl is a UNIDIRECTIONAL keep→reimagine ramp (not colours' centered ±ceil). The float is the
// source of truth (it lives in the render param + cache fingerprint); this only converts for
// display/write so the user never sees a raw 0.4. Constants mirror the authoritative Python guard
// in service/adapters/stable_audio3_adapter.py (NL_MIN / NL_MAX_RECOGNIZABLE) — keep them in
// lockstep. Normal caps at NL_MAX (recognizability guard); the Lab slider spans up to NL_GENERATE
// (1.0 = full re-imagine = generate). The Lab guard is uncapped service-side, so a raw nl > 1.0
// simply shows as 100 here.
export const NL_MIN = 0.01;      // < this is a near-identity no-op (the adapter rejects it)
export const NL_MAX = 0.5;       // normal-mode recognizability ceiling
export const NL_GENERATE = 1.0;  // Lab slider top: nl=1.0 == generate-from-scratch (source fully gone)

const ceilFor = (lab: boolean): number => (lab ? NL_GENERATE : NL_MAX);

/** 0–100 dial → nl float. 0 → NL_MIN (minimal change), 100 → ceil (0.5 normal / 1.0 Lab). */
export function amountToNl(amount: number, lab: boolean): number {
  const a = Math.max(0, Math.min(100, amount)) / 100;
  const ceil = ceilFor(lab);
  return NL_MIN + a * (ceil - NL_MIN);
}

/** nl float → 0–100 dial position (rounded int, display-clamped to [0,100]). */
export function nlToAmount(nl: number, lab: boolean): number {
  const ceil = ceilFor(lab);
  const frac = (nl - NL_MIN) / (ceil - NL_MIN);
  return Math.round(Math.max(0, Math.min(1, frac)) * 100);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd ui && npx vitest run src/ui/reimagineAmount.test.ts`
Expected: PASS — 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ui/reimagineAmount.ts ui/src/ui/reimagineAmount.test.ts
git commit -m "feat(ui): reimagineAmount 0–100 ↔ nl mapping helper"
```

---

### Task 3: Surface the dial in the drawer + mock parity + RenderLayer comment

**Files:**
- Modify: `ui/src/ui/Dock.tsx` (import near line 13; `GenBody` reimagine branch ~310)
- Modify: `ui/src/bridge.mock.reimagine.test.ts` (add one test)
- Modify: `src/state/RenderLayer.h` (comment at line 51)

**Interfaces:**
- Consumes: `amountToNl` / `nlToAmount` from Task 2; the existing `set_render_param` command (accepts `nl` + `lab`), `useStore(s => s.labMode)`, and `clip.renderLayer.nl` from the snapshot (all already present).

- [ ] **Step 1: Write the failing mock-parity test**

In `ui/src/bridge.mock.reimagine.test.ts`, add this `it(...)` inside the existing top-level `describe(...)` block (after the last test, before the closing `});`):

```ts
  it("the keep↔reimagine dial round-trips through set_render_param; Lab unlocks past 0.5", async () => {
    const s = await snap();
    const wave = s.tracks.flatMap((t) => t.clips).find((c) => c.type === "wave")!;
    const clipId = wave.id;
    await exec("create_render_layer", { clipId, adapter: "fake", mode: "reimagine" });
    const nlOf = async () =>
      (await snap()).tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)!.renderLayer!.nl!;

    // Normal: dial 80 → nl ≈ 0.40 → reads back 80.
    await exec("set_render_param", { clipId, nl: amountToNl(80, false), lab: false });
    expect(nlToAmount(await nlOf(), false)).toBe(80);

    // Lab: dial 100 → nl 1.0 (> the 0.5 normal cap) → reads back 100.
    await exec("set_render_param", { clipId, nl: amountToNl(100, true), lab: true });
    const labNl = await nlOf();
    expect(labNl).toBeGreaterThan(0.5);
    expect(nlToAmount(labNl, true)).toBe(100);
  });
```

Add the import at the top of the file (after the existing imports):

```ts
import { amountToNl, nlToAmount } from "./ui/reimagineAmount";
```

- [ ] **Step 2: Run to verify it passes already (the mock already models `nl`)**

Run: `cd ui && npx vitest run src/bridge.mock.reimagine.test.ts`
Expected: PASS — the new test passes (the mock's `set_render_param` already does `if ("nl" in args) rl.nl = num(args.nl, rl.nl)` and returns `renderLayer.nl` in the snapshot). This test locks the parity so a future mock change can't silently drop `nl`.

*(Note: this test is GREEN on first write because the mock already supports `nl`; it is a regression guard, not red→green. That is the correct shape here — the behavior under test is the round-trip contract, and the helper from Task 2 is the new code it exercises.)*

- [ ] **Step 3: Add the dial to `GenBody`**

In `ui/src/ui/Dock.tsx`, add the import near the other `./`-local imports (e.g. just below the `engineBadge` import at line 13):

```ts
import { amountToNl, nlToAmount } from "./reimagineAmount";
```

Then, in `GenBody`, the reimagine branch begins at `: (<>` (~line 310) followed by `{active.map(...)}`. Insert the dial as the FIRST child of that fragment, immediately after `(<>`:

```tsx
      : (<>
      <label className="nparam" data-testid="gen-nl-row"
        title="How much to keep vs re-imagine — 0 keeps your original, 100 fully re-imagines. Lab unlocks up to a full generate-from-scratch.">
        <span className="nlabel">re-imagine</span>
        <span className="nslider"><input type="range" min={0} max={100} step={1}
          aria-label="re-imagine amount"
          data-testid="gen-nl"
          value={nlToAmount(rl.nl ?? 0.4, labMode)}
          onChange={(e) => void exec("set_render_param", { clipId: clip.id, nl: amountToNl(Number(e.target.value), labMode), lab: labMode })} /></span>
        <span className="nval">{nlToAmount(rl.nl ?? 0.4, labMode)}</span>
      </label>
      {active.map((c) => {
```

(The `{active.map((c) => {` line already exists — do not duplicate it; the insertion adds only the `<label>` block above it.)

- [ ] **Step 4: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Add the RenderLayer default comment**

In `src/state/RenderLayer.h`, line 51, change:

```cpp
        params.setProperty (ids::nl, 0.4, nullptr);
```

to:

```cpp
        params.setProperty (ids::nl, 0.4, nullptr);   // init_noise_level; ≤0.5 keeps whole-clip stitch pulse-free (service clamp_nl is the guard). UI surfaces it as a 0–100 "keep ↔ re-imagine" dial.
```

- [ ] **Step 6: Run the two touched vitest specs + typecheck together**

Run: `cd ui && npx vitest run src/ui/reimagineAmount.test.ts src/bridge.mock.reimagine.test.ts && npx tsc --noEmit`
Expected: all specs pass; tsc clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/ui/Dock.tsx ui/src/bridge.mock.reimagine.test.ts src/state/RenderLayer.h
git commit -m "feat(ui): surface nl as a 0–100 keep↔re-imagine dial in the gen drawer"
```

---

### Task 4: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Python golden 3× deterministic**

Run: `for i in 1 2 3; do python3 service/adapters/stable_audio3_adapter_test.py >/dev/null && echo "run $i OK"; done`
Expected: `run 1 OK` / `run 2 OK` / `run 3 OK`.

- [ ] **Step 2: Full UI unit suite (proves no regression from the new import/slider)**

Run: `cd ui && npx vitest run`
Expected: all specs pass (the prior green count + the new `reimagineAmount` spec + the new mock-parity test).

- [ ] **Step 3: Typecheck (src + e2e)**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Confirm the C++ change is comment-only (selftest byte-stable by construction)**

Run: `git diff --stat HEAD~3 -- src/` (or `git show` the RenderLayer.h commit)
Expected: `src/state/RenderLayer.h` shows only a comment on the `nl` default line — no logic/token change. Because MoshOps/RenderLayer logic is untouched, `--selftest` counts and the cache fingerprint are unchanged. A full `--selftest` build is OPTIONAL proof; if run in this worktree, use the memory recipe (`Mosh worktree build recipe`: `-DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`, and build `MoshTests` for a C++-only proof given the worktree UI-build esbuild SIGKILL gotcha).

- [ ] **Step 5: Behavior spot-check (drive the real drawer)**

Per the `verify` skill / preview workflow: start the UI dev server, open a clip's Gen tab, confirm the "re-imagine" dial shows ~80 at the default, drag it, confirm `set_render_param` fires with a mapped `nl` float (not a 0–100), and that toggling Lab lets the dial map past 0.5. (Optional but recommended for a UI change; the mock backend exercises the same command path.)

---

## Self-Review

**Spec coverage:**
- Decision 1 (UI maps, nl stays float) → Tasks 2 & 3 (helper + slider; float in the command). ✓
- Decision 2 (default ≤0.5, no pulse) → Task 1 (`clamp_nl` normal cap) + Task 3 Step 5 comment; default `nl=0.4` unchanged. ✓
- Decision 3 (keep legacy/misaligned stitch A; bar-align deferred) → no `coverage.py` change (confirmed absent); documented in the spec, nothing to implement. ✓
- Decision 4 (Lab-defeatable, uncapped) → Task 1 `clamp_nl` Lab pass-through + Task 2 `NL_GENERATE` slider top. ✓
- Component A (adapter) → Task 1. Component B (helper) → Task 2. Component C (drawer, sends `lab`) → Task 3 Step 3. Component D (mock parity) → Task 3 Steps 1–2. ✓
- Testing (Python golden 3×, vitest, tsc, selftest byte-stability) → Task 4. ✓

**Placeholder scan:** every code step contains full code; commands have expected output. No TBD/TODO. ✓

**Type consistency:** `amountToNl(amount, lab)` / `nlToAmount(nl, lab)` and exports `NL_MIN`/`NL_MAX`/`NL_GENERATE` are used identically in Tasks 2 & 3. Python `clamp_nl(nl, lab)` + reused `NL_MIN`/`NL_MAX_RECOGNIZABLE` are consistent across Task 1's test and impl. ✓
