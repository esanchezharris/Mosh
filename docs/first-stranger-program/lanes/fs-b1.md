# FS-B1 — Skill schema + mock harness + contract test

*Lane plan (first-session, gate-registered). Spec: `docs/first-stranger-program/SPEC.md` §7 (Lane B, B1).
Backlog row: `docs/first-stranger-program/backlog.jsonl` id `FS-B1`. Written 2026-07-12.*

---

## Context

Lane B (Brain) needs a **typed, testable, undoable** skill layer before any real skills (B2) or a
router (B3) can land. B1 is the substrate: a **Skill** = name + NL description + typed slots +
MoshOps template (with control flow) + preconditions + an **engine-mock-assertable postcondition**,
plus a **harness** that runs one reference skill against the engine mock and asserts its
postconditions, plus a **contract test** that ties the skill catalog to the *real* command surface.

B1 is explicitly **script-independent** (spec §7.B1) — it does **not** need the O2 demo script. It
builds machinery, not the demo's ~10 skills (that is B2, blocked on O2).

### Gap verification (spec §0 — "verify the gap before building it")

Confirmed the target gap **still exists** in the current tree (2026-07-12):

- `service/skills/` — **does not exist** (`find service -iname '*skill*'` → nothing; the only
  `skill` hits under `service/**.py` are the substring "skilled" in lyric/phonology prose).
- No `Skill` type / skill schema / skill harness anywhere in `ui/src` (`grep -rin skill ui/src
  --include=*.ts` → 0 schema hits). The agent layer has `commands.ts` (the `AGENT_COMMANDS`
  catalog of ~90 single commands) and `recipeVerifier.ts` (grades a finished recipe), but **no
  skill = template-of-commands abstraction** and **no per-skill precondition/postcondition harness**.
- The substrate the acceptance names already exists and is reusable:
  - **Engine mock** — `ui/src/bridge.mock.ts`: in-memory MoshOps contract impl exposing
    `mockExecute({command,args})`, `mockSnapshot()`, `__resetMockForTests()` (the exact seam the
    B1 harness asserts against; every existing `bridge.mock.*.test.ts` uses it).
  - **Contract test** — `ui/src/agent/commands.contract.test.ts`: parses the C++ dispatch table +
    per-handler `args.getProperty(...)` reads out of `src/moshops/MoshOps.cpp` (**read-only**) and
    asserts every catalog arg is actually read by its backend handler. B1 extends this same file.

**Verdict: `gapExists: true`.** Nothing to un-build; the harness/contract substrate is present and
ready to extend.

### Design (shape only — not implemented here)

Everything lands in **`ui/src/agent/`** (TypeScript), because the two things the acceptance ties
together — the engine mock (`bridge.mock.ts`) and the contract test (`commands.contract.test.ts`) —
both live on the TS side. One source of truth; no second catalog to drift.

- **`ui/src/agent/skills.ts`** — the schema + a one-entry reference catalog:
  - `SkillSlot = { name; type: "string"|"number"|"boolean"; required; desc?; enum?; min?; max? }`
    (typed slots; slot filling is schema-validated → invalid fills rejected *before* execution).
  - `SkillStep` — one MoshOps command whose args are templated from slots + prior-step outputs,
    with minimal **control flow**: a step may carry a `when(slots)` guard (conditional) and/or a
    `forEach(snapshot,slots)` expansion (bounded loop over snapshot entities). Every command a step
    emits **must** be a member of `AGENT_COMMANDS`.
  - `Skill = { name; description; slots; preconditions(snapshot,slots)->ok|reason;
    template: SkillStep[]; postcondition(before,after,slots,results)->ok|reason }`. Both
    precondition and postcondition are pure predicates over the mock snapshot (engine-mock-assertable).
- **`ui/src/agent/skillHarness.ts`** — `runSkill(skill, rawSlots, {execute, snapshot})`:
  (1) validate + coerce slots against the typed schema (fail → user-legible refusal, no mutation);
  (2) check `preconditions` against `snapshot()` (fail → refusal, no mutation);
  (3) resolve control flow and `execute()` each step in order;
  (4) assert `postcondition(before, after, …)`. Backend-agnostic (takes an `execute`/`snapshot`
  pair) so the same runner drives the mock now and the native bridge later (B2).
- **Reference skill (script-independent):** `lay_down_a_beat` — slots `style` (enum
  `trap|boom_bap`, default `trap`), `bars` (number 1–8, default 1), `bpm` (number, optional).
  Template: **conditionally** `set_tempo(bpm)` when `bpm` is filled, then `add_drum_pattern(pattern
  for style, bars)`. Precondition: none required. Postcondition (asserted on the mock snapshot):
  a new `drum` track exists carrying a clip whose `noteCount` matches the pattern, and tempo equals
  `bpm` when supplied. This exercises **all** acceptance ingredients (typed+enum+optional slots,
  control-flow guard, 2-command MoshOps template, precondition, mock-assertable postcondition) using
  only commands that already have mock parity (`set_tempo`, `add_drum_pattern`).
- **`service/skills/`** — reserved for B2/B3's service-side skill artifacts (eval sets, router
  candidates). To keep the B1 diff unambiguously **safe** and single-sourced, B1 adds **at most**
  `service/skills/__init__.py` (a `.py`, so still safe-bucket) as a one-line reserved-package
  marker — or leaves `service/` untouched entirely. **No non-`.py` file is created under
  `service/`** (that would leave the safe bucket).

---

## Exact gate(s) that prove it

All gates are **local** (spec §0 — GitHub Actions may be billing-blocked). Reuse existing gates; add
to them, do not invent a parallel harness.

1. **New harness test — `ui/src/agent/skillHarness.test.ts`** (vitest): runs `lay_down_a_beat`
   end-to-end against the engine mock (`mockExecute`/`mockSnapshot`, `__resetMockForTests()` in
   `beforeEach`, exactly like `bridge.mock.drumpattern.test.ts`). Asserts:
   - happy path: precondition passes → both steps execute → postcondition holds (drum track +
     matching `noteCount`; tempo == `bpm` when supplied; tempo untouched when `bpm` omitted — the
     control-flow branch);
   - **schema-invalid slot** (e.g. `bars: 99`, or `style: "jungle"` not in the enum) is rejected
     **before** any `mockExecute` (no snapshot mutation — proven by snapshot-equality before/after);
   - a deliberately-wrong postcondition predicate returns `{ok:false, reason}` (proves the assertion
     actually bites — RED-first per `test-driven-development`).
2. **Extended contract test — `ui/src/agent/commands.contract.test.ts`** (vitest): add a block that,
   for every `Skill` in the catalog and every command its `template` emits, asserts (a) the command
   is a member of `AGENT_COMMANDS`, and (b) it has a dispatch entry in the parsed `MoshOps.cpp`
   table (reusing the file's existing `parseDispatch`). This is the "catalog tied to the real
   command surface" clause. **Read-only** on `src/moshops/MoshOps.cpp` — the parse only, never a write.
3. **Full vitest suite green + no baseline regression:** `cd ui && npm test` — baseline ≈874 must
   still pass; the run grows by the harness + contract additions only.
4. **`tsc` clean:** `cd ui && npm run typecheck` (`tsc --noEmit` + the e2e project) — zero errors.
5. **Native gates unchanged *by construction*** (no C++, no `src/`, no `service` import path that
   `--selftest` exercises): `--selftest` ≈1254 ×3, Catch2 ≈494, `verify.py --gate`, Playwright e2e
   125/125 all stay at baseline. The lane touches none of their inputs; note this in the PR rather
   than re-running unless the review asks (the loop's gate will run them regardless).

**Acceptance mapped to gates:** "one reference skill passes end-to-end" → gate 1 happy path;
"contract test green" → gates 2–3; the schema (name + NL desc + typed slots + MoshOps template +
preconditions + mock-assertable postcondition) is exercised whole by gate 1.

---

## Files to change

- `ui/src/agent/skills.ts` — **new.** Skill schema + the `lay_down_a_beat` reference catalog.
- `ui/src/agent/skillHarness.ts` — **new.** `runSkill` (validate → preconditions → execute → assert).
- `ui/src/agent/skillHarness.test.ts` — **new.** Reference-skill end-to-end against the engine mock.
- `ui/src/agent/commands.contract.test.ts` — **edit (append a describe block).** Tie the skill
  catalog to the real command surface (every templated command ∈ `AGENT_COMMANDS` ∧ ∈ dispatch).
- `service/skills/__init__.py` — **new, optional** (reserved-package marker only; `.py` ⇒ safe).
  Prefer omitting it and reserving `service/skills/` for B2 unless the declared path must exist.

**Explicitly NOT touched:** any `src/**` (C++/engine), `cmake/**`, `relay/**`, `supabase/**`,
`scripts/auto-loop/**`, `CLAUDE.md`, specs `00`–`06`, `.github/**`. `src/moshops/MoshOps.cpp` is
**read** by the contract test, never modified.

---

## §0 rules binding this lane

- **One lane per worktree.** B1 only — no B2 skills, no router (B3), no unrelated agent refactor.
- **MoshOps is the sole mutation seam.** The harness mutates *only* via `execute()` (the mock's
  `mockExecute`, i.e. the `execute_command` contract) — never by poking mock state directly. Skill
  templates are lists of MoshOps commands; the swappable seam holds (the runner is backend-agnostic,
  so the identical skill drives the native bridge in B2).
- **Nothing a build reads lives under `~/Documents`.** No new caches/artifacts; if any are ever
  needed they go under `~/Library/Mosh/`. (B1 writes none.)
- **Build recipe** (only if a native build is needed for the native-gate note — it is not for B1):
  `cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache
  -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.
- **Info.plist TCC keys intact (MoshFixInfoPlist).** Untouched — no packaging/plist work here.
- **Do not touch parked threads** (`arena/`, SA3 LoRA branch, FMS spike worktrees, `PROGRAM_STAGE1`).
- **Never edit the loop's rulebook** — `scripts/auto-loop/{gate,classify,merge-one,discover,lib}.sh`,
  `CLAUDE.md`, specs `00`–`06`, `cmake/Dependencies.cmake` + version pins, `.github/**`. A diff
  touching any of these is a hard REJECT.
- **TDD (`test-driven-development`):** write the harness test RED first (the wrong-postcondition and
  invalid-slot cases must fail before the schema/harness make them pass).

---

## Merge bucket

**SAFE.** The entire diff stays in `ui/` (TS + tests) + optionally `service/**.py` + this `docs/`
plan — none excluded, none owner-taste-gated. The contract test only **reads** `src/moshops/
MoshOps.cpp`; it does not modify `src/`. No engine, `src/state`, auth/secret, packaging, `cmake`, or
relay path is touched. Per the README routing table this auto-merges on a green gate + APPROVE.

**Bucket guardrail (must hold or the lane re-routes to owner):** if implementation discovers it
needs to edit any `src/**` C++ (e.g. a missing command handler), STOP — do **not** cross into `src/`.
The reference skill is deliberately chosen to use only commands that already exist in
`AGENT_COMMANDS` **and** `MoshOps.cpp` (`set_tempo`, `add_drum_pattern`), so no engine change is
required. Any `src/` edit flips the bucket to **owner** and is out of B1's scope.

---

## Blocked-on-owner

**None.** B1 is script-independent (spec §7.B1 — does not need O2). No owner critical-path item
(O1–O6) gates it. Downstream only: **B2** (first ~10 skills) is blocked on **O2** (demo script) and
consumes this harness; **B3** (router) is blocked on **O2 + FS-T1**. B1 unblocks both by existing —
it does not wait on either.
