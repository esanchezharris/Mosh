# Moshi Phase 1 — DAW project-file importers (RPP/ALS/FLP → MoshIR → MoshOps)

Turn existing DAW project files into ordered **agent-callable MoshOps command
sequences** that reconstruct the session as a Tracktion `Edit`. This is bulk
cold-start **SFT / behavioral-cloning** data in the exact command vocabulary the
model must emit — and it doubles as the Phase-0 verifier's first real workload.

Code: [`ui/src/import/`](../ui/src/import/). Run: `cd ui && npm run import -- <file>`.

## One pipeline, not N importers

```
.rpp ─┐
.als ─┼─►  parser frontend       ──►  MoshIR  ──►  emitter  ──►  agent commands  ──►  Phase-0 verifier
.flp ─┘   (parseRpp/Als/Flp)         (moshIR.ts)  (emit.ts)     (BoundCommand[])      (bindReplay.ts)
```

- **MoshIR** ([moshIR.ts](../ui/src/import/moshIR.ts)) — a small normalized session:
  tempo/timeSig/key, tracks (name/type/vol/pan/mute/solo), clips (wave|midi,
  start/length, **notes**). Adding a format = one parser to this shape.
- **Parsers** — `.rpp` (text) and `.als` (gzipped XML) parse from bytes in pure TS.
  `.flp` is binary: [parseFlp.ts](../ui/src/import/parseFlp.ts) shells out to a PyFLP
  sidecar (`service/flp/`) and wraps its JSON into the same MoshIR.
- **Emitter** ([emit.ts](../ui/src/import/emit.ts)) — MoshIR → `BoundCommand[]`. Only the
  **agent-callable subset** is emitted (Moshi can call nothing else). Engine ids
  aren't known until create time, so commands reference tracks/clips by **logical
  refs** (`$t0`, `$c0_1`) that the binder resolves at replay — mirroring the native
  `--run-script ${VAR}` capture.
- **Binder + replay** ([bindReplay.ts](../ui/src/import/bindReplay.ts)) — starts from a clean
  slate (`new_project`), runs the commands through the mock backend, resolves
  `$refs` from each create's result, and reports clean-validate / clean-apply.

## What maps (and what's logged as unmappable)

| Project feature | MoshOps command | Notes |
|---|---|---|
| tempo / time sig / key | `set_tempo` / `set_time_signature` / `set_key` | |
| track + name + type | `create_track` | |
| track volume/pan/mute/solo | `set_track_volume` / `_pan` / `_mute` / `_solo` | linear gain → dB |
| MIDI clip + **notes** | `add_midi_clip` + `add_note` | RPP delta-PPQ `E`/`e` events; ALS `MidiNoteEvent`s; FLP pattern notes (grouped by `rack_channel`) → pitch/start/length(beats)/velocity |
| **audio clip** (with a source path) | `import_clip` (positioned) | RPP `<SOURCE> FILE`, ALS `SampleRef>FileRef>Path`, FLP `channel.sample_path` → resolved to an absolute path (Windows separators normalized) at `startSeconds` |
| audio clip (no path captured) | `add_test_tone_clip` (positioned) | **lossy** fallback — content becomes a placeholder, logged |
| plugins / FX chains | — | logged (no agent plugin-by-name command) |
| sends / return / group tracks | — | logged (flattened) |
| automation | — | logged |

Per the spec, unmappable features are **logged explicitly, never silently
dropped** — `program.unmappable` lists every one.

## Demo results (real fixtures + local catalog, 100% clean-apply)

`npm run import -- <file>` (verified). `add_note` counts match the source exactly:

| File | Format | Tracks | Commands | `add_note` | clean-apply |
|---|---|---|---|---|---|
| griffin-with-external-files.rpp | RPP | 19 | 1046 | 895 | **1046/1046** |
| BY MYSELF … DECONSTRUCTED.als (local) | ALS | 109 | 5575 | 1429 | **5575/5575** |
| Gravitas Catalyst Demo.als (local) | ALS | 32 | 1681 | 1307 | **1681/1681** |
| Shazy 4342.flp (local) | FLP | 15 | 1404 | 1325 | **1404/1404** |
| pyflp-FL-20.8.4.flp (fixture) | FLP | 12 | 281 | 192 | **281/281** |

Before note extraction, griffin imported as 151 commands of positioned *empty*
clips; it is now 1046 commands carrying 895 real notes (and its audio clips are
real `import_clip`s, not test tones). FLP audio clips + repeated pattern placements
lifted 4342 from 665 → 1404 commands. Demo fixtures and locals (provenance in
`~/mosh-demo-projects/`) are **kept local/internal, never redistributed** (spec
data-rights: importer-derived data is imitation-only cold-start).

## FLP setup (PyFLP carve)

`.flp` is binary and parsed by [PyFLP](https://github.com/demberto/PyFLP) (MIT) in a
dedicated venv — **one-time**: `service/flp/setup-flp.sh`. It pins **Python 3.10**
(PyFLP 2.2.1's enum base breaks on 3.11+) — `uv` fetches a standalone 3.10 if needed.
The frontend reads the venv path from `service/flp/.flp.env`; absent it, `.flp`
degrades to an empty IR that logs how to enable it. FL's channel-rack/pattern model
is flattened to linear tracks: channels→tracks; the **selected** arrangement's playlist
is walked (only one arrangement is the song — each has its own 0-based timeline) so each
pattern placement becomes a positioned MIDI clip (notes grouped by `rack_channel`) and
each audio playlist item a positioned `import_clip`. PyFLP can throw building the
playlist on some files, so the walk is guarded: a clean miss (no placements) falls back
to a **sequential** layout, and a mid-walk crash appends the un-reached patterns
sequentially so no notes are lost. FL sample roots (`%FLStudio*Data%`) resolve to
best-effort absolute paths.

## Known gaps / follow-ups

- **Missing audio files** — `import_clip` carries the resolved source path, but the
  file may not exist on this machine (foreign Windows `D:\…` paths, FL factory
  samples). The command is structurally correct; the engine treats a missing file as
  relink territory. The verifier (mock) is file-agnostic, so clean-apply is unaffected.
- **FLP placement detail** — clip trim/loop offsets aren't modeled (a placement emits
  the full pattern / sample at its position); note-bearing patterns never placed on the
  playlist are logged, not imported. Channel volume (FL's internal taper) + time
  signature unmapped.
- **Clip loop/offset** — RPP/ALS note `start` is the clip-internal beat position;
  loop start-offset trimming is not modeled (v1).
- **Provenance per session** — record source + format + rights status alongside
  emitted programs when this feeds the training corpus at volume.
