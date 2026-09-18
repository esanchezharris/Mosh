# Reconciliation — validation-first amendment, 2026-09-06

Delta record for [MOSH-HANDOFF-2026-09-06-v4-VALIDATION-FIRST](HANDOFF-2026-09-06-VALIDATION-FIRST.md)
(sha256 `4c174a13…`), executing its §11 output 1 and §2's "delta reconciliation, not another
open-ended audit".

**What this is:** a dated statement of where the repository actually stands, which of the new
handoff's obligations are retained, replaced or deferred, and what conflicts exist between it
and decisions already signed. **What it is not:** a new audit, a new framework, a revision of
anything signed, or permission for runtime work. It supersedes no document; where it disagrees
with an older document, the older document keeps its own date and this one records the delta.

Status vocabulary throughout, per handoff §0.3: **verified · reported-not-rerun · inferred ·
failed · absent · blocked**. Vendor features are separately labelled **reported** ·
**documented for the exact interface** · **demonstrated locally**.

---

## 1. Lineage — stated once

The new handoff names its baseline `H3 = MOSH-PIVOT-HANDOFF-2026-09-05-v3.md`. Every document
in this repository was instead written against `MOSH-PIVOT-HANDOFF-2026-09-05-v4.md`, which the
signed amendment cites as the source of the owner's settled decisions.

This is a naming difference, not a substantive one. A heading-level diff of the two files
differs in exactly one line — §14 is titled "Change log and residual disagreements" in v3 and
"Change log" in v4. **Every `[H3 §N]` citation therefore resolves 1:1 onto the v4 this
repository already used.**

| Document | Bytes | sha256 |
|---|---|---|
| v3 (the handoff's "H3") | 52,819 | `0299124a1617e4765e08a4063e68ab52aba63321fa228cc02033a23314557330` |
| v4 (cited by the signed amendment, vendored here) | 58,268 | `9102c302fdb606fa9b71cb93666172f7d045dccaece4a67e709240b9de097a52` |
| 09-06 validation-first amendment (vendored here) | 57,072 | `4c174a135d1f215e70fde12c07ce5d367c97abc72e5aa91466d3c7e8ece015fe` |

Hashes for v3 and v4 are from the bundle's own `MANIFEST.json`. **Adopt the shorthand
H3-as-v4 and do not re-litigate this.**

---

## 1.1 Owner decisions recorded this pass

Three decisions were taken in chat on 2026-09-06, in the session that produced this document.
They are recorded here verbatim because the rest of this pass depends on them and an independent
review correctly found them otherwise unverifiable from repository evidence. Each is
**reported (owner, chat 2026-09-06)** — the same standing as the step-1 acceptance recorded in
[STEP1-STATUS-2026-09-06.md](STEP1-STATUS-2026-09-06.md), and not independently corroborated by
any artifact.

| # | Question put to the owner | His answer, verbatim | Consumed by |
|---|---|---|---|
| **D1** | Song A's reverb is printed into separate audio tracks — there are no sends in the project. How should the experiment handle "a little less reverb"? | *"those printed reverbs are the bounced output of the sends"* | [MIX-PACKAGE-V0 §7.6](MIX-PACKAGE-V0.md) |
| **D2** | Condition A (specialized automated mixing, RoEx) needs a vendor account and uploading your unreleased song to a third party. How should I record it? | *Drop A from round 1* | §5.2 below |
| **D3** | A failed skill transaction can latch the session ledger and silently kill Moshi's deterministic lane. What runs first? | *Headless rehearsal decides* | §7 below |
| **D4** | Which listening range is "the hook"? | *"hook is measures 5-17 and 41-53"* — and, re-confirming D1, *"FX tracks really are the bounced"* | [MIX-PACKAGE-V0 §7.3](MIX-PACKAGE-V0.md) |

**D1 was re-confirmed on request, 2026-09-06**, after an independent review flagged it as the one
claim carrying weight without corroboration. It is a structural fact about the owner's own
Ableton session — that the printed `FX A-Reverb` / `FX B-Delay` tracks are the bounced output of
return sends — which no file in this repository can independently verify; what *is* verified here
is only its consequence, that `greg.mosh` contains no send buses. Asked a second time and
answered the same way, it is settled enough for revision 2 to rely on. If it later proves
otherwise, revision 2's target changes and this section is where to correct it.

D2 is close to a mechanical entailment of handoff §3.2, which already bars uploads and account
creation; the owner's answer settles the remaining question of whether to wait for A rather than
proceed without it.

**D4 — the hook (2026-09-06): "measures 5-17 and 41-53".** Unlike D1, this one is
**corroborated by the audio**. Counting bar 1 at t = 0 in 4/4 at 145 BPM, those four downbeats
fall at 6.621 / 26.483 / 66.207 / 86.069 s, and each lands 0.18–0.42 s before a *measured*
double-vocal edge (6.950 / 26.900 / 66.550 / 86.250 s) — every offset small and positive, which
is what a vocal entering just after the bar line looks like through a 50 ms envelope. So the hook
is the two doubled-vocal passages, and the owner's measure numbering and this pass's
measurements are now the same coordinate system.

It also **corrected the frozen spec**: the earlier E1 of 14.100–39.750 s began at bar ≈9.5, a
third of the way inside hook 1, which would have made "the vocal gets lost in the hook"
untestable. E1 and E2 were re-derived to contain a hook whole
([MIX-PACKAGE-V0 §7.3](MIX-PACKAGE-V0.md)) — the freeze earning its keep before a single
candidate existed.

---

## 2. Workspace (handoff §2 row 1)

| Field | Value | How established |
|---|---|---|
| Repository | `/Users/emiliosanchez-harris/Mosh`, shared gitdir `~/Library/Mosh/repo/ClaudeMosh.git` | `git worktree list --porcelain` |
| Worktree for this pass | `.claude/worktrees/step1-useful-edits` | — |
| Branch / HEAD | `claude/step1-useful-edits` @ `d20fcede24178f4eea1e7dfcb6dafb843d9c3e03` | `git rev-parse` |
| `origin/main` | `914faf856c1004eced9e85024f1b1a54ac25b195` | `git rev-parse origin/main` |
| Relationship | HEAD **is an ancestor of** `origin/main` — this branch is fully merged, 6 commits behind | `git merge-base --is-ancestor`, `rev-list --left-right --count` |
| Working tree | clean **at the start of this pass**; its only changes since are this pass's own documents | `git status --porcelain` |
| Governing instructions | `CLAUDE.md` (root and worktree), the native gate `scripts/auto-loop/gate.sh native <worktree> origin/main` | — |

Uncommitted work elsewhere: other linked worktrees under `~/Library/Mosh/worktrees/` and
`/private/tmp/` carry their own state. **This pass touches none of them.**

---

## 3. Current milestone (handoff §2 row 2)

**Step 1 "useful edits exactly once" is delivered, accepted and merged.**

| | Audit 1 (`ccdaab85`) | Audit 2 (`7b1d7423`) |
|---|---|---|
| Supported requests | 10 / 12 | **12 / 12** |
| Safety cases | 3 / 8 | **6 / 8** |
| Verdict | FAIL | **FAIL** |

Owner decision 2026-09-06 (option 1, recorded in [STEP1-STATUS-2026-09-06.md](STEP1-STATUS-2026-09-06.md)):
accepted as delivered at `1453a647`, with the carried items named rather than waived. Merged as
PR #698 → `914faf85`; PR #697 (v3 shell) merged just before it as `43ad4467`. No open PRs remain.

**Carried items, restated verbatim and not re-scored:**

1. An idempotent replay of a committed envelope **opens a second undo transaction**, so one
   undo no longer returns the pre-edit state. This is the one acceptance criterion knowingly
   unmet and the reason audit 2 is a FAIL.
2. F6 stays unknown — not inducible through the companion or GUI surface.
3. F4 stays half exercised — the abort landed before any command ran, so "an applied step stays
   one undo unit" was never tested.
4. One SIGSEGV in JUCE main-menu teardown stays **unattributed**. If it recurs, attribute it
   before releasing.
5. The ten engine quirks filed in [BRIEF-STEP1 §3](BRIEF-STEP1-USEFUL-EDITS-EXACTLY-ONCE.md)
   remain open and unranked except for item A below.

**Step 2 is open at item A** ([BRIEF-STEP2-A-UNRESOLVED-TRANSACTION-BLOCK.md](BRIEF-STEP2-A-UNRESOLVED-TRANSACTION-BLOCK.md)):
any non-terminal record in `<sessionDir>/agent-transactions.jsonl` at startup — **including a
transaction that merely failed and said so** — latches `unresolvedTxnIds_`, and `cmdBatchBegin`
then refuses every transactional skill batch for the life of that session directory, with no
snapshot field naming it and no UI route out once the recovery banner is gone.

### 3.1 The handoff's named default task is already complete

Handoff §2 names, as the "default next implementation task, only when still necessary", *"the
existing router/exactly-once/readback/undo task for one useful builtin edit and the vocal reverb
send [H3 §12]"*. That is step 1, above. §2's own fallback therefore governs:

> "If the required machinery already works, the next task is the experiment—not inventing
> another implementation milestone."

Recorded here so no future reader restarts it. See §7 for what this pass selects instead.

---

## 4. Regression evidence — reused, not rerun (handoff §2 row 3)

Handoff §2 says rerun only affected or genuinely unverified paths. Nothing in this pass changes
runtime behaviour, so nothing was rerun. Carried forward:

| Evidence | Result | Where |
|---|---|---|
| `Mosh --selftest` | 3538 / 3538 checks | audit 2 excerpt, `evidence/step1-7b1d7423/` |
| `Mosh --selftest-undo` | 18 / 18 | same |
| Send/fader undo reproducer | `undo_send_immediate` −12, `undo_fader` −10, reopen equal | `repro/step1-fader-send-undo.jsonl` |
| Mix Package fixture | copies byte-identical; save/reopen byte-identical; constant +2-sample render lag | [MIX-PACKAGE-V0 §5](MIX-PACKAGE-V0.md) |
| Native gate at `d20fcede` | 205 eval rows, 154 pass, **0 FAIL**, GATE: PASS | commit message of `d20fcede` |
| CI on the merge commit | success | run 34023063866 |

**Genuinely unverified — do not treat as passing:**

- The measured recording-recovery contract (completed takes, committed frames, lost tail).
  **absent.** Needs the real crash test; scheduled as step 3.
- F6 (a command landing inside an open skill transaction). **absent.**
- F4's second half (an applied step staying one undo unit). **absent.**
- The one unattributed SIGSEGV. **absent.**
- Whether the merged tree behaves as audited: it differs from audited `1453a647` by exactly one
  non-doc file, `scripts/daw-conformance/conformance.py` (`d20fcede`), which **no independent
  audit saw**. The native gate covered it; an auditor did not. See conflict C5.

---

## 5. Dependencies — exact-interface feasibility (handoff §§2 row 4, 6)

Per §6, this updates the existing ledger rather than commissioning a landscape report.
Availability, musical utility and embeddability are scored **separately**; a tool can be
available and musically useless, or musically useful and unembeddable.

| Route | Exact interface | Availability | Musical utility | Embeddability | Verdict |
|---|---|---|---|---|---|
| **Mosh builtin effects** | `load_builtin {compressor, reverb, delay, lowpass, highpass, eq}` at `src/moshops/MoshOps.Plugins.cpp:203`; `set_plugin_param` normalised 0–1 at `:835`, one undo + immediate readback | **demonstrated locally** | **not measured** — no by-ear judgment exists on this material | native, no question | **available for a bounded experiment** |
| **Owner-installed plugins** | `load_plugin` at `:698`; catalog enumerated by `list_plugins` at `:153` (1,198 entries on this machine — figure carried from [CAPABILITY-AUDIT-2026-09-05](CAPABILITY-AUDIT-2026-09-05.md), `reported-not-rerun`; the UI cap was raised to 4096 in step 1) | **demonstrated locally** | not measured | **hosted, never bundled** (amendment clause 8) | **available**, mapping only when a tested revision needs it |
| **SA3 (condition G)** | local MLX at `~/AI/stable-audio-3/optimized/mlx`; `render_layer` at `MoshOps.Generative.cpp:612` with `mode ∈ {reimagine, generate, transform, sing}`, `prompt`, `seed`, `nl`, `colors[]`, `loras[]`, `strength`, `coverage`; gated by `MOSH_ENABLE_SA3`; `SA3_MLX_DIR` set in `service/run-reimagine.sh:12` | **demonstrated locally** — no network, no cost | not measured on this song | native job queue | **available, constrained** — see 5.1 |
| **ffmpeg loudness** | `/opt/homebrew/bin/ffmpeg`, filters `ebur128` (ITU-R BS.1770, true peak) and `loudnorm` | **demonstrated locally** | measurement only, never selection | already installed | **available for a bounded experiment** |
| **RoEx (condition A)** | consumer product, API, desktop product and SDK are **four separate surfaces**; a feature in one establishes nothing about another | **blocked** | unknown | unknown | **blocked** — see C4 |

### 5.1 SA3's three real constraints

Recorded because they bound what condition G can possibly demonstrate, and because handoff §6
forbids copying R3's generic capability table in place of the installed combination:

1. **Sub-region renders do not modify the clip.** Corrected from source 2026-09-06: a sub-region
   render is rejected from in-place apply (`MoshOps.Generative.cpp:1183`, `:1232`) and lands as a
   **new clip on a separate "Neural Renders" track** (`:2283-2371`). Only a **whole-clip** render
   auto-applies in place (`:1070-1078`), capturing `originalSourceRef` (`:1199-1200`) so
   `reset_render_layer` (`:1298`) restores the original. Condition G was redesigned to whole-clip
   accordingly — as first written it would not have re-imagined the beat at all.
2. **The 8-second figure is not a cap.** `SA3_SECONDS` (default 8.0) is the initial latent grid;
   retargeting is RoPE-free and the ceiling is `MOSH_SA3_MAX_CONTIGUOUS = 240 s`
   (`service/sa3/engine.py:41-42`). At 92.69 s the Beat may render contiguously and seamlessly.
   Whether it does, or falls back to `coverage: "stitch"` (independent windows crossfaded at 1 ms,
   `service/clip_coverage.py:51-59`), is **measured, not assumed**. **G is a re-imagination, not
   a mix** either way.
3. **The audio path is 44.1 kHz / 16-bit.** `stageWavRegionAt44k` (`:182`) resamples and truncates
   to 44.1 k/16-bit stereo; a conventional treatment never leaves 48 kHz / 32-bit float. Any blind
   "G sounds different" is confounded unless that is separated — hence the G-STAGING-NULL output.

### 5.2 Why RoEx is blocked, narrowly

Two independent reasons, neither of which is an audio-quality judgment:

1. It requires a vendor account and sign-in. The assistant may never create accounts or log in.
2. It requires uploading the owner's **unreleased** song to a third party. Handoff §3.2 grants
   no upload authorization, and this is a rights and consent decision only the owner can make.

**Owner decision D2 (§1.1): condition A is dropped from round 1.** Per handoff §7.2 a blocked
condition stays blocked — it is never quietly filled in after C and G have been heard, and no
substitute mixer silently takes its place. Unblocking it needs a new dated authorization naming
both reasons.

---

## 6. Contract, census and counters (handoff §§2 row 5, 3.1)

### 6.1 Signed status

[docs/CONTRACT-AMENDMENT-2026-09-07.md](../CONTRACT-AMENDMENT-2026-09-07.md) is **signed by the
owner 2026-09-05 (in chat), effective 2026-09-07**, nine clauses. Handoff §3.1 asks whether the
amendment was actually signed rather than merely recommended: **it was.** It is not edited by
this pass; changing it requires a new signed amendment.

### 6.2 Amendment map — handoff §1 row by row

| Handoff §1 row | Repository disposition | Evidence | Action |
|---|---|---|---|
| Useful edits exactly once; IDs/state; readback; undo; save/reopen — *keep, finish, do not restart* | **Satisfied and closed.** Delivered, twice audited, accepted, merged | §3 above | None. Carried items restated, not re-scored |
| Aligned audio handoff, pristine recordings, durable takes, recovery, rights review — *keep* | **Partly satisfied.** Handoff and package done; **recovery contract unmeasured**; the rights ledger of record lived outside the repo until this pass | [MIX-PACKAGE-V0](MIX-PACKAGE-V0.md); §4 above; §8 below | Keep. Recovery stays step 3 |
| Custom observation → LLM mix-decision experiment — *defer as a prerequisite* | **Already gated harder than asked**: step 4 requires a verified ≥25 census that does not exist | [PLAN §3](PLAN-90-DAY-2026-09-07.md) step 4; §6.3 below | Adopt (costless). Preserve step 4-early — it is an existing-facilities probe, not the observation build |
| Mapping a few controls on one or two installed effects — *keep when a tested revision requires it* | **Consistent.** Step 1 shipped the vocal-reverb macro; broader mapping already sits in the cut order | BRIEF-STEP1 slice 7; PLAN cut order | None |
| SA3 convenience postponed — *split evaluation from integration* | **Adopt.** Evaluation is available now at zero cost; integration stays the conditional ≤2-day task | §5 above; PLAN §3 step 6 | Edit PLAN step 6 to name the split |
| Repeated whole-mix regeneration as ordinary correction — *do not adopt* | **Already prohibited** | amendment clause 6; `CLAUDE.md` invariants | None |
| R2's immutable layered retention — *adopt boundaries, do not prebuild* | **Already the practice**: project copies, `greg-correction-copy.mosh`, `mixpackage.json`, the byte-identical save/reopen fixture | MIX-PACKAGE-V0 §§1–2, 5 | None. Clause 5 defers new databases until 25 |
| R3's compiler, take database, six-week roadmap, 288-output pilot — *not adopted* | **Already a non-goal** | amendment §3 non-goals | None |
| R1's personalized detector + duplex + full data pipeline — *not adopted wholesale* | **CONFLICT** | C1 below | Record; do not re-gate |
| Learned taste/reward, critic ranking, flywheel expansion, external pilot, replatform — *out of scope* | **Already out of scope** | amendment §3 | None |
| Market language: drop H3 §2.1's categorical absence claim | **No-op.** No pivot document, the amendment, or `CLAUDE.md` asserts it | grep | Recorded so nobody goes looking |

### 6.3 Census — stamped

**Stamp: 2026-09-06 · HEAD `d20fcede` · this machine · `python3 docs/pivot-2026-09/evidence/2026-09-05/census.py` from the repo root.**
Result equals the frozen derivation in [CAPABILITY-AUDIT-2026-09-05 §3.1](CAPABILITY-AUDIT-2026-09-05.md);
no drift. **Any document needing these numbers links here. Only this section is updated; the
audit's table stays frozen as the derivation.**

| Fact | Value |
|---|---|
| Counted verdict rows | **14** — flywheel 2, r2 6, r3 3, r4 3 |
| Straddling (flagged, not renamed) | **8** — r1's seven-candidate group row, plus `r3c-labkit` with zero notes |
| Range, loose to strict | 14–22 / 10 |
| **Mixing rows** | **0** |
| **Recording rows** | **0** |
| **Blind rows** | **0** |
| Rule 2 gate | **25 — not met under any reading** |

**All 14 counted rows are composition-lane.** Handoff §3.1 and amendment clause 4 both hold that
historical composition rows may count toward the infrastructure gate but are **not mixing
evidence**. Consequences, stated rather than implied:

- No new audio-analysis pipeline, event-collection service, label schema, database or dashboard
  is authorized.
- PLAN step 4 cannot open.
- The arithmetic: **11 more counted rows** are needed; the only qualifying producer is the weekly
  correction filed through `scripts/produce/capture-correction.py` at ≤1 per week; the plan
  horizon ends 2026-12-05. **Step 4's window will not open this quarter at the current rate.**
  That is an expectation to plan around, not a surprise to discover in week 9.

**The 26 `dpo-pairs` rows count zero.** `~/Library/Mosh/dpo-pairs/pairs-*.jsonl` holds 26 rows,
**all** with source `agent-loop`: no owner rating, no meaningful note, not in the `meta.json`
format amendment clause 5 fixes as the row format. They are not verdict rows. `census.py` does
not scan that directory, and that exclusion is a **documented decision, not an oversight** —
recorded here so nobody later "discovers" 26 rows and walks them toward the gate.

**Zero felt-wrong rows, and why — verified from source.** The Cmd+Shift+F correction surface is
fully implemented (`ui/src/ui/FeltWrongDialog.tsx` → `ui/src/agent/feltWrong.ts:buildFeltWrongRow`
→ bridge `archive_pair` → `service/bestofn/runtime.py:archive_append`) and has produced no rows.
The reason is a mount gap: `FeltWrongDialog` is rendered only in `ui/src/AppLegacy.tsx:110` and
`ui/src/v2/AppV2.tsx:69`, and **not** in the default Pro Tools shell — while that shell does call
`useKeyboardShortcuts()` (`ui/src/protools/AppProTools.tsx:58`), which dispatches `felt_wrong`
(`ui/src/hooks/useKeyboardShortcuts.ts:240`). So in the default shell the store flag flips and
nothing appears. **verified (source); one runtime check would close it** — launch the default
shell, press Cmd+Shift+F, observe.

This is **not a Rule 1 miss**: the correction path of record is `capture-correction.py`, which
works. Cmd+Shift+F is a second, separate taste-capture lane. Whether an unreachable surface in
the default shell counts as a *blocked surface* under amendment clause 4 is the owner's call.
**Not fixed in this pass** — it is an addition, and the removal rule was waived only for clause 9.

### 6.4 Counters

| Named loop | Consumed / cap | Status |
|---|---|---|
| Produce lane (`PRODUCE_VERSION` = 4) | 4 of 6 | Parked by amendment clause 3. Not reset, not inherited |
| Flywheel lab (`gen001`, `mac-r0-001`) | 2 rounds | Superseded by amendment clause 2; history preserved |
| Recording experiments | 0 named, 0 consumed | None exist |
| Mixing experiments | 0 named, 0 consumed | None exist |

The §7 comparison must be **named before its first round** and gets a fresh six-round counter.
Renaming a backend, a song or an experiment does not reset an exhausted hypothesis.

Verification: `grep -n 'PRODUCE_VERSION' ui/src/agent/loop/producePrompt.ts` must still read 4;
a read-only recount of `dpo-pairs` rows and distinct `source` values must match §6.3.

### 6.5 Conflicts recorded (handoff §3.1: record before proceeding under a changed rule)

**C1 — Recording and voice sequencing.** Handoff §9.1 proposes a shadow transcript-vs-audio
study with no transport authority as the first recording experiment, and §9.2's capacity rule
demotes natural interaction to one of three optional experiments *after core gates*. The
repository holds a **signed** owner decision (amendment clause 9) that the minimal hold-to-talk
path is built this quarter as an addition, with the removal rule explicitly waived, running in
parallel from week 1. **The signed contract governs.** The shadow study is an unfunded proposal
and does not consume clause 9. The two are safety-compatible — always-listening remains a
non-goal, a physical stop is always present, the mode is hands-free of the mouse only — so the
conflict is sequencing and budget, not safety. Changing it requires a new signed amendment.

**C2 — The named default task is complete.** Handoff §2's default next implementation task is
step 1, which is merged. Moot; §2's own fallback applies. See §3.1.

**C3 — Two experiments competing for one budget.** Handoff §7's C/G comparison and the
repository's existing step 4-early judgment probe ask different questions but draw on the same
owner listening hours and the same six-round cap. **Owner decision required**: which is named
first, and whether they share one counter or take two. **Not resolved here.**

**C4 — RoEx.** Nominated by §6; §3.2 grants no account, budget, upload or terms acceptance.
Verdict `blocked`, two narrow reasons (§5.2). Consumer ≠ API ≠ desktop ≠ SDK. Do not broaden the
shortlist.

**C5 — Merge authorization is unrecorded.** [STEP1-STATUS](STEP1-STATUS-2026-09-06.md) states
merging is a separate decision needing the native gate, and that nothing had been pushed or
merged. The merge has since happened (PR #698 → `914faf85`) and the gate evidence exists
(205/154/0, GATE: PASS at `d20fcede`). **No owner authorization line for the merge exists in the
repository**, and the merged tree differs from audited `1453a647` by one non-doc file that no
independent audit saw. Flagged, not resolved.

**C6 — Capacity presentation.** Handoff §10 restates the inherited "20 focused engineering
hours/week (≈16 + 4)". [PLAN §1](PLAN-90-DAY-2026-09-07.md) carries the owner-corrected ≈24 h/week
total with owner-role hours a **subset**, not an addition, and effective engineering ≈16–18 h.
**PLAN §1 governs**; the 20 h figure is inherited, not measured.

**C7 — New files against "no new framework".** Handoff §11 forbids another documentation
framework. Three new files exist in this pass. Each records the existing document considered and
rejected: this one (the amendment is signed, the audit is pinned to `0da6c638`, STEP1-STATUS is
milestone-scoped, PLAN is designed to be re-windowed), the rehearsal brief and its audit prompt
(the repo's established brief/prompt pairing). Everything else is a section-level edit.

**C8 — Documents cited as authoritative but not durable.** See §8.

---

## 7. Next action — exactly one (handoff §§2 row 6, 11 output 4)

**Selected: [BRIEF-REHEARSAL-SONGA-2026-09-06.md](BRIEF-REHEARSAL-SONGA-2026-09-06.md)** — a
headless rehearsal of the Song A revision sequence and the SA3 region pre-flight. No owner
listening time. **Not a round** of the named experiment. Its frozen decision rule authorizes
exactly one successor:

- ledger stays terminal across a restart **and** one undo restores **and** a region render
  splices → **run round 1** of `mix-2026-09-songA-first-pass`, with one fresh session directory
  per round as standing procedure;
- otherwise → **repair items 1–2 only** of [BRIEF-STEP2-A](BRIEF-STEP2-A-UNRESOLVED-TRANSACTION-BLOCK.md)
  first.

**Alternatives considered and why they were not selected.**

*Run the experiment immediately.* Handoff §2 favours it, and the two conditions that produce the
primary deliverable — a conventional treatment, and SA3 — never touch the transactional lane.
But the revision arm, which is the half that decides whether Mosh is worth integrating, runs
entirely through the deterministic balance lane, and that lane opens a transaction per move. The
experiment also deliberately relaunches the app ("save, close, reopen" is written into the
protocol), which is exactly item A's trigger condition. The failure mode is not "it stops
working" — it is a **false result**: the owner sees a bare refusal, and a ledger latch gets
recorded as a musical or routing failure.

*Repair item A first.* Safest, but it spends the one bounded repair cycle and an unknown number
of hours before a single musical fact exists, which is precisely what the validation-first
amendment exists to prevent.

The rehearsal dominates both: it costs no owner time, it decides empirically rather than by
argument, and it must close the SA3 region question regardless of which branch wins.

---

## 8. Source register and durability

**The rule this pass adopts:** *a repository document may cite an external document as
authoritative only if the citation carries an immutable identity — absolute path plus sha256 plus
version — or the document is vendored here.*

| Document | Disposition |
|---|---|
| `RESEARCH_AND_VERIFICATION.md` v2 (27,265 B, sha256 `4d05dfe5a799339551e77686ae335eb64cbcbe2749240b38da182e8659b12058`) | **Vendored verbatim** to [../references/RESEARCH_AND_VERIFICATION-v2-2026-09-04.md](../references/RESEARCH_AND_VERIFICATION-v2-2026-09-04.md). Signed clause 8 names it the license ledger of record and it existed only in `~/Downloads`, which is volatile. Same genre as the verbatim upstream copies in `docs/licenses/`. Vendoring does not re-verify: its own "recheck 2026-09-04" caveat travels with it |
| `MOSH-PIVOT-HANDOFF-2026-09-05-v4.md` (sha256 `9102c302…`) | **Vendored verbatim** to [HANDOFF-2026-09-05-v4.md](HANDOFF-2026-09-05-v4.md). Signed amendment §0 cites it as the source of the owner's settled decisions |
| `MOSH-HANDOFF-2026-09-06-v4-VALIDATION-FIRST.md` (sha256 `4c174a13…`) | **Vendored verbatim** to [HANDOFF-2026-09-06-VALIDATION-FIRST.md](HANDOFF-2026-09-06-VALIDATION-FIRST.md). This document's dispositions cite it densely |
| `~/AbletonMONSTER/METHODOLOGY.md` — sha256 `9a822205d0d3d0699cb9d85838b3fa6fe833d2a8a896dd4a8e0060309c819bff`, repo HEAD `09e3df4` | **Not vendored.** It is another project's living document; the amendment deliberately gives it a pointer rather than an edit; clause 7 already maps all seven non-negotiables into the signed Mosh contract, so the dependency is citational, not operational. **Two owner action items** (§8.1) |
| R1 / R2 / R3 research reports | **Not vendored.** Identities recorded from handoff §13: `d25efb47…`, `3bce7d4f…`, `55746f7b…`. Verified this session: these hashes match `deep-research-report-2.md`, `-3.md`, `-4.md` in `~/Downloads` |
| The rest of the handoff bundle (history, drafts, sources) | Not vendored — scope creep. `MANIFEST.json` records every hash |

### 8.1 Owner action items (outside this pass's authority)

1. `~/AbletonMONSTER/METHODOLOGY.md` has an **uncommitted** working-tree modification — the
   "Pointer — Mosh contract amendment 2026-09-07" paragraph (`git status` shows ` M`). Commit it.
2. That repository has **no remote**. Give it a remote or a backup; a signed Mosh clause cites it.

---

## 9. Not run, blocked, or unknown

Nothing below is a defect claim; each is an honest gap.

| Item | Status | Closes when |
|---|---|---|
| Any musical judgment on Song A | **not run** | Round 1 of the named experiment |
| RoEx / any specialized automated mixing | **blocked** | A dated owner authorization covering account access and third-party upload |
| ~~Whether a sub-region SA3 render splices or replaces~~ | **answered from source 2026-09-06** — neither; see §5.1. What remains is whether the whole-clip `reset_render_layer` round-trip restores byte-for-byte | The rehearsal brief |
| ~~Whether `--run-script` can open an existing `.mosh` and drive `batch_begin`~~ | **closed 2026-09-06** — it can | — |
| Whether declined utterances write ledger records | **unknown** | The rehearsal brief. Material: this experiment produces declines by design |
| SA3 wall time / memory for a stitched multi-window region | **not measured** | The rehearsal brief |
| Provenance of the built binary used for any candidate | **absent** | Recorded in the freeze manifest, or rebuild from the frozen SHA |
| The measured recording-recovery contract | **absent** | Step 3's real crash test |
| F6, F4's second half, the unattributed SIGSEGV | **absent** | Step 2 |
| Whether Cmd+Shift+F is a blocked surface under clause 4 | **owner's call** | One runtime check plus his classification |
| ~~Which listening range is "the hook"~~ | **closed 2026-09-06** — bars 5–17 and 41–53 (D4) | — |
| ~~Whether the printed FX tracks are the bounced send returns~~ | **closed 2026-09-06** — confirmed (D1) | — |
| C3: which experiment is named first, and one counter or two | **owner's call** | — |

---

## 10. Handoff §11 coverage

| Required output | Carried by |
|---|---|
| 1. Adoption and current-state delta | **This document**, §§1–4, 6 |
| 2. Feasibility and experiment record | §5 here (exact-interface matrix) + [MIX-PACKAGE-V0 §7](MIX-PACKAGE-V0.md) (frozen Song A specification) |
| 3. Re-estimated dependency plan | [PLAN-90-DAY-2026-09-07.md](PLAN-90-DAY-2026-09-07.md), re-reconciled 2026-09-06 |
| 4. Exactly one next execution brief + independent review prompt | [BRIEF-REHEARSAL-SONGA-2026-09-06.md](BRIEF-REHEARSAL-SONGA-2026-09-06.md) + [AUDIT-PROMPT-REHEARSAL.md](AUDIT-PROMPT-REHEARSAL.md) |

| Required field (§11 closing) | Resolved |
|---|---|
| Repository / branch / SHA | §2 |
| Current task | §3, §7 |
| Census | §6.3 |
| Signed amendment | §6.1 |
| Song A paths | MIX-PACKAGE-V0 §§6–7 |
| Backend identities | §5 |
| Permissions | §5.2, and the brief's own boundaries |
| Output location | The brief |
| Exact existing verification commands | §4, §6.3, the brief |

Nothing above was fabricated to make a brief appear executable. **Documentation passing is not
code or musical value passing.**

## Addendum — owner mandate, 2026-09-08

The owner authorized all tightly related repairs needed to close Producer v0 S3 on
the selected bounded agent path, followed by model-independent scripted S4.
Earlier diagnostic-only, one-repair and stop-for-another-prompt restrictions are
superseded only for this milestone. Historical verdicts, the frozen minimal rack,
owner-data protection and normal merge approval remain intact. No push, merge,
installation, deployment, live model calls or owner-audio processing is authorized.
The single implementation checkpoint is
[S3-S4-EXECUTION-2026-09-08.md](S3-S4-EXECUTION-2026-09-08.md).
