# Mosh — Architecture Review Handoff

*For external reviewers (LLMs or people). This presents the architecture and every significant decision **at a conceptual level**, with rationale and the alternative we rejected, so you can reopen any choice, present alternatives, flag risks, and red-team it. It deliberately **omits implementation detail** (no code, no engine method names, no schemas) — that lives in a separate spec set. Engage the **reasoning and tradeoffs**, not the wiring.*

**What we want from a review:** challenge the decisions; surface alternatives; tell us which risks we're under-weighting; identify where the architecture will fight us later. Pushback is the point. Explicit open questions are at the end.

> **This document already incorporates one full review pass.** A prior version deferred a typed command surface and specced a fully-custom native UI; a reviewer pushed hard on both. We **adopted** four changes (see §0 changelog). This version reflects the current architecture, so critique it as it stands now.

---

## 0. Changelog from the last review (what changed and why)

- **Adopted a typed command surface (MoshOps) as the mutation spine, day one** — instead of deferring it. It is *not* a CRDT op-log; it's a thin command facade over the engine's existing undo. This keeps the engine's undo/state as the store while giving validation, atomicity, a semantic audit log, and the future agent/multiplayer/MCP substrate — without building multiplayer now.
- **Switched the v0 UI to a WebView/React arrangement** (built fresh, conventional) — instead of a fully-custom native timeline. It reuses our web-native design direction, de-risks the single longest build item, and is swappable by construction.
- **Put the generative model behind a model-neutral adapter + a real job service** — instead of hard-coding one model behind bare request/response. The model becomes an adapter; a stub adapter proves the pipeline first.
- **Gave the safety clamp a Lab-mode escape hatch** — instead of an always-on cage.

Decisions we kept unchanged: the non-destructive source-graph; the real-time/offline neural split; the dependency rule; reusing the generative-control research behind a clean adapter; the honest ML caveats.

---

## 1. What we're building

Mosh is a **native, hybrid digital audio workstation** — a fully functional DAW (import/record, arrange, host plugins, mix, export) with **neural processing woven into the same signal model as a first-class, non-destructive layer** rather than a separate "AI" mode. Three kinds of processing coexist in a track: traditional plugins; real-time neural inserts (timbre morph, neural amp/effect emulation); and an offline generative layer (a diffusion model) used as a reversible "render layer" with semantic controls. v0 is single-player and native; an AI-operator character and multiplayer are deferred but not precluded.

Product thesis: creative AI tools fail when they **flatten** the artist's material into dead output. Mosh's wedge is the opposite — **typed, auditioned, reversible editing of the producer's own sound**, where the source always survives.

---

## 2. The two spines

**Audio model — the non-destructive source-graph.** Every neural edit is a reversible insert, a lineage-preserving render whose audio is a *cache* (committed as an alternate take) and whose *parameters* are the durable layer, or a hosted plugin — never a silent flatten. The source of truth is always the upstream source; rendered audio is a cache keyed by a full fingerprint and re-rendered when inputs change. (Photoshop-adjustment-layer semantics for audio.)

**App model — the swappable command seam.** The UI talks to the engine *only* through a typed command API and a snapshot+events state feed. No direct coupling, no audio on the UI thread. Any UI that renders a snapshot and applies typed events is a valid client; the frontend is disposable. The v0 UI is intentionally a conventional, throwaway-grade layout meant to surface all controls now and be made beautiful later.

---

## 3. The core architectural commitments

Each: decision, why, rejected alternative.

### 3.1 Native C++/JUCE on an existing engine (Tracktion Engine)
**Why.** We need real DAW semantics (clip/automation/render/transport/host); building that is a multi-year detour. The engine is C++/JUCE (matching real-time neural tooling) and its state is a structured, serializable, undoable tree we can align to.
**Rejected.** A web app (loses native hosting/low-latency audio); building our own engine (off-thesis); scripting an existing open DAW (less control over the hybrid model and UI).
**Reopen?** Is this the right engine for a *neural-first* DAW specifically? Where will its opinions fight us?

### 3.2 A typed command surface (MoshOps) as the single mutation API — adopted this pass
**Why.** Letting UI/agent layers mutate the raw engine tree loses validation, atomicity, undo coupling, and guardrails. One typed facade with structured results + a semantic log fixes that and *is* the future agent/MCP/multiplayer substrate — and the accept/reject events it logs are taste labels we want from day one. The engine's undo stays the implementation underneath, so we don't build two undo systems or a CRDT yet.
**Rejected.** (a) Defer it and mutate the engine tree directly (what we had — unsafe surface, no audit trail, painful agent/multiplayer retrofit). (b) Build a full CRDT op-log now (overkill for single-player).
**Reopen?** Is a command facade the right middle ground, or does committing to the CRDT op-log now avoid a later migration? Is the command granularity right (too coarse loses repldelay fidelity; too fine becomes chatty)?

### 3.3 The two-tier neural split (real-time vs offline) — the most important cut
**Why.** Real-time capability, not model family, determines what's possible. A streaming model can be a live insert with declared latency; a whole-region diffusion generator is a *job* (render, wait, audition, cache, re-render). Conflating them is wrong for both.
**Rejected.** Everything real-time (impossible for diffusion); everything offline (kills live feel); one unified abstraction (hides the constraint that matters).
**Reopen?** Is "real-time vs offline" the right primary axis? If a near-real-time generative path arrives, should the architecture anticipate the wall moving now rather than later?

### 3.4 The generative model behind a model-neutral adapter + a job service — adopted this pass
**Why.** The product primitive should be model-neutral so a smaller local model, a near-real-time model, or our own research service can slot in without touching the DAW. And generative renders are slow/expensive, so the experience depends as much on **job orchestration** (submit/progress/cancel/cache/lifecycle, audio over files+manifests) as on the model. A stub adapter proves the whole pipeline before the heavy model exists.
**Rejected.** Hard-code one model (brittle to licensing/packaging/version change); bare request/response HTTP (underspecified for slow cancellable jobs); giant JSON audio payloads (wrong transport for audio).
**Reopen?** Is the process boundary worth the operational cost (two things to launch/version-match)? Is the adapter capability set right?

### 3.5 The generative model runs out-of-process; the real-time tier in-process
**Why.** The diffusion model is large, GPU-bound, and its semantic control is a live intervention in its internals (not a static graph), so it can't be embedded in the audio process or exported. As an offline job, a local file/manifest protocol is sufficient. The real-time tier *is* in-process (on the audio graph), which means **there is no real-time sidecar** — the only out-of-process piece is the offline model service.
**Rejected.** Embed/port the model in the audio process (infeasible); build a low-latency shared-memory transport (pointless for an offline job).
**Reopen?** Is the offline-orchestration pattern (uncommon for DAWs) a hidden operational tax?

### 3.6 WebView/React UI, built fresh and conventional — adopted this pass
**Why.** The engine ships no reusable arrange UI, so the timeline is custom regardless; doing it in React over a clean command/state contract reuses our web-native design direction and de-risks the longest build item. Coupling only through the command seam makes the frontend disposable — exactly what we want while the design is still in flux. Plugin editors stay native pop-outs; audio never touches the web thread; telemetry is decimated.
**Rejected.** (a) Fully-custom native timeline first (what we had — slowest path, from scratch in raw UI toolkit). (b) Reuse the existing messy web UI as-is (carries legacy we want gone; we're rebuilding it clean). (c) All-declarative-native (can't express a dynamic timeline).
**Reopen?** The arrange view is the worst surface to feel laggy and it's going into WebView — does that scale to large sessions, or will the hardest surface get rewritten native anyway? (We have a working React arrangement as evidence it's viable, and the seam means a later native swap is contained.)

### 3.7 Two control vocabularies for neural controls
**Why.** Producers want musical knobs they trust (named, validated "semantic" directions); the diffusion sampling parameters (seed/guidance/steps/denoise) are a different mental model and only the generative layer even has them. Mixing them confuses the interaction.
**Rejected.** One undifferentiated parameter panel.
**Reopen?** Should sampling parameters be hidden from the producer entirely? How much generative machinery should ever be user-facing?

### 3.8 A platform-wide "never sounds broken" safety mapping, with a Lab-mode escape hatch — escape hatch adopted this pass
**Why.** It's the difference between a fragile research knob and one a producer trusts; the same quality oracle that validated the semantic controls calibrates a safe range for any over-driveable parameter, across both neural tiers. But a producer will *want* broken/harsh/alien sometimes, so the clamp is a default, not a cage: Lab mode unlocks the raw range behind a warning.
**Rejected.** No safety mapping (broken extremes by default); ad-hoc per-feature clamps (inconsistent); an always-on cage (limiting for power users).
**Reopen?** Is auto-calibrated clamping sound, or still subtly limiting even with Lab mode? Is the quality oracle trustworthy enough to gate UX on?

### 3.9 Single-player now; multiplayer and an agent later
**Why.** Scope; both are separable layers that benefit from a working single-player core. The command surface (§3.2) is the substrate they'll build on, so deferring them no longer implies a painful retrofit.
**Reopen?** Are the right hooks present given the command facade is semantic-log, not yet CRDT?

### 3.10 macOS / Apple Silicon only for v0 — adopted this pass
**Why.** A single-platform target lets us lean fully into Apple Silicon (MLX/CoreML/Metal, unified-memory zero-copy — the load-bearing advantage for local neural inference) with no cross-platform abstraction tax, and it collapses CI to one target. It also removes the main objection to a future live generative-instrument lane (those models' real-time paths are Apple-Silicon-centric). The developer is on a Mac; the heavy generative service is already MLX.
**Rejected.** Cross-platform from day one (abstraction tax, doubled QA surface, and the neural stack is Apple-optimized anyway).
**Tradeoff accepted.** No Windows/Linux/CUDA in v0; a future port is a deliberate later effort (or upstream tooling gets there first). The risk is architectural lock-in to Apple-only paths — mitigated by keeping the model boundary (adapters, the job service) platform-neutral so only the host/runtime layer is Apple-specific.
**Reopen?** Does single-platform v0 bake in assumptions that make a later cross-platform port disproportionately costly?

---

## 4. The latency model (worth challenging)

Two costs hide under "latency." **Streaming latency** is a fixed offset in a continuously flowing signal — a live insert that adds constant delay still passes audio continuously, and the DAW hides it by delaying everything else to match; you can perform through it. **Re-render cost** is the diffusion model's cost: it's not "high latency," it's *not real-time* — hand it a region, wait seconds, get it back, and the cost recurs when its input changes.

The **dependency rule**: in your monitored output, a node is only as responsive as the slowest thing downstream you're listening through. A live source upstream of the generative layer loses its live feel — not because the source slowed, but because you can't hear the final output until the layer re-renders. So: **don't perform live *through* a generative layer — perform, capture, then transform; put hands-on real-time processing *downstream* of it, where edits are free.** This is why the generative layer is an offline, cached, committed thing, never a live downstream insert.
**Reopen?** Is this complete, or do speculative/predictive/partial-streaming render strategies meaningfully soften the re-render cost and change the architecture?

---

## 5. The generative-control research, briefly (for ML reviewers)

The offline layer's semantic control reuses prior research, exposed behind the adapter:
- **Mechanism:** lightweight activation steering — add a learned direction to the model's internal stream at inference to push a clip toward a named musical quality, no retraining. Each direction is a "color."
- **Validity filter:** a "paraphrase gate" — build the same concept twice from disjoint vocabularies, keep it only if the two directions agree, separating a real musical direction from one that merely cached the prompt words. It has a measured null floor (calibrated, not vibes). Notable finding: short acoustic descriptions yield far more robust directions than verbose ones.
- **Evaluation:** a panel of independent audio judges (not one) that reproduces the practitioner's ear and auto-flags mislabels; it also measures a real quality cost (strongest-steering directions degrade production quality most), which motivates the safety clamp (§3.8).
- **Creative mode:** "re-imagine" — re-noise an encoded loop and denoise *with steering*, preserving groove while transforming sound; a low re-noise level keeps it recognizably the same song.
- **Status (honest):** a handful of colors are ear-confirmed; the geometry/theory is a coherent organizing hypothesis, not locally proven; **nothing has cleared a formal held-out test**; the practitioner's ear remains ground truth; and there's a known **circularity** — the same judge panel both discovers and validates controls.
**For ML reviewers:** notes on the steering/validation methodology, the held-out gap, the discovery/validation circularity, the composition limits (few simultaneous controls, order-dependent), and stronger/complementary control mechanisms are all welcome.

---

## 6. Risks & things we're least sure about

1. **WebView arrangement at scale** — the timeline is the worst surface to feel laggy and it's in WebView; the bad ending is rewriting the hardest surface native anyway (mitigated: working React arrangement exists; the seam contains a later swap).
2. **Command granularity** — too coarse and the log/undo lose fidelity; too fine and the bridge gets chatty. The right level is a judgment call.
3. **Generative interaction model** — "render → audition → accept as a take" depends on engine features whose exact surface we're unsure of (there's a simpler fallback, but the ideal UX may be constrained).
4. **Real-time-safety + delay-compensation correctness** for the live neural insert is the hardest *correctness* item; wrong reported latency silently misaligns parallel tracks.
5. **Generative-control science is unproven on held-out data**; the "measures good, sounds bad" gap stands (mitigated by the clamp, not eliminated).
6. **The two-tier wall could be temporary** — a near-real-time generative path would force rework.
7. **Off-the-beaten-path operationally** — a DAW orchestrating a separate generative service is unusual; fewer reference implementations (we avoid needing a real-time sidecar, but the offline-orchestration pattern is still uncommon).
8. **Two processes to manage** — service lifecycle (warmup/heartbeat/crash/version-match) is real work and a real failure surface.

---

## 7. Explicitly out of scope for v0 (deferred, not rejected)

Each a layer the architecture must not preclude: the AI-operator character/agent (a client of the command surface); the full multiplayer / CRDT op-log (the command log is a semantic trail, not yet CRDT); real-time collaboration; an on-device generative model + whether the learned controls transfer to it; a **live generative-instrument lane (Magenta RealTime 2)** — a MIDI/text/audio-conditioned real-time generator that would sit in the live tier as a neural *instrument*, now more viable since v0 is Apple-Silicon-only, but not core v0; layering a "house style" adaptation under the interactive controls; scheduling steering across the diffusion trajectory; the full bespoke panel/drawer interaction system (a simplified set ships); cross-platform (Windows/Linux/CUDA) support.

---

## 8. Open questions we'd most like reviewers to weigh in on

1. **Engine choice** for a neural-first DAW — right foundation, or will its assumptions fight us? Alternatives?
2. **Command facade vs CRDT op-log now** — does the facade-over-engine-undo middle ground save real pain, or just defer it? Is the command granularity right?
3. **WebView arrangement at scale** — will a React timeline over the command/state seam hold up for large sessions, or is a native timeline inevitable for the worst-case surface?
4. **Generative interaction** — is "render → audition → accept as an alternate take" the best non-destructive UX for a slow generative layer, or is there something better?
5. **The real-time/offline cut** — right primary axis, and should we pre-empt a future near-real-time generative path rather than treat the wall as permanent?
6. **Real-time neural tier** — are NAM/Proteus/RAVE/DDSP the right starting set of live neural models that coexist with a generative layer without replacing it? Stronger complements?
7. **The safety clamp** — sound with Lab mode, or still subtly limiting? Is the quality oracle trustworthy enough to gate UX on?
8. **Control surfacing** — how much generative machinery (sampling hyperparameters) should ever be user-facing?
9. **The latency model (§4)** — complete, or do speculative/predictive/streaming strategies change the calculus?
10. **The biggest thing we're not seeing** — what fails first, and what would you cut or add?

*Reviewers: be adversarial. This document exists to get the decisions stress-tested, not agreed with. Where feasibility (not approach) is in question, ask for the relevant module spec — this doc is "is this the right thing to build," the specs are "is it buildable as described."*
