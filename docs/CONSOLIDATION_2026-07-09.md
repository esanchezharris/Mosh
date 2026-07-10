# Consolidation ledger — 2026-07-09 (Codex → Claude transition)

One session cleared the entire Codex-era backlog: every open PR resolved, every branch
dispositioned, the corrupted git store rebuilt, the r4 training cycle honestly closed,
and the r5 fix-first pipeline advanced through P1. Runbook for repeating this:
[CONSOLIDATION_LOOP.md](CONSOLIDATION_LOOP.md).

## PR ledger (16 open at start + 3 opened during — all resolved)

| PR | Title (short) | Disposition | Gate evidence |
|---|---|---|---|
| #275 | r4 mock runtime timers (window→globalThis) | **MERGED** | tsc ✓ · vitest 823 ✓ (fix-plan P0) |
| #270 | UI shortcuts → runAction | **MERGED** | tsc ✓ · vitest 832 ✓ · e2e 121 + walkthrough 5/5 (initial 2 fails A/B-proven load-flakes) |
| #258 | r7 audition profile restore | **MERGED** | both test scripts ALL PASS |
| #261 | Used2 transcript editor + aligner | **MERGED** | py_compile ✓ (lab scripts) |
| #268 | a3b-r4 CUDA parity controls | **MERGED** | bash -n/py_compile/--help/bundle ✓ + ran today's real pod lifecycle |
| #267 | Companion restyle + vitest exit fix | **MERGED** | Catch2 344 · selftest 1186×3 · vitest 833 (exit-stall fix proven) · e2e 123 · strict codesign ✓ |
| #269→#279 | Bundle xattr clear | **MERGED** (re-land; stack-base auto-close trap) | gated inside the combined #267 tree |
| #274 | Asserted-lyric sing gate | **MERGED** | soulx ×3 · Catch2 · selftest 1195×3 · vitest 834 · lyrics e2e 19/19 BOTH modes — after dropping its dev-breaking optimizeDeps override |
| #271 | (same feature, earlier cut) | **CLOSED** superseded by #274 (lacked LockManager classification) |
| #280 | Fader undo replay recursion (from unPR'd branch) | **MERGED** | selftest 1195×3 · **UndoManager asserts 4→0/run (A/B same machine)** |
| #255 | Design tokens + visual gate | **MERGED** | tsc · vitest 834 · e2e · visual 4/4 after shell.css conflict resolve + baseline regold |
| #260 | MP lock-classifier + engine patches 0002/0003 | **MERGED** | Catch2+[multiplayer][lock] 48/48 · ctest · selftest 1195×3 (0 asserts/leaks) · **relay MP smoke 1218/1218** · fader collision resolved to setParameterWithoutUndo |
| #233 | FMS extraction pipeline (+7067) | **MERGED** | 7 lyric goldens ×3 · overlap --selftest · Catch2 · selftest 1195×3 · lyrics e2e 19/19 both modes · 4 conflicts union-resolved vs #274; Stage D stays owner-gated |
| #266→#282 | Service liveness fail-fast + port reap + log cache | **MERGED** (re-land; same trap) | selftest 1195×3, 0 asserts/leaks |
| #197 | r7 recipe corpus promotion (+24.7k) | **MERGED** | recipe goldens ×3 · bundle parity fixed · teardown suites ×4 · selftest 1195×3 · below-floor invariant scoped to transcribed sources (local-midi rolls are off-grid by design) |
| #176 | GRPO rungs | **CLOSED** per the 2026-07-01 RL freeze; branch preserved as tag `archive/funny-mendel-grpo-rungs` |
| #272 | Docs-only r5 carve | **CLOSED** — content already on main in newer form |
| #277 | Rescued transform-backend commit | **PARKED** — venv-seam conformance red + starter-model semantics = owner call (see PR comment) |
| #281 | Non-44.1k re-imagine staging fix | **PARKED** — 17 days stale vs the rebuilt pipeline; revive checklist on the PR |
| #278 | r4 close-out docs | **MERGED** (authored this session) |
| P1 split normalization | fix/split-clip-normalization | **MERGED** (authored this session) | RED-proven, 5/5 vitest, selftest 1199/1199 ×3 |

## Training lane (r4 → r5)

- r4 completed on RunPod (12889/12889, 5h); §P8 gate read = **MISS on measurable floors**
  (aggregate 0.889 ✓, §B 0.919 ✓). Full reconstruction: `service/sft/GATE_READ_a3b-r4-cuda.md`.
- Pod `gc3v0gpji7xskt` resumed once, adapter pulled + sha-verified to
  `~/AI/adapters/a3b-r4-cuda-pull` (2f29b655…), then **terminated** — zero ongoing billing.
- Owner decision: **fix-first, then informed r5** (`docs/bench/R5_TRAINING_DECISION_2026-07-09.md` addendum).
- Fix plan status: **P0 landed** (#275) · **P1 landed** (split normalization; diagnosis showed
  2 of 6 eval fixtures were degenerate — Sub clip [0,3] asked to split at 4s) · P2 = audit
  after the rerun (candidate rows staged at `service/sft/a3b-r4-cuda_next_run_examples.*`).
- **Next step (one unit of work):** rent a pod (`runpod_r4.py create`), serve the archived
  adapter, rerun evalA/frozen300/§B, fix the 2 degenerate split fixtures in the eval set,
  read the floors, fold surviving model-caused misses into `s2-mix-v5`, launch r5
  (local MLX seat is free; v5-prep data verified present).

## Branch dispositions

- **Deleted (content on main):** 36 remote branches (18 merged-PR tier + 14 older-merged tier + 4 zero-ahead).
- **Archive-tagged then deleted:** musing-herschel (taste-probe result), production-reward
  (restart handoff docs), r7-production-layer (superseded by #258), bar-iq-vocabulary
  (merged via #178), funny-mendel (RL freeze). Tags live under `archive/*`.
- **Kept, listed for review:** `claude/auto-g1..g9` (1-commit DAW-conformance gap fixes from
  2026-06-27 — real unmerged feature attempts), `codex/video2recipe-port` (35 commits,
  teardown recovery lane), `claude/fms-extraction-svc-pivot` (score/melody hybrid beyond #233),
  `claude/design-system-phase2` (superseded by #255 — delete after confirming),
  `claude/intelligent-banach-25ad5f` (r4 runtime worktree branch), park/rescue branches.
- **Lost to iCloud corruption (unrecoverable, inventoried):** 9 local-only Codex park/backup
  branches (tips unreadable; most provably redundant with merged PRs), the "park-demo-loop"
  stash, one WebKit-bootstrap commit (predates the branch's repair+merge), one
  handoff-reconciliation local commit. Full ledger: `~/Library/Mosh/rescue-20260709/LEDGER.md`.

## Infrastructure changes

- **The git store moved out of iCloud**: `~/Library/Mosh/repo/ClaudeMosh.git` (fsck --full
  clean; the checkout keeps its Documents path via a `gitdir:` pointer). The corrupt old
  store is parked at `Documents/ClaudeMosh/.git-old-icloud-corrupt-20260709` — trash when
  comfortable. **Recommendation stands: move the whole checkout out of ~/Documents.**
- Gate infrastructure at `~/Library/Mosh/work/`: pristine patched tracktion clone (0001+0002+0003),
  three gate worktrees, non-iCloud build dirs.
- 385 iCloud " 2" conflict copies cleaned from source dirs (368 identical removed,
  17 differing quarantined to the rescue dir).
