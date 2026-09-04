# Moshpit → Mosh: what came across, what was skipped, what is still an idea

Moshpit (`~/moshpit`, private) was the 2026-08-23 pivot: a JUCE-only vocal recorder plus
an Ableton VST3 bridge exchanging audio through a "Room" format, built to nine accepted
milestones in a clean repo. On 2026-09-01 the owner decided Mosh is the product and the
Room concept is more convoluted than Mosh, so Moshpit was mined for parts and is being
archived. This page is the ledger: which parts landed in Mosh, which were deliberately
not ported, and which Moshpit ideas are still worth building — on Mosh's own foundations.

## Landed (one branch each, off `origin/main`, each through the native gate)

| Piece | Mosh branch | What it is | Moshpit provenance |
|---|---|---|---|
| A · LAT-001 | `claude/moshpit-parts` | Measured round-trip latency calibration: `calibrate_latency`, Calibrate row in the record panel, residual over the driver's report pushed into Tracktion's record adjustment, honoured only at the measured rate/device pair | M005-13/29, M006-04 (`LatencyCalibration.h`, `CalibrationRunner.h`, `CalibrationController.h` @ af8b6b7) |
| C · IMP-001 | `claude/moshpit-parts-reimagine-import` | Re-Imagine **Import** (external WAV at a bar becomes an ordinary region/take) and `export_clip_consolidated` (one clip from edit time zero, so it lands at bar 1 anywhere) | M001 ConsolidatedExport, M003 AnchorCapture — the Bridge's two useful halves, folded into Mosh's existing Ableton surface instead of a third plug-in |
| D · CAP-001 | `claude/moshpit-parts-capture-durability` | Crash-residue take recovery (list / adopt at BWAV position / quarantine by rename, never delete) and the amber **silent** badge on a landed take below −80 dBFS | M005-07/08 (`CrashRecovery.h`, `TakeWriter.h` policy) |
| F · TPL-001 | `claude/moshpit-parts-vocal-template` | `new_project {template:"vocal"}` / File → New Vocal Recording: Backing + armed Vocal, one-bar count-in, overdub takes, four-bar loop | Moshpit's whole product, reduced to the one recipe that matters inside a DAW |

## Deliberately not ported

- **Mosh Tune (M009).** The owner listened after all four repairs and it still sounded
  distorted; Moshpit's own status records that its gate suite does not measure the defect.
  Mosh's AutoTune is a sine resynthesis and is not good either. Vocal tuning is an OPEN
  problem in both codebases and deserves its own spike with a listening protocol first.
- **Room Bundle, Room Zero, fixed-tempo timing core, session schema.** Tracktion's tempo
  map and Mosh's content-addressed stems cover it.
- **Cloud Room / sync_core / Supabase room service.** Mosh's relay already does resumable,
  SHA-256-verified, offline-capable transfer; two backends would be strictly worse.
- **Take stacks + non-destructive keeper.** Mosh has take lanes, comping and loop-overdub.
  A non-destructive "preferred take" flag would be a small MoshOps command if wanted;
  note Mosh's `keep_take` IS destructive (undoable) and Moshpit's keeper was not.
- **Ink & Lime UI, Room panel, support bundle.** The tokens came from Mosh's own
  `mosh.css`; the tester programme is paused.
- **Device preflight.** Mosh already had the identical child-process probe (AUD-017).
- **Stock chain (tilt EQ, 3-band OTT, tanh saturator, FDN reverb).** Measured and clean
  in Moshpit but unvoiced; Mosh hosts any VST3. Kept as an OPTION (Piece E): one
  "Mosh Vocal Strip" built-in, only if the vocal template must sound good with zero
  third-party plug-ins installed.

## Still ideas (from Moshpit's deferred ledger), to build on Mosh's foundations

- **Headphone-feedback detection** for input monitoring (Moshpit R007-07 kept a
  headphones-only doctrine; Mosh has X-FDBK, which is the seed).
- **Recording requests and comments on takes** — Moshpit's Room vision; in Mosh these are
  multiplayer-scoped annotations on clips, not a new document.
- **Take lifecycle: archive / rename / publish states** — typed MoshOps commands on the
  clip's take metadata, non-destructive.
- **Phone recording remote + lyric display** — DAWN already controls Live from a phone;
  the same companion can arm/record Mosh and show the lyric sheet.
- **A performer-only shell** ("Mosh Recorder") — was Moshpit's reason to exist. If a
  lightweight distribution ever matters, it is a build target over the same MoshOps
  seam, not a second product.
- **AU / more DAW bridges** — Re-Imagine's Import/Transfer pair already generalises;
  AU is a build flag away when the licensing gate clears.

## Archive procedure (Piece G, after A/C/D/F merge)

Tag `archive/parts-mined-2026-09` on Moshpit `main` and `codex/009-mosh-tune`, write
`docs/ARCHIVED.md` there pointing at the four Mosh branches above, and stop the M009
milestone in its tracker. Nothing in Moshpit is deleted.
