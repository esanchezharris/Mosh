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
| Tempo (BPM) | text in the prompt | no; beat alignment is not enforced |
| Key | text in the prompt | no |
| Chords | chord names in the prompt; change timing is **not** sent | no |
| Meter, section, protected choices | stored and logged only | no |

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

## Not verified (owner steps)

- A real SA3 render through this loop on the owner's Mac. Run one Generate on an
  authorized 2–240 s phrase with SA3 installed, then check the `test_fixture` flag is
  absent and `backend` reads `mlx` in the version report.
- Plug-in behaviour inside Live 11: transport, seek and loop-wrap audition, drag-out
  landing, and save/reopen of a Live Set. The playback code is unchanged from PR #666 and
  was not retested here at other sample rates or block sizes.
- Any musical judgement: is a candidate useful, does it follow the chords. The comparison
  against direct use of Gary, with the same source and budget, has not been run.
- Free audition when host timing is unavailable is **not implemented**. Playback is
  host-synced only.
- No time-stretch or conforming: raw output equals the stored version, and length
  differences are only flagged.
