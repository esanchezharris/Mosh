# Bundled drum kits

`mosh-kit/` is Mosh's built-in default drum kit. The eight one-shots are
**synthesised** by [`generate_kit.py`](generate_kit.py) (sines + seeded noise +
envelopes, Python stdlib only) — nothing is sampled from a third party, so the
kit is rights-clean and the C++ build never needs Python. The WAVs are committed.

The native sampler (`src/moshops/MoshOps.cpp`, `kDefaultKit[]`) maps each file to
the GM percussion pitch the UI drum sequencer uses
(`ui/src/ui/drumGrid.ts` → `DRUM_LANES`):

| file             | pad        | GM pitch |
|------------------|------------|----------|
| `kick.wav`       | Kick       | 36 |
| `snare.wav`      | Snare      | 38 |
| `clap.wav`       | Clap       | 39 |
| `hat_closed.wav` | Closed Hat | 42 |
| `tom_low.wav`    | Low Tom    | 45 |
| `hat_open.wav`   | Open Hat   | 46 |
| `tom_mid.wav`    | Mid Tom    | 47 |
| `crash.wav`      | Crash      | 49 |

Each pad is loaded with `keyNote == minNote == maxNote == pitch` (so it plays at
unity pitch on exactly its lane) and `openEnded = true` (a short note still rings
the whole one-shot — drum behaviour).

CMake stages this directory into `Mosh.app/Contents/Resources/drumkits`
(see `cmake/BuildUI.cmake`-adjacent staging in `CMakeLists.txt`); the runtime
resolver is `MoshOps::drumKitDir()` (env `MOSH_DRUMKIT_DIR` overrides for tests).

To regenerate: `python3 generate_kit.py`.
