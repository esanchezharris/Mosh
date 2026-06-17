# Mosh — Master Build Spec (v0)

> **Status:** Design spec — the source of truth for *how* Mosh v0 was built (all six stages PASSED). **New to the repo? Start with [ARCHITECTURE.md](ARCHITECTURE.md)** for the 2-minute on-ramp, then return here for depth. Current build/gate status lives in [CLAUDE.md](CLAUDE.md).
> *Spec-set numbering note:* `02` lives at [docs/02_MOSHOPS_CONTRACT.md](docs/02_MOSHOPS_CONTRACT.md) (reconstructed); there is no standalone `03` — the WebView UI is covered by [ARCHITECTURE.md](ARCHITECTURE.md) plus `docs/02_MOSHOPS_CONTRACT.md`.

*A native, hybrid digital audio workstation. Tracktion Engine + JUCE 8/C++20 for the audio + DAW core; a React/Vite arrangement UI in a JUCE 8 WebView; a typed command surface (**MoshOps**) as the single mutation API; traditional VST3 plugins alongside two neural tiers — real-time in-process inserts (NAM/Proteus/RAVE/DDSP) and an offline generative layer behind a model-neutral adapter (Stable Audio 3 first).*

**This is the entry document.** It defines the vision, the locked decisions, the architecture, the module map, and the staged build plan. Each module has its own spec (`01`–`06`); this doc says what they are and the order to build them. Written to seed an autonomous overnight coding run — assume the implementing agent does **not** have the conversation that produced this.

> **This version supersedes a prior draft** that deferred the command surface and specced a fully-custom native UI. After an architecture review, four changes were adopted: (1) **MoshOps** typed-command surface is the mutation spine from day one (Tracktion's UndoManager stays the undo *implementation* underneath); (2) the v0 UI is a **WebView/React** arrangement, built fresh and conventional; (3) the generative model sits behind a **model-neutral adapter** and a proper **job service**; (4) the ASTD safety clamp gains a **Lab-mode** escape hatch. Rationale for each is in `ARCHITECTURE_REVIEW.md`.

---

## 0. What Mosh is (and is not)

**Is:** a fully functional DAW — import/record audio and MIDI, arrange clips on a timeline, host VST3 instruments/effects, mix, export — with a **non-destructive neural transform layer** woven into the same signal model. Neural processing is just another kind of insert/layer in a track, never a separate mode.

**Is not (in v0):** multiplayer; an AI-operator ("B-5"/Monster) app; a pixel-final UI. Those are deferred. v0 is single-player and driven by direct manipulation through the UI. The architecture must not *preclude* the deferred layers — and the MoshOps spine is precisely what keeps them cheap to add later — but must not *build* them now.

**The non-destructive principle (the spine of the audio model).** Every neural edit is one of three things, never a silent flatten:
1. a **reversible real-time insert** (Tier A) — a plugin in the track chain; the source clip is untouched;
2. a **lineage-preserving offline render** (Tier B) — a **RenderLayer** whose *parameters* are the durable artifact and whose *audio* is a cache (committed as a take); the source take always survives, and the layer is re-renderable and reversible;
3. a hosted VST3 insert.

The source of truth is always the upstream source (synth preset / MIDI / automation / original take). Rendered neural audio is a cache keyed by a **full fingerprint** (`05 §4`); when the source or any fingerprint input changes, the cache invalidates and re-renders.

**The swappable-frontend principle (the spine of the app).** The React UI talks to C++ **only** through MoshOps `execute_command(...)` and a **snapshot + events** state feed. No direct coupling to Tracktion, no audio on the web thread. The frontend is disposable by construction: any UI that can render a snapshot and apply typed events is a valid client. This is deliberate — the v0 UI is a conventional, throwaway-grade traditional-DAW layout meant to surface all controls and be consolidated into something beautiful later.

---

## 1. Locked decisions (do not re-litigate)

| Decision | Choice | Rationale |
|---|---|---|
| **Platform** | **macOS on Apple Silicon (arm64) ONLY for v0** | Lean fully into MLX/CoreML/Metal + unified-memory zero-copy; no cross-platform hedging. Windows/Linux/CUDA are explicit non-goals for v0 (revisit later, or upstream/Google gets there first). |
| Engine | **Tracktion Engine** (pin a commit) | Full edit/clip/automation/render/host model; ValueTree-backed store. |
| Language / core | **C++20**, JUCE 8 | — |
| Build scaffold | **Pamplejuce as template**, adapted to a **standalone-app** target + a Vite frontend build | Pamplejuce is plugin-shaped; we adopt its CMake/CPM/CI/test hygiene. See `06`. |
| **Mutation API** | **MoshOps / DslExecutor** — every user-visible mutation is a typed command with a structured result + JSONL log | One validated entry point; the taste-signal flywheel; the agent/MCP/multiplayer substrate. `02`. |
| State store | **Tracktion `Edit::state` (ValueTree) + `edit.getUndoManager()` as the undo *implementation* under MoshOps** | No second undo system; raw tree mutation is internal-only, reached through MoshOps. |
| State feed to UI | **Snapshot + typed events** — full snapshot on load/resync, typed deltas during a session | Maximum decoupling: any UI renders a snapshot cold; deltas keep 60fps surfaces cheap. `02 §4`. |
| UI | **JUCE 8 WebView shell + React/Vite arrangement**, built fresh, conventional layout | Reuses the web-native design direction; de-risks the timeline; swappable. Plugin editors are native pop-outs. `03`. |
| Tier A (real-time neural) | **One model-agnostic in-process insert** (anira-backed). **NAM/Proteus ship in v0; RAVE staged behind a gate; DDSP in the set** | Custom `tracktion::engine::Plugin` in the track `pluginList`. `04`. |
| Tier B (offline generative) | **Model-neutral `GenerativeModelAdapter` + a generative job service.** **`FakeAdapter` for bring-up; `StableAudio3Adapter` first real adapter** | SA3 is an adapter, not the architecture. Files+manifests, full cache fingerprint. `05`. |
| Safety | **ASTD clamp by default + a Lab-mode escape hatch** | Trusted "never sounds broken" default; unlock the broken/alien range deliberately. `04 §6`, `05 §6`. |
| Collaboration | **None in v0** | Single-player. Deferred (MoshOps log is the future substrate). |

**Explicitly NOT in v0:** B-5/Monster operator behavior (reserved UI slot only); full multiplayer / CRDT op-log (MoshOps JSONL is a semantic audit trail, not yet a CRDT); on-device generative tier (SAO-Small) and Medium→Small vector transfer; LoRA-base + vector layering; timestep-scheduled steering; the full bespoke Context-Drawers system (a simple panel/drawer set is fine); **Magenta RealTime 2 (MRT2)** as a live generative-instrument lane (now *more* viable since we're Mac-only, but not core v0 — see `07`).

---

## 2. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ MOSH UI — React/Vite in a JUCE 8 WebView (bundled, local, owned)                   │
│   conventional DAW layout: track list · timeline lanes · transport · mixer · drawers│
│   calls execute_command(...) · subscribes to snapshot + typed events               │
│   NO audio on web thread · telemetry decimated to 30–60 Hz · plugin editors native  │
└───────────────────────────────┬────────────────────────────────────────────────────┘
                                 │  (the swappable seam — the only coupling)
┌───────────────────────────────▼────────────────────────────────────────────────────┐
│ MoshOps / DslExecutor  (C++)                                                         │
│   typed commands · validation · undo transactions · structured results · JSONL log   │
│   get_snapshot() + event emitter (snapshot+events) · same surface for UI / tests /   │
│   future Monster / future MCP / future multiplayer                                   │
└───────────────┬───────────────────────────────────────┬──────────────────────────────┘
                │                                         │
┌───────────────▼───────────────┐         ┌───────────────▼────────────────────────────┐
│ Tracktion Engine Store          │         │ Source-Graph / RenderLayer Model            │
│  Edit · tracks · clips · plugins │         │  sources · transforms · cache fingerprints  │
│  ValueTree + UndoManager         │         │  provenance · accept/reject (taste labels)  │
└───────────────┬───────────────┘         └───────────────┬────────────────────────────┘
                │                                           │
┌───────────────▼───────────────┐         ┌───────────────▼────────────────────────────┐
│ Real-Time Audio Graph           │         │ Generative Job Manager                      │
│  VST3/AU inserts                 │         │  submit/status/progress/cancel · queue       │
│  NeuralInsertPlugin (Tier A,     │         │  cache + result manifests · cancel-on-close │
│  anira: NAM/Proteus/RAVE/DDSP)   │         └───────────────┬────────────────────────────┘
└───────────────┬───────────────┘                          │  files + manifests, local job protocol
                │                            ┌───────────────▼────────────────────────────┐
   audio I/O (Tracktion DeviceManager)       │ Model Service process (Python)               │
                                             │  GenerativeModelAdapter:                     │
                                             │   FakeAdapter (bring-up) · StableAudio3Adapter│
                                             │   (MLX, steering, colors, judge panel)        │
                                             └──────────────────────────────────────────────┘
```

**The two neural tiers never mix in one signal path.** Tier A models stream and run **in-process** on the audio graph (anira). Tier B (generative) is a **job**: a region is rendered, cached, committed as a layer, re-rendered when its fingerprint changes — never a live downstream insert. Because Tier A covers real-time in-process, **there is no real-time sidecar**; the only out-of-process component is the offline model service, reached through the job manager over a local file/manifest protocol.

---

## 3. Module map (work packages)

| Spec | Module | One-line scope | Effort |
|---|---|---|---|
| `01_ENGINE_STATE_AND_SOURCE_GRAPH.md` | Engine store + source-graph | Tracktion bootstrap, object model, ValueTree store, transport, device, the RenderLayer/source-graph model | API wiring + the RenderLayer model |
| `02_MOSHOPS_AND_STATE_FEED.md` | The command spine | Typed command catalog, result envelope, validation, undo transactions, JSONL event log, the snapshot+events state feed | **Core new design — the spine** |
| `03_WEBVIEW_UI.md` | The (swappable) frontend | JUCE 8 WebView shell, the bridge, the conventional React/Vite arrangement, native plugin pop-outs, telemetry decimation | Frontend — kept deliberately thin/disposable |
| `04_PLUGIN_CHAIN_AND_REALTIME_NEURAL.md` | The plugin chain | VST3 hosting (`ExternalPlugin`) + the custom `Plugin` seam + Tier-A neural (NAM/Proteus ship, RAVE gated, DDSP), latency/PDC, RT-safety, ASTD + Lab mode | API wiring + real custom DSP work |
| `05_GENERATIVE_LAYER.md` | Tier B / generative | The adapter abstraction, the job service, the RenderLayer + cache fingerprint, render→accept-as-take flow, SA3 specifics (colors, two vocabularies, re-imagine, init-latent cache, judge QA, composition cap) | API wiring + adapter/service + research carve-out |
| `06_BUILD_TOOLING_AND_RUN_PLAN.md` | Build + run | Pamplejuce-adapted CMake/CPM + Vite build, deps, CI/tests, service packaging, the staged run plan with gates | Setup |
| `07_DEFERRED_AND_MODEL_NOTES.md` | Context / parking lot | Model-landscape inventory, deferred lanes (MRT2, SAO-Small, on-device, LoRA, timestep steering), per-lane safety profiles, license posture | Not build work — context |

Read order: `00` → `06` (set up build) → `01` → `02` → `03` → `04` → `05`.

---

## 4. Build stages & gates

Each stage must pass its gate before the next. The "MVP in a night" caveat stands: the **scaffold** (Stage 0–1) is fast; a **usable instrument** (through Stage 6) is a focused multi-session build. Report against the concrete gate, never "looks done."

- **Stage 0 — Skeleton (`06`).** App builds (standalone target); JUCE 8 WebView loads a bundled React/Vite placeholder; CPM deps resolve; the generative service stub answers a health check.
  - *Gate:* window opens on macOS arm64; WebView shows the placeholder; service `/health` returns ok.

- **Stage 1 — Engine + MoshOps + state feed (`01`,`02`).** Tracktion up; MoshOps facade with the result envelope, validation, Tracktion-undo transactions, JSONL log; `get_snapshot()` + typed event stream; first commands (`create_track`, `import_clip`, `set_transport`).
  - *Gate:* the WebView renders a snapshot cold; issues `create_track`+`import_clip` through MoshOps; audio loops; undo/redo through MoshOps; the JSONL log records the semantic commands; save/reload restores.

- **Stage 2 — WebView arrangement (`03`).** Conventional layout: track headers, timeline lanes, clips, transport bar, mixer stub; playhead + meters via **decimated** events (30–60 Hz); all mutation through MoshOps; plugin editors reserved native.
  - *Gate:* arrange a session entirely from the WebView (move/trim/split clips, transport, loop) and it feels responsive; reload/rebuild the React bundle with **zero** backend change and it still works (proves swappability).

- **Stage 3 — VST3 hosting via commands (`04`).** `load_plugin`/`remove_plugin`/`reorder_plugin`/`set_plugin_param`/`bypass_plugin`/`open_plugin_editor`; native editor pop-outs.
  - *Gate:* a VST3 synth plays from a MIDI clip and a VST3 effect alters a wave clip, **all via MoshOps commands**; editor opens native; persists.

- **Stage 4 — Tier-A real-time neural (`04`).** `NeuralInsertPlugin` (anira); **NAM/Proteus ship**, **RAVE behind a gate**, DDSP in the set; `add_neural_insert`/`set_neural_param`; correct latency via `getLatencySeconds()`; ASTD-clamped knobs + Lab mode.
  - *Gate:* NAM tone and RAVE morph audible; **PDC null test passes (no drift vs dry copy)**; bypass correct (test the known bug); no audio-thread dropouts; ASTD clamps hold and Lab-mode unlock works — all driven via commands.

- **Stage 5 — Generative layer (`05`).** Build **`FakeAdapter` first** and prove the entire orchestration with it: the job service (submit/status/progress/cancel + lifecycle), the RenderLayer model + full cache fingerprint, `create_render_layer`/`render_layer`/`cancel_render`/`accept_render`/`reject_render`/`bypass_layer`/`freeze_layer`/`bounce_layer`. **Then swap in `StableAudio3Adapter`** (colors, ASTD, the two control vocabularies, re-imagine, init-latent cache, judge QA, composition cap).
  - *Gate (Fake):* full generative loop via commands — submit job → progress events → render → audition → A/B vs source → accept-as-layer or reject; cache hit/miss correct; source change → dirty → re-render; the JSONL log records accept/reject as **taste labels**.
  - *Gate (SA3):* a real color and a real re-imagine render commit as an auditionable layer/take with a quality readout; `/colors` drives the knobs and their ASTD clamps; init-latent cache reports a hit on seed-only change.

- **Stage 6 — Consolidation (`03`,`04`,`05`).** Mixer polish, two-theme system, reserved B-5 slot, optional prompt-concision rewriter and quality readout.
  - *Gate:* full producer loop from the UI with no code — import/record → arrange → host VST3 → Tier-A insert → generative transform → mix → export; undo/redo correct throughout (everything routes through MoshOps).

Within Stage 2/6 build the arrangement incrementally (static clips → drag/move → trim/split → zoom/snap → marquee). It's lower-risk than the prior plan because it's React over a clean contract, not raw-JUCE from scratch.

---

## 5. Repository layout (target)

```
mosh/
├── CMakeLists.txt                 # standalone-app target; CPM deps; Vite build hook
├── cmake/                         # Pamplejuce-derived helpers, adapted to app
├── libs/                          # CPM: JUCE, tracktion_engine, anira, RTNeural, chowdsp_utils
├── src/
│   ├── Main.cpp                   # JUCEApplication; out-of-process scan hook; Engine + MoshOps bootstrap
│   ├── app/                       # window, WebView shell host, app-level wiring, theme tokens
│   ├── engine/                    # Engine wrapper, Edit lifecycle, device, transport            (01)
│   ├── state/                     # ValueTree IDs, the RenderLayer model, snapshot serialization (01,02)
│   ├── moshops/                   # DslExecutor: command catalog, validation, results, JSONL log,
│   │                              #   the snapshot+events feed                                   (02)
│   ├── webview/                   # JUCE WebView bridge: execute_command relay, event push, native fns (03)
│   ├── plugins/
│   │   ├── hosting/               # VST3 scan + ExternalPlugin glue                               (04)
│   │   └── neural/                # NeuralInsertPlugin (Tier A), anira host, model registry, ASTD  (04)
│   └── generative/                # job manager, GenerativeModelAdapter, FakeAdapter, SA3Adapter,
│                                  #   service client (file/manifest protocol)                     (05)
├── ui/                            # React/Vite frontend (bundled into the app) — SWAPPABLE        (03)
│   ├── src/                       #   renders snapshot, applies events, emits commands
│   └── vite.config.ts
├── service/                       # the model service process (Python)                            (05)
│   ├── server.py                  #   job protocol; lifecycle
│   ├── adapters/                  #   fake_adapter.py, stable_audio3_adapter.py (carved from research)
│   ├── colors/                    #   vecs.npz, ASTD collapse-α registry, color metadata
│   └── judges/                    #   CLAP / MuQ / Audiobox / MERT panel (QA + ASTD calibration)
└── tests/                         # Catch2 + a command-surface harness                            (06)
```

External (not in-repo, pointed at by the SA3 adapter): the MLX SA3 port, the judge venv, the CLAP checkpoint (parameterized via env vars; see `05`).

---

## 6. Cross-cutting invariants

- **One mutation path:** every user-visible state change goes through a MoshOps command that (validates → runs a Tracktion undo transaction → emits events → writes a JSONL line). UI never mutates Tracktion directly; raw tree writes are internal to command handlers. (`02`)
- **One undo system:** Tracktion's `UndoManager` is the undo *implementation*; MoshOps commands wrap transactions. No second UndoManager, no shadow model.
- **The swappable seam:** the frontend couples to the backend **only** via `execute_command` + the snapshot/events feed. Pure view state (drawer open, zoom, scroll, selection) is UI-local and is **not** a mutation command (keeps the log a clean semantic/taste trail). (`02 §3`, `03`)
- **Threading:** model + UI-bridge on the message thread; audio in `applyToBuffer` on the graph's RT threads; rendering / thumbnails / freeze / all service I/O on background threads; **the audio thread never blocks on neural work**; telemetry to the UI is decimated (30–60 Hz), never per-block.
- **Tier wall:** Tier A in-process (anira); Tier B is a job through the adapter/service. No generative model in anira; no real-time sidecar.
- **ASTD everywhere, defeatable:** every over-driveable neural param is a 0–100 UI control clamped below quality-collapse by default; Lab mode unlocks the raw range behind a warning. (`04 §6`, `05 §6`)
- **Cache by full fingerprint:** Tier-B renders are caches keyed by the complete fingerprint in `05 §4` (not just source+params), to avoid wrong-cache-reuse bugs.
- **Honesty about gaps:** thin Tracktion APIs are flagged `// VERIFY` in the modules (VST3 editor accessor; takes/comp API; `LatencyPlugin` source; `Renderer::Parameters` fields). Resolve against the pinned clone; prefer the documented file-based fallback when uncertain.

---

## 7. Glossary

- **MoshOps / DslExecutor** — the typed-command mutation surface; the single API the UI/tests/future-agent use to change project state. Returns a structured result, writes a JSONL semantic log.
- **Snapshot + events** — the state feed: a full session snapshot on load/resync, plus typed deltas during a session.
- **Edit** — Tracktion's arrangement/project object; owns the ValueTree store, UndoManager, PluginCache, TransportControl.
- **Source-graph** — Mosh's non-destructive model: source clip → (optional neural analysis) → neural transform layer → mix.
- **RenderLayer** — a Tier-B transform record: input ref, time range, adapter+version, params, seed, safety-mapping version, source fingerprint, cache key/artifact, status, provenance, kept-flag. (`05 §3`)
- **Tier A** — real-time, in-process neural inserts (anira). NAM/Proteus (ship), RAVE (gated), DDSP.
- **Tier B** — offline generative layer behind a `GenerativeModelAdapter` via a job service.
- **GenerativeModelAdapter / FakeAdapter / StableAudio3Adapter** — the model-neutral interface; a stub for bring-up; the first real adapter.
- **Color** — a named SA3 steering direction (e.g. `grit`, `air`), validated by the paraphrase gate; surfaced as an ASTD-clamped knob.
- **ASTD** — quality-aware slider reparameterization: clamp a param's UI range below the point production quality collapses. Defeatable via Lab mode.
- **Re-imagine** — SA3 audio2audio: encode a loop, re-noise, denoise with steering; low re-noise keeps the song.
- **Take** — Tracktion's alternate clip recordings; used to hold generative renders non-destructively (audition → accept).
- **Lab mode** — the ASTD escape hatch: unlock the unsafe/broken/alien range behind a warning.

See module specs for concrete classes, methods, command signatures, and code sketches.
