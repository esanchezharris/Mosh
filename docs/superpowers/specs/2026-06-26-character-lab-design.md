# Moshi Character Lab — in-app knob demo (2026-06-26)

*An in-app demo that shows the Moshi 3D character changing **shape / texture / style / color**
as you drive a rack of sliders. Built for the integration pitch: it drives the **exact**
`ui/src/vendor/moshi.js` the product ships, through nothing but the component's public
semantic API — proving the seam (a canvas + a handful of scalars) that the main app would use.*

## Goal

A reviewer opens one URL on the dev server, drags sliders, and watches the same creature
that sits in the dock morph in real time. No backend, no engine, no new commands — just the
shipping component wired to controls.

## Why this is small

`moshi.js` already exposes every axis we need as a clean public API (verified against the
vendored source):

| User word | Control | API | Notes |
|---|---|---|---|
| texture + color | **MORPH** | `setPersonality(0.0→1.0)` | float resolves to family `NAMES[floor((v%1)*9)]`, order **TAR·DISCO·MOLTEN·GHOST·SILK·BREAKS·CHROME·BUBBLE·PORCELAIN**; a non-snap call does a real cross-family palette/displacement crossfade |
| shape | **SHAPE** | `set('energy', 0..1)` | body-wave displacement amplitude |
| shape variant | **SEED** | `setPersonality(currentName, seed)` | re-resolves limb anatomy inside the family |
| color/heat | **HEAT** | `set('heat', 0..1)` | ember core + lime eyes |
| liveliness | **MOOD** | `set('mood', 0..1)` | resting grin + liveliness |
| style | **STYLE** | `setStyle('ps2'\|'toon'\|'baked')` | render language (discrete) |
| resolution | **QUALITY** | `setQuality('ps1'\|'ps2'\|'ps2+')` | console dial (discrete) |
| 3D↔flat | **ANATOMY** | `setAnatomy('A'\|'B'\|'C')` | blob-vs-sticker balance (discrete) |

Public statics used for the option lists: `Moshi.STYLES`, `Moshi.QUALITIES`, `Moshi.ANATOMIES`,
`Moshi.PERSONALITIES` (no hard-coding — read them from the component so the lab can't drift).

## Architecture

Three units, each independently understandable/testable:

1. **`ui/src/lab/characterLabModel.ts`** — pure, no React, no DOM. The testable core:
   - `FAMILY_NAMES` resolved from `window.Moshi?.PERSONALITIES` with a hard-coded fallback
     (the canonical order above) so unit tests run headless with no WebGL.
   - `familyNameAt(dial: number): string` — mirrors moshi.js exactly:
     `NAMES[Math.floor(((dial % 1) + 1) % 1 * NAMES.length)]`.
   - `SLIDERS` / `TOGGLES` descriptor arrays: `{ key, label, apply(api, v) }` so the
     component renders the rack from data and the test asserts each control calls the
     right API method with the right value (via a mock api object).

2. **`ui/src/lab/CharacterLab.tsx`** — the panel. Mounts the real `ui/src/vendor/moshi.js`
   into a host div (`room:true`, `quality:'ps2+'`, `style:'toon'` to match the lab
   frontrunner), holds local React state for each control, applies changes through the
   model descriptors, and shows live numeric readouts + the live family name. Renders a
   second small **56px presence orb** of the *same* component (the integration punchline:
   "this is the thing in the dock"). Extras: **Randomize all**, **Reset**, **Auto-sweep**
   (a rAF loop that walks the MORPH dial 0→1 hands-free).

3. **Dev route** in `ui/src/App.tsx` — when `?view=character-lab` and `import.meta.env.DEV`,
   render `<CharacterLab/>` instead of the shell and **do not call `store.init()`**. A new
   `ui/src/lab/labQuery.ts` (dependency-free, mirroring `v2/shellQuery.ts`) exposes
   `isCharacterLab(): boolean`. Production single-file bundle has `DEV === false`, so the
   route is unreachable in the shipped app — zero risk to the shipping shells.

## Wiring details / correctness

- **MORPH drag behavior:** call `setPersonality(v)` (no snap), rAF-throttled to one call
  per frame, so dragging produces a live crossfade chase. If live testing shows it lagging
  or never settling, fall back to `{snap:true}` during drag (instant scrub) and a single
  non-snap crossfade on release. Decision made by eye during verification; either way the
  family-name readout uses `familyNameAt(v)`.
- **SEED** applies as `setPersonality(familyNameAt(morph), seed)` so it stays in the family
  the MORPH dial currently selects.
- **Cleanup:** `destroy()` both Moshi instances on unmount; cancel the auto-sweep rAF.
- **Throttling:** a single shared rAF coalesces rapid slider input → one API apply per frame.
- **No engine/bridge/backend, no C++, no new MoshOps commands, no store usage.** The lab
  does not import the store; it can't perturb a session.

## Styling

Reuse `mosh.css` brand tokens (`--lime`, `--ink`, PS2 chrome) and the native
`<input type="range">` + `accent-color: var(--lime)` house style (same as the Inspector).
New scoped rules under a `.charlab` namespace appended to `mosh.css` (kept small) or a
co-located `CharacterLab.css`. Layout: big stage left, labeled rack right, readouts inline,
56px orb pinned corner, title strip naming the integration seam.

## Testing

- **vitest** `ui/src/lab/characterLabModel.test.ts`:
  - `familyNameAt` returns the right family at boundaries (0 → TAR, ~0.5 → BREAKS,
    just-under-1 → PORCELAIN, wraps for <0 and ≥1).
  - each `SLIDERS`/`TOGGLES` descriptor's `apply` calls the expected mock-api method with
    the expected argument.
- **Live verification** (preview tools): `npm run dev`, open `?view=character-lab`, drive
  each slider, screenshot a couple of distinct morph states, confirm a clean console.
- **Regression guard:** `npm run typecheck` + full `vitest` stay green; the shipping shells
  are untouched (route is additive + dev-gated).

## Out of scope (YAGNI)

Voice/brain (trivial to add later, not core to "twist a knob → it changes"); promoting this
to a real production feature of the v2 shell (it stays a dev demo route); any backend/engine
or persistence work.
