# Moshi Phase 1 — DAW project-file importers (RPP/ALS → MoshIR → MoshOps)

Turn existing DAW project files into ordered **agent-callable MoshOps command
sequences** that reconstruct the session as a Tracktion `Edit`. This is bulk
cold-start **SFT / behavioral-cloning** data in the exact command vocabulary the
model must emit — and it doubles as the Phase-0 verifier's first real workload.

Code: [`ui/src/import/`](../ui/src/import/). Run: `cd ui && npm run import -- <file>`.

## One pipeline, not N importers

```
.rpp ─┐
.als ─┼─►  parser frontend  ──►  MoshIR  ──►  emitter  ──►  agent commands  ──►  Phase-0 verifier
.flp ─┘   (parseRpp/parseAls)   (moshIR.ts)  (emit.ts)     (BoundCommand[])      (bindReplay.ts)
```

- **MoshIR** ([moshIR.ts](../ui/src/import/moshIR.ts)) — a small normalized session:
  tempo/timeSig/key, tracks (name/type/vol/pan/mute/solo), clips (wave|midi,
  start/length, notes). Adding a format = one parser to this shape.
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
| MIDI clip | `add_midi_clip` (+ `add_note`) | |
| **audio clip** | `add_test_tone_clip` (positioned) | **lossy** — no agent audio-import command; content becomes a placeholder, logged |
| plugins / FX chains | — | logged (no agent plugin-by-name command) |
| sends / return / group tracks | — | logged (flattened) |
| automation | — | logged |

Per the spec, unmappable features are **logged explicitly, never silently
dropped** — `program.unmappable` lists every one.

## Demo results (real fixtures, 100% clean-apply)

`npm run import -- <file>` (verified):

| File | Format | Tracks | Clips | Commands | clean-apply |
|---|---|---|---|---|---|
| griffin-with-external-files.rpp | RPP | 19 | 88 | 151 | **151/151** |
| tb303-reaper-project-VST.RPP | RPP | 1 | 0 | 5 | **5/5** |
| 233.als (local) | ALS | 9 | 77 | 105 | **105/105** |
| theen.als (local) | ALS | 9 | 127 | 155 | **155/155** |

Demo fixtures (parser test fixtures + own-catalog locals) and their provenance
live in `~/mosh-demo-projects/` — **kept local/internal, never redistributed**
(spec data-rights posture: importer-derived data is imitation-only cold-start).

## Known gaps / follow-ups

- **MIDI note extraction** — RPP inline MIDI events and ALS `MidiNoteEvent`s are
  not yet parsed; MIDI clips import as positioned empty clips (logged). The note
  primitive (`add_note`) and the emitter path already exist — only the per-format
  note read is pending.
- **Audio content** — there is no agent-callable audio-import command, so audio
  clips are positioned test-tone placeholders. Closing this needs either an
  agent-callable `import_clip` or a positioned-audio command in the catalog.
- **FLP** — binary; needs a Python/PyFLP frontend emitting the same MoshIR
  (the `.flp` path is dispatched and logged as not-implemented today).
- **Provenance per session** — record source + format + rights status alongside
  emitted programs when this feeds the training corpus at volume.
