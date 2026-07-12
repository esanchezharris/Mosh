# FS-B0 — r5-freeze memo (Lane B, spec §7 B0)

*First-session gate-registered plan. Written 2026-07-12. Docs-only, `ownerMerge:true`.
Backlog row: `{"id":"FS-B0","lane":"B","class":"cheap","size":"S","order":10,"ownerMerge":true,
"files":["docs/bench/PROGRAM_STAGE1_2026-07.md"]}`.*

---

## Context

Lane B (Brain: skills + router) is blocked on the owner's demo script (O2), but **B0 and B1 may
proceed** (spec §7). B0 is the smallest, script-independent item: land the **r5-freeze memo** so the
SFT training thread is formally closed at the program level and the reader of
`docs/bench/PROGRAM_STAGE1_2026-07.md` sees the First-Stranger decision, not just the raw training
result.

**Why the memo is needed (the reconciliation it performs).** `PROGRAM_STAGE1_2026-07.md` was last
edited 2026-07-10 and its `§P9` section ends on the technical fact that **r5 PASSED its gate** and is
"the new best A3B adapter" (r5 CUDA run 12,994/12,994; gate read agg(A,C)=0.9563 ✓, §B=0.8919 ✓;
adapter sha `76f8db52…`, archived `~/AI/adapters/a3b-r5-cuda-pull`). One day later, the First-Stranger
Program (SPEC §1.1 + §2 ledger, settled 2026-07-11) made a **higher-level** decision that supersedes
that framing for the 6-week window:

- **SFT r5 is CLOSED** (spec §2: `SFT r5 run — CLOSED — 2026-07-11 — revisit: never (target
  deprecated)`), and no local router-model work happens in the window because the **serving path is
  the cloud brain via the T1 proxy** (spec §1.8).
- The **r4 adapter** (`~/AI/adapters/a3b-r4-cuda-pull`, sha `2f29b655…`) is **retained as an interim
  brain** (spec §1.1) — the known-good local fallback.
- The **12,994 `s2-mix-v5` rows** (train sha `3c4e2e8b2ecc3562…`) are **retained as a workflow corpus,
  parked** for future skill mining (spec §2: `Skill learning v2 / sharing v3 (incl. mining the 12,994
  rows) — PARKED — revisit post-playtest`).

Without the memo, the STAGE1 doc's own conclusion ("r5 is the new best adapter") reads as the live
state and directly contradicts the program decision. B0 appends a short freeze memo that records the
program-level close and points forward to the parked corpus, per spec §1 (do **not** re-litigate the
decision — record it as given).

### Gap verification (spec §0 — confirmed STILL OPEN, 2026-07-12)

- `docs/bench/PROGRAM_STAGE1_2026-07.md` **exists** (411 lines, 45 KB) — so the memo is an **append**,
  not a new file.
- `grep -niE 'first.stranger|freeze memo|B0|interim brain|workflow corpus'` over that file → **NONE**.
  No First-Stranger-level freeze memo is present.
- The file's tail is the `§P9 result — r5 gate read (2026-07-10): PASS` table, ending on the
  "r5 disposition … r5 is the new best A3B adapter" line. The program-close framing (r5 CLOSED / r4
  interim / rows parked-as-corpus) is **absent**.
- **Conclusion: `gapExists = true`.** The memo has not been written.

---

## Exact gate(s) that prove this lane

B0 is docs-only, so the proof is a **content-presence check on the memo** plus **diff-scope** and
**baseline-preservation** guards. All are locally runnable and reuse existing harness discipline.

1. **Memo-content gate (lane-specific, scriptable).** After the memo is appended, all three of these
   greps over `docs/bench/PROGRAM_STAGE1_2026-07.md` must succeed — one per required fact in the
   acceptance:
   - r5 close: `grep -qiE 'r5[^.]*(CLOSED|frozen)'` AND the memo cites spec §1.1/§2.
   - r4 interim brain: `grep -qiE 'a3b-r4-cuda-pull|2f29b655' && grep -qi 'interim brain'`.
   - rows parked as corpus: `grep -qiE '12,?994|s2-mix-v5' && grep -qiE 'corpus' && grep -qi 'park'`.
   (Wire these as a single `scripts/first-stranger/`-adjacent check invoked from the review step, or
   assert them inline in the PR description — no new selftest surface needed for a docs memo.)
2. **Diff-scope gate (spec §0 "do not touch PROGRAM_STAGE1 beyond the memo").** `git diff` must show
   **only appended lines** in `PROGRAM_STAGE1_2026-07.md` (a new trailing memo section) — **zero**
   deletions or edits to any pre-existing `§P9`/`§B`/`WP-*` line. Verify with
   `git diff --stat` (insertions only on that file) + a `git diff` eyeball that the `@@` hunks are all
   at end-of-file additions. The only other changed path is this plan (`lanes/fs-b0.md`).
3. **Baseline-preservation gate (spec §0).** The change is pure Markdown → binaries are
   byte-identical and the full local gate is unaffected. If the loop runs it, the baselines must stay
   green: `--selftest` ≈1254–1260 ×3 deterministic, Catch2 ≈494, vitest ≈874, Playwright e2e 125/125
   (isolated config / port 5191 if `:5173` is owned), `tsc` clean. No new checks are introduced.
4. **Owner wording-approval gate (the human gate — see BLOCKED-ON-OWNER).** Per spec §7 B0 and the
   backlog `ownerMerge:true`, the memo does **not** merge until the owner approves the wording. The
   loop routes it to a `needs-owner-merge` PR; it never auto-merges.

---

## Files to change

| path | change |
|---|---|
| `docs/bench/PROGRAM_STAGE1_2026-07.md` | **Append only** a short `## r5-freeze memo (First-Stranger Program, 2026-07-11)` section recording the three acceptance facts, cross-linking spec §1.1/§1.8/§2, and pointing the parked corpus forward to the post-playtest skill-mining revisit. No edits above the new section. |
| `docs/first-stranger-program/lanes/fs-b0.md` | This plan (already written). |

**Nothing else.** No `src/`, `service/`, `ui/`, `cmake/`, engine, state, or config paths. No changes
to the SA3 LoRA branch, `arena/`, FMS spike worktrees, or any other bench doc (spec §0).

### Memo content outline (for the execute step — not written this session)

- **Decision:** SFT r5 is CLOSED at the program level (spec §2 ledger, 2026-07-11), target
  deprecated, revisit never. Note the technical result stands (r5 cleared the §P9 gate on 2026-07-10)
  but is **superseded as a serving choice**: the window's brain is the cloud model via the T1 proxy
  (spec §1.8), so no local router model ships.
- **Interim brain:** r4 (`~/AI/adapters/a3b-r4-cuda-pull`, sha `2f29b655…`) retained as the interim
  local fallback (spec §1.1). Record the r5 archive (`a3b-r5-cuda-pull`, sha `76f8db52…`) as
  kept-not-served so the artifact isn't lost.
- **Corpus:** the 12,994 `s2-mix-v5` rows (train sha `3c4e2e8b2ecc3562…`) retained as a **workflow
  corpus, parked** for skill mining (spec §2, revisit post-playtest).
- One line reconciling the apparent tension with the existing "r5 is the new best A3B adapter" tail so
  a future reader isn't confused (the owner-approved wording resolves it — see below).

---

## §0 rules binding this lane

- **One lane per worktree.** This worktree is FS-B0 only; no other lane's files are touched.
- **MoshOps sole mutation seam.** N/A by construction — this lane adds no code and mutates no engine
  state; the rule is not exercised (and cannot be violated).
- **Nothing a build reads under `~/Documents`.** N/A — no caches/artifacts created; docs only.
- **Parked-threads / PROGRAM_STAGE1 exception.** Spec §0 forbids modifying `PROGRAM_STAGE1` *"beyond
  the freeze memo task (B0)"* — this lane **is** that sanctioned exception, and must stay strictly
  within it (append the memo, edit nothing above it). Do not touch `arena/`, the SA3 LoRA branch, or
  FMS spike worktrees.
- **Never-touch rulebook.** Untouched — no changes to `scripts/auto-loop/*`, `CLAUDE.md`, specs
  `00`–`06`, `cmake/Dependencies.cmake`/version pins, or `.github/**`.
- **Build recipe / Info.plist TCC keys.** N/A — no build or bundle change; keys intact.

---

## Expected merge BUCKET: **owner**

Path-wise the diff is docs-only (`docs/**`), which the classifier would call **safe** — but the
backlog row carries **`ownerMerge:true`** and the acceptance explicitly requires **"Owner approves the
wording before merge."** Per the README routing table, `ownerMerge` lanes route to **Owner** and
**never auto-merge**. So the loop's Plan → implement → full gate → hostile review pipeline runs, then
it opens a **`needs-owner-merge` PR**. Final bucket = **owner**.

---

## BLOCKED-ON-OWNER

- **Merge is gated on owner wording approval** (spec §7 B0). This is *not* an O1–O6 hard external
  blocker: **all prep may proceed now** — draft the memo, run the gates, open the `needs-owner-merge`
  PR. Only the merge waits on the owner's sign-off of the exact wording.
- **One wording point to surface for the owner to confirm** (do not resolve it unilaterally — spec §1
  says record the decision as given): the STAGE1 doc's own tail concludes *"r5 is the new best A3B
  adapter,"* yet spec §1.1 and this acceptance retain **r4** (not r5) as the interim brain. That is
  **deliberate** — the window serves via the cloud brain (§1.8), so the local adapter is only a
  fallback and the program keeps the prior known-good r4 while archiving r5. The memo should state
  this reconciliation in one sentence; the exact phrasing is the thing the owner approves.
