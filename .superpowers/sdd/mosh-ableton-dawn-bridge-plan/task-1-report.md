# Task 1 report: Live 11 Remote Script and fake-Live tests

## Status

Complete. The task is implemented only under `resources/ableton/MoshDawnController/` plus this report. Live was not launched, and the real User Library and AbletonOSC checkout were not modified.

## Behavioral authority consulted

- `/Users/emiliosanchez-harris/Library/Application Support/REAPER/Scripts/KeepTake.lua`
- `/Users/emiliosanchez-harris/Library/Application Support/REAPER/Scripts/RedoTake.lua`
- `/Users/emiliosanchez-harris/Library/Application Support/REAPER/Scripts/GetCursorPosition.lua`
- `/Users/emiliosanchez-harris/Library/Application Support/REAPER/Scripts/MoveToMeasure.lua`
- Installed Live 11 Remote Scripts, read-only, under `/Applications/Ableton Live 11 Standard.app/Contents/App-Resources/MIDI Remote Scripts/`
- Owner-installed AbletonOSC and AudioInserter sources, read-only, to confirm scheduled ControlSurface work and the Live 11 arrangement APIs. The Live binary exposes `Track.delete_clip`, `Track.duplicate_clip_to_arrangement`, `Song.begin_undo_step`, `Song.end_undo_step`, and `Song.undo`; production code uses those forms.

The installed Live 11 Remote Script bytecode has the Python 3.7 magic number. The implementation therefore deliberately uses Python 3.7-compatible stdlib syntax and explicit no-excuse opt-outs for dataclass `slots=True`, which Python 3.7 does not support.

## Implementation

- `model.py`: frozen typed semantic action variants, request/response values, lifecycle state, and the narrow Live Object Model shape consumed by the engine.
- `protocol.py`: strict version-1 descriptor/request parsing, exact `127.0.0.1` enforcement, owner/mode-0600 descriptor checks, closed semantic action parsing, and versioned outbound NDJSON.
- `transport.py`: bounded non-blocking NDJSON framing, authenticated hello, reconnect retry backoff, inbound request queue, and safe close/reconnect behavior.
- `engine.py` + `topology.py`: revision/idempotency guard, Set/track/clip identity checks, current-lifecycle snapshots, and exact `put`, `keep`, `again`, `hear`, `stop`, and `seek` behavior.
- `surface.py` + `__init__.py`: Live `create_instance(c_instance)`, scheduled polling, a second scheduled main-thread drain before any Song mutation, initial/revision snapshots, and Live-safe teardown.
- `tests/`: dependency-free `unittest` fake-Live coverage for all brief-listed behavior and failure paths.

Keep prevalidates both the pending source/clip and the next armed audio target. It reuses only a writable, non-overlapping lower audio track that is not the next recording target; otherwise it inserts a source duplicate directly below, restores the exact source name, deletes all copied clips with `Track.delete_clip`, disarms the clone, and creates only the accepted arrangement clip. Source deletion occurs after destination creation. The archive plus restart is one owned Live undo step; any late `RuntimeError` closes and reverses the step and restores the controller marker.

The one-bar value is captured with the stop beat as `signature_numerator * 4 / signature_denominator`, before playback returns to the pass start.

## NDJSON contract produced for Task 2

Default descriptor path:

`~/Library/Application Support/Mosh/DAWN Bridge/remote-script.json`

`MOSH_DAWN_DESCRIPTOR` is an owner/test override. The descriptor must be a regular owner-owned mode-0600 file:

```json
{"protocol":1,"host":"127.0.0.1","port":4567,"secret":"at-least-32-characters"}
```

The Remote Script connects outward and first sends:

```json
{"protocol":1,"type":"hello","secret":"..."}
```

Inbound action:

```json
{"protocol":1,"type":"action","requestId":"...","expectedRevision":0,"action":"put|keep|again|hear|stop|seek","positionBeats":12.5}
```

`positionBeats` is required only for `seek`. Raw method/object actions are rejected and disconnect the malformed peer.

Outbound messages are `{"protocol":1,"type":"snapshot","state":{...}}` and `{"protocol":1,"type":"result","ok":true,"requestId":"...","revision":1,"state":{...},"error":"optional_code"}`.

## TDD evidence

### RED 1: action behavior

Command:

```sh
python3 -m unittest resources.ableton.MoshDawnController.tests.test_actions -v
```

Observed: `Ran 2 tests`; both errored at `DawnEngine.handle` with `NotImplementedError`; exit 1. This pinned topmost armed-audio selection and long-keep semantics before implementation.

### RED 2: typed descriptor/action boundary

Command:

```sh
python3 -m unittest resources.ableton.MoshDawnController.tests.test_protocol -v
```

Observed: `Ran 6 tests`; all errored in the importable `load_descriptor` / `parse_request` stubs with `NotImplementedError`; exit 1.

### RED 3: Live scheduling and teardown

Command:

```sh
python3 -m unittest resources.ableton.MoshDawnController.tests.test_surface -v
```

Observed: `Ran 2 tests`; both errored in the importable `MoshDawnController.__init__` stub with `NotImplementedError`; exit 1.

### GREEN and determinism

Command, run three times with the system Python 3.9 interpreter as the closest installed runnable interpreter to Live 11's Python 3.7:

```sh
PYTHONDONTWRITEBYTECODE=1 /usr/bin/python3 -m unittest discover \
  -s resources/ableton/MoshDawnController/tests -t . -q
```

Observed each run: `Ran 35 tests`, `OK` (0.006s, 0.007s, 0.007s).

## Additional verification

- Python 3.7 grammar parse over all 15 Python files: `Python 3.7 grammar: OK (15 files)`.
- Programming-skill no-excuse audit: `no violations in 15 file(s)`.
- Pure source LOC: every file <=250. Largest is `engine.py` at 222 pure LOC; it is in the warning band, so the next substantive engine edit should extract either take lifecycle or archive mutation rather than grow the file.
- `git diff --check`: clean.
- No `.pyc` or `__pycache__` artifacts retained.

## Self-review

- Single responsibility: protocol, transport, topology, model, action engine, Live surface, and fakes/tests are separated.
- Boundary purity: descriptor and inbound JSON are parsed once into frozen variants; no raw method or raw JSON object reaches the engine.
- Runtime compatibility: no third-party dependency and no post-3.7 syntax/API requirement.
- Mutation safety: all Song changes enter through the scheduled semantic action drain; destructive actions are revision/idempotency and identity guarded.
- Live preference preservation: fake-Live tests pin loop, punch-in, punch-out, count-in, and metronome unchanged.
- No unrelated files, owner projects, Ableton preferences, User Library scripts, or AbletonOSC files were touched.

## Remaining physical concern

Repository tests cannot prove Live's real audio recording, arrangement proxy identity stability, device/routing preservation on duplicate, single-undo UX, or by-ear playback. Those remain explicit owner scratch-Set gates; Live was intentionally not launched for this task.
