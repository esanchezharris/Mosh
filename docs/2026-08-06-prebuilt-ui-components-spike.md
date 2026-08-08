# Prebuilt UI components spike — piano roll & generic chrome (2026-08-06)

Triggered by: "the MIDI editor is unusable — should we adopt prebuilt components instead of
agent-built ones?" Approved as a research spike (approach C) before committing to anything.

**Verdict in one line: keep our piano roll (its bugs were shallow and are now fixed); adopt a
headless library (Base UI, first pick) for the generic chrome — menus, dialogs, popovers,
tooltips, sliders — where prebuilt genuinely pays off.**

## Part 1 — Is there an adoptable piano roll? No.

Catalog of every plausible embeddable piano-roll/MIDI editor, judged against Mosh's hard
constraint: the host owns all note data and every edit must route through the MoshOps command
seam (`add_note` / `set_note` / `remove_note`, one undo step per gesture).

| Candidate | License | Seam fit | Verdict |
|---|---|---|---|
| GridSound `gsuiPianoroll` | **AGPL-3.0** | Perfect — emits op-shaped deltas (`onchange("add"/"move"/"cropEnd"/"remove")`) | The architecture to copy; license kills adoption |
| `@molecule/app-feature-piano-roll-react` | Apache-2.0 | Controlled `notes` prop + callbacks | Prototyped below — **not viable** |
| `webaudio-pianoroll` (g200kg) | Apache-2.0 | **None** — `sendEvent()` is dead code; edits mutate internal state silently | Usable only as a fork; canvas renderer, no velocity model |
| signal (ryohey) | MIT | Owns data + own undo stack | Best UX reference extant; extraction is a project, not an adoption |
| react-piano, react-piano-roll, pixi-piano-roll, wave-roll, html-midi-player, etc. | — | — | Keyboards or playback visualizers, not editors |
| BandLab / Soundtrap / Amped / openDAW | — | — | All in-house custom; there is no CodeMirror-for-piano-rolls |

The structural lesson: **every serious web DAW built its own editor**, because
"host-owns-data with interceptable, batchable edits" is exactly what no mature component was
designed for.

## Part 2 — The wrap prototype (molecule package)

Prototype: `.tmp/pianoroll-spike/wrap.test.jsx` (throwaway; vitest + jsdom, React 18).
Both hypotheses confirmed empirically:

1. **Seam routing is mechanically fine.** A grid click routes through a 6-line adapter to
   `add_note {pitch:60, start:1.5, length:0.5, velocity:96}` — floor-snapped, correct.
2. **The interaction model is incompatible.** One 10-step drag fires **10 `set_note` calls
   with no gesture-end callback**. Mosh commits once per gesture (one undo step, no JSONL
   flood, preview-during-drag). With no gesture boundary to hook, batching is impossible
   without an external pointer-tracker + local preview mirror — i.e. a parallel interaction
   layer, a fork in disguise.

Further gaps found by reading the component (439 lines, one file):

- **Hardcoded 4/4** (`isBar = beat % 4`) — no meter map; Mosh has tempo/meter maps.
- No selection at all (no marquee/multi-select), no velocity lane, no zoom, no playhead,
  no loop markers, no audition, no step-record/qwerty, right-click-only delete, no keyboard ops.
- Controlled notes + per-frame move callbacks mean the dragged note only moves after the
  parent applies state — with Mosh's async exec→engine→snapshot round trip it would visibly
  lag without a local preview mirror (more adapter).
- Notes keyed by stable `id`; Mosh addresses by re-sorting **index** — the adapter must
  re-derive id→index after every snapshot (fragile with duplicate-identical notes).
- Requires adopting the `@molecule` "bond" DI runtime: `setClassMap()` + `I18nProvider` +
  19 sibling packages just to render. Published 2026-08-05; unproven, AI-generated ecosystem.

**Effort estimate if forced:** 2–4 days to adapter + preview mirror + re-add
marquee/velocity/zoom/meter — landing at a *feature regression* versus the current editor,
on a one-day-old dependency. Rejected.

The fork path (`webaudio-pianoroll`) is better-bounded (one 1,160-line Apache-2.0 file, add op
emission at ~8 mutation sites) but still yields a canvas editor with no velocity lane and no
meter map — strictly worse than what we have. Rejected.

## Part 3 — Where prebuilt DOES pay off: generic chrome

Full catalog verified against npm/GitHub 2026-08-06. Recommendation:

1. **Base UI (`@base-ui/react`, 1.7.0, MIT)** — first pick. Stable 1.x (Dec 2025), MUI +
   ex-Radix + Floating-UI authors, fastest-moving, covers Dialog/Menu/ContextMenu/Popover/
   Tooltip/Slider/Tabs/Combobox, `data-*` styling fits the token system.
2. **Radix UI** — defensible alternative (maintenance scare over; heavy 2026 activity); no
   true combobox.

Skip: React Aria (best a11y but heavyweight/verbose for internal chrome), Headless UI (no
tooltip/slider), Ariakit (0.x, bus factor), Ark/Zag (abstraction without payoff here).

All of them solve **stacked modals / Escape-stack / focus-trap** correctly — the exact class
of hand-rolled jank Mosh keeps re-fixing (`.modal`/#44, `.pop`, the Escape stack, the
TopbarTools portal workaround). None is hostile to WKWebView.

Migration shape (when scheduled): inventory hand-rolled chrome → thin
`ui/src/chrome/` wrapper layer applying tokens via `data-state` → replace leaf-first
(tooltips, menus → popovers, sliders → dialogs last) → delete the private focus/Escape-stack
code. Musical surfaces (piano roll, arrange, clips, knobs) stay custom; use
`@floating-ui/react` directly for one-off anchored overlays on them.

**Pilot landed (same day):** `@base-ui/react` added; `ui/src/chrome/Menu.tsx` +
`ui/src/chrome/Tooltip.tsx` are the seam. Migrated: the v2 add-track menu (deleted its
measured-rect placement; Floating UI flips/clamps/re-anchors — the popup now tracks its
trigger on scroll instead of dismissing, a deliberate behaviour change pinned in
`anchored-panel-scroll-race.spec.ts`) and the piano-roll header's ten `title=` tooltips
(now `MoshTip`, themed via `--tip-*` tokens with the same dual-shell re-pin discipline as
`--pr-*`). Note for follow-ups: a Floating-UI popup taller than the flip space needs
`max-height: var(--available-height)` on the skin — the Positioner publishes it.

## Part 4 — The bugs that started this (fixed same day, on `main` worktree)

All three reported piano-roll bugs were shallow and are fixed with regression gates:

1. **"Transparent, lines confusing"** — v2 pinned the `--pr-*` surfaces to the shell's
   *glass* tokens (`rgba(24,24,25,0.64)` etc., `00-tokens.css`), so the arrangement bled
   through the editor's grid. Fixed with opaque `--v2-surface{,-2,-sunken}-solid` twins;
   guarded by a new "no glass on modal surfaces" assertion in `pianoRollCss.test.ts` and an
   opacity e2e in `piano-roll.spec.ts` (both themes).
2. **"Note starts half a beat off the grid"** — entry used round-to-nearest (`Math.round`),
   which can drop the note up to half a step away and *ahead* of the click. Entry now floors
   (`snapDownBeat` in `pianoRollGeom.ts`, epsilon-guarded), matching Live/Logic/FL pencil
   behavior; round stays on drags. Unit + component + in-browser verification.
3. **"Keeps moving around"** — could not reproduce any real motion after the above: panel
   rect and scroll offsets are pixel-stable across open/draw/zoom in e2e. Most plausible
   perception sources were the translucent double-grid (two misaligned line sets) and
   round-snap misplacement — both fixed. If it still reproduces in the real app, get a
   screen recording; the e2e harness (`.pr` rect + scroll sampling) is ready to pin it.

Verification: `vitest run` 2686 passed / 1 skipped; `tsc --noEmit` clean (incl. e2e config);
`playwright test e2e/piano-roll.spec.ts` 14/14.
