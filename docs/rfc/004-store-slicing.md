# RFC 004 — store.ts slicing (events extraction + zustand slices)

- **Status:** accepted
- **Decided:** 2026-07-28 (owner approved the program plan)

## Problem

[`ui/src/store.ts`](../../ui/src/store.ts) is 1,109 LOC with 150+ state fields in one file — the
UI's collision hotspot: nearly every frontend lane touches it, and concurrent worktrees conflict
on it constantly. The repo already partitioned `shell.css` for exactly this dynamic; the store is
the remaining monolith. The `init()` event switch (~lines 401–608) additionally mixes every event
rail (snapshot invalidation, transport, levels, spectrum, multiplayer, jobs) into one handler
body.

## Invariants touched

- **The swappable seam** (prime directive): the frontend still couples to the backend only via
  `execute_command` + snapshot/events. Slicing is file organisation, not a seam change.
- **The single-`State` seam:** `useStore` export, the `State` type, every type re-export, and
  `window.__moshStore` (Playwright reaches the store through it) are all **unchanged** —
  consumers and e2e specs see an identical surface.
- **Rail discipline:** transport/levels/spectrum live deliberately *outside* the snapshot
  (30 Hz rails, CLAUDE.md Stage 2 correction). The slice boundary is chosen to match this
  existing seam, not to invent a new one.

## Options considered

**(a) Two mechanical PRs: events extraction, then StateCreator slices — CHOSEN.**
1. Extract the `init()` event switch (~lines 401–608) into `ui/src/store/events.ts` as per-rail
   handlers — pure motion, no case reordering.
2. Zustand `StateCreator` slice composition — `ui/src/store/telemetry.ts`, `mp.ts`, `jobs.ts`,
   `catalogs.ts` — composed **inside the single existing `create()` call**. The module-level
   `mpSyncChain` serializer stays module-level (it is intentionally outside React/zustand
   lifecycle). Slice boundary = **event rail + laziness class**, which matches the seam the
   architecture already draws (snapshot vs. 30 Hz rails vs. lazily-fetched catalogs). Chosen
   because both PRs are mechanical, individually verifiable, and leave every consumer import and
   the Playwright hook byte-compatible.

**(b) Multiple zustand stores — REJECTED because** it breaks the single-`State` seam and every
consumer import (`useStore` selectors compose across rails today, e.g. components reading
snapshot + transport together), plus `window.__moshStore` would no longer be *the* store.
Maximum churn, no coupling actually removed.

**(c) Leave it; rely on merge tooling — REJECTED because** the collision cost is already being
paid weekly, and the `shell.css` partition proved the fix pattern works in this repo.

## Decision

Option (a): PR 1 extracts the event switch to `ui/src/store/events.ts` as per-rail handlers
(pure motion); PR 2 splits state into `StateCreator` slices (`telemetry`, `mp`, `jobs`,
`catalogs`) composed in the single existing `create()` call, with `useStore`, `State`, all type
re-exports, `window.__moshStore`, and the module-level `mpSyncChain` serializer unchanged.

## Migration / PR plan

Two PRs, in order (events extraction first — it shrinks the surface PR 2 moves). Change-class
per [`classify.sh`](../../scripts/auto-loop/classify.sh): `ui/` only → **cheap**; eligible for
auto-merge on a green gate + review per the program's routing.

## Verification

- **Gate lane:** full vitest suite + **full e2e including `multiplayer.spec.ts`** (the mp rail
  is the easiest to silently detach in a slice move, and e2e reaches the store via
  `window.__moshStore` — a real consumer of the preserved surface).
- **Oracles:** `tsc` clean (the `State` type and re-exports are compile-checked consumers);
  vitest store tests exercise per-rail behaviour, so a dropped or re-wired handler fails
  concretely. **Zero DOM change** is a stated property of both PRs, so no visual run is needed —
  and any e2e screenshot/DOM diff appearing in review is by itself a red flag that the PR
  exceeded its mandate.
- **RED-proof:** before trusting the "surface unchanged" claim, temporarily rename
  `window.__moshStore` and confirm e2e actually fails (proves the specs really consume it — a
  guard that cannot fail is this repo's recorded failure mode; see the vacuous-verification
  gotcha in [`CLAUDE.md`](../../CLAUDE.md)).
- **e2e isolation:** run under `ui/playwright.isolated.config.ts` (port 5191) if any other
  session owns `:5173` — a foreign bundle false-fails every spec.

## Status log

- 2026-07-28 — accepted (owner approved the program plan).
- 2026-07-29 — **implemented and merged**: #493 (event-rail extraction to `store/events.ts`) and #498 (slice composition — `store/{telemetry,mp,jobs,catalogs}.ts`). Both verified pure motion; `useStore`, the `State` type, every type re-export, `window.__moshStore` and the module-level `mpSyncChain` singleton all unchanged, so no consumer import moved. Full vitest + e2e green.
