# Classic-Shell Audit — Recommendation Memo (B-PR0)

*Evidence: [INVENTORY.md](INVENTORY.md) (module diff, behavior table, settings) and
[SPEC-MIGRATION.md](SPEC-MIGRATION.md) (e2e bill, REACHABILITY scan).*

**THE DECISION IS THE OWNER'S.** This memo lays out the two options with the evidence for
each; it deliberately does not pick. RFC 005 will be written from this document once the
owner calls it.

---

## What the evidence establishes

1. **The exclusive surface is small and shrinking in relevance:** 17 modules / ~1,285 LOC
   effectively classic-only, plus ~800 classic-only lines of `Arrange.tsx` (INVENTORY §1).
   Everything else classic touches is shared infrastructure v2 also depends on.
2. **v2 has organically superseded most of it.** Of 13 classic-unique behaviors, 8 are
   already superseded or deliberately rewritten in v2 (INVENTORY §2 rows 5, 8–13), and two
   planning hypotheses turned out overstated on inspection (the docks are not drag-dockable;
   v2 does have a coarse zoom). The "written reason ages" rule held again: three stale
   comments were found during this audit alone (INVENTORY rows 10, 12; SPEC-MIGRATION §2).
3. **Three real presentation gaps remain** where classic is strictly better for a mouse-only
   producer (INVENTORY §2 rows 4, 6, 7):
   - **inline take lanes** in the arrangement (recorded in
     `agent/commandClassification.ts:204–211` as a presentation gap);
   - **a snap toggle + grid-division control** — verified: nothing in `ui/src/v2/` calls
     `setSnap`/`setSnapDivision`, so v2 users are locked to snap-on at 1/4;
   - **fine-grained zoom** (v2 has only 8b/16b/Full fit stops vs classic's 20–400 px/s slider).
4. **Two behaviors need an explicit owner verdict** (INVENTORY §2 rows 1, 3): the
   all-tracks console Mixer view, and resizable/persisted panel widths. Both conflict with
   v2's stated single-design / capped-centered-stage position — porting them is a design
   decision, not a mechanical one.
5. **The e2e bill is real but bounded** (SPEC-MIGRATION §1): 10 classic-booted specs are
   today the only Playwright proof of *shared* backend surfaces (the whole generative
   drawer lane: compile, freeze, LoRA, RAVE, sustain, transform, felt-wrong, hands-free…);
   they migrate by re-booting in v2. One journey spec (`producer-loop`) needs a genuine v2
   twin authored. Four specs die with the classic-only axis.
6. **REACHABILITY.md is sever-safe** — zero reachable-row selectors resolve into
   classic-only modules (SPEC-MIGRATION §2).
7. **Classic is not free**: classic-only files took commits as recently as 2026-07-25, and
   every reachability probe carries a hand-maintained `CLASSIC_ONLY_MODULES` boundary whose
   false-positive mode has already hidden a real v2 bug once
   (`uiReachability.test.ts:36–43`).

## Option A — freeze-and-sever

Declare classic frozen now (no features, no polish; bugfix only if it corrupts shared
state), pay the e2e bill, then delete: the 17 exclusive modules, the classic 80% of
`Arrange.tsx` (after re-homing the 4 presentational exports), the `redesignShell`/`layout`/
`skin` settings + TemplatePicker, the classic boot helpers, and finally the `uiShell` enum
+ `App.tsx` routing + the `CLASSIC_ONLY_MODULES` boundary (which becomes vacuous — its own
guard test will demand removal, `uiReachability.test.ts:139–151`).

- **For:** smallest total work; removes the boundary machinery and a whole class of stale
  comments; consistent with v2 being the shipped default and with the three v2 rewrites
  being deliberate; the 3 port candidates can still be built *in v2, later, on demand*
  without keeping classic alive as their reference.
- **Against:** the take-lane / snap / zoom gaps ship unfixed with no working reference
  implementation left in-tree (git history only); the two OWNER-verdict behaviors
  (console view, resizable panels) are decided by default (dropped).

## Option B — port-and-archive

Port first, then archive: land the 3 port candidates in v2 (take-lane presentation, snap
control, finer zoom), get the owner's verdict on the console view + resizable panels and
port those if wanted, migrate the e2e bill, and only then delete classic in the same shape
as Option A.

- **For:** no producer-visible regression at sever time; the ports are written while the
  classic reference still runs side-by-side (cheapest time to write them); the owner
  verdicts get made explicitly instead of by deletion.
- **Against:** more work before the payoff; risks the freeze eroding (classic keeps
  receiving drive-by changes while it waits — it got one on 2026-07-25); the port list can
  grow by discovery, delaying the sever indefinitely without a hard cap.

## Rules that should hold under EITHER option (proposed for RFC 005)

1. **The ratchet:** the classic `boot()`/`bootRedesign()` spec count (today 18 + 2) may
   only decrease, and only via a migration PR that lands the v2 twin in the same diff
   (SPEC-MIGRATION §1).
2. **Freeze is a tested property, not a promise:** classic-only modules (the INVENTORY §1
   list) take no feature commits after the freeze date; any diff touching them must cite a
   shared-state bug.
3. **Port candidates get their verdict recorded** — each of rows 1/3/4/6/7 in INVENTORY §2
   ends as either a landed v2 PR or a written owner "won't port", so no gap is dropped
   silently.
4. **Sever lands in stages** (modules → settings → e2e → `uiShell` routing), each stage a
   PR the gate can bisect.

## What this memo does NOT decide

Whether Mosh owes producers the classic affordances at all. That is a product/taste call
on exactly five items (console mixer view, resizable panels, inline take lanes, snap
control, fine zoom) — the owner's, and the entire remaining difference between the options.

*Written by the B-PR0 audit lane, 2026-07-28. Source of truth for the follow-up: RFC 005
(to be authored from this doc after the owner's call).*
