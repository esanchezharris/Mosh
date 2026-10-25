# Mosh: session-aware local generation agent — repo execution brief

> **Owner brief, 2026-10-10.** Copied verbatim on 2026-10-25 from the owner's original
> (`MOSH_SESSION_AGENT_REPO_PROMPT.md`); this note is the only addition. It is the current
> product direction for Re-Imagine, and §10 is the milestone ladder (M0 audit → M1 loop →
> M2 evaluator → M3 feedback search → M4 persistent experience). Its run instructions
> (§2, §3, §11 and the closing lines) were written for the M1 implementation run. Status
> and evidence live in [M1-CONTEXTUAL-LOOP.md](M1-CONTEXTUAL-LOOP.md).

Act as the implementation lead inside this Mosh/Moshpit repository. Inspect the actual code, choose the shortest reliable path, implement the next bounded milestone, and test it. Do not return another startup plan or architecture essay.

## 1. Product decisions: do not reopen these

Mosh is a plugin inside an existing DAW, not a new DAW. Its first user is me, in my own music-making sessions. The aim is better-sounding music matching my intention, with less prompting, paid reasoning, auditioning, and repair work.

The first product is a session-aware agent over existing Gary/local-model infrastructure. Generated audio is a legitimate final output, not merely a sketch that must be reconstructed with conventional instruments. Mosh-owned controls and audio/MIDI export are acceptable initially. One deeply integrated DAW is acceptable; other hosts can initially use explicit capture/import, plugin audition, and drag-out.

The sequence is: usable generation workflow → qualified evaluator → within-session feedback search → persistent experience → targeted training when evidence justifies it. Preserve that direction, but do not implement the whole sequence now.

Do not import older requirements that conflict with this brief: recording-first, leased-beat rapper as first user, generation-only-for-gaps, transform-only forever, a stock-effects suite, universal plugin control, or multiplayer before useful solo production. Preserve existing working code without turning all historical features into dependencies. Artist-named datasets/models and training helpers are outside the initial scope.

## 2. This run: one workflow, one backend, one primary host

Complete a bounded audit, then implement the next missing slice of Milestone 1 below. If it already works, verify it before selecting the next missing step. Do not advance into evaluator training, voice engineering, or multiple new backends during this run.

Default first task: transform a selected instrumental phrase into a useful variation in its musical context. Example:

“Turn these eight bars of keys into a hazy sampled-keyboard loop. Follow the supplied chord changes and make the performance less busy.”

Then:

“Version B is closer. Roughen the texture, but preserve the chord-change timing.”

The result is versioned audio I can audition against my track, keep, revise, revert, and export. Protect source files; do not promise exact musical preservation from a model that has not demonstrated it.

Choose an already working local audio-conditioned backend, preferably through Gary’s existing integration. Stable Audio 3 is a candidate, not an assumed installation. If the repository already has a substantially stronger permitted path for generating a separate accompaniment part, choose that instead and document the evidence. Implement ONE task, not both.

For accompaniment, distinguish an isolated new part from a replacement mix. Do not double the backing, label a full mix as a stem, or pretend source separation proves the generator left the backing untouched. If this capability is missing, use the transformation task rather than silently expanding scope.

The example specifies intent, not a claim that a model obeys every constraint. Record unsupported conditioning and observed failures honestly.

## 3. Establish repo truth before changing architecture

Read AGENTS.md and applicable build/test/safety instructions. Inspect branch, worktree, build targets, existing plugin formats, relevant tests, and actual runtime availability. Preserve uncommitted work and other agents’ changes. Do not reset, delete, rename the product, migrate frameworks, merge branches, commit, or push without instruction.

Look specifically for:
- A working JUCE plugin shell, audio capture, synchronized playback, version storage, and export.
- Existing MoshOps/op logs, controller, companion service, and generation adapters.
- Claimed REAPER take-loop and Lua media-commit components, their tests, and their current call paths.
- Existing speech/cloud connections and any automatic upload or remote-backend fallback.
- Existing evaluator briefs, including mosh_evaluator_gate_v2.md if present.

Report verified paths/functions and commands. Distinguish working, partially implemented, proposed-only, and absent. Assistant descriptions of “what is already built” are leads, not proof.

Mac-first: inspect actual hardware and installed tools. Do not depend on the NVIDIA PC being available. Prefer REAPER as the first deep host only if its claimed adapter exists and is useful. Otherwise use the currently working installed host with generic capture/export. Do not build REAPER and Ableton adapters in parallel or block generic generation on either.

Compare reuse of the current Mosh shell with a deliberate Gary integration. Default to the existing shell plus an adapter to an existing service. Do not fork Gary and build a competing Mosh shell simultaneously. Do not write an agent that clicks Gary’s interface.

Check exact licenses for code, runtime, weights, and dependencies actually selected. Preserve notices. Do not assume all Gary components share a license, local use automatically permits startup use, or a network boundary settles copyleft obligations. Do not relicense the repository. A licensing blocker should stop that dependency, not unrelated implementation work.

## 4. Architecture: thin plugin, local model process

Reuse existing processes and services. Logical boundaries do not require separate frameworks or microservices.

PLUGIN:
- Explicit capture/import of source material and available host timing.
- A small editable context view, text request, candidate history, audition, and export.
- A generation button, progress/cancel, previous-version selection, and one revision field.
- Mosh-owned playback/mute/gain and optional loop-boundary controls.

CONTROLLER:
- Build a typed request from the user’s intention and the frozen context snapshot.
- Validate against the one backend’s actual capabilities, submit jobs, and retain provenance.
- Use ordinary code for polling, file handling, checks, and state transitions.
- Never execute arbitrary model-generated shell commands or Lua. Host writes use allowlisted operations.

MODEL SERVICE:
- Run outside the DAW audio process; reuse the existing Gary companion/backend where possible.
- Verify endpoint schemas, versions, outputs, and error behavior from actual source or a live probe. Do not invent API routes.
- Share one heavyweight model runtime across plugin instances. Initially serialize generation jobs if that is simpler.
- Include request/instance IDs so one instance cannot receive another’s result. Handle unavailable service, timeout, cancellation, stale completion, and restart without corrupting audio or killing the session.

Do not allocate model weights, perform inference, wait on network/disk, or take unbounded locks in the audio callback. Transfer captured audio through bounded buffers to a worker. Prepare playback buffers off-thread; publish and retire them without audio-thread allocation or destruction.

## 5. Context: explicit evidence, not imaginary project access

A plugin’s context must come from routed inputs, imported files/MIDI, provided host information, user confirmation, or a tested host adapter. Do not assume global access to other tracks or universal timeline-write access.

Use the simplest explicit routing available: source through the plugin’s input, backing through an existing sidechain or imported reference, or adapter-exported audio. Do not build multi-plugin discovery or whole-project reconstruction.

Capture an immutable SessionSnapshot containing only what this task uses:
- Snapshot ID, instance ID, source hashes, and source-region offset.
- Sample rate, channels, region start/end in samples and musical time where available.
- Tempo and meter; initially constant-tempo regions are acceptable.
- Optional key/scale and timed chord events.
- Optional backing reference and section label/markers.
- Original request, protected choices, and each field’s provenance: host, user, inferred, or unknown.

Do not delete chords from the design. A small user-entered timed chord list is sufficient initially; no automatic transcription is required. Key is not a chord progression. Manual corrections override inference.

Distinguish stored context from context actually supplied to the controller, generator, and evaluator. Unsupported chord or audio conditioning must be visible. Putting chord names in a text prompt is not proof of enforced harmony. A text-only controller must not claim to have listened to audio it never received.

Missing timing fields remain unknown; request or expose manual values rather than substituting silent defaults. If tempo changes or another unsupported condition crosses the region, flag it and require a supported region or explicit reconform. Do not quietly use stale timing after the session changes.

## 6. Audition, acceptance, and export

Reuse existing synchronized playback. Where missing, implement a bounded player for the chosen region, not an arrangement engine.

- Anchor candidate playback to the captured musical region using valid host timing. Handle transport start/stop, seek into the region, loop wrap, and callback-boundary crossings.
- Start with one constant-tempo region. A later tempo change marks the candidate stale for synchronization until reconformed; do not pretend a fixed-length file automatically follows it.
- Provide an explicit free audition mode when host timing is unavailable; never label it host-synced.
- A/B compares the source and candidates at equivalent positions, with safe switching. Preserve meaningful level differences; store optional audition-only gains separately.
- Define whether the chosen route replaces the source or adds a part. Prevent unintended source doubling, feedback, and recapture of Mosh’s own output.
- Keep every revision linked to its parent. A new generation does not overwrite an approved version.

“Keep” selects a durable Mosh version; it does not silently write the host timeline. Drag/export writes a stable WAV with correct duration, sample rate, and useful timing metadata. Export MIDI only when genuine MIDI exists; do not fabricate symbolic data to check a box.

Save/reopen must restore selected versions and region metadata. Files referenced by a project or dragged into a DAW must not disappear with a temporary cache. Use existing asset storage; provide an explicit durable copy/export path, not a new asset-management platform.

REAPER commit is optional for Milestone 1 and only reused when already supported. Require explicit user action, validate project/track/region identity, copy to durable media storage, use one undoable operation, and make retries idempotent. Do not insert into whichever track happens to be selected later. Generic hosts use drag-out; mark host placement as unobserved unless an adapter confirms it.

When committing an additive part, prevent simultaneous plugin and timeline playback from doubling it. When host undo makes commit status uncertain, expose it rather than guessing.

## 7. Intent compilation and privacy

Start with typed natural language. New ASR, wake words, speech synthesis, and real-time conversation are not Milestone 1 dependencies.

Use an existing permitted local controller if available. One planning call should produce a bounded structured request: task, backend/version, source/conditioning references, prompt, supported settings, duration, candidate seeds/count, protected choices, and stop budget. Validate it in code. No general tool-using agent framework.

Use a small task-specific template informed by a few controlled local probes. Change one conditioning variable at a time, save outputs, and distinguish documented controls from observed adherence. Do not run a large benchmark before the path works.

If no language model is available, a clearly labeled template-driven path can validate infrastructure. It does NOT complete natural-language interpretation; report that gap. Do not implement a new local LLM runtime just to avoid admitting this limitation.

For this task, audio remains local by default. No fallback to Gary’s hosted backend, cloud ASR, or cloud audio judge. Do not inherit permission from an old realtime client. Identify such paths without deleting unrelated working features.

Cloud text reasoning is a separate opt-in: use only a specifically authorized provider/data scope/budget, and disclose that prompts, lyrics, or metadata may be transmitted. Existing credentials alone are not consent. Otherwise continue local-only work and report the missing permission.

Prefer loopback-only service access. Inspect actual bind addresses and prevent unintended LAN exposure. LAN inference is deferred unless already working and explicitly enabled; do not assume private IP addressing supplies authentication or confidentiality. No telemetry or training on user audio by default.

Default to no new paid calls and a small configurable generation budget: two initial candidates, a user-triggered revision batch, and at most eight total model attempts per intention during this milestone. Count failures and retries. Do not silently spend or make large model downloads; reuse installed models or request the exact missing resource after independent work.

## 8. Timing and technical checks are not musical taste

Validate decoding, finite samples, channel layout, duration, gross silence, peak problems, and provenance. Include deliberately bad fixtures so checks prove they can fail.

Assess tempo, chord adherence, and loop quality as estimates with uncertainty unless an exact check is available. An ambient phrase may have no identifiable beat. Lack of a beat estimate is not proof of failure.

For conforming, preserve both raw output and processed derivative. Prefer the least invasive correction. Bound any stretch, trimming, padding, offset, or crossfade; log what changed. Exact file length does not prove correct downbeats or groove. Do not run all audio through automatic warping or pitch correction merely to pass a metric.

Reuse a suitable licensed stretching library only if required. Make severe repair or uncertain alignment visible. Overgeneration can discard useful endings and change musical structure; test it rather than assuming it solves looping.

Checks may flag unusable files and protected-boundary violations. They must not be presented as a validated taste judge, “best take,” or evidence of learned improvement. Start with the artist choosing among candidates; evaluator decisions come later.

## 9. Capture the experience needed for learning

Use the existing op log or append-only local events, not a new database service. Log:
- Session/snapshot/task IDs; source and backing hashes; intention and revisions.
- Backend/model/checkpoint/template versions; conditioning actually sent; seed and parameters.
- Raw and conformed output hashes, timing changes, technical checks and uncertainty.
- Generation/controller/evaluation time, model calls, retries, and known monetary cost.
- Candidate presentation, audition, explicit preference, keep/reject/revise, export, and later undo where observable.

Keep explicit preference distinct from implicit events. Export, keep, undo, and survival in a final bounce are useful but ambiguous signals. Do not label unobserved final-bounce survival as false, or infer it from export. Store unknown where necessary. Add an optional later “used in song” confirmation rather than building full-bounce tracking now.

Do not fabricate human ratings. Pin automatic evaluator versions when they are introduced. Avoid recording secrets; keep private audio and large generated assets out of source control.

## 10. Milestones and advancement criteria

M0 — BOUNDED AUDIT AND BACKEND PROBE.
Choose one existing shell, one task, one local backend, and one host. Verify a real audio round trip on an authorized fixture. Limit initial probing to one or two configurations and a few renders. No multi-model survey, installer rewrite, or week-long benchmark.

M1 — USEFUL CONTEXTUAL GENERATION LOOP. CURRENT GOAL.
Capture/import → inspect/correct context → type request → generate → synchronized audition → revise/version → keep/export → reopen safely. Use one model and one task. Evaluate against my competent direct use of Gary with the same source and comparable candidate budget.

M2 — EVALUATOR QUALIFICATION. NOT THIS RUN.
Adapt the existing evaluator-gate protocol to these actual candidate pools. Evaluate in relevant musical context, separate adherence from preference, retain original/no-change options, and measure keeper discovery, damage, abstention, and human audition time. Few judges, held-out parent songs, limited blind listening. No universal 0.65 rule or hundreds of mandatory labels before a pilot.

M3 — WITHIN-SESSION FEEDBACK SEARCH.
Only with a useful judge, compare independent best-of-eight with feedback-guided eight-attempt search. Freeze the evaluator; count all reasoning, evaluation, rendering, and retries. Blind human adoption and efficiency must improve, not just reward scores. Stop expansion when scores rise without human benefit.

M4 — PERSISTENT EXPERIENCE.
Compare memory off/on on new songs with the same tools and budgets. Start with retrieval or warm-started proposals; separate language memory from optimizer priors. Only then consider a small ranking/proposal model or action-conditioned JEPA comparison. Controller learning and audio-model LoRA training are distinct investments.

LATER — speech/performed input, deeper host integration, second model for a demonstrated gap, real-time vocal engineering, supported LoRA workflows, contribution sharing, and additional hosts. Reorder later work only to solve observed use friction. None is a prerequisite for M1.

## 11. Tests, evidence, and scope discipline

For the code changed, run focused tests and the available build/plugin validation path. Preserve existing passing behavior. Test implemented components; do not build deferred features merely to satisfy their future acceptance tests. Test malformed controller requests, missing context, backend down, cancellation/late results, multiple-instance isolation, source immutability, stale snapshots, save/reopen, missing assets, no unauthorized remote fallback, and stable export.

Test playback at representative sample rates/block sizes, including seeks and loop boundaries. Use deterministic fixtures for engineering claims. A stub backend can test transport and UI; it cannot establish generation quality or complete the real-model test.

If host access is unavailable, run independent tests and give exact remaining manual steps. Do not claim a host/plugin/audio-quality pass from compilation or mocks. Musical acceptance remains mine until I listen.

Keep documentation short: a repo-truth note, current milestone/decisions, exact run commands, and test evidence. Reuse existing docs. Do not create a framework, multi-agent system, new DAW, recording-suite rewrite, dataset factory, automatic chord-transcription project, generic plugin host, model marketplace, or collaboration service.

Do not make my weekly availability or a new requirements interview a prerequisite. Make reversible choices and proceed. Ask only for a genuinely missing resource or consequential permission, after completing independent work. If the milestone exceeds one working session, finish and test the smallest coherent slice and state what remains; do not describe future steps as completed.

End with: verified components reused, implementation changes, exact build/run/test commands and results, what I can try now, what remains untested, and the single next milestone. Do not claim repeat-user demand, autonomous taste, or cross-song learning from M1.

## Primary implementation references

Starting points checked October 10, 2026. Inspect installed versions and exact licenses before implementation; these links are not proof of local availability or musical quality. Recheck only what materially affects this milestone.

- Gary plugin, component notices, and current model capabilities: https://github.com/betweentwomidnights/gary4juce
- Gary Mac companion: https://github.com/betweentwomidnights/gary-localhost-installer-mac
- Published SA3 backend implementation: https://raw.githubusercontent.com/betweentwomidnights/gary-localhost-installer-mac/main/sa3/api.py
- Gary ACE-Step mode notes and limitations: https://github.com/betweentwomidnights/gary4juce/blob/main/docs/CAREY.md
- JUCE optional host timing: https://docs.juce.com/master/classjuce_1_1AudioPlayHead_1_1PositionInfo.html
- JUCE audio processing: https://docs.juce.com/master/classjuce_1_1AudioProcessor.html
- JUCE external file dragging: https://docs.juce.com/master/classjuce_1_1DragAndDropContainer.html
- REAPER scripting/media insertion: https://www.reaper.fm/sdk/reascript/reascripthelp.html
- Optional time-stretching implementation: https://github.com/Signalsmith-Audio/signalsmith-stretch

Begin with the bounded repo audit, state the selected M1 slice briefly, then implement and test it. Do not stop after proposing the plan.
