# Natural-Polish Rubric

The single source of truth for what the **polish-loop** is allowed to ship. The whole point of the loop is to make
the v2 UI nicer **without going overboard** — so this rubric is conservative by design, and **stopping is always an
acceptable outcome**. The curator must prefer to ship *nothing* over shipping a marginal, subjective, or risky change.

> A polish is a *small, obviously-correct improvement to the **existing** UI that a tasteful designer would tidy
> without anyone needing to discuss it.* If it would need a design conversation, it is **not** a polish.

## Hard invariants (every polish, no exceptions)

- **Frontend-only.** Touch `ui/` only — never compiled/CMake/native paths. This is the *swappable seam*: a UI change
  must leave the C++ binary byte-identical. (Enforced by `scripts/auto-loop/classify.sh` → `cheap` class.)
- **Provable by the cheap gate.** `typecheck + vitest + e2e` must prove it. Add a small test guard (red before,
  green after). Never weaken a gate (no deleted/skipped/`.only` tests, no downgraded assertions).
- **Small.** ≤ ~60 changed lines and ≤ 3 files. One coherent polish per PR.
- **One PR per polish**, titled `polish(v2/...): <what>`.

## ALLOW — genuinely-natural polishes

- **Missing-but-expected interactive states** — `:focus-visible` where `:hover` exists; `:disabled` / active styling;
  `prefers-reduced-motion` fallbacks for transitions/transforms/animations.
- **A11y completeness** — `aria-label`/`title`/`role` on icon-only controls; `aria-pressed`/`aria-selected` on toggles/tabs.
- **Unfinished states** — finishing an empty / loading / error state that reads terse or unstyled vs the rest of the shell.
- **Token consistency** — replacing a hardcoded px / colour / radius / font-size with the **clearly-intended** existing
  `--v2-*` design token in `ui/src/v2/shell.css`.
- **Obvious nits** — a clear alignment, overflow, or truncation glitch.

## DENY — "going overboard" (reject, and prefer to STOP)

- Any **new feature**, new command, or **behaviour/semantics change**.
- **Backend / C++ / service** changes; anything outside `ui/`.
- **Refactors / renames / file-moves**; dependency or build changes.
- Touching the **hard-exclusion list**: CMake/CMakeLists/pins, `MoshEngine.*`, `src/state`, `src/plugins/hosting`,
  `CLAUDE.md`, specs `00`–`06`, `.github`, deploy scripts, relay/Supabase auth, the gate scripts, **this rubric**.
- **Subjective redesign** — new colour choices, new layout, new type scale, "make it pop". Taste calls are the owner's.
- **Redundant** with an existing affordance. *Canonical example:* a per-element "drop audio here" hint on the add-track
  lane is **redundant** with the full-surface `.v2-drop` overlay that already covers the stage during a file drag → REJECT.
- Anything **> ~60 lines / > 3 files**, or not provable by the cheap gate.

## STOP conditions

The curator returns `stop:true` (ships nothing) when **any** of:

- No scout candidate clears this rubric with high confidence.
- Everything surfaced is already shipped / in flight (dedupe via `polish-log.jsonl` + `git log` + `gh pr list`).
- A `docs/polish-loop/STOP` (or `docs/auto-loop/STOP`) sentinel is present.

When unsure, **STOP**. A missed polish costs nothing; an over-eager or wrong one costs the owner's trust.
