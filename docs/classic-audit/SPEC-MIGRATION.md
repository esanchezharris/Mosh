# Classic-Shell Audit — e2e Migration Bill + REACHABILITY Scan (B-PR0)

*Companion to [INVENTORY.md](INVENTORY.md). This is the bill that must be paid before (or
as part of) any sever: every Playwright spec that boots the classic shell, what backend
behavior it proves, and whether a v2 twin already proves the same thing.*

Boot helpers ([`ui/e2e/helpers.ts`](../../ui/e2e/helpers.ts)):
- `boot()` (lines 26–29) seeds `{ redesignShell: false, uiShell: "classic" }` — plain classic.
- `bootRedesign()` (lines 39–42) seeds `{ redesignShell: true, uiShell: "classic" }` — the redesign-classic variant.
- `bootV2()` (lines 49–58) navigates `/?shell=v2`.

Census at the audit commit (45 spec files): **18 specs use `boot()`**, **2 use
`bootRedesign()`** (`redesign-shell.spec.ts`, plus one call in `templates.spec.ts`), and
**26 boot v2** — 23 via `bootV2()` plus 3 via a direct `goto("/?shell=v2")`
(`agent-loop`, `agent-memory`, `session-lifecycle`).

## 1. Classic-booted specs — the migration bill

"Surface" says where the exercised UI actually lives (per the module diff in INVENTORY §1):
**shared** = mounted by both shells (migration = re-boot the spec in v2 + swap selectors);
**classic-only** = the surface dies with classic (spec is frozen/retired with it, unless the
behavior gets a v2 port first).

| Spec (`ui/e2e/`) | Backend behavior it proves | Surface | v2 twin today | Bill |
|---|---|---|---|---|
| `arrange.spec.ts` | move/trim/split/marquee via real pointer events; gesture-table + feel + snap config honored | classic `Arrange.tsx` + interaction layer (shared logic, classic surface) | Partial: `v2-shell.spec.ts` "a clip drags to a new position" (:469), "right-click → split" (:484); `v2-timerange.spec.ts` | Port drag-variant coverage (trim, marquee, snap on/off — blocked on port candidate #2, the v2 snap control) |
| `audio-routing.spec.ts` | `set_audio_device`/`list_audio_devices` + `set_track_input` cross the seam from real UI | SettingsPanel (shared) + classic strip; asserts `template-picker` visible (classic-only, line 14) | None named; v2 HAS the surfaces (`v2/inspector/Inspector.tsx:191` input picker; settings device select reachable in v2) | Rewrite against v2 Inspector Mix tab + v2 settings (drop the template-picker assertion) |
| `compile.spec.ts` | prompt compiler: descriptive → colour fill, corrective → honest decline | `CompileBox` in `ui/Dock.tsx` GenDrawer (**shared** — v2 Gen tab mounts GenDrawer) | None | Re-boot in v2 (Gen tab), same assertions |
| `drum-pattern.spec.ts` | `add_drum_pattern` lays a whole grid; envelope + `snapshot_invalidated` reflow | store/exec seam + arrangement | Partial: `pattern-library.spec.ts` (v2) covers pattern surfaces | Re-boot in v2; arrangement assertions move to lanes |
| `felt-wrong.spec.ts` | ⌘⇧F capture dialog interaction contract | `FeltWrongDialog` (**shared** — mounted `v2/AppV2.tsx:62`) | None | Re-boot in v2 verbatim (selectors are dialog-local) |
| `freeze-layer.spec.ts` | `freeze_layer`/`unfreeze_layer` through the real drawer (the anti-inert guard) | GenDrawer (**shared** — v2 Gen tab) | None | Re-boot in v2 (Gen tab) |
| `hands-free.spec.ts` | hands-free voice: toggle → recognizer → fastPath → command | voice layer (shared); booted classic | None | Re-boot in v2 (verify the toggle's v2 affordance — overflow menu item, `v2/TopBar.tsx:250`) |
| `lora-rack.spec.ts` | LoRA add/strength/stack/Σ/remove in the re-imagine drawer | GenDrawer (**shared**) | None | Re-boot in v2 (Gen tab) |
| `moshi-dock.spec.ts` | Moshi dock cap row clickability regression | classic bottom dock (classic-only presentation) | n/a — v2's Moshi lives in `MoshCard` (`v2/RightRail.tsx`) | Freeze/retire with classic (regression is classic-geometry-specific) |
| `polish.spec.ts` | modal keyboard-dismiss consistency, empty states, narrow-window behavior; automation-panel open | mixed classic + shared (`open-automation` is in shared `ui/Dock.tsx:51`) | Partial: `v2-edgecases.spec.ts` (21 tests) covers v2 polish | Split: shared assertions re-boot in v2; classic-layout assertions retire |
| `producer-loop.spec.ts` | THE end-to-end loop: new project → track → MIDI → drums → plugin → generative → mix → export | classic shell journey | Pieces exist (`v2-shell.spec.ts` add-track/playable/generative :446,:533; `export-dialog.spec.ts` (v2); `guest-degradation.spec.ts`) — **no single v2 journey spec** | **Highest-value migration**: author `v2-producer-loop.spec.ts` as one journey |
| `rave-insert.spec.ts` | `add_rave_insert` gating on `session.raveAvailable` + rack card UI | `Rack` (**shared** — v2 FX tab) | None | Re-boot in v2 (FX tab) |
| `reimagine-midi.spec.ts` | MIDI re-imagine lands hidden render beneath muted MIDI; Reset restores | GenDrawer (**shared**) | **Yes**: `v2-shell.spec.ts` :446 "generative runs on a MIDI/drum track (auto-bounce → hidden audio beneath)" | Verify equivalence, then retire classic spec |
| `smoke.spec.ts` | dev server + mock + selectors line up | classic selectors | **Yes**: `v2-shell.spec.ts` :113 boot test | Retire with classic |
| `sustain-toggle.spec.ts` | Sustain axis: one control, Gentle⇄Swell vector swap | colour rack in GenDrawer (**shared**) | None | Re-boot in v2 (Gen tab) |
| `templates.spec.ts` | template switch applies skin/keymap/gesture/layout bundle | classic-only axis by design (v2 pins skin, hides the axis) | n/a | Freeze/retire with classic (or with the template feature) |
| `transform.spec.ts` | Route B transform: target + strength → render → auto-apply → Reset | GenDrawer (**shared**) | None | Re-boot in v2 (Gen tab) |
| `walkthrough.spec.ts` | producer-loop slice under each template | classic-only axis | n/a | Freeze/retire with classic |
| `redesign-shell.spec.ts` (bootRedesign) | SessionRail/SectionNavigator/promptbar/PresenceCluster/annotation surfaces of redesign-classic | classic-only (redesign variant) | v2 equivalents covered by `v2-shell` / `v2-sections` / `v2-annotations` | Retire with classic after a coverage-diff pass |

**Bill summary.** Of the 18 `boot()` specs: **10 exercise SHARED surfaces** (compile,
felt-wrong, freeze-layer, hands-free, lora-rack, rave-insert, reimagine-midi, sustain-toggle,
transform, plus most of drum-pattern) and migrate by re-booting in v2 with selector swaps —
this is the mandatory bill, because today the *only* Playwright proof of those backend
behaviors dies with classic. **3 are journeys/harness** (producer-loop, smoke, polish) —
producer-loop needs a real v2 twin authored. **4 die with the classic-only axis**
(moshi-dock, templates, walkthrough, and redesign-shell after a coverage diff).
`audio-routing` needs a rewrite, not a re-boot.

**Proposed ratchet (for RFC 005):** *the classic `boot()`/`bootRedesign()` spec count may
only decrease via a migration PR* — a PR that removes or re-boots a classic spec must land
the v2 twin proving the same backend behavior in the same diff. No silent deletions.

## 2. REACHABILITY.md selector scan

Planning expected **no** [`docs/verification/REACHABILITY.md`](../verification/REACHABILITY.md)
selectors to live in classic-only files. **Verified — confirmed**, with two nuances. Every
`reachable`-row selector was grepped to its defining module and checked against the
module-graph diff (INVENTORY §1):

- All `v2-*` selectors resolve into `ui/src/v2/**` (Inspector, RightRail, TrackLaneList,
  TopBar). `export-run` → `ui/ExportControls.tsx` (shared). **Zero resolve into a
  classic-only or effective-classic-only module.** The ledger survives a sever untouched.
- **Nuance 1 — a stale row label, not a stale selector:** the row "Automation point editing
  *(classic shell)*" (REACHABILITY.md:43) points at `testid:open-automation`, which lives in
  the shared `Rack` (`ui/Dock.tsx:51`) — mounted by v2's FX tab (`v2/inspector/Inspector.tsx:66`)
  — and `AutomationPanel` is mounted in `v2/AppV2.tsx:90`. The capability is v2-reachable
  today; only the row's "(classic shell)" annotation and its `polish.spec.ts` (classic boot)
  coverage are classic-flavored. G16 (write-arm + lane view) remains a real v2 gap regardless.
- **Nuance 2 — expected zero-hit selectors:** `export-stems-run`, `v2-track-arm`,
  `v2-automation-arm`, `v2-ripple-delete`, `v2-group-tracks` have no source hits — they are
  `gap:` rows whose selectors exist only in `test.fixme` specs, which is the ledger's
  documented definition-of-done convention (REACHABILITY.md:12–14). Not classic exposure.

*Decision memo: [RECOMMENDATION.md](RECOMMENDATION.md).*
