# Design — Documentation On-Ramp & Prune

**Date:** 2026-06-17
**Status:** approved (brainstorm) — pending spec review → writing-plans
**Scope discipline:** **docs-only. No C++ / TS / build changes in this session.**

## Problem

Even the project owner was unsure whether Mosh is "native" or "web," and a basic
"can I save and reopen a project?" question required dispatching 11 agents to read
source because no doc answered it. The doc surface is **39 markdown files / ~6,800
lines** with real drift and sprawl:

- Spec set is numbered `00,01,04,05,06,07` at root — **`02` and `03` are missing**
  (`02` was reconstructed into `docs/02_MOSHOPS_CONTRACT.md`; `03` never existed at
  root). The sequence *looks* broken at first glance.
- `docs/FEATURE_AUDIT.md` is 886 lines; ~10 **dated point-in-time reports**
  (`docs/consolidation/*`, `docs/hardening/*`) are stale by design; `design-lab/`
  is a 5-file archive.
- `CLAUDE.md` (~430 lines, ~18KB) auto-loads into **every** session — the single
  largest recurring token cost — yet reads as a build checklist, not an on-ramp.

**Goal:** open the repo, understand it in ~2 minutes, stop re-deriving. Make the docs
reflect the code so future sessions waste minimal tokens figuring out the codebase.

## Non-goals (explicitly out of scope this session)

- **No code changes.** The three verified file-management data-safety gaps
  (no auto-save/save-on-quit; relaunch never reopens last project; non-portable
  shared-audio pool) are **documented as honest "known gaps," not fixed.** They are
  a candidate *separate* future work-session (captured in memory
  `project-file-management-state.md`).
- No spec rewrites. Specs get a status banner only.
- No restructuring beyond the archive move described below.

## Architecture clarification to bake in (the recurring confusion)

Mosh is a **native macOS arm64 app**. Native C++ engine (Tracktion), native plugin
hosting (VST3/AU), native neural DSP, native window/menus/file-I/O. The **visual UI
layer** is a React app rendered inside an embedded JUCE `WebBrowserComponent`
(WebView), shipped *inside* `Mosh.app/Contents/Resources/ui`, talking to the C++ core
through an in-process bridge (`execute_command` + snapshot/events) — **never over a
network.** Not Electron, not a website, no server. "WebView UI layer," not "web UI."

## Deliverables

### 1. `ARCHITECTURE.md` (new, repo root) — the canonical on-ramp
Sections, each scaled to need:
1. **What Mosh is** — the native-shell + WebView-UI + engine + Python generative
   service mental model, with a small diagram. (Resolves the web/native confusion.)
2. **Module map** — every source dir → one-line purpose → key entry file:
   `src/app`, `src/engine`, `src/moshops`, `src/state`, `src/plugins/hosting`,
   `src/plugins/neural`, `src/plugins/spectral`, `src/generative`, `src/webview`,
   `src/brain`, `src/voice`, `src/remote`, plus `ui/`, `service/`.
3. **The two load-bearing contracts** — the MoshOps mutation path (validate →
   Tracktion undo txn → events → JSONL → result) and the snapshot/events feed
   (the swappable seam).
4. **Capability index** — "Can the app do X?" → command(s) + **honest status**
   (works / partial / known gap). File-management gaps live here.
5. **Run / build / test** — pointers only (`run-mosh.sh`, `Mosh --selftest`).
6. **Where the truth lives** — which specs are still current, and where the archive is.

### 2. `CLAUDE.md` — trimmed
Keep: prime directives, the stage/gate ledger (what's done / next). Add a pointer to
`ARCHITECTURE.md` at the top. Move the long `// VERIFY` appendix and resolved-API
detail into `ARCHITECTURE.md` or the archive. Target: a lean manifest, not a wall.

### 3. Prune → `docs/archive/`
Move (not delete — git keeps history, fully reversible) the dated/point-in-time docs:
`docs/consolidation/*`, `docs/hardening/*`, and the `design-lab/` archive set.
Keep active: `02_MOSHOPS_CONTRACT.md`, `ENGINE_API_NOTES.md`, `PROGRESS.md`,
`IPHONE_COMPANION.md`, `service/README.md`, the `superpowers/` specs+plans, and any
`docs/plans/*` still in flight (verify each before moving).

### 4. Specs `00–07` — status banners
One-line banner at the top of each (`CURRENT` / `HISTORICAL — see ARCHITECTURE.md`),
and a note explaining the `02`/`03` numbering gap. No content rewrites.

## The discipline that makes this "reflect the code"

Every factual claim in `ARCHITECTURE.md` and the trimmed `CLAUDE.md` is **verified
against source at write-time** (cite `file:line` where a reader would otherwise doubt
it) — the same standard as the file-management audit. The capability index's status
column is the honest part: no aspirational claims stated as fact.

## Acceptance criteria

- `ARCHITECTURE.md` exists; a cold reader can answer "native or web?", "where does
  feature X live?", and "what can the app actually do / not do?" without opening source.
- `CLAUDE.md` is materially shorter and points to `ARCHITECTURE.md`.
- `docs/consolidation/`, `docs/hardening/`, `design-lab/` relocated under
  `docs/archive/`; active docs remain in place; `git log --follow` still works.
- Specs `00–07` carry status banners; the `02`/`03` gap is explained.
- Every capability/status claim traceable to code; the three file-management gaps
  appear as honest known-gaps.
- Zero changes under `src/`, `ui/src/`, `service/` (excluding markdown). Build/selftest
  unaffected (no source touched).

## Risks / watch-items

- **Moving docs breaks links.** After the archive move, grep for references to moved
  paths (CLAUDE.md, READMEs, specs) and fix them.
- **Re-drift.** ARCHITECTURE.md must be verified at write-time or it just becomes the
  next stale doc. Verification discipline is non-optional.
- **Scope creep into fixing the data-safety gaps.** Resist — document only this session.
