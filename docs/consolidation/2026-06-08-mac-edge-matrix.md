# ClaudeMosh Mac Edge Matrix - 2026-06-08

## Purpose

This matrix keeps the Mac v0 release bar honest while CI is split into:

- GitHub-hosted macOS smoke CI: portable build, unit, and headless command gates.
- Self-hosted/local Mac gates: CoreAudio, GUI automation, plugin editor, SA3, and
  machine-specific permission proof.

GoogleUpdater in System Settings > Privacy & Security > App Management is a local
system-management state. It is not expected to affect Mosh CI or local release
gates, but App Management remains separate from Accessibility, Screen Recording,
Microphone, and Local Network permissions.

## Automation Priority

1. Portable smoke gates run on GitHub-hosted `macos-15`: UI build, native build,
   `ctest`, headless command selftests, and command-log validation.
2. Local deterministic preflight runs on self-hosted/local Macs:
   `scripts/macos-local-preflight.sh`.
3. Local full release gates run only after the preflight is green:
   `scripts/strict-local-v0-gate.sh`,
   `scripts/blackhole-live-audio-gate.sh`, and
   `scripts/macos-ui-automation-gate.py`.
4. Manual/CUA evidence remains additive for native-window inspection and is not
   allowed to override a deterministic gate failure.

The self-hosted GitHub Actions job is intentionally manual and non-required until
a runner with labels `self-hosted`, `macOS`, `ARM64`, and `mosh-local` is online
and has produced one clean full-gate artifact set. If no matching runner is
registered, the workflow_dispatch run can be cancelled without changing release
status; the local gate evidence remains the authority.

## Edge Matrix

| Edge | Deterministic signal | Gate / preflight | Current policy |
| --- | --- | --- | --- |
| Hosted macOS has no local plugins/models/devices | Runner lacks BlackHole, Serum, local SA3 assets, and GUI TCC grants | `.github/workflows/macos-ci.yml` `hosted-smoke` omits local-only gates | Hosted CI is smoke only, not release authority |
| Tracktion submodule SSH URL | CMake dependency fetch tries `git@github.com:` | CI runs `git config --global url."https://github.com/".insteadOf "git@github.com:"` | Required in both hosted and self-hosted CI |
| UI build drift | `npm --prefix ui run build` fails | Hosted smoke CI, strict local gate | Blocking |
| Native build drift | `cmake --build ... Mosh MoshTests` fails | Hosted smoke CI, strict local gate | Blocking |
| Unit regression | `ctest --test-dir build --output-on-failure` fails | Hosted smoke CI, strict local gate | Blocking |
| Command-surface regression | `Mosh --selftest-undo` or `Mosh --selftest` fails | Hosted smoke CI, strict local gate | Blocking |
| Command-log schema drift | `scripts/validate-command-log-contract.sh` fails | Hosted smoke CI, strict local gate | Blocking |
| SA3 unavailable | `SA3_MLX_DIR` or color rack missing; SA3 selftest fails | `scripts/macos-local-preflight.sh` + `scripts/strict-local-v0-gate.sh` | Local release blocker; not hosted blocker |
| Self-hosted checkout lacks archived proof assets | `MOSH_LEGACY_SA3_BUNDLE` is missing; SA3 color compare cannot find legacy steering data | `scripts/macos-local-preflight.sh` + `scripts/compare-sa3-colors.sh` | Local release blocker; workflow points at the canonical local archive |
| BlackHole missing | `system_profiler SPAudioDataType` lacks `BlackHole 2ch` | `scripts/macos-local-preflight.sh` + `scripts/blackhole-live-audio-gate.sh` | Local release blocker |
| `ffmpeg` missing or AVFoundation cannot see BlackHole | `ffmpeg -f avfoundation -list_devices true` has no BlackHole input | `scripts/macos-local-preflight.sh` + BlackHole gate | Local release blocker |
| BlackHole loopback silent | `--live-audio-smoke` can write to BlackHole output but `MOSH_AUDIO_INPUT_DEVICE="BlackHole 2ch"` receives no non-silent input | `scripts/blackhole-live-audio-gate.sh` internal loopback smoke | Local CoreAudio/BlackHole routing blocker before ffmpeg proof |
| Silent ffmpeg live capture | WAV duration/RMS/peak below threshold after internal BlackHole loopback passes | BlackHole gate Python analyzer with bounded retry attempts | Local AVFoundation capture blocker |
| GUI `open` loses repo cwd/env | Render click shows service unavailable when service was not prestarted | `scripts/macos-ui-automation-gate.py` starts FakeAdapter service explicitly | Automated fallback, not product failure |
| Service port conflict | `http://127.0.0.1:8770/health` points at stale or incompatible service | `scripts/macos-local-preflight.sh` + UI gate service logs | Investigate before release if behavior mismatches |
| CUA action session flake | Computer Use says app is inactive after `get_app_state(app="Mosh")` | CUA evidence doc + AX/Quartz fallback gate | CUA is inspection evidence; AX/Quartz is action authority |
| Accessibility / Screen Recording missing | AX/Quartz or `screencapture -l` cannot inspect/capture windows | `scripts/macos-local-preflight.sh` + `scripts/macos-ui-automation-gate.py` | Local permission blocker |
| Native plugin license dialog | Serum editor opens license/auth dialog instead of full UI | CUA evidence + `scripts/macos-ui-automation-gate.py` Serum tab switch | Local release blocker until authorized |
| Native plugin internals not exposed through AX | AX tree only sees plugin window/container | UI gate uses Quartz window-relative Serum tab click | Accepted local fallback |
| Plugin scan assertion/leak noise | Logs contain `JUCE Assertion failure` or `Leaked objects detected` | `MOSH_STRICT_ASSERTIONS=1 scripts/plugin-host-evidence-gate.sh` inside strict gate | Blocking |
| Strict gates run in parallel | Lock directory already exists | `scripts/macos-local-preflight.sh` + `scripts/strict-local-v0-gate.sh` lock preflight | Blocking until prior run exits or stale lock is investigated |
| Stale persisted session | Old `~/Library/Mosh/session` state changes GUI/demo behavior | Headless selftests use fresh session; GUI gates launch deterministic demos | Accepted, but debug with preserved evidence path |
| Local proof assets accidentally tracked | `assets/grit_demo` reappears in git status | Preservation manifest + git status review | Blocking |
| App Management confusion | System Settings App Management shows updater/dev tools | Human/system observation only | Not a Mosh release gate unless it blocks a tool update |

## Release Bar

Before Mac v0 is called finished:

- Hosted smoke CI must pass on the CI PR and on `main`.
- Self-hosted/local full gates must pass at least once on this Mac:
  - `scripts/macos-local-preflight.sh`
  - `scripts/strict-local-v0-gate.sh`
  - `scripts/blackhole-live-audio-gate.sh`
  - `scripts/macos-ui-automation-gate.py`
- Any failure must be classified into this matrix before being waived.
- Physical speaker/microphone proof remains out of scope; BlackHole is a
  virtual CoreAudio HAL loopback proof only.

## PC / Cross-Platform Readiness Boundary

Do not start Windows/Linux implementation until the Mac matrix is green and the
non-portable assumptions are explicit:

- JUCE/Tracktion native app build surface.
- CoreAudio-only routing and BlackHole proof.
- Apple TCC/AX/screencapture GUI automation.
- MLX/SA3 model path.
- VST3 plugin availability and license state.

The next cross-platform plan should replace each Mac-only proof with either a
portable equivalent, a platform-specific gate, or an explicit out-of-scope note.
The tracked follow-up is
`docs/consolidation/2026-06-08-pc-cross-platform-gate-plan.md`.
