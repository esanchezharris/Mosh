# Mosh architecture on-ramp

Mosh is a native macOS DAW application with a React UI rendered in a JUCE
WebView. Apple Silicon macOS is the owner-validation surface; the Windows +
NVIDIA/CUDA path is additive. This document maps the selected pre-pivot source
baseline through origin/main **7eb0d617**; it does not define the next product
direction. The annotated tag **pre-pivot-baseline-2026-08-23** identifies the
final docs-only baseline after final verification and publication.

Fresh settings use the **Pro Tools** UI shell (uiShell: "protools"). Live, v2,
and classic are selectable, and existing explicit preferences are retained. The
default is a UI configuration fact, not a declaration of manual parity or
physical-audio acceptance.

## System shape

~~~
React WebView UI (ui/)
        │ execute_command / snapshot + events
        ▼
WebBridge + MoshOps (src/webview, src/moshops)
        │ validated Tracktion mutations, one undo system, JSONL/events
        ▼
MoshEngine + plugins (src/engine, src/plugins)
        │ local asynchronous job protocol
        ▼
Generative service (src/generative, service/)
~~~

The app is a native JUCE/Tracktion process, not Electron and not a web server.
The WebView is a view layer: user-visible engine mutations cross the MoshOps
seam, which validates a command, opens one Tracktion undo transaction, updates
the edit, records JSONL, emits events, and returns a result envelope. Snapshot
and event changes must remain additive.

Heavy generative work runs as a local asynchronous job and never on the audio
thread. The real-time RAVE/anira insert is a separately build-gated option
(MOSH_ENABLE_ANIRA) and is off in the default build.

## Module map

| Area | Primary paths | Responsibility |
|---|---|---|
| Native app and harness | src/app/, src/Main.cpp | Lifecycle, window, packaged UI, --selftest, and --selftest-undo. |
| Engine and persistence | src/engine/, src/state/ | The single Tracktion engine/edit, project/session state, and additive value schema. |
| Mutation seam | src/moshops/, src/webview/ | MoshOps validation/undo/events/result envelopes and native WebView bridge functions. |
| Plugins and DSP | src/plugins/ | VST3/AU hosting, editor pop-outs, spectral/mixer paths, and the optional RAVE insert. |
| Generative rendering | src/generative/, service/ | Local service lifecycle, fake/SA3 adapters, rendering, LoRA/colour paths, and result manifests. |
| Re-Imagine VST3 | src/reimagine/ | Separate VST3 processor/editor and its service protocol; native/bundle evidence is not by-ear Ableton acceptance. |
| DAWN controller | src/dawn_bridge/, resources/ableton/MoshDawnController/, ui/src/companion/ | Native bridge, Ableton Live 11 Remote Script, and phone controller. The iPhone is a controller, not an audio recorder/uploader. |
| UI shells | ui/src/ | Pro Tools fresh-settings default plus selectable Live, v2, and classic shells; UI-local view state remains outside MoshOps. |
| Remote companion | src/remote/, ui/src/companion/ | Pairing, owner-local command/event paths, and phone surfaces. |
| Brain and telemetry | src/brain/, src/telemetry/ | Local agent integration with opt-in telemetry and no repository secrets. |

## Evidence and acceptance boundaries

Automated tests and native gates establish source and contract behavior. They do
not establish the following manual owner-machine outcomes:

| Surface | Still required before claiming product acceptance |
|---|---|
| Physical audio and recovery | Real device routing, playback/input monitoring, repair/rollback, and any signed/installable release claim. |
| Serum recovery | Real BlackHole/Serum-family playback confirmation. |
| Re-Imagine | Ableton audio-track Transfer, real SA3 result, Colours/LoRA by-ear comparison, Set reopen, and shared-process/model-release observation. |
| DAWN | Ableton Live 11 and iPhone reachability, take recording, routing preservation, audible playback, and Live Undo behavior. |
| UI parity | Physical/manual workflow checks beyond browser or host smoke evidence. |

Do not elevate screenshots, dashboards, CI, a host discovery event, or a native
gate to any of these manual claims.

## Build and verification

The local merge authority is:

~~~sh
scripts/auto-loop/gate.sh native <candidate-worktree> origin/main
~~~

Use the configured preset's built application for --selftest three times and
--selftest-undo during final-baseline verification. Regenerate
[docs/FEATURE_AUDIT.md](docs/FEATURE_AUDIT.md) with
scripts/daw-conformance/scoreboard.py and verify it with --check; never
hand-edit the generated scoreboard. Add focused tests where the changed module
has them, including MoshTests for Re-Imagine work.

## Source-of-truth map

- [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) records this pre-pivot
  selected baseline, archive posture, and acceptance limits.
- [docs/FEATURE_AUDIT.md](docs/FEATURE_AUDIT.md) is the generated conformance
  inventory.
- [docs/VERIFICATION.md](docs/VERIFICATION.md) contains physical verification
  policy.
- Re-Imagine and DAWN subsystem evidence records retain detailed automated
  evidence and owner acceptance boundaries.
- [docs/first-stranger-program/README.md](docs/first-stranger-program/README.md)
  is an archive tombstone: First-Stranger is paused and must not be resumed from
  its old lane or worktree instructions.

main remains the only development trunk. Keep
/Users/emiliosanchez-harris/Mosh as the primary checkout; never remove the
shared Git directory at
/Users/emiliosanchez-harris/Library/Mosh/repo/ClaudeMosh.git. The design-lab
branch is protected and outside product consolidation.
