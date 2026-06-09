# ClaudeMosh Alignment Notes

ClaudeMosh `main` is the source of truth for the public seam. This MBMC branch keeps
the existing MoshOps/DslExecutor internals, but adapts the JUCE/HTTP boundary and UI
tests to the ClaudeMosh contract so later porting can be selective instead of a
wholesale overwrite.

## Command Boundary

Canonical client requests use:

```json
{ "command": "create_track", "args": { "name": "Vocal" } }
```

Canonical results use:

```json
{ "ok": true, "command": "create_track", "data": { "trackId": "track:1" } }
```

Failures use `error`:

```json
{ "ok": false, "command": "remove_track", "error": "No such track: track:999" }
```

The app still accepts the deprecated MBMC request key `{ "name": "...", "args": ... }`
and keeps internal `MoshResult::toVar()` diagnostics for local tests/tools.

## Names

Preferred public names:

- `remove_track` instead of `delete_track`
- `set_track_volume` instead of `set_track_gain`
- `set_track_pan` for pan
- `list_colors` instead of `get_colors`
- `trackId`, `clipId`, `pluginId`, `layerId`
- clip `start`, `length`, `offset`

Deprecated aliases remain registered during the transition. They should not be used
by new UI/E2E coverage.

## Snapshot And Events

Snapshots now include the ClaudeMosh-facing spine:

- `schemaVersion`
- `session`
- `tracks`
- `transport`

Clip geometry is public as `start`, `length`, and `offset`. Legacy `range` and
track-level `renderLayers` are retained only for transition compatibility; new UI
paths read `clip.renderLayer`.

HTTP/WebView events are sent as:

```json
{ "type": "clip_moved", "payload": { "id": "clip:1", "start": 1.0, "length": 4.0 } }
```

Internal C++ listeners still use the old flat event object. The bridge normalizes
both shapes, and missed event recovery still uses snapshot resync.

## Generative Service

Canonical endpoints:

- `GET /health`
- `GET /capabilities`
- `GET /colors`
- `POST /submit`
- `GET /status?jobId=...`
- `POST /cancel`

Legacy `/jobs` endpoints still work while MBMC and ClaudeMosh converge. The canonical
adapter id is `stable_audio3`; `stable_audio_3`, `stableaudio3`, and `sa3` remain PC
compatibility aliases. Model paths stay outside source and are supplied through local
environment variables/scripts.

## Replay-Ready JSONL

Each command log line now includes:

- `schemaVersion`
- `sessionId`
- `actorId`
- `commandId`
- `seq`
- `command`
- `args`
- `ok`

`seq` is process-local ordering only. This is enough for deterministic replay and
future cross-play prep, but this branch intentionally does not add networking, CRDTs,
conflict resolution, or multiplayer UI.

## Merge Hygiene

Generated E2E artifacts, Playwright traces/reports, generated WAVs, build outputs,
`midi_data/`, and `midi_rag_database.pkl` are ignored and should not be staged.
