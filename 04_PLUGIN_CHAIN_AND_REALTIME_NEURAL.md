# 04 — The Plugin Chain: VST3 Hosting & Real-Time Neural Inserts (Tier A)

> **Status:** Design spec — source of truth for *how* this subsystem was built (v0, gate PASSED). New to the repo? Start with [ARCHITECTURE.md](ARCHITECTURE.md); build status is in [CLAUDE.md](CLAUDE.md).

*Scope: everything in a track's `pluginList` — traditional VST3 plugins (`ExternalPlugin`) and Mosh's real-time, in-process neural insert (a custom `tracktion::engine::Plugin` backed by anira). Includes PDC, RT-safety, and the ASTD safety clamp with a Lab-mode escape hatch. All of it is driven through MoshOps commands (`02`).*

**Depends on:** `01` (engine/tracks), `02` (the commands that invoke this), `06` (anira/RTNeural deps). **Consumed by:** `03` (faceplates), `05` (shares the ASTD module).
**Effort:** VST3 hosting is wiring; the neural insert is real custom DSP/threading work — the hardest *correctness* item (PDC + RT-safety).
**Primary references:** Tracktion `DistortionEffectDemo` (template for a custom `Plugin`), `tracktion_Plugin.h`, built-in effects under `modules/tracktion_engine/plugins/effects/`, `LatencyPlugin`; anira (`https://anira-project.github.io/anira/`) + `nn-inference-template` (Torsion-Audio); RTNeural.

> **v0 scope:** NAM/Proteus **ship** (mature, sample-accurate, ~2% CPU). RAVE is **staged behind a gate** (it works but adds latency — see §2.4). DDSP is in the model set (interpretable knobs). One model-agnostic insert hosts all of them.

---

## PART 1 — Hosting VST3 (`ExternalPlugin`)

### 1.1 Scanning (out-of-process)

In `JUCEApplication::initialise()`:
```cpp
if (te::PluginManager::startChildProcessPluginScan (commandLine)) return;  // this instance is a scan worker
```
The `PluginManager` owns a `juce::KnownPluginList`; scan flags via `PropertyStorage` (`numThreadsForPluginScanning`, `useSeparateProcessForScanning`); results persist via `PropertyStorage`.

### 1.2 Create & insert (via the `load_plugin` command)

```cpp
auto plugin = edit.getPluginCache().createNewPlugin (te::ExternalPlugin::xmlTypeName, desc);
track->pluginList.insertPlugin (plugin, index, nullptr);
```
`pluginList` (a `ValueTreeObjectList` over `PLUGIN` children) is the serial chain; order = signal order. The `load_plugin`/`reorder_plugin`/`remove_plugin` commands wrap these inside a transaction and emit `plugin_added`/`plugin_*` events. Detach: `Plugin::removeFromParent()`; full remove: `Plugin::deleteFromParent()`.

### 1.3 Params & editor

Params are `AutomatableParameter` (external: `ExternalAutomatableParameter`): `getAutomatableParameterByID`, `setParameter(v, sendNotification)`, `getCurrentValue()`, `getCurve()`. The `set_plugin_param` command drives these. **Editor window** (`open_plugin_editor` → native pop-out, `03 §4`): build a `juce::AudioProcessorEditor` from the hosted `AudioPluginInstance` `ExternalPlugin` wraps — **`// VERIFY`** the accessor (`getAudioPluginInstance`/window helper); thin API.

---

## PART 2 — The real-time neural insert (Tier A)

`NeuralInsertPlugin`: one model-agnostic custom plugin hosting any anira-compatible model (TorchScript/ONNX/TFLite). Added via `add_neural_insert(modelId)`; knobs via `set_neural_param`.

### 2.1 Subclass `te::Plugin` (template: `DistortionEffectDemo`)

```cpp
struct NeuralInsertPlugin : te::Plugin {
    static const char* xmlTypeName;                  // "moshNeuralInsert"
    NeuralInsertPlugin (te::PluginCreationInfo);
    ~NeuralInsertPlugin() override;                  // notifyListenersOfDeletion(); detach params
    juce::String getName() const override            { return "Mosh Neural"; }
    juce::String getPluginType() override            { return xmlTypeName; }
    void initialise (const te::PluginInitialisationInfo&) override;   // model load, anira prepare, warm-up
    void deinitialise() override;
    void applyToBuffer (const te::PluginRenderContext& fc) override;  // RT thread
    int  getNumOutputChannelsGivenInputs (int n) override { return n; }
    double getLatencySeconds() override;             // PDC — §2.4
    void restorePluginStateFromValueTree (const juce::ValueTree&) override;  // (mind the base64 quirk)
};
```
Process body reads `fc.destBuffer` (`juce::AudioBuffer<float>*`), `fc.bufferNumSamples`, `fc.bufferStartSample`; MIDI via `fc.bufferForMidiMessages`. Base class stores `sampleRate`, `blockSizeSamples`.

### 2.2 Register & instantiate

```cpp
engine.getPluginManager().createBuiltInType<NeuralInsertPlugin>();              // once
auto p = edit.getPluginCache().createNewPlugin (NeuralInsertPlugin::xmlTypeName, {});  // per insert
track->pluginList.insertPlugin (p, index, nullptr);
```
Reference built-ins: `tracktion_ToneGenerator`, `EqualiserPlugin`, `ReverbPlugin`, `VolumeAndPanPlugin`, `LatencyPlugin`.

### 2.3 anira (RT-safe inference)

anira decouples inference from the audio callback onto a static high-priority thread pool and processes fixed-size chunks independent of host buffer size. **Don't run a forward pass inline in `applyToBuffer`** unless the model is tiny and provably RT-safe (NAM/Proteus via RTNeural may run inline; RAVE/DDSP go through anira's pool).

```cpp
// initialise():
anira::InferenceConfig cfg ({{ modelPath, anira::InferenceBackend::ONNX }},   // or LibTorch/TFLite per model
                            {{ inShape }, { outShape }}, maxInferenceTimeMs);
inferenceHandler = std::make_unique<anira::InferenceHandler>(/*…*/ cfg);
inferenceHandler->prepare({ sampleRate, blockSizeSamples /*…*/ });
// warm up a few inferences here.
// applyToBuffer(): push/pull, no alloc, no locks.
inferenceHandler->process (fc.destBuffer->getArrayOfWritePointers(), fc.bufferNumSamples);
```
Backend per model (anira benchmarks): ONNX for stateless, LibTorch for stateful (RAVE), TFLite for tiny nets. Formats: RAVE/DDSP → TorchScript; NAM → `.nam`; Proteus → RTNeural JSON. Consider the **Neutone `.nm`** convention for one loader across RAVE/DDSP/TCN. The **`nn-inference-template`** is the working reference for the anira plumbing.

### 2.4 Latency / PDC (CRITICAL)

```cpp
double NeuralInsertPlugin::getLatencySeconds() override { return totalLatencySamples / sampleRate; }
```
Base is verbatim `virtual double getLatencySeconds() { return 0.0; }` (a virtual, seconds, no member). `PluginNode::prepareToPlay()` reads it; the graph inserts balancing latency at sum points ("max of all input latencies"). **The reported value must equal the actual delay** or parallel tracks drift. Compute `totalLatencySamples` anira-style: worst-case inference (rounded up to an integer multiple of the host block) + buffer-adaptation + model-internal latency.

- **RAVE:** standard RAVE adds ~200–500 ms on Apple Silicon (fine as an insert with PDC; not live monitoring). For live monitoring, target the **BRAVE** causal variant (<10 ms). Report the true figure either way. *This latency is exactly why RAVE is gated and NAM/Proteus ship first.*
- **Bypass bug (known):** bypassed-plugin PDC depends on `PluginRenderContext::allowBypassedProcessing` / the `canProcessBypassed` branch in `tracktion_PluginNode.cpp` (historical inverted-logic bug, forum #53709). **Test bypass explicitly.**
- **Validate with `LatencyPlugin`:** A/B the insert track against a dry copy — no drift.

### 2.5 Knobs as AutomatableParameters

```cpp
gainValue.referTo (state, IDs::gain, getUndoManager(), 1.0f);
gainParam = addParam ("gain", TRANS("Gain"), { 0.0f, 1.0f });
gainParam->attachToCurrentValue (gainValue);
```
RAVE → first ~8 latent dims (+bias/scale, latent-noise, stereo-width); DDSP → pitch/loudness/harmonic-distribution/noise; NAM → gain + EQ. `set_neural_param` drives these. Bind a UI control by wrapping the param in a `ValueSource` (demo's `ParameterValueSource`).

### 2.6 ASTD + Lab mode (shared safety layer)

Every continuous neural knob is surfaced as a perceptually-uniform **0–100 UI control mapped to a raw range clamped below its quality-collapse point**. Calibrate the collapse point **offline** by sweeping the param and scoring with the judge panel (`05 §7`); store the safe range per (model, param) in the registry.

**Lab mode (the escape hatch):** `set_neural_lab_mode(insertId, on)` unlocks the raw range beyond the clamp, behind a clear visual warning, with per-parameter reset and easy A/B. Lab mode is never used by default presets. ASTD is a **trust feature, not a cage** — the default protects; the producer can choose the broken/alien extremes deliberately. Implement once, generically (`src/plugins/neural/astd.*`), shared with Tier B (`05 §6`).

### 2.7 Operational safety (distinct from ASTD; per lane)

ASTD is *semantic* safety (knobs that don't sound broken). Live neural models also need *operational* safety, which differs by model class:
- **NAM/Proteus (deterministic emulation):** standard plugin hygiene — correct gain staging, true bypass, preset sanity, low-noise startup state.
- **RAVE/DDSP (fail like unstable instruments, not deterministic effects):** always expose a **dry/wet blend** and a **model reset**; a runaway latent shouldn't be unrecoverable.
- **Live generative instruments (MRT2, deferred — `07`):** prioritize operational over semantic safety — **warmup** (no first-block stall), **state reset on transport stop**, **CPU/GPU headroom monitoring**, and a **hard-bypass path if latency spikes**. These are the invariants the neural host must enforce before any such model is wired in.

Bake the dry/wet + reset affordances into the `NeuralInsertPlugin` host generically so every live model inherits them.

---

## 3. Threading

`applyToBuffer` runs on `tracktion_graph`'s lock-free multithreaded node player, off the message thread — RT-safe (no locks/allocs); anira's pool absorbs model compute and you report the buffering as latency. Model loading / registry I/O / ASTD calibration are background/startup, never on the audio thread. Meters feeding the UI are tapped and **decimated** (`02 §4.2`).

---

## 4. Verification gates

- **Stage 3 (VST3):** VST3 synth from a MIDI clip + effect on a wave clip, **all via MoshOps commands**; native editor opens; one param automates; persists.
- **Stage 4 (Tier A):** NAM tone + RAVE morph audible; **PDC null test passes (no drift)**; bypass correct (test the known bug); no audio-thread dropouts; ASTD clamps hold and Lab-mode unlock works — all via commands.

## 5. Honest gaps / `// VERIFY`

- `ExternalPlugin` editor-window accessor.
- `LatencyPlugin` `.h/.cpp` source (copy the latency-reporting pattern exactly).
- anira `InferenceHandler::process`/`prepare` signatures on the pinned anira version.
- NAM/Proteus inline (RTNeural) vs via anira on target hardware — **measure**; default to anira's pool if unsure.
