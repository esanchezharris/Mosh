# RFC 005 — Classic-shell decision (freeze-and-sever vs port-and-archive)

- **Status:** draft — decision pending owner
- **Decided:** — (pending)

## Problem

Mosh ships two frontend shells: the v2 shell (the default, `ui/src/v2/`) and the classic
shell (`ui/src/AppLegacy.tsx` + its exclusive `ui/` subtree), selected by the `uiShell`
setting. The B-PR0 classic-shell audit (merged as PR #495) established, with file:line
evidence, that classic's exclusive surface is small but **not free**:

- The effective classic-only surface is 17 modules / ~1,285 LOC, plus the ~800
  classic-only lines of `ui/src/ui/Arrange.tsx` whose 4 presentational exports v2 still
  imports — [INVENTORY §1](../classic-audit/INVENTORY.md#1-module-graph-diff).
- Classic-only files were still taking commits as recently as 2026-07-25
  (INVENTORY §1, maintenance-cost datapoint).
- Every reachability probe carries the hand-maintained `CLASSIC_ONLY_MODULES` boundary in
  [`ui/src/agent/uiReachability.test.ts`](../../ui/src/agent/uiReachability.test.ts), whose
  false-positive mode has already hidden a real v2 bug once (see the boundary note in
  CLAUDE.md's mouse-reachability directive and INVENTORY §1).
- The audit itself found three stale comments describing classic/v2 responsibilities that
  no longer hold (INVENTORY §2 rows 10 and 12;
  [SPEC-MIGRATION §2](../classic-audit/SPEC-MIGRATION.md#2-reachabilitymd-selector-scan)) —
  the repo's "written reasons age" failure mode, live in this exact seam.

What is missing is a **decision**: keep paying for classic, or retire it — and if retiring,
what must be ported or migrated first. The audit deliberately did not decide
([RECOMMENDATION](../classic-audit/RECOMMENDATION.md): "THE DECISION IS THE OWNER'S").
This RFC frames that decision; it is a draft until the owner calls it.

### Evidence base (cite, don't duplicate)

The three audit documents are the source of truth for every number and claim condensed
below; this RFC intentionally restates none of their tables:

- [`docs/classic-audit/INVENTORY.md`](../classic-audit/INVENTORY.md) — the module-graph
  diff (raw + effective boundary), the 13-row classic-unique behavior table with verdicts,
  and the settings inventory.
- [`docs/classic-audit/SPEC-MIGRATION.md`](../classic-audit/SPEC-MIGRATION.md) — the
  per-spec e2e migration bill and the REACHABILITY.md selector scan.
- [`docs/classic-audit/RECOMMENDATION.md`](../classic-audit/RECOMMENDATION.md) — the
  decision memo: what the evidence establishes, the two options, and the rules proposed
  to hold under either.

### The three verified port candidates

Where classic is strictly better for a mouse-only producer today (INVENTORY §2 rows 4, 6, 7;
RECOMMENDATION point 3):

1. **Inline take lanes in the arrangement** — v2 has takes only in the Inspector Takes
   tab; the gap is already recorded as presentation-only in
   [`ui/src/agent/commandClassification.ts`](../../ui/src/agent/commandClassification.ts)
   (see INVENTORY row 4 for the line cite).
2. **Snap toggle + grid-division control** — verified real gap: nothing in `ui/src/v2/`
   calls `setSnap`/`setSnapDivision`, so **v2 currently has NO mouse control to change
   snap** — a mouse-only v2 user is locked to the store defaults (snap on, 1/4).
3. **Finer zoom** — v2 has only the coarse 3-stop `ZoomToggle` fit vs classic's
   continuous zoom slider. Lower severity than #2 (a coarse affordance does exist).

### The two items needing an explicit owner verdict

Porting these **contradicts v2's stated design position** (single Mosh-native design,
capped-centered stage), so they are product calls, not mechanical ports (INVENTORY §2
rows 1 and 3; RECOMMENDATION point 4):

- **All-tracks Mixer console** — v2's per-track Inspector Mix tab + MasterCard is a
  per-track superset, but the side-by-side all-tracks *glance* has no v2 equivalent.
- **Resizable/persisted panels** — classic's DockShell resizes and persists panel sizes;
  v2 has boolean push-docks only, deliberately.

### The e2e migration bill

Per [SPEC-MIGRATION §1](../classic-audit/SPEC-MIGRATION.md#1-classic-booted-specs--the-migration-bill):
**10 of the classic-booted specs exercise SHARED surfaces** (the generative-drawer lane:
compile, felt-wrong, freeze-layer, hands-free, lora-rack, rave-insert, reimagine-midi,
sustain-toggle, transform, plus most of drum-pattern) and are today the **only** Playwright
proof of those backend behaviors — they migrate by re-booting in v2 with selector swaps.
`producer-loop.spec.ts` needs a genuine v2 journey twin authored; `audio-routing.spec.ts`
needs a rewrite, not a re-boot; four specs die with the classic-only axis. The proposed
**ratchet rule**: *the classic `boot()`/`bootRedesign()` spec count may only decrease, and
only via a migration PR that lands the v2 twin proving the same backend behavior in the
same diff.* No silent deletions.

### Settings dispositions

Per [INVENTORY §3](../classic-audit/INVENTORY.md#3-settings-inventory):

- **`uiShell`** — keep while classic exists (it is the routing switch and v2's escape
  hatch back); on sever, retire the enum + the "Switch to Classic UI" TopBar item +
  `shellQuery`/`shellFlag` plumbing as its own PR.
- **`redesignShell`** — freeze-with-classic; on sever, simplify the one shared guard
  (`store.ts` `webrtc_signal` gate — line cite in INVENTORY §3) to the v2 check and retire.
- **`layout`** — freeze-with-classic; applied only by `AppLegacy.tsx`, retire with classic.
- **`skin`** — freeze-with-classic; already pinned to `mosh` whenever v2 is active, retire
  with classic (together with the classic-only template axes).

`theme` is explicitly NOT classic-coupled and out of scope (INVENTORY §3 note).

## Invariants touched

- **Swappable seam — preserved.** Everything in scope is frontend-only. Neither option
  adds, removes, or changes any MoshOps command or any snapshot/event; the backend is
  byte-uninvolved. The e2e migration exists precisely to keep the Playwright proof of
  *shared backend behaviors* alive across the shell change.
- **Everything is reachable by mouse — strengthened (either option).** The audit surfaced
  a live v2 mouse gap (snap control, port candidate #2). Under either option, each of the
  five gap/verdict items ends as a landed v2 PR or a written owner "won't port" — no gap
  is dropped silently. A sever additionally retires the `CLASSIC_ONLY_MODULES` boundary,
  removing its documented false-positive mode.
- **One mutation path, one undo system, tier wall, threading, cache fingerprint — not
  touched.** Stated per the template: none of these are in scope.

## Options considered

Both options are condensed from [RECOMMENDATION](../classic-audit/RECOMMENDATION.md);
neither is marked CHOSEN — **the decision is pending the owner**, and a hybrid (e.g. port
a subset of the three candidates, drop the rest with a written "won't port") is a valid
call.

### Option A — freeze-and-sever

Declare classic frozen now (no features, no polish; bugfix only if it corrupts shared
state), pay the e2e bill, then delete in stages: the exclusive modules, the classic
majority of `Arrange.tsx` (after re-homing the 4 presentational exports), the
`redesignShell`/`layout`/`skin` settings + TemplatePicker, the classic boot helpers, and
finally the `uiShell` enum + routing + the `CLASSIC_ONLY_MODULES` boundary.

- **For:** smallest total work; removes the boundary machinery and a whole class of stale
  comments; consistent with v2 being the shipped default and with the deliberate v2
  rewrites the audit verified; the three port candidates can still be built in v2 later,
  on demand, without keeping classic alive as their reference.
- **Against:** the take-lane / snap / zoom gaps ship unfixed with no working reference
  implementation left in-tree (git history only); the two owner-verdict behaviors
  (console view, resizable panels) get decided by default — dropped.

### Option B — port-and-archive

Port first, then archive: land the three port candidates in v2, get the owner's verdict
on the console view + resizable panels and port those if wanted, migrate the e2e bill,
and only then delete classic in the same shape as Option A.

- **For:** no producer-visible regression at sever time; the ports are written while the
  classic reference still runs side-by-side (the cheapest time to write them); the owner
  verdicts get made explicitly instead of by deletion.
- **Against:** more work before the payoff; risks the freeze eroding (classic kept
  receiving drive-by changes while the audit ran); the port list can grow by discovery,
  delaying the sever indefinitely without a hard cap.

## Decision

**PENDING OWNER — choose an option (or a hybrid) and flip this RFC to accepted; the
Migration section then becomes the plan.**

Concretely, the owner's call reduces to five items (RECOMMENDATION, "What this memo does
NOT decide"): console mixer view, resizable panels, inline take lanes, snap control, fine
zoom. Everything else — the freeze, the e2e migration, the staged sever, the settings
retirements — is the same work under either option and is already sequenced below.

## Migration / PR plan

Change-classes per [`scripts/auto-loop/classify.sh`](../../scripts/auto-loop/classify.sh):
every PR below touches only `ui/` and/or `docs/`, so every PR is class **`cheap`**
(auto-merge on green gate). The owner's control point is this RFC's acceptance — the
stages do not start until the Decision section above is filled in.

Rules that hold under **either** option (adopted from RECOMMENDATION):

1. **The ratchet:** the classic `boot()`/`bootRedesign()` spec count may only decrease,
   and only via a migration PR that lands the v2 twin in the same diff.
2. **Freeze is a tested property, not a promise:** classic-only modules (the INVENTORY §1
   list) take no feature commits after the freeze date; any diff touching them must cite
   a shared-state bug.
3. **Port candidates get their verdict recorded:** each of INVENTORY §2 rows 1/3/4/6/7
   ends as either a landed v2 PR or a written owner "won't port" appended to this RFC's
   Status log.
4. **Sever lands in stages,** each a PR the gate can bisect.

Ordered sequence (Option-B-only stages marked; under Option A they are skipped or replaced
by a written "won't port" log entry):

| # | PR | class | notes |
|---|----|-------|-------|
| 0 | Freeze declaration + freeze guard (rule 2 as a test) | cheap | first PR after acceptance, either option |
| 1 | *(B only)* Port: v2 snap toggle + grid-division control | cheap | candidate #2 first — it is the only *control* gap, and `arrange.spec.ts` snap coverage is blocked on it (SPEC-MIGRATION §1) |
| 2 | *(B only)* Port: inline take lanes in v2 lanes | cheap | candidate #1; shared `takeLanes.ts` helper already exists |
| 3 | *(B only)* Port: finer v2 zoom | cheap | candidate #3, lowest severity |
| 4 | *(B only, if owner says port)* Console mixer view and/or resizable panels | cheap | only on an explicit owner "port" verdict |
| 5 | e2e migration, batched: re-boot the 10 shared-surface specs in v2 | cheap | each batch obeys the ratchet (twin in the same diff) |
| 6 | e2e: author `v2-producer-loop.spec.ts`; rewrite `audio-routing.spec.ts` against v2 surfaces | cheap | the journey twin is the highest-value single migration |
| 7 | Sever stage 1: delete the 17 exclusive modules + classic side of `Arrange.tsx` (re-home the 4 presentational exports first) | cheap | INVENTORY §1 list is the manifest |
| 8 | Sever stage 2: retire `redesignShell`/`layout`/`skin` + TemplatePicker; simplify the shared `webrtc_signal` guard | cheap | INVENTORY §3 dispositions |
| 9 | Sever stage 3: retire the classic-axis specs (moshi-dock, templates, walkthrough, redesign-shell after its coverage diff) | cheap | ratchet-compliant deletions |
| 10 | Sever stage 4: retire `uiShell` + `App.tsx` routing + `shellQuery`/`shellFlag` + the `CLASSIC_ONLY_MODULES` boundary | cheap | last, so the escape hatch outlives everything it escapes to |

## Verification

- **Gate lane:** cheap gate (vitest + `tsc`) per PR, **plus the full e2e suite on every
  spec-touching PR and every sever stage** — the e2e census is where the ratchet lives.
  No native gate: no compiled code, fingerprint input, or engine path is touched by any
  stage (any PR that would touch one is out of scope for this RFC and reclassifies).
- **RED-proofs:**
  - *The ratchet guard* (a census over `boot()`/`bootRedesign()` call sites in `ui/e2e/`
    with a recorded ceiling): prove it RED by adding a scratch classic-booted spec —
    the guard must fail naming the new spec — then restore and `grep SABOTAGE` before
    landing. A census that cannot name its violator is the vacuous-test failure mode
    ([worklog post-mortems](../worklog/INDEX.md)).
  - *The freeze guard* (rule 2): prove it RED with a scratch feature-shaped diff to a
    frozen module (absolute-path sabotage, verify the restore).
  - *Each migrated spec*: before landing, run the v2 twin against a deliberately broken
    assertion target once (or mutate the asserted command name) to show it can fail —
    a twin that boots v2 and asserts nothing real passes forever.
- **Oracles:**
  - *Spec-twin equivalence:* for each of the 10 shared-surface migrations, the v2 twin
    must assert the **same backend behavior** (same commands/events per the
    SPEC-MIGRATION §1 "Backend behavior it proves" column); review maps the assertion
    lists 1:1. This cannot pass vacuously because the mapping is checked against the
    audit table, not against the new spec's own claims.
  - *Boot census:* the classic-boot spec count from
    [`ui/e2e/helpers.ts`](../../ui/e2e/helpers.ts) call sites is an integer that only
    moves when files change — compared against SPEC-MIGRATION §1's recorded census.
  - *Reachability:* `uiReachability.test.ts` keeps `UI_REACH_GAPS` at exactly 0
    throughout; after sever stage 4, its own boundary-vacuity guard demands the
    `CLASSIC_ONLY_MODULES` removal (cited in RECOMMENDATION, Option A).
  - *REACHABILITY ledger:* [SPEC-MIGRATION §2](../classic-audit/SPEC-MIGRATION.md#2-reachabilitymd-selector-scan)
    verified zero reachable-row selectors resolve into classic-only modules, so
    [`docs/verification/REACHABILITY.md`](../verification/REACHABILITY.md) must survive
    the sever with no row edits other than the one stale "(classic shell)" annotation it
    documents.

## Status log

- 2026-07-29 — drafted from the merged B-PR0 classic-audit docs (`docs/classic-audit/`,
  PR #495); decision pending owner. The five owner items: console mixer view, resizable
  panels, inline take lanes, snap control, fine zoom.
