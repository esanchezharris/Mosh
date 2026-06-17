# 07 — Deferred Lanes & Model-Landscape Notes

> **Status:** Context & parking-lot — model landscape, deferred lanes, license posture. **Not build work.** For what's actually built, see [ARCHITECTURE.md](ARCHITECTURE.md).

*Durable home for the model-survey findings and the deferred lanes, so they live somewhere without bloating the build specs (`00`–`06`). Nothing here is v0 build work; it's context, parking lot, and the model inventory the adapter/host design must keep room for. Read for orientation, not as instructions.*

> **Scope reminder:** this is **private personal research** and **macOS / Apple Silicon only** for v0. Two consequences run through this doc: (1) the licensing column below is recorded **for awareness only** — it does **not** gate any v0 choice (it only matters *if* the project later goes commercial); (2) Mac-only removes the main objection to Apple-Silicon-centric models like MRT2.

---

## 1. The candidate inventory (model → role → notes)

What each surveyed model is for, whether it's truly real-time, and its role in Mosh. The v0 picks are in `04`/`05`; this is the fuller landscape.

| Model | Real-time? | Mosh role | Notes (Mac-only context) |
|---|---|---|---|
| **Stable Audio 3 (Medium)** | No (offline job) | **v0 flagship offline generative layer** (`05`) | text→audio, audio→audio, inpaint, continuation, LoRA; stereo 44.1 kHz; **≤380s**; official MLX (Apple) path. No JUCE-native route → service boundary is correct. |
| **Stable Audio 3 (Small-Music / Small-SFX)** | No (offline, CPU-capable) | Lighter offline option / fast preview | **≤120s**; stereo 44.1 kHz; CPU-capable. |
| **Stable Audio Open Small** | No | **Optional bring-up rung** (`05 §2`) | ~11s, Arm-CPU optimized; real-but-light adapter to shake out the service before SA3 Medium. Optional for us (FakeAdapter already de-risks orchestration). |
| **Stable Audio Open 1.0** | No | Alternate fallback adapter | ~47s, stereo 44.1 kHz; generation-oriented. |
| **Neural Amp Modeler (NAM)** | **Yes** | **v0 Tier-A insert, ship first** (`04`) | `.nam` models; mature real-time VST3/AU; the cleanest real-time pick. |
| **GuitarML Proteus** | **Yes** | v0 Tier-A insert (alongside NAM) | RTNeural-based LSTM capture. (License GPL-3 — irrelevant to private research.) |
| **RAVE** | **Yes** (≈20× RT on laptop CPU per project page; ~200–500 ms latency, BRAVE <10 ms) | **v0 Tier-A insert, staged behind a latency gate** (`04`) | Timbre transfer + latent play; TorchScript/streaming/ONNX export. Gated for **latency**, not license. |
| **DDSP** | Partial | v0 Tier-A insert (interpretable knobs) / future synthesis lane | pitch/loudness/harmonic-noise control; TF dependency; best on monophonic/instrument material. |
| **Magenta RealTime 2 (MRT2)** | **Yes (Apple Silicon)** | **Deferred live generative-instrument lane** (§2) | 40 ms frames, ~200 ms control latency; text+audio+**MIDI**; C++ engine + AUv3 example; sizes 230M / 2.4B. Mac-only real-time = a *fit* for us, not a liability. |
| **RTNeural** | Yes | **Infrastructure** for small embedded models (`04`) | C++ real-time inference; JSON export from TF/PyTorch. |
| **anira** | n/a (pattern) | **Infrastructure** — the Tier-A host (`04`) | Decouples inference from the callback; ONNX/LibTorch/TFLite backends; latency mgmt. |
| **AudioCraft / MusicGen / AudioGen** | No | Benchmark/comparator only | Melody+text conditioning; offline. (Weights CC-BY-NC — irrelevant to private research.) |

---

## 2. MRT2 — the deferred live generative-instrument lane

**What it is.** A real-time *generative instrument*: it doesn't process existing audio (that's a Tier-A insert) and it isn't an offline job (that's Tier B). It **generates** audio live, conditioned by **style text + style audio + MIDI note control** (with Auto-Strum vs explicit onset, and a drums on/off control). 40 ms frames, ~200 ms control latency, a C++ inference engine, JAX/MLX Python libs, and an AUv3 example. Sizes 230M (runs on "any Mac") and 2.4B (Pro/Max-class).

**Why it's a third category, and where it fits.** It's a live neural **instrument** — in Tracktion terms it sits where a VST3 synth sits (takes MIDI, emits audio), on the **live side**, hosted through the same custom-`Plugin`/anira seam as Tier A but in an *instrument* role rather than an *insert* role. So the only architectural change it implies is widening the Tier-A framing from "real-time neural **inserts**" to "real-time neural **inserts and instruments**." No rework — which is a good sign the two-tier cut is right.

**Why it's deferred anyway.** It wasn't in the locked v0 scope (VST3 + SA3 + Tier-A inserts), and the survey itself recommends treating it as experimental rather than core. **But Mac-only changes its calculus:** its real-time path being Apple-Silicon-centric was the main strike against it, and that strike is gone. So MRT2 is the **most natural first post-v0 addition** — a premium "playable AI instrument" lane — rather than a far-future item.

**If/when added, it needs (operational, not semantic, safety — `04 §2.7`):** warmup (no first-block stall), state reset on transport stop, CPU/GPU headroom monitoring, hard-bypass on latency spike, and a UI treated as a hybrid instrument/performance surface (MIDI + style controls), not a generic effect.

**Open items to verify before an adapter:** the official output sample-rate statement, and the exact weight-license terms for the specific checkpoints (Apache at repo level; verify per-checkpoint).

---

## 3. SA3 facts worth pinning (for the adapter)

- **Modes:** text→audio, audio→audio (re-imagine), inpaint, continuation, LoRA loading. v0 surfaces **generate + re-imagine** in the UI; **inpaint + continuation are adapter-available** and can be exposed later (they're in `generation_modes` and the cache-key `mode`, `05 §2`, `01 §4.3`).
- **Caps:** Small ≤ 120s, Medium ≤ 380s. Same autoencoder, **stereo 44.1 kHz**.
- **Runtime:** official **MLX (Apple Silicon)** path — the v0 target — plus CUDA/TensorRT (not used in v0) and CPU-capable small models.
- **No JUCE-native route** → the local job service + file/manifest boundary (`05 §4`) is the right integration, not in-process.
- **Control layer (your research, reused):** activation steering + the paraphrase gate + the judge panel + ASTD. The reused asset is the *control surface*, not the base model.

---

## 4. Per-lane safety profiles (consolidated)

Safety differs by model class; `04 §2.6–2.7` and `05 §6–§7` implement these. Summary:

- **SA3 semantic-edit layer (Tier B):** *semantic* safety — ASTD-clamped colors by default, Lab-mode escape hatch. (Strong steering trades off production quality — your research's finding — which is exactly why ASTD exists.)
- **Live generative instrument (MRT2, deferred):** *operational* safety — warmup, state-reset-on-stop, headroom monitoring, hard-bypass on latency spike.
- **RAVE / DDSP (Tier A, fail like unstable instruments):** always expose **dry/wet** + **model reset**.
- **NAM / Proteus (Tier A, deterministic emulation):** standard plugin hygiene — gain staging, true bypass, preset sanity, low-noise startup.

---

## 5. Other deferred research tracks (pointers)

Recorded in the spec deferred lists; consolidated here:
- **On-device generative tier:** SAO-Small for local re-imagine; open question whether SA3 steering vectors transfer Medium→Small (mint/validate on Medium, bake/transfer onto Small).
- **LoRA-base + vector-knobs layering:** a genre LoRA holds the on-manifold "my sound" base; steering vectors ride on top as interactive knobs (simultaneous).
- **Timestep-scheduled steering:** apply α only at denoising timesteps that move concept without collapsing quality — a quality + render-cost win, and a path toward a live generative tier.
- **Held-out validation (the science gate):** the SA3 control research has not cleared a formal held-out test; that gates *trusting library expansion*, not shipping the ear-confirmed colors. Rotate one judge out of any discovery loop to avoid oracle-overfitting.
- **Cross-platform (Windows/Linux/CUDA):** deliberate non-goal for v0. Keep the model boundary (adapters, job service) platform-neutral so a later port touches only the host/runtime layer.

---

## 6. License posture (awareness only — NOT a v0 gate)

Recorded so it's on file *if* the project ever turns commercial. For private research it changes nothing.

| Component | License | If-commercial implication |
|---|---|---|
| NAM (training + plugin) | MIT | Cleanest; no constraint. |
| MRT2 | Apache (repo); open weights | Verify per-checkpoint weight terms before bundling. |
| Stable Audio 3 weights | Stability Community/Enterprise (revenue threshold) | Not plain OSS; check the threshold/terms. |
| Stable Audio Open | Open-weight (Stability terms) | Check terms. |
| RAVE | CC BY-NC 4.0 | Non-commercial — would need alternate rights for a commercial ship. |
| GuitarML Proteus | GPL-3.0 | Host-as-plugin rather than entangle code, in a commercial context. |
| AudioCraft / MusicGen weights | CC-BY-NC 4.0 | Non-commercial. |
| DDSP | Apache-2.0 | Permissive. |
| RTNeural / Tracktion / JUCE | (per their terms) | Tracktion/JUCE have their own commercial licensing if it ever ships closed-source. |

**The one thing not to do:** don't let this table demote RAVE (or anything) in the **v0** plan. RAVE stays a staged Tier-A insert, gated only for latency. The survey's RAVE/Proteus demotions are commercial-licensing calls and do not apply here.
