# Drum Sequencer + Sample Browser — Design (2026-06-18)

Two missing singleplayer-DAW features. Both are clients of the existing MoshOps
command/snapshot seam. The drum sequencer is frontend-only; the sample-browser
upgrade adds two small backend commands.

## 1. Drum step sequencer

A new **projection of a MIDI clip's notes** — not a new data model. Opens in the
existing piano-roll modal via a `Piano | Drums` segmented toggle in the header
(same `store.editingClipId`, same open path = double-click a MIDI clip).

- **Grid:** 8 GM lanes × 16 steps (= 1 bar). Lanes: kick 36, snare 38, clap 39,
  closed-hat 42, open-hat 46, low-tom 45, mid-tom 47, crash 49.
- **Step→beats:** `stepBeats = beatsPerBar / 16` from the clip-local meter
  (`meterAt(tempoMapFrom(session), clip.start)`), matching PianoRoll.
- **Interactions → commands:**
  - click empty cell → `add_note {clipId, pitch=lane, start=step·stepBeats, length=stepBeats, velocity=100}`
  - click on-cell → `remove_note {clipId, noteIndex}`
  - shift+click on-cell → cycle velocity (127→90→50→127) via `set_note`
    (per-step velocity; cell brightness = velocity)
  - Clear (remove all grid notes) · Play (transport from clip start)
- A note maps to a cell deterministically by `(pitch, round(start/stepBeats))`;
  notes off-lane or past bar 1 stay in the clip (editable in piano view) and are
  simply not drawn. Undo/redo + snapshot resync already work (no new state).
- **Files:** `ui/src/ui/drumGrid.ts` (pure mapping: lane table, `stepBeats`,
  `cellForNote`, `buildGrid`, `noteStart`) + `drumGrid.test.ts`;
  `ui/src/ui/DrumSequencer.tsx` (the grid body); small edit to `PianoRoll.tsx`
  (the toggle + conditional body).

## 2. Sample browser (rework `FilesTool` → `SampleBrowser.tsx`)

| Feature | Layer | Mechanism |
|---|---|---|
| Search/filter + recents | frontend | `list_directory` + client filter + `localStorage` recents |
| Drag-to-arrange | frontend | HTML5 DnD → `import_clip {file, trackId, startSeconds}` (already supported) |
| Waveform thumbnails | **backend** | new `file_peaks {path, buckets}` → `{peaks:[[min,max]…]}`, drawn with existing `ClipWave` |
| Audition / preview | **backend** | new `audition_file {path}` / `stop_audition` — standalone preview player in the engine (JUCE `AudioFormatReaderSource` + `AudioSourcePlayer`), independent of the Edit (no undo, RT-safe) |

### Backend commands (src/moshops)
- `file_peaks` — read-only (like `get_clip_peaks`): `AudioFormatReader` → bucketed
  min/max. No transaction.
- `audition_file` / `stop_audition` — transient preview, not a mutation (no undo
  txn). One preview at a time; selecting another or stopping releases it. Audio
  stays in the engine — only the command + status cross the seam.

## Testing
- Frontend: **TDD with vitest + dev mock.** `bridge.mock` gains stub handlers for
  `file_peaks` (synthetic peaks) and `audition_file`/`stop_audition` (ok). Pure
  mapping (`drumGrid.ts`, drop-x→seconds) unit-tested like `time.test.ts`.
- `commands.contract.test.ts` forces the 2 new commands' args to match `MoshOps.cpp`.
- Backend: `--selftest` checks (peaks non-empty for a seeded wav; audition
  start/stop clean), then **rebuild + 3× selftest** for determinism.

## Out of scope (v1)
Variable bar length, swing, per-lane mute/solo, choosing each lane's sample,
sample tagging/library DB. (The "richer pattern editor" option was declined.)
