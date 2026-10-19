# Re-Imagine M1: contextual generation loop

Owner brief of 2026-10-10 ("session-aware local generation agent"). Milestone M1 has one
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
  this. Licence obligations for SA3 and JUCE are already recorded in
  [DEPENDENCY_BOM.md](../DEPENDENCY_BOM.md). The open item there is SA3 checkpoint
  provenance.
- **Host:** Ableton Live 11, the plug-in's existing target. It uses generic capture and
  export; no REAPER adapter is built.
- **Task:** transformation (audio-to-audio re-imagine). An isolated accompaniment part
  does not exist in the repository.
- **Route:** *replace*. The selected version substitutes for the source inside the
  region, so the plug-in never adds a second audible copy.
- **Controller:** template-driven (`reimagine-transform-template/1`). **The typed request
  is not interpreted by a language model.** It goes into the prompt verbatim, followed by
  the user's key, the BPM and chord names. This is a known gap.
- **Privacy:** audio stays local. The service client refuses non-loopback hosts unless
  `MOSH_SERVICE_ALLOW_LAN=1` is set. Direct requests never fall back to another provider
  or a cloud service. The loop makes no paid calls and sends no telemetry.

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
| Meter, section, protected choices | stored and logged only | no |

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
  into its own namespace. Pitch is kept. The output has exactly round(frames x ratio)
  frames at the version's own sample rate.
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

## Commands

macOS, through the repository's build:

~~~sh
cmake --preset <your-preset> -DMOSH_BUILD_REIMAGINE_PLUGIN=ON -DMOSH_BUILD_TESTS=ON
cmake --build <build-dir> --target MoshTests MoshReImaginePlugin_VST3 MoshReImagineLoopE2E MoshReImagineEditorSmoke
<build-dir>/tests/MoshTests "[reimagine]"
ctest --test-dir <build-dir> -R MoshReImagine --output-on-failure   # Bundle, Editor and LoopE2E (LoopE2E needs python3)
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

## Not verified (owner steps)

- A real SA3 render of an **authorized musical phrase** (the run above used a synthetic
  fixture).
- Plug-in behaviour inside Live 11: transport, seek and loop-wrap audition, drag-out
  landing, and save/reopen of a Live Set. The playback code is unchanged from PR #666 and
  was not retested here at other sample rates or block sizes.
- Any musical judgement: is a candidate useful, does it follow the chords. The comparison
  against direct use of Gary, with the same source and budget, has not been run.
- Free audition inside a real host with no transport, and its hand-off to host playback
  in Live: only a fake playhead was used.
- Conform on real SA3 output: how often the measurement allows it, and how SoundTouch
  sounds on it. It was not checked by ear. Conform aligns the beat period only, never the
  downbeat, and does not make a take musically fit the chords. Unconformed versions still
  play raw.
