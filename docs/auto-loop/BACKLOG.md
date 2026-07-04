# Auto-Loop Backlog

**Machine source of truth:** [`backlog.jsonl`](backlog.jsonl) (one JSON item per line).
This markdown is the human-readable companion — keep it in sync when you hand-edit, but
the loop reads `backlog.jsonl` (via `scripts/auto-loop/discover.sh`).

## Item schema

```jsonc
{
  "id": "AL-001",              // AL-### ; discover.sh auto-assigns the next free one
  "title": "…",
  "class": "cheap|native",     // verifiable without a native build vs needs build+selftest
  "size": "S|M|L",
  "status": "ready|in_progress|blocked|needs-human|done",
  "order": 10,                 // lower = sooner; discovered items default to 1000+id
  "files": ["…"],              // hint, not a contract
  "acceptance": "how an automated gate proves it done",
  "skills": ["test-driven-development", …],
  "notes": "…"
}
```

Only items whose acceptance is provable by an automated gate (selftest / vitest /
verify.py) in ONE PR belong here. Anything bigger is an **epic** → decompose or exclude.

## Seed (curated, cheap wins first)

| order | id | item | class | size | notes |
|---|---|---|---|---|---|
| 5  | AL-000 | Merge pending `c7dc67a` bootstrap commit | native | S | **Run FIRST.** Branch already exists (`claude/confident-chatelet-dd59df`, the deployed playtest fix, not on main). `mode:"merge-existing"` → worktree FROM that branch → native gate → merge. Known-good warm-up that proves the merge-queue. |
| 10 | AL-001 | Escape-listener overlay-stack fix | cheap | S | Shared `useEscapeStack`; Esc closes only the topmost overlay. First cheap-lane win. |
| 20 | AL-002 | Per-template rebind persistence | cheap | S–M | Persist keybind rebinds per template (localStorage); UI-local. |
| 30 | AL-003 | LoRA popover progress/error UI | cheap | M | Fill the WIP popover's progress/error states over existing `/training/*` snapshot fields. |
| 40 | AL-004 | Prompt-concision rewriter (service) | cheap | M | Stdlib, deterministic; never touches the command surface. |
| 50 | AL-005 | Multiplayer relay hardening | cheap | M | rate-limit / slow-POST cap / lock-lease GC on the stdlib relay. SQL/Supabase parts split out. |
| 60 | AL-006 | Judge-panel quality readout | native | M | Manifest side feeds verify.py → native gate. |
| 70 | AL-007 | Recent-projects list | native | M | Smallest native item — proves the native lane. |
| 80 | AL-008 | bypass_layer real audio re-route | native | M–L | **Confirmed bug:** `cmdBypassLayer` only flips a flag; needs a verify.py A/B. Highest-value native fix. |
| 90 | AL-009 | Save-As audio consolidation / portability | native | L | Deferred B1; consolidate + relative repath. May need decomposition. |

## Excluded epics (the loop must refuse to start whole)

Real on-device LoRA training backend · OOP plugin hosting · real-time RAVE / MRT2 live
instrument lane · Medium→Small model transfer · full Context-Drawers system ·
CRDT/realtime multiplayer. Hardware-gated *verifications* (voice barge-in, 2-machine
video, by-ear A/B, iPhone device, Windows build) are **not** loop work — they need the
owner's hardware.

## AL-007 / AL-009 caveat

Both may need to edit `src/engine/MoshEngine.{cpp,h}`, which is on the **hard-exclusion
list** (a prime-directive seam). Prefer isolating new logic in helper files + `MoshOps`
so the PR stays auto-mergeable; if `MoshEngine.cpp` must change, the loop will open the
PR but route it to `needs-human` (it will not auto-merge an exclusion-list change).

## DAW-parity items (G*) — added 2026-06-27

Seeded from the gathered reality-pack conformance pass. Source of truth for status is the
scoreboard `docs/FEATURE_AUDIT.md` (regenerated from `scripts/daw-conformance/conformance.py`).
Each `G*` row in `backlog.jsonl` maps to a reality-model invariant + an eval-suite area; the
native gate runs `conformance.py`, so closing a gap flips its scenario from `gap` → `pass`.
The ready picker suppresses any matching open or merged `auto(G*)` PR title, so claimed
G-series items stay out of rotation until their local backlog status changes.

Leverage order: stranded-backend UI wiring first (G5/G6/G8/G9/G3 — cheap), then native
absences (G14 gain-undo, G1 export range/tail, G7 stems, G4 clip inspector+fades, G2
record UX/count-in), then nice-tier (G11/G13/G10/G12). G14 was **discovered** by the
conformance harness (set_track_volume/pan bypass the UndoManager — undo doesn't restore).


## De-slop campaign findings

These items came from the 2026-06-26 read-only native/UI/service/scripts/verification
audit. Only PR-sized, gate-verifiable findings are `ready`; gate/rulebook/deploy
changes are `needs-human` because the loop must not silently rewrite its own controls.

| order | id | item | class | size | status |
|---|---|---|---|---|---|
| 100 | AL-010 | Route live multiplayer commits through the MoshOps seam | native | M | ready |
| 110 | AL-011 | Cover multiplayer lock-classifier drift | native | S | ready |
| 120 | AL-012 | Reject WebBridge UI resource traversal | native | S | ready |
| 130 | AL-013 | Return the replaced training source index | native | S | ready |
| 140 | AL-014 | Reject malformed training registry imports | cheap | S | ready |
| 150 | AL-015 | Preserve corrupt training state diagnostics | cheap | M | ready |
| 160 | AL-016 | Stream training source SHA-256 hashing | native | S | ready |
| 170 | AL-017 | Make bridge.mock fail closed for unhandled mutating commands | cheap | S | ready |
| 180 | AL-018 | Unify duplicated UI project action dispatch | cheap | M | ready |
| 190 | AL-019 | Remove CommandLogTool render-time side effects | cheap | S | ready |
| 200 | AL-020 | Fail mp-live-smoke on PARTIAL | cheap | S | ready |
| 210 | AL-021 | Harden auto-loop de-slop review and gate artifacts | cheap | M | needs-human |
| 220 | AL-022 | Add RAVE load diagnostics without changing command contracts | native | M | ready |
| 230 | AL-023 | Make deploy replacement staged and non-destructive | native | M | needs-human |
| 240 | AL-024 | Stop default provider-key bundling during deploy | native | M | needs-human |
| 250 | AL-025 | Fail Anira self-containment on install_name_tool errors | native | M | needs-human |
| 260 | AL-026 | Repair installed-app gate blockers | native | M | needs-human |
