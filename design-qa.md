# Mosh V1 Graphite Shell Design QA

## Source truth

- Branded target: `/Users/emiliosanchez-harris/.codex/generated_images/019fac63-bc82-7142-80ab-854d3cf99529/call_RdIEz0xwpiyTUBy3xHkSA9xv.png`
- Layout reference: `/Users/emiliosanchez-harris/Downloads/hQGRC.png`
- Brand icon: `/Users/emiliosanchez-harris/Mosh/resources/icon/MoshIcon.png`

## Captured states

- Idle, 2000 x 1250 CSS px at density 1:
  `ui/visual/shell.spec.ts-snapshots/shell-rest-dark-shell-darwin.png`
- Three active jobs, 2000 x 1250 CSS px at density 1:
  `ui/visual/shell.spec.ts-snapshots/shell-three-jobs-dark-shell-darwin.png`
- Compact, 1280 x 768 CSS px at density 1:
  `ui/visual/shell.spec.ts-snapshots/shell-compact-dark-shell-darwin.png`
- Narrow, 820 x 768 CSS px at density 1:
  `ui/visual/shell.spec.ts-snapshots/shell-narrow-dark-shell-darwin.png`
- Idle comparison: `design-qa-comparison-idle.png`
- Three-job comparison: `design-qa-comparison-three-jobs.png`

The 1586 x 992 branded target was proportionally normalized into the
2000 x 1250 comparison canvas before judging the implementation.

## Comparison

- Typography uses the existing IBM Plex-style Mosh stack and preserves the
  shell's monospace readouts. Weight, density, and label hierarchy match the
  reference without replacing Classic typography.
- Spacing follows the reference's two-row header, compact track headers,
  full-width arrangement, fixed inspector, and bottom status strip. The narrow
  layout keeps transport and primary actions reachable and collapses secondary
  rails instead of removing them.
- Color uses near-black graphite grounds, soft-white type, and muted track
  colors. Acid lime `#CCFF23` is reserved for active agent controls, affected
  regions, progress, and agent badges; the static Mosh icon is the sole idle
  lime exception.
- The real Mosh icon is used in the top-left and for local worker identities.
  No mascot approximation, inline SVG, or persistent mascot stage is present.
- Copy names one Mosh orchestrator and the real local workers Drummer,
  Arranger, and Generator. The unsupported stem-split wording is replaced with
  Re-imagine this clip.

## Functional checks

- Browser rail, browser tabs, inspector, drawers, overflow actions, and Classic
  fallback remain part of the existing V2 architecture.
- Section, tempo, annotation, loop-state, and file/options/export controls remain
  visible by default; the arrangement rows can still be tucked away from overflow.
- Clip selection, track selection, drag, trim, split, locks, remote cursors,
  transport controls, meters, and collaborator presence remain reachable.
- Drummer dispatches `add_drum_pattern`.
- Arranger uses the existing scoped agent and region-render command path.
- Generator uses the existing clip re-imagine path with progress, audition,
  accept/reject, reset, and undo.
- Idle state has no agent count or animated job treatment.
- Busy state confines motion and lime to active jobs and affected regions.
- Reduced-motion media preferences produce a static busy treatment.
- The final staged native app was opened with audio disabled, the session picker
  was completed, File/options/export was opened, the Agent rail was inspected,
  and Drummer created a real Drums track and MIDI clip.

## Findings resolved

1. Transport readouts initially omitted meter information; the meter readout
   was restored in the second header row.
2. The first narrow layout let the expanded rail consume the arrangement; the
   rail now auto-collapses at the existing narrow-window breakpoint.
3. The collapsed right-rail pull target was too visually dominant; it now uses
   the real small Mosh icon at the appropriate control size.
4. Whole-clip native renders were mislabeled as Arranger jobs because native
   snapshots always serialize region bounds; the adapter now identifies
   Arranger only for a range narrower than its clip.
5. The first Graphite pass hid V2's section, tempo, and annotation rows by
   default and removed the file/options/export trigger; both were restored as
   first-class controls to keep the shell functional and merge-friendly.

## Intentional deviations

- The deterministic fixture has three functional tracks rather than the
  reference's six illustrative tracks.
- The Agent tab exposes real worker actions and task recall instead of a
  decorative agent list.
- Source separation remains deferred; per-track stem export stays in Export.
- The existing Browser is collapsed in the Mosh layout, not deleted, so this
  remains a merge-friendly evolution of V2 rather than a separate shell.

final result: passed
