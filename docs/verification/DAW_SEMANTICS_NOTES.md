# Reference-DAW semantics notes (capture once, cite forever)

*Scaffold for the owner's ONE timeboxed (~half-day) semantics-capture session — part of the
DAW-parity program's L4 lane. Mosh's parity assertions currently encode our **guesses**
about reference semantics (warp length math, quantize strength interpretation, default fade
curves). This session replaces guesses with observed values from a real Ableton Live
instance (driven via the Producer Pal MCP bridge where convenient, by hand where not).
This file — not a standing A/B lane — is the durable artifact; conformance/verify
assertions cite it. A continuous Live-vs-Mosh differential lane was assessed and rejected:
it needs a licensed GUI app, non-deterministic timing reads, and human interpretation —
everything a gate can't hold.*

**Status: NOT YET CAPTURED** — every table below is a template awaiting the session.

## 1. Warp-to-tempo length math

Setup: the same 2-bar, 170 BPM loop imported into a 120 BPM project in both DAWs.

| Observation | Ableton Live 12 | Mosh (`stretch_clip` / `set_clip_warp detect`) | Match? |
| --- | --- | --- | --- |
| Resulting clip length (beats) | | | |
| End-of-loop grid alignment | | | |
| Detected source BPM | | | |
| Pitch preserved at this ratio (by ear) | | | |

Pins: `stretch_clip{bars}` derivation (`sourceBpm = bars×beatsPerBar×60/sourceLen`), the
`fam_warp_stretch` conformance assertions, and `check_warp_stretch`'s tolerance.

## 2. Quantize semantics

Setup: identical deliberately-off-grid 8-note MIDI phrase in both; quantize to 1/16 at
50% strength.

| Observation | Ableton Live 12 | Mosh (`quantize_notes{division:0.25, strength:0.5}`) | Match? |
| --- | --- | --- | --- |
| A note 40 ticks early moves to… | | | |
| Notes already on-grid move? | | | |
| Note ENDS quantized too, or starts only? | | | |
| Swing interaction (if any) | | | |

Pins: `quantize_notes` strength math (`next = start + (q−start)×strength`) and the future
groove/swing capability row's spec.

## 3. Default fade curves

Setup: default fade-in on a clip in Live (drag the fade handle to 1 s) vs
`set_clip_fade{fadeInSec:1.0}` with Mosh's default curve.

| Observation | Ableton Live 12 | Mosh | Match? |
| --- | --- | --- | --- |
| Default curve shape (linear / log / s-curve) | | | |
| Crossfade default (equal-power vs equal-gain) | | | |
| Audible click without fade on a hard splice (control) | | | |

Pins: `set_clip_fade` default `curve` choice and `check_clip_fades`'s golden shape.

## Capture protocol

1. Timebox: half a day, once. New questions found mid-session go in §4 below, not into
   scope creep.
2. For each table: set up the case in Live (Producer Pal can create/inspect clips, tracks,
   and playback state; use the GUI for what it can't reach), read the observed value from
   Live's UI/clip view, run the twin case in Mosh via `--run-script` or the UI, fill both
   columns.
3. A mismatch is not automatically a bug — decide per row: match Live (file a backlog
   item citing the row), or deliberately diverge (record the rationale HERE — the row then
   documents Mosh's chosen semantics).
4. Screenshots optional, values mandatory.

## 4. Questions discovered during capture

*(append as found)*
