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
