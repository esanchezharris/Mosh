# Mosh

A native, hybrid digital audio workstation: **Tracktion Engine + JUCE 8/C++20** for the
DAW core, a **React/Vite UI in a JUCE 8 WebView**, a typed command spine (**MoshOps**) as
the single mutation API, traditional **VST3** plugins alongside **real-time neural inserts**
(Tier A, in-process via anira) and an **offline generative layer** (Tier B, model-neutral
adapter + Python service).

See `00_MOSH_MASTER_SPEC.md` for the architecture and `CLAUDE.md` for the build manifest /
checklist. Module specs are `01`–`06`.

## Architecture in one breath

```
React/Vite UI (JUCE 8 WebView)  ──execute_command(...) + snapshot/events──▶  MoshOps (C++)
                                          (the only coupling — swappable seam)        │
                                                                                      ▼
                                   Tracktion Engine store (ValueTree + UndoManager) · Source-graph/RenderLayer
                                                                                      │
                              Real-time audio graph (VST3 + Tier-A neural)   ·   Generative job manager → Python model service
```

Prime directives (never violated): **one mutation path** (every change is a MoshOps command),
**one undo system** (Tracktion's `UndoManager` under MoshOps), a **swappable seam** (the UI
couples only to the command surface + feed), a **tier wall** (Tier A in-process; Tier B is a
job), **ASTD** safety clamps everywhere (defeatable via Lab mode), and **cache by full
fingerprint**.

## Repo layout

```
CMakeLists.txt          # standalone-app target; CPM pinned deps; spine/tests/app split
cmake/CPM.cmake         # pinned CPM bootstrap (v0.42.3)
src/
  spine/                # mosh_spine — Tracktion-FREE command/state spine (unit-testable anywhere)
  app/                  # Mosh — JUCE 8 GUI app: WebView host + (Stage 1+) engine/MoshOps bootstrap
tests/                  # Catch2 units + the command-surface harness
ui/                     # React/Vite frontend (bundled) — the swappable client
service/                # Python generative model service (separate process; stdlib health stub)
```

## Build

Primary target is **macOS arm64**. The build is split so the load-bearing logic is verifiable
on any OS:

- **`mosh_spine` + `mosh_tests`** — pure logic over JUCE's data modules only (no Tracktion, no
  audio). Builds and runs on Windows/Linux/macOS. This is the highest-leverage verification.
- **`Mosh` (the app)** — the full JUCE + Tracktion + WebView standalone. macOS-primary.

```bash
# Spine + tests only (fast; any OS) — the command-surface harness lives here:
cmake -B build -G "Visual Studio 17 2022" -A x64 -DMOSH_BUILD_APP=OFF -DMOSH_BUILD_UI=OFF
cmake --build build --config Debug --target mosh_tests
ctest --test-dir build -C Debug --output-on-failure

# Full app (macOS arm64 primary):
cmake -B build -DMOSH_BUILD_APP=ON
cmake --build build --config Release
```

Dependencies are CPM-pinned (see `CMakeLists.txt`): JUCE 8.0.8, tracktion_engine v3.2.0,
anira v2.0.3, RTNeural, chowdsp_utils, Catch2 v3.9.1.

### Frontend (`ui/`)

```bash
cd ui && npm install && npm run build      # → ui/dist (loaded by the WebView)
npm run dev                                # browser dev with a mock bridge
```

### Model service (`service/`)

```bash
py -3.12 service/server.py --port 8765     # GET /health (zero external deps)
```

## Status

See `STATUS.md` for current stage, gate verification (what's proven on which OS), and the
next concrete step.
