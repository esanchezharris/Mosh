# Re-Imagine M1: contextual generation loop

[Owner brief of 2026-10-10](SESSION-AGENT-BRIEF-2026-10-10.md) ("session-aware local generation
agent"; its §10 sets the milestone ladder M0–M4). Milestone M1 has one
workflow: transform a selected instrumental phrase into variations that fit its musical
context, then revise, keep and export them. It uses one backend and one primary host.
This file is the repo-truth note, the record of decisions, the run commands and the test
evidence. It claims nothing about how the music sounds.

## Repo truth at the start (base `269c81b5`)

| Component | State | Where |
|---|---|---|
| In-DAW plug-in shell (JUCE VST3, Ableton Live 11 target) | **Working**, built on macOS only | `src/reimagine/plugin/`, `MOSH_BUILD_REIMAGINE_PLUGIN` |
| Host-synced capture (Transfer), WAV import at a bar | Working | `TransferCapture`, `importTakeFromFile` |
| Content-addressed asset store and Relink | Working | `AssetStore` (`~/Library/Mosh/ReImagine/assets`) |
| Host-synced replace-mode playback, dry A/B, take history, save/reopen | Working | `renderSelected`, `PluginStateV1` |
| Local model service, single serialized SA3 worker | Working | `service/server.py`, bound to `127.0.0.1` |
| Explicit direct-render contract (frozen source hash, MLX SA3 Medium only, no fallback) | Working on the service side; **the plug-in did not use it** | `service/direct_render.py` |
| Gary (gary4juce / gary-localhost) integration | **Absent**: specs only, no code | `docs/superpowers/specs/2026-06-21-*` |
| REAPER take loop / Lua media commit | **Absent**: only RPP import and UI parity code | `ui/src/import/parseRpp.ts` |
| Local language-model controller | **Absent**. `service/brain_client.py` is cloud-only (deepseek/openai/xai) and is not used | — |
| Evaluator gate brief (`mosh_evaluator_gate_v2.md`) | Absent | — |
| Session context (chords, key, provenance), intentions, budget, lineage, export, experience log | **Absent** | — |

## Decisions (reversible)

- **Shell:** the existing Re-Imagine VST3. Nothing is forked or re-platformed.
- **Backend:** the existing local SA3 Medium (MLX) through `service/server.py`. The
  repository has no Gary path to reuse, and the brief rules out building one alongside
  this. Owner decision 2026-10-19: Gary is the **baseline**, used directly by the owner,
  not a backend Mosh calls ([M1-GARY-COMPARISON.md](M1-GARY-COMPARISON.md)). Licence obligations for SA3 and JUCE are already recorded in
  [DEPENDENCY_BOM.md](../DEPENDENCY_BOM.md). The open item there is SA3 checkpoint
  provenance.
- **Host:** Ableton Live (the owner's host is Live 12; this record first said Live 11), the plug-in's existing target. It uses generic capture and
  export; no REAPER adapter is built.
- **Task:** transformation (audio-to-audio re-imagine). An isolated accompaniment part
  does not exist in the repository.
- **Route:** *replace*. The selected version substitutes for the source inside the
  region, so the plug-in never adds a second audible copy.
- **Controller:** template-driven (`reimagine-transform-template/1`) by default: the typed
  request goes into the prompt verbatim, followed by the user's key, the BPM and timed
  chords. Since 2026-10-19 an **opt-in cloud planner** (Claude, owner opt-in to cloud
  text providers on 2026-10-19) can write the prompt, strength and candidate count
  instead; see "Cloud planner" below. With the planner off or unavailable the template is
  used and the version records why.
- **Privacy:** audio stays local. The service client refuses non-loopback hosts unless
  `MOSH_SERVICE_ALLOW_LAN=1` is set. Direct requests never fall back to another provider
  or a cloud service. The only cloud call is the opt-in planner, which receives text and
  context, never audio, paths or hashes. No telemetry.

## What M1 added

- `src/reimagine/ReImagineSession.{h,cpp}` (engine-free):
  - `SessionContext`, with provenance (host/user/inferred/unknown) on every field.
  - Timed chord list, entered by the user as `1:Fm7 3:Db ...`.
  - Immutable `SessionSnapshot`.
  - `compileIntention`, `validateRequest`, and `directServiceParams`, which build the
    explicit request for `direct_render.py`.
  - Per-intention attempt budget: 2 candidates by default, at most 8 attempts, with
    failures counted.
  - Technical checks (decode, finite samples, silence, peak, length, channel count),
    shown separately from any taste judgement.
  - Lineage stored on the take (`manifest.m1`), export naming and JSON sidecar.
  - Append-only `ExperienceLog` (`~/Library/Mosh/ReImagine/experience.jsonl`). Explicit
    signals (keep, context edit, request, revision) are tagged apart from implicit ones
    (audition, export).
- `ReImagineProcessor` gains `generateCandidates`, `reviseSelected` (starting from the
  selected version's audio or from the original source), `cancelGeneration`,
  `keepSelected`, `exportSelected` (to `~/Music/Mosh Exports`, durable and idempotent)
  and `selectedReport`.
  - Results are discarded if they arrive after a cancel, or after the region or its source
    changed.
  - Every render request gets its own artifact path. Two instances previously collided on
    `work/render.wav`; the legacy path is fixed too.
- The editor has a third column with: context fields, candidate count, Generate and Cancel,
  revision text with a "from selected audio" option, Keep, Export, a Drag WAV button
  (external file drag), and a report showing tempo/meter provenance, lineage, budget,
  checks, and which context the model did not enforce.
- **Rack edits no longer render.** Only Generate, Revise and New Take spend model calls.
  New Take is the legacy single render and is not counted against the budget.
- Imports made before the host reports tempo are marked `tempoMapAssumed`. Their BPM stays
  unknown instead of being passed off as host data.

## Honest conditioning

| Context | Reaches the model as | Enforced? |
|---|---|---|
| Source audio, or the parent version's audio | init audio at strength 0.01–0.5 | applied, but resemblance is not preservation |
| Duration | requested length equals the input length | yes, by the service contract |
| Tempo (BPM) | text in the prompt | no; beat alignment is not enforced. The take's beat period is **measured** afterwards (see below), which reports drift but changes nothing. An optional, explicit **conform** can stretch a drifting version afterwards; that edits the version, it does not condition the model |
| Key | text in the prompt | no |
| Chords | chord names **and change bars** in the prompt (`chords by bar: 1 Fm7, 3 Db`) and as the structured `chord_timing` request field (bars from the region start, with provenance); the service records it in the render manifest | no; neither harmony nor change timing is enforced, and the service's manifest copy always says `enforced: false` |
| Meter, section, protected choices | stored and logged only (template); sent to the planner as text when it is on | no |
| Controller (opt-in) | the planner reads your text and the context above and writes the SA3 prompt, strength and candidate count | no; it never hears the audio, and what it writes is still only a prompt |

### Chord timing and tempo conformance (2026-10-15)

- **Chord timing is sent, not enforced.** `compileIntention` copies the timed chord list
  and its provenance into `CompiledRequest::chordTiming`. The prompt renders it compactly
  and deterministically: `chords by bar: 1 Fm7, 3 Db, 4.50 Eb/G` (fractional bars use two
  decimals). `directServiceParams` adds `chord_timing` (`unit: bar`, `origin:
  region-start`, `provenance`, `enforced: false`, `events: [{bar, symbol}]`) only when
  chords are known, so requests without chords are unchanged. `service/direct_render.py`
  accepts the field as optional, rejects a malformed one (non-increasing or sub-1 bars,
  non-chord symbols, more than 64 events, other units or provenance names), and records a
  normalized copy in the manifest with `enforced: false`. Older requests stay valid. SA3
  sees only the prompt text, and nothing checks whether the take follows the changes.
- **Tempo conformance is a technical check, not taste.** After the existing checks, the
  worker measures the generated audio's beat period with `checkTempoConformance`. It is
  dependency-free. The audio is first-differenced (high-frequency emphasis, so steady low
  tones do not ripple into fake pulses). The method then takes 20 ms log energy on 5 ms
  hops, floored 60 dB below the loudest window, and builds an onset envelope from rises
  gated at about 0.4 dB. A normalized autocorrelation is searched only within ±15% of the
  session beat period, or of 2 beats for half-time material. The 4-beat lag is not used:
  4 beats at 120 BPM equal 3 beats at 90, so it would pass a wrong tempo. The estimate is
  then refined on 2, 4, 8 ... beat lags.
  The verdict is one of the following, stored as `manifest.m1.tempoConformance` and shown
  in the report column as "Tempo conformance (technical): ...":
  - `conforms`: |drift| ≤ 5 ms per bar;
  - `drifts N ms per bar slower/faster`;
  - `undetermined`, with a reason. This is the result when the BPM is missing or its
    provenance is unknown, when the tempo map is `tempoMapAssumed`, when the audio is
    shorter than 4 beats, or when no clear pulse exists.

  Only the period is measured. Downbeat phase and swing are not checked. With an unknown
  meter, 4 beats per bar is assumed and the line says so. A drifting take stays usable,
  because the check never rejects a take or stretches audio. Takes saved before this
  change report "not measured (version predates the check)". Evidence comes from
  synthetic click tracks only: steady (48 and 44.1 kHz, 90/120/143 BPM, 4 s and 16 s),
  over a sustained pad, at another tempo, in 3/4, accelerating, half-time, at 90 BPM
  against a 120 session, and against noise, a steady tone and silence. Loud broadband
  noise over clicks comes out `undetermined`, not `conforms`. How well the check behaves on real SA3 output is unmeasured.

### Conform and free audition (2026-10-19)

- **Conform is explicit, optional and timing-only.** "Conform tempo" (editor monitor
  column, `ReImagineProcessor::conformSelected`) queues a job on the plug-in's worker
  thread, never the audio thread. The job decodes the selected version and measures it
  again with `checkTempoConformance` against the session as it is now (a stored report may
  be stale). It then asks `planConform` for a ratio. `stretchRatio` = measured BPM /
  session BPM = stretched length / input length, so a 121 BPM take in a 120 BPM session is
  lengthened by 121/120. The new version then keeps its parent's exact length, because it
  replaces the same region: a sped-up take is padded with silence (otherwise the dry source
  would play through the end of the region) and a slowed one is trimmed. `paddedFrames` and
  `trimmedFrames` are recorded on the version and in `version.conformed`, and the technical
  checks are re-run on the conformed audio.
- **Refusals, each with its reason in the status line and the experience log
  (`conform.refused`):** the tempo map is `tempoMapAssumed`; the session BPM is missing or
  its provenance is unknown (host- and user-set BPM are both accepted); the measurement is
  `undetermined` (its reason is quoted); it was taken against a different BPM; the version
  already conforms; |stretchRatio - 1| is above 8%, which more likely means another tempo or
  feel than drift. A generation and a conform never run at the same time.
- **Stretcher:** the SoundTouch library vendored inside Tracktion Engine, with Tracktion's
  `soundtouchBetter` settings. This is the stretcher the main app's warp uses. The plug-in
  does not link the engine, so `src/reimagine/ReImagineConform.cpp` compiles those sources
  into its own namespace. Pitch is kept. The stretcher returns round(frames x ratio)
  frames at the version's own sample rate, which are then padded or trimmed to the
  parent's length (above).
- **The result is a new version.** The original take and its asset are never overwritten.
  The new take copies the parent's manifest and adds lineage in `manifest.m1`: `role:
  conform`, `parentTakeId`, `conformedFrom`, `stretchRatio`, and a `conform` record (the
  plan, the method, the measurement before, the parent's asset hash). Its
  `tempoConformance` is measured on the stretched audio. It is selected, and the report
  column shows "Conform: x1.0083 (121.00 -> 120.00 BPM); timing only - downbeats not
  aligned, not checked by ear". The new keys are only written on conformed takes, so older
  takes and states load unchanged (`PluginStateV1` is still schema 1).
- **Undo** removes the selected version when it is the newest version, a conform, and not
  kept, then reselects its parent. The stored asset stays in the content-addressed store.
  The plug-in has no Tracktion UndoManager; this is its own one-step undo for this edit.
- **Experience log:** `conform.requested` and `version.conformed` are `explicit`;
  `version.conform-undone` is `explicit`; refusals are `system`.
- **What conform does not do.** It changes the beat period only. It does not move the
  downbeat, so a take that starts off the grid still starts off the grid. It does not fix
  swing, tempo changes inside the take, or musical alignment with the chords. It was not
  checked by ear, and SoundTouch artefacts on real SA3 output are unmeasured.
- **Free audition.** "Free preview" plays the selected version locally when the host gives
  no transport or timing (or is stopped). It starts from the version's first sample, plays
  once and stops; it never follows the host timeline. The state machine is
  `FreeAudition` (lock-free; started by the worker after it loads the selection, advanced
  on the audio thread). The preview replaces the input, like the replace route; it never
  adds to it. It refuses to start while the host plays, and it stops itself in the same
  block in which host-synced replace playback becomes active, or when the selection's
  audio is reloaded. So the region is never audible twice. The report column says
  "Audition: FREE-RUNNING local preview - not host-synced, does not follow the timeline",
  and the experience log records `version.auditioned` with `mode: free-running`
  (implicit).

### Cloud planner (opt-in, 2026-10-19)

- **What it does.** With "Claude writes the prompt" on (editor, beside the intention
  heading; stored with the Set), Generate and Revise first ask the helper's
  `POST /reimagine/plan`. `service/reimagine_planner.py` makes **one** Claude Messages API
  call with a JSON-schema answer: `prompt` (at most 600 characters), `strength`
  (0.01-0.5), `candidate_count` (at most the count you chose), `interpretation`, and
  `unsupported` (what SA3 cannot enforce, in your terms). Default model `claude-opus-5-5`
  at effort `medium`, with Anthropic's server-side default fallback for safety refusals.
- **What it receives.** Your request and revision text; key, BPM, meter, chord names with
  bar numbers, section label and protected choices, each with provenance; the input's
  duration and whether it is the source or a parent version. **Never** audio, file names,
  paths, hashes or ids. `plannerRequestBody` builds it in C++, and the helper drops
  anything else before sending.
- **Consent and key.** Off unless `~/.config/mosh/reimagine-planner.env` (override
  `MOSH_REIMAGINE_PLANNER_ENV`) says `MOSH_REIMAGINE_PLANNER=anthropic` and holds
  `ANTHROPIC_API_KEY`. A key in the shell or in `~/.config/mosh/env` is not consent and is
  never read. The helper never holds the key: the call runs in a subprocess under
  `MOSH_REIMAGINE_PLANNER_PYTHON` (default `~/Library/Mosh/planner-venv/bin/python`, a
  venv with the `anthropic` package), started with the shell's `ANTHROPIC_API_KEY`
  removed.
- **Budget.** Each call is priced from its token usage and appended to
  `~/Library/Mosh/ReImagine/planner-ledger.jsonl` (cost, tokens, model, request id; no
  text). A call is refused before it is made when the ledger total plus its worst case
  would pass `MOSH_REIMAGINE_PLANNER_BUDGET_USD` (default 20). Unpriced models are
  refused. `GET /reimagine/plan/status` reports enabled/model/spent without the key.
- **Fit to the budget.** The template request is compiled and validated first, so the
  attempt budget is reserved before any call. A plan can only lower the candidate count;
  it is applied by `applyPlannerPlan` and validated again by `validateRequest`.
- **When it is not used.** Off, no key, over budget, helper or network down, a refusal, a
  timeout (120 s) or an unusable plan: the template request renders, the version stores
  `controllerRecord {requested, used:false, reason}`, the report says "Prompt by:
  template (cloud planner not used: <reason>)", and the log records
  `controller.plan-unavailable`. This is a local fallback, never another provider.
- **Provenance.** A planned version stores `controller: cloud-planner`, the controller
  record (model, served model, effort, tokens, `costUsd`, latency, request id), the
  interpretation and the unsupported list in `manifest.m1.request`; the conditioning
  table gains a `controller` row; the report shows "Prompt by: <model> ($cost, text only -
  it never heard the audio)". The log records `controller.planned` (`system`).
- **Gary comparison instrumentation.** `intention.compiled` and `revision.requested`
  carry `controlsTouched` and `controls`: the settings changed since this instance's
  previous request, each counted once (prompt, strength, seed, count, colors, LoRAs,
  revision text, from-selected-audio, planner switch, and user-entered context fields).
  Every `version.presented` carries `secondsSinceRequest`; the first of a batch also
  carries `firstCandidateSeconds`.
- **What it does not prove.** Nothing here shows that Claude writes better prompts than
  the template, or that SA3 follows them. Tests use a stand-in for the provider.

### Review fixes (R1, 2026-10-19)

- **P1**: the audible-snapshot hand-off (both reader sites and the publisher) uses
  seq_cst, so a snapshot cannot be freed under the audio thread.
- **P2**: a host re-prepare right after a Transfer stops no longer re-sizes the capture
  buffer under the pending write; the Transfer is saved whole, at its capture rate.
- **P3**: assets are named only by 64-hex digests, so a hash from a crafted Set never
  becomes a path.

## Commands

macOS, through the repository's build:

~~~sh
cmake --preset <your-preset> -DMOSH_BUILD_REIMAGINE_PLUGIN=ON -DMOSH_BUILD_TESTS=ON
cmake --build <build-dir> --target MoshTests MoshReImaginePlugin_VST3 MoshReImagineLoopE2E MoshReImagineEditorSmoke
<build-dir>/tests/MoshTests "[reimagine]"
ctest --test-dir <build-dir> -R MoshReImagine --output-on-failure   # Bundle, Editor and LoopE2E (LoopE2E needs python3)
~~~

Linux (CI and the cloud container) add `-DMOSH_BUILD_APP=OFF -DMOSH_BUILD_UI=OFF
-DMOSH_BUILD_PLUGIN_FIXTURES=OFF` to the `linux-x64-debug` preset and run the editor
smoke under `xvfb-run -a`.

Planner (owner Mac, once):

~~~sh
python3 -m venv ~/Library/Mosh/planner-venv && ~/Library/Mosh/planner-venv/bin/pip install anthropic
umask 077; cat > ~/.config/mosh/reimagine-planner.env   # MOSH_REIMAGINE_PLANNER=anthropic, ANTHROPIC_API_KEY=..., optional _MODEL/_EFFORT/_BUDGET_USD
python3 service/reimagine_planner.py --status
python3 service/scripts/reimagine_planner_test.py      # no network, no key
~~~

`MoshReImagineLoopE2E <repo-root>` runs the real processor headless against
`service/server.py`. It uses a scratch `HOME` and the direct-render **test fixture**
adapter (`MOSH_REIMAGINE_ADAPTER=fake`, `MOSH_DIRECT_RENDER_TEST_FIXTURE=1`). Its output
is plumbing evidence, not a model render.

## Evidence (2026-10-10, Linux cloud container, JUCE `7c89e11f` as pinned)

The plug-in target is gated to Apple in the repository build, so these results come from
a scratch CMake project that compiles the same sources.

- `[reimagine]` Catch2: **33 test cases / 274 assertions passed**. These are the 20
  existing core cases plus 13 new session cases. The new cases include deliberately bad
  audio (silent, NaN/Inf, empty, clipped, wrong length) and malformed requests.
- The Re-Imagine VST3 compiles and links on Linux with JUCE's recommended warnings. Two
  warnings remain, both already present (`progressValue`, `playHead` shadow).
- `MoshReImagineLoopE2E`: **PASS, 3 of 3 runs** (54 checks). It covers:
  - helper down: no attempts spent, no fallback
  - a LAN host is refused
  - 2 candidates, then 2 revisions linked to version B, starting from B's audio
  - Keep; new versions do not displace the kept selection
  - budget 8/8 reached; a ninth attempt is refused
  - byte-identical, idempotent export plus sidecar
  - cancel publishes nothing
  - two instances on one helper receive only their own results
  - save/reopen restores versions, the kept selection, the budget and the context
  - a missing asset is reported and audio stays dry; the exported copy survives
  - the source file is byte-identical
  - the experience log contains the expected events and signal tags
- `MoshReImagineEditorSmoke` passes under Xvfb with the new 1180×690 layout.

### Linux CI (2026-10-15)

The repository build now accepts `-DMOSH_BUILD_REIMAGINE_PLUGIN=ON` on Linux. The
default stays Apple-only, so the scratch project above is no longer needed. The
path-filtered `reimagine-plugin` job in `.github/workflows/linux-ci.yml` builds the VST3,
`MoshReImagineLoopE2E` and `MoshReImagineEditorSmoke`, then runs
`xvfb-run -a ctest -R MoshReImagine`. Local run in the cloud container: both tests
passed 3 of 3 times, and `MoshTests "[reimagine]"` passed 3 of 3 times (33 cases,
274 assertions). `MoshReImagineBundleSmoke` is not built on Linux because it inspects
the macOS bundle (`Info.plist` via `plutil`, the `Contents/MacOS` binary via `lipo`).
None of this is evidence for the macOS native gate, audibility, Live 11 or a real SA3
render.

### Conform and free audition evidence (2026-10-19, Linux cloud container)

Same method as above (local-only CMake patch so the plug-in targets configure on Linux;
not committed). Engineering evidence only: synthetic clicks, no model, no listening.

- `[reimagine]` Catch2: **43 test cases / 511 assertions passed**. New cases cover:
  - the ratio math and the inclusive 8% bound, both directions;
  - every refusal (assumed tempo map, unknown or unproven BPM, undetermined, already
    conforms, a measurement against another BPM, out of bounds);
  - a synthetic click at 121, 118 and 126 BPM, at 48 and 44.1 kHz, stretched with the plan's
    ratio. D1's checker then reports `conforms` to 120 BPM within 0.15 BPM, and the length
    is exact;
  - lineage and `PluginStateV1` round-trip, with an older state still loading;
  - the free-audition state transitions.
- `MoshReImagineLoopE2E`: **PASS, 3 of 3 runs** (85 checks after the review fixes; the 31 conform/preview checks need no helper).
  It covers:
  - an assumed-tempo import is refused;
  - an import under a fake 120 BPM host playhead conforms a 121 BPM click into a new
    version that measures `conforms`, keeps the parent's exact length (the trim is
    recorded), is labelled "conform of v1" rather than "import", and leaves the original
    asset intact;
  - conforming that version again is refused ("already conforms");
  - free preview is audible with no playhead;
  - when the fake host starts playing, the preview stops in that block. (The output peak
    of 0.736 equals one copy, but the preview copies rather than adds, so the peak alone
    could not reveal double playback; the evidence is that the preview reports stopped.)
  - the preview is refused while the host plays;
  - undo restores the original;
  - the experience log has the conform events.
- `MoshReImagineEditorSmoke` passes under Xvfb; the conform, undo and preview buttons sit
  in the monitor column. `MoshReImagineBundleSmoke` is macOS-only (it runs `plutil` and
  `lipo`) and fails on Linux whatever the change.
- Licence note: SoundTouch is LGPL-2.1. It is not listed in
  [DEPENDENCY_BOM.md](../DEPENDENCY_BOM.md) for either the app (which already ships it for
  warp) or this plug-in. That is an open item for the owner, not resolved here.

## Owner-Mac verification (2026-10-10, arm64, macOS 26.4.1, 64 GB)

Automated and engineering-only. It says nothing about how anything sounds, and nothing
about Live.

- Repo build, `macos-arm64-release` preset with `-DMOSH_BUILD_REIMAGINE_PLUGIN=ON
  -DMOSH_BUILD_TESTS=ON`: `MoshTests "[reimagine]"` **33 cases / 274 assertions passed**;
  `ctest -R MoshReImagine` Bundle, Editor and LoopE2E **3/3 passed**; LoopE2E **PASS 3 of
  3** (54 checks, about 10 s each).
- LoopE2E first **failed** on macOS (ctest timeout). JUCE resolves the home directory with
  `NSHomeDirectory()` and ignores `$HOME`. The test therefore read the owner's real
  helper `service.port` and never reached its fixture helper. It also wrote to the real
  experience log, asset store and `~/Music/Mosh Exports`. Fix `49a2e3b5`: the four
  per-user roots honour `MOSH_REIMAGINE_HOME`, and LoopE2E sets it. With the variable
  unset, behaviour is unchanged.
- Canonical gate `scripts/auto-loop/gate.sh native <worktree> origin/main` on `49a2e3b5`:
  **PASS**, 24/24 steps, `--selftest` ×3 at 5038/5038, ctest 12/12 (LoopE2E included),
  `verify.py` 35/35, `direct_reimagine` PASS. An earlier run failed `build_app` only
  because the verifier had briefly left an uncommitted doc edit in the worktree. The
  Release identity check refuses a dirty tree; the failure was reproduced and is not a
  defect in the PR.
- One real render through the plug-in's request path. A headless `ReImagineProcessor`
  ran against the owner's shared helper, with real HOME and no adapter or fixture env.
  Source was the **4 s synthetic E2E fixture, engineering-only**. The run made 2
  candidates and then 1 revision of candidate 2 from its audio (3 model attempts, no
  retry):
  - every version reports `backend: mlx`, `model_variant: sa3-medium` and no
    `test_fixture`, at 8 steps, nl 0.35;
  - technical checks are `usable`, with duration delta 0.000 s;
  - the 8-row conditioning table is stored, and the revision is linked to its parent.
  - `generationSeconds`: 4.13 (first, warm helper), 1.18, 1.52.
  - SA3 returned **44.1 kHz** for the 48 kHz source. Playback resamples on load;
    Export copies the raw 44.1 kHz file.
- The bundle smoke passed against the copy installed in `~/Library/Audio/Plug-Ins/VST3`.
- SA3 checkpoint provenance: the local MLX weights link to the Hugging Face cache of
  `stabilityai/stable-audio-3-optimized` (snapshot `2204d508`, `MLX/`), fetched by
  Stability-AI/stable-audio-3's own installer. That is an official Stability AI release
  under the Stability AI Community License. The licence text is not cached locally.

## Owner-Mac verification (2026-10-19/20, arm64, macOS 26.4.1)

Automated and engineering-only, like the 2026-10-10 pass. Nobody listened to anything, and
Live was not opened. Evidence lives outside the repo in
`~/Library/Mosh/task-evidence/reimagine-m1-20261019/` (manifests, harness logs, analysis
scripts, the planner request/response and ledger lines).

### 1. Canonical gate

`scripts/auto-loop/gate.sh native <worktree> origin/main` ran from each candidate
worktree's own driver. #790 and #799 were already merged, so they were not gated.

| PR | Head gated | Base | Result |
|---|---|---|---|
| #802 | `8838ffe4` | `c01087e7` | **PASS** 25/25. `--selftest` ×3 5046/5046, ctest 12/12. Merged on that head. |
| #803 | `baa0a104` | `d954a588` | **PASS** 24/24 (`npm_ci_native` skipped: node_modules fresh). `--selftest` ×3 5046/5046, ctest 12/12. |

#803's head moved twice while being gated (`0c035e49` → `b6f2b847` → `baa0a104`, the last
merge bringing in #789's CMake changes). Both earlier heads also passed and are superseded.
Extra checks on the `baa0a104` build (`macos-arm64-release`,
`-DMOSH_BUILD_REIMAGINE_PLUGIN=ON -DMOSH_BUILD_TESTS=ON`):

- `Mosh --selftest` ×3, private session and port each: 5046/5046 ×3.
- `Mosh --selftest-undo`: 92/92.
- `MoshTests "[reimagine]"`: 49 cases / 581 assertions.
- `ctest -R MoshReImagine --output-on-failure`: Bundle 0.85 s, Editor 0.13 s, LoopE2E
  14.07 s, 3/3.

Known side effects, not defects of these PRs: each manual `--selftest` left its spawned
shared helper orphaned on its port, and `MoshReImagineEditorSmoke` started the real shared
helper on :8770. All four were stopped by hand. The PR comments carry the step tables.
Main after #803 (`938d4068`) differs from `baa0a104` only in tests, CI and harness files
(#795), so the installed plug-in has main's product code.

### 2. Gary baseline probe (read-only)

- Installed: `/Applications/gary4local.app`, `thecollabagepatch.gary4local` **0.1.11**
  (build 111), team `P8L4LGS728`.
- Not running and apparently never launched: no Application Support folder. Nothing
  listened on 8000/8002/8003/8006/8007/8015/8770, and `curl` to `:8006/health`,
  `:8006/ready` and `:8003/health` returned HTTP 000. So no versions or models were
  reported, and the 0.0.0.0 bind in its published `sa3/api.py` was not observed here.
  Gary was not launched, because a first launch may download models.

### 3. Claude planner

- Venv `~/Library/Mosh/planner-venv` with `anthropic` 1.15.0. The opt-in file
  `~/.config/mosh/reimagine-planner.env` is mode 600. The owner pasted the key; the file
  was never printed.
- `python3 service/reimagine_planner.py --status`: `enabled: true`, `anthropic`,
  `claude-opus-5-5`, effort `medium`, budget $20, spent $0. No key is shown.
- `python3 service/scripts/reimagine_planner_test.py`: OK, 57 PASS and 1 SKIP (the no-SDK
  path, because this interpreter has `anthropic`).
- One smoke call: `POST /reimagine/plan` on the restaged helper (scratch port 18770), with
  `body()` text only and no paths. Result: `ok`; served model `claude-opus-5-5`;
  1322 input / 303 output tokens; **$0.011348**; **7164 ms**; strength 0.3; 2
  candidates. Three "unsupported" items were listed: exact chord following, chord-change
  timing, and "less busy". One ledger line was written, with no text.

### 4. Plug-in install

- Built from `baa0a104` with the repository preset and the flags above. Installed as
  `scripts/install-owner-reimagine-plugin.sh` does for the bundle: `ditto`, ad-hoc
  `codesign --force --deep`, then `--verify --deep --strict` (valid). The previous bundle
  was kept as `Mosh Re-Imagine.vst3.bak-20261019`.
- `MoshReImagineBundleSmoke` against the installed copy: "scan/load/editor/dry/state smoke
  passed".
- **The install script was not run as written.** Its helper step is `rsync -a --delete`
  without excluding `sft/.adapters/` or `sft/.sft-data/`, so it would have deleted
  3.5 GB of owner SFT data in the shared helper. Instead:
  - the helper was backed up as `service.bak-20261019` (APFS clone);
  - main's `service/` was restaged additively (`rsync -rlc`, no `--delete`). That changed
    9 files (`server.py`, `direct_render.py`, `reimagine_planner.py` and tests) and
    deleted nothing.
  - On a scratch port the restaged helper reported `explicitRenderDecision: true`,
    `sa3: true` and planner `enabled: true`.
  - The script's `--delete` is still a hazard for the next person who runs it.

### 5. Real SA3 renders on the owner's phrase

**Source.** `LasTrain 15-Rhodes_01.wav` is the isolated Rhodes stem from the owner's own
2021 "LastTrain" multitrack export (Google Drive). The owner chose it by syncing it for this
run. Bars 33–40 were cut: 127.241 s to 150.374 s, **23.133 s**, 44.1 kHz, written as 24-bit.
All context was measured by script, not given by the owner:

- **BPM 83, 4/4.** A grid fit put 182/182 kick onsets within 25 ms of an eighth-note grid at
  166.00 BPM (median error 3 ms). 83 rather than 166 was chosen because 82% of the Rhodes'
  harmonic changes fall on even grid beats. The chord loop is 4 bars at 83 (chroma
  similarity 0.983 at a 4-bar lag).
- **Key Eb major.** Krumhansl correlation 0.904; next best C minor, 0.63.
- **Chords** (chroma-template estimate, not a transcription):
  `1:Abmaj7 1.75:Ebmaj7 2.25:Bbm7 2.75:Ebmaj7 4:Cm7 5:Ebmaj7 6.25:Bbm7 6.75:Ebmaj7 8:Cm7`.
  This is the raw labels with a 2-beat out-of-key "Cmaj7" read as Cm7 and a 2-beat tail
  dropped.

**Method.** A headless `ReImagineProcessor` (throwaway harness, not committed) ran with
real HOME, the restaged shared helper on :8770, and no adapter or fixture env. A fake host
playhead reported 83 BPM 4/4, so tempo is host-provided rather than assumed. Strength was
0.4, seeds 4242+, 2 candidates, then 1 revision batch of 2 from candidate 2 using its
audio. Requests were as in M1-GARY-COMPARISON.md. Each intention used **4/8 attempts, 0
failed**.

All 8 versions report `backend mlx`, `model_variant sa3-medium`, 8 steps, no
`test_fixture`, checks `usable`, duration delta 0.000 s, and **44.1 kHz in and out**.

| Run | Version | nl | gen s | Since request s | Tempo conformance (technical) |
|---|---|---|---|---|---|
| template | cand 1 | 0.40 | 2.68 | 2.84 (first candidate) | undetermined: no clear pulse within 15% |
| template | cand 2 | 0.40 | 4.07 | 6.97 | conforms: 83.01 BPM, −0.3 ms/bar |
| template | rev 1 of cand 2 | 0.40 | 5.83 | 6.04 (first) | undetermined |
| template | rev 2 of cand 2 | 0.40 | 4.68 | 10.78 | drifts +365.5 ms/bar (95.01 BPM) |
| planner | cand 1 | 0.30 | 2.60 | 9.21 (first) | undetermined |
| planner | cand 2 | 0.30 | 4.16 | 13.44 | undetermined |
| planner | rev 1 of cand 2 | 0.22 | 4.08 | 9.25 (first) | undetermined |
| planner | rev 2 of cand 2 | 0.22 | 4.76 | 14.08 | undetermined |

**Controller.** Template runs report "Prompt by: template". The prompt sent was the
request verbatim, the revision text when there was one, then
`in Eb major, 83 BPM, chords by bar: 1 Abmaj7, …`.

Planner runs: two calls to `claude-opus-5-5`, served as `claude-opus-5-5`:

| Batch | Cost | Latency | Prompt sent |
|---|---|---|---|
| Generate | $0.012032 | 6445 ms | "hazy sampled keyboard loop, dusty lo-fi electric piano sample, warm tape saturation, soft wow and flutter, vinyl crackle, muffled high end, mellow sustained chords, sparse relaxed playing, gentle reverb wash, nostalgic dreamy mood, Eb major, lo-fi hip hop production" |
| Revise | $0.011680 | 4927 ms | "hazy sampled keyboard loop, lo-fi Rhodes-style electric piano resampled from vinyl, rough gritty texture, crunchy bit-reduced grain, tape saturation and wow, dusty crackle, muffled warm low-pass tone, mellow sparse chords, laid-back soulful mood, Eb major, boom-bap sampler character" |

Neither planned prompt carries the BPM or the chord list as text. Chord timing still went
as structured data. The planner lowered strength to 0.3 and then 0.22. Ledger total so
far: $0.035.

**Earlier aborted run.** A first template run made 2 candidates (`generationSeconds` 8.11
cold, 4.65), then exited before its revision batch ran. The harness bug: the revision wait
checked "batch active" 100 ms after queueing. The log has `revision.requested` and no
revision attempt. It is kept as `template-aborted-harness-wait-bug/` and is not counted
above.

**Files for Live.** `~/Music/Mosh Re-Imagine M1 2026-10-20/` holds the source excerpt
(`00 …`) and the 8 versions (`11`–`14` template, `21`–`24` planner, named by role, seed and
nl). These are copies; the content-addressed originals stay in the asset store.

The measured "first candidate" is time to a stored, decoded version in a headless
process. It is not "seconds to first audible" in Live, which is the owner's stopwatch
number on the comparison sheet.

### 6. Unattended pass through the listening checklist in Live 12

Done overnight with the owner's go-ahead, and with no listening.

**Host.** Ableton Live **12.4.6** Suite at 48 kHz, which is the owner's host (owner
correction, 2026-10-20: the checklists' "Live 11" means the owner's Live, which is Live 12).
A stale Live 11 Standard install on this Mac is broken and not used.

**Setup.** Producer Pal 1.4.7 created the test Set and drove the transport: tempo 83,
the source excerpt unwarped on an audio track at bar 1, and Main at −70 dB while testing.
The plug-in UI was driven with synthetic clicks and keys plus screenshots.

**Results.** Screenshots and the 54 experience-log lines of this pass are in
`~/Library/Mosh/task-evidence/reimagine-m1-20261019/live12/`. The Set is
`~/Music/Mosh Re-Imagine M1 2026-10-20/Live12 check/…/M1 Live12 check.als`, with Main back
at 0 dB.

**A. Set up**

| Item | Observed |
|---|---|
| A1 | The plug-in loads and its editor opens. "Claude writes the prompt" sits beside the intention heading. "10 local adapters available". |
| A2 | Transfer → "Transfer armed – press Play in Live"; after 8 bars → "Transfer ready". My first stop was late, so the region was 0–34.45 beats. A second Transfer → "Overlap detected – choose Replace or Discard" → Replace. The stored region is 0–32.38 beats (export sidecar), but the region menu kept showing "0.00 to 34.45" until the Set was reopened (**stale label**). |
| A3 | Key, chords, section and protected choices saved: "Context saved for this region (user values override host values)". The report shows Tempo 83.00 BPM (host). |

**B. Template, then planner.** Candidate 2 was selected mechanically, not by ear.

| Item | Observed |
|---|---|
| Template B1 | 2 candidates, "2/8 attempts, 0 failed", "Prompt by: template". `firstCandidateSeconds` 6.90 (cold helper), second at 11.78 s. `controlsTouched` 6. |
| Template B3 | Revision of v2 from its audio: v3 and v4 at 3.81 s and 8.94 s, "4/8". v3 reports "drifts 361.1 ms per bar slower (measured 73.79 BPM)". |
| Planner B1 | 10.31 s and 15.71 s (includes one call: $0.012736). Report: "Prompt by: claude-opus-5-5 ($0.0127, text only - it never heard the audio)" and a "Planner: not enforceable" list. The checklist expects the words "Planned by"; the plug-in says "Prompt by". `controlsTouched` 3 counts "revision" on a Generate because the unused revision box changed since the previous request. |
| Planner B3 | v7 and v8 at 10.79 s and 15.93 s (call $0.011844, 4992 ms), "4/8". |
| B2 and B4 | Listening, left blank. |

**C. Keep, export, conform, preview**

| Item | Observed |
|---|---|
| C1 Keep | v7 → "kept in Mosh (not written to the DAW timeline; Export or drag to place it)". |
| C1 Drag WAV | **Not done.** A synthetic mouse drag from Drag WAV onto a Live track created no clip. During that attempt Live's transport started and the automation-arm and draw toggles changed, leaving a stray automation envelope on 1-MIDI in the test Set only. Needs a human drag. |
| C2 Export | `~/Music/Mosh Exports/Verse_bar1_83bpm_99ddecbd.wav` (44.1 kHz, 23.41 s, decodes) plus a JSON sidecar with region ppq 0–32.38, context, lineage and `hostPlacement: unobserved`. |
| C3 Conform | On v3: "Conform refused: would stretch by -11.1% (limit +-8%): more likely another tempo or feel than drift". No conformed version exists, so there is nothing to judge for SoundTouch artefacts. |
| C4 Free preview | Stopped → "Free audition playing – local preview, not synced to the host timeline". Live Play → the button resets and the report says "host-synced playback took over". The bottom status line still says "Free audition playing" (**stale status**). Only the start is logged (`version.auditioned`). Audibility is unknown. |

**D. Save, reopen, safety**

| Item | Observed |
|---|---|
| D1 | Save, quit Live, reopen: all 8 versions, v7 KEPT, the selected version, context, request text and planner switch are restored, and "Selected takes loaded". The region label now reads 0.00–32.38. The revision text box is not restored. |
| D2 | 100 BPM + Play → "Tempo map changed – region is stale; Re-transfer required". Back at 83 the region **stays stale**; by code, the stale flag is latched until a re-Transfer, and the audio path skips substitution (dry). The report's "Audible:" line still names the selected version. "Plays dry" is confirmed from the code, not by ear. |
| D3 | **Skipped.** It means changing Live's audio buffer or sample rate preferences. Covered only by the headless P2 test. |

**Item 9 of the 2026-10-10 checklist (two instances at once).** A second instance on another
track had its own Transfer. Instance B queued 4 candidates, and instance A queued 2 about
6 s later, while B was still rendering. Attempts interleaved on the shared helper, and each
instance presented only its own versions. Under contention an attempt took about 9.3 s
(about 5 s alone), and B's 4th version arrived at 26.7 s.

**Planner spend after this pass:** $0.0596 over 5 calls.

**Other.** macOS asked whether Live 12 may access Apple Music / media; I answered
"Don't Allow".

### 7. Merges, reinstall and the Gary side (2026-10-20, owner-authorized)

- **Merged:** #805 (additive installer), #806 (stale editor labels), #804 (this record).
  Main `36e68a78`.
- **Reinstalled from main** with the fixed `scripts/install-owner-reimagine-plugin.sh`.
  The previous bundle was kept as `.bak-20261020`. Bundle smoke against the installed copy
  passed. The helper's `server.py` matches main. The 3.5 GB of SFT data (`.adapters`,
  `.sft-data`, `.artifacts`) survived, and the run scripts stayed executable.
- **Gary probe (live this time).** gary4local 0.1.11:
  - The owner approved the first-launch dialog. Only the **sa3** environment was built
    (Python 3.11 venv, 732 MB; torch 2.7.1, MLX).
  - Its checkpoint `stabilityai/stable-audio-3-medium` is gated. The owner accepted access
    and saved an HF token in Gary's keychain setup.
  - Gary downloaded 9.2 GB of weights plus a 1.2 GB t5gemma encoder, about 10 GB in all
    under `~/Library/Application Support/GaryLocalhost/cache`.
  - `/health`: `status healthy`, `backend mlx`, `model medium`, 44.1 kHz, DiT float32 /
    autoencoder float16, `hf_token_configured: true`.
  - **Listens on `*:8006`, all interfaces** (LAN-reachable), as `api.py`'s `0.0.0.0`
    suggested. No other Gary port was started.
- **Gary run** (`gary/run_gary.py` in the evidence folder): the same 8-bar source and the
  same two requests, sent to `/transform` and timed POST-to-result. Settings were Gary's
  defaults (8 steps, cfg 1.0, pingpong, **strength 0.9**) with no chord list, run one at a
  time. The Mosh helper was not running.

  | Attempt | Seconds |
  |---|---|
  | 1A | 39.62 (cold: includes about 33 s of model load) |
  | 1B | 6.73 |
  | Revision 2A of 1B | 6.68 |
  | Revision 2B of 1B | 6.84 |

  Batch 1 took 46.4 s and batch 2 13.6 s, 4 attempts in all. All outputs are 23.13 s,
  44.1 kHz, copied to `~/Music/Mosh Re-Imagine M1 2026-10-20/` as `31`–`34`.
  Gary's model was then unloaded (`/unload`).
- **Read with care.** Different checkpoints: Gary uses `stable-audio-3-medium` (float32
  DiT); Mosh uses `stable-audio-3-optimized` MLX at about 4–5 s warm. Strength differs too
  (0.9 vs 0.4). These are the out-of-the-box settings of each tool, not a matched model
  test. The sheet's measures (seconds to first *audible*, controls touched, keep/reject)
  are the owner's.
- Disk after the Gary install: 19 GB free. That is below the 32 GB the native gate's
  memory preflight requires.

## Not verified (owner steps)

- Listening to the owner-phrase renders above: keep/reject, chord fit, "less busy",
  texture. Also whether the measured BPM, key and chords match what the owner played,
  since they are estimates.
- In Live 12 (section 6), these remain unchecked: seek and loop-wrap audition, the Drag WAV landing (C1), D3, and
  every audible claim (no doubling, no clicks, dry when stale). Host-synced playback is
  tested headless at 44.1/48/96 kHz, five block sizes, seeks and a loop wrap against a
  fake playhead; that is not Live.
- Any musical judgement: is a candidate useful, does it follow the chords. The comparison
  against direct use of Gary, with the same source and budget, has not been run
  ([M1-GARY-COMPARISON.md](M1-GARY-COMPARISON.md) is the sheet).
- Whether planned prompts beat the template is a listening question. Three real calls
  were measured on the owner's account (above), and one session is an anecdote.
- The Gary side of the sheet: listening, keep/reject, seconds to first audible, controls
  touched. The renders exist (section 7); judging them is the owner's.
- The #806 editor fixes (region label, preview status, "Audible: dry") are only tested
  headless. They have not been seen in Live yet.
- Free audition inside a real host with no transport, and its hand-off to host playback
  in Live: only a fake playhead was used.
- Conform on real SA3 output: how often the measurement allows it, and how SoundTouch
  sounds on it. It was not checked by ear. Conform aligns the beat period only, never the
  downbeat, and does not make a take musically fit the chords. Unconformed versions still
  play raw.

### Evidence (2026-10-19, Linux cloud container)

- `MoshTests "[reimagine]"`: **49 cases / 581 assertions**, 3 of 3 runs.
- `MoshReImagineLoopE2E`: **PASS, 3 of 3 runs, 133 checks**, adding:
  - the planner through the real helper with a stand-in subprocess (no network): off by
    default with the reason recorded; on, its prompt/strength/count reach the request,
    cost and provenance are stored, the stand-in received the request and chords but no
    paths, file names or hashes, the ledger has the call, and the log has
    `controller.planned`, `controller.plan-unavailable`, `controlsTouched` and
    `firstCandidateSeconds`;
  - re-prepare right after a Transfer stops, 5 rounds: saved whole at 48 kHz (the same
    test lost the Transfer 5 of 5 times without the P2 fix);
  - the playback matrix described under "Not verified".
- `python3 service/scripts/reimagine_planner_test.py`: 58 checks (consent gate, data
  scope, budget, 13 malformed requests, 8 malformed plans, SDK call shape against a fake
  `anthropic` module, the subprocess key boundary, the HTTP routes).
- `MoshReImagineEditorSmoke` under Xvfb: the planner switch fits beside the heading.

