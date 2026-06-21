# ClaudeMosh E2E Planning Audit Code Review

Scope: read-only planning audit for `/Users/emiliosanchez-harris/Documents/ClaudeMosh`.

Current checkout: `main` at `4c858e0` (`Merge pull request #91 from zeke431/feature/ios-companion-hardening`).

Skill-perspective check: ran. Loaded `omo:remove-ai-slops` and `omo:programming` from `/Users/emiliosanchez-harris/.codex/plugins/cache/sisyphuslabs/omo/4.12.1/skills/`. The audit applied their criteria to gate/test quality: reject false-confidence tests, tautological removal-only tests, implementation-mirroring prompt tests, brittle exact-string prompt tests, untyped escape hatches, and production complexity that exists only to satisfy tests.

Subagent availability: no multi-agent/subagent tool was exposed in this harness. I did not spawn subagents. Recommended execution split is listed below as runner roles.

## Findings By Severity

### CRITICAL

None.

### HIGH

1. Stale default native gate paths can fail or create false confidence if copied into a thorough plan.

- `AGENTS.md:16-23` and `docs/CURRENT_STATUS.md:94-105` still point at legacy `build/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh` and `cmake --build build`.
- Current presets build under `build-macos-arm64` and `build-macos-arm64-release` (`CMakePresets.json:5-30`, `CMakePresets.json:60-100`).
- `scripts/strict-local-v0-gate.sh:4-33`, `scripts/plugin-host-evidence-gate.sh:4-19`, and `scripts/stage-ui-swappability-gate.sh` still default to the legacy `build/` app bundle unless env overrides are supplied.
- Risk: a "thorough" e2e plan using wrapper defaults may test an absent/stale app or fail before reaching the real gates. Treat these wrappers as unsafe until called with explicit `MOSH_APP_BIN` / `MOSH_APP_BUNDLE` pointing at the current preset output, or until the wrappers are updated.

2. Project status docs disagree on platform and current gate counts.

- `AGENTS.md:30-31` says macOS/Apple Silicon arm64 only.
- `CLAUDE.md:86-95`, `CMakePresets.json:33-57`, and `scripts/verify-pc-build.ps1:1-127` show a Windows/CUDA port now exists on `main`.
- `docs/CURRENT_STATUS.md:51-60` says Windows remnants were removed and the latest default selftest is 744 checks, while `CLAUDE.md:94-95` and `docs/VERIFICATION.md:63-65` report newer 793/893-era gates.
- Risk: planning from the older handoff doc under-scopes current trunk and misses iOS/Windows/hardware surfaces, or incorrectly treats Windows as forbidden/dead.

### MEDIUM

1. Playwright e2e is valuable but not packaged-app e2e.

- `ui/playwright.config.ts:3-10` is explicit: it drives Chromium + Vite dev server + in-memory mock backend, not WKWebView or the native binary.
- The e2e specs sampled assert real frontend behavior (producer loop, pointer gestures, template-specific drag semantics, modal focus, Web Speech lifecycle), so this is not slop by itself.
- Risk: it cannot prove native WebView resource loading, packaged service discovery, CoreAudio, Tracktion, plugin hosting, or Python service behavior. Always pair it with app binary selftests and `/Applications/Mosh.app` launch/smoke checks.

2. Hardware gates are strong but partly owner/hardware/state gated.

- `docs/VERIFICATION.md:17-25` lists SA3 model wiring, numpy, microphone grant, and brain-key status.
- `docs/VERIFICATION.md:51-65` still has owner-side voice/by-ear/two-window visual confirmations.
- Risk: a fully automated run cannot honestly claim mic/voice, by-ear output, plugin editor visuals, or physical iPhone workflow without local permissions/devices and saved evidence.

3. Deep plugin scans remain environment-bound.

- `docs/CURRENT_STATUS.md:123-125` and `src/app/SelfTest.cpp` comments call out hostile/unknown third-party plugin instability and slow/hanging full-library scans.
- Risk: `--scan-plugins-deep` is useful diagnostic coverage, but should not be a default merge blocker. Keep deterministic allowlisted plugin-host coverage in selftest; run deep scans as a separate environment report.

4. Some unit tests intentionally mirror schema/vocabulary constants.

- Examples sampled: `ui/src/settings/schema.test.ts` and `ui/src/interaction/actions.test.ts`.
- This does not violate the skill perspectives if counted as low-level invariant coverage. It would be slop if presented as e2e confidence.

### LOW

1. TypeScript strictness is useful but not as strict as the `programming` skill ideal.

- `ui/tsconfig.json` has `strict`, `noUnusedLocals`, and `noUnusedParameters`, but not `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, or Biome-style lint enforcement.
- Risk is low for this audit, but a future hardening pass should not confuse "tsc clean" with the skill's strictest TypeScript posture.

2. Python/service tests are script-style, not one unified runner.

- `service/scripts/*.py`, `service/flp/flp_cli_test.py`, and `relay/test_*.py` exist, but there is no top-level Python test manifest.
- Risk: easy to omit a service/relay test in ad hoc e2e runs.

## Strongest Current Automated Gate Stack

The strongest stack is layered. It should be run from `/Users/emiliosanchez-harris/Documents/ClaudeMosh`.

1. Preflight and dependency sanity:

```sh
cd /Users/emiliosanchez-harris/Documents/ClaudeMosh
git status --short --branch
npm --prefix /Users/emiliosanchez-harris/Documents/ClaudeMosh/ui ci
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/macos-local-preflight.sh
```

2. UI static/unit/e2e:

```sh
npm --prefix /Users/emiliosanchez-harris/Documents/ClaudeMosh/ui run typecheck
npm --prefix /Users/emiliosanchez-harris/Documents/ClaudeMosh/ui test
npm --prefix /Users/emiliosanchez-harris/Documents/ClaudeMosh/ui run test:e2e
```

3. Native build and C++ units:

```sh
cmake --preset macos-arm64-debug
cmake --build --preset macos-arm64-app --parallel
cmake --build --preset macos-arm64-tests --parallel
ctest --test-dir /Users/emiliosanchez-harris/Documents/ClaudeMosh/build-macos-arm64 --output-on-failure
```

4. Native command-surface app gates:

```sh
APP=/Users/emiliosanchez-harris/Documents/ClaudeMosh/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 MOSH_ENABLE_SA3=0 "$APP" --selftest
MOSH_NO_AUDIO=1 "$APP" --selftest-undo
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/validate-command-log-contract.sh "$HOME/Library/Mosh/session-selftest/mosh-log.jsonl" 500
```

5. Optional model/service-gated native selftests:

```sh
APP=/Users/emiliosanchez-harris/Documents/ClaudeMosh/build-macos-arm64/Mosh_artefacts/Debug/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 MOSH_SELFTEST_SA3=1 "$APP" --selftest
MOSH_NO_AUDIO=1 MOSH_SELFTEST_TRANSCRIBE=1 "$APP" --selftest
MOSH_NO_AUDIO=1 MOSH_SELFTEST_SKETCH=1 MOSH_SKETCH_FIXTURE_DIR=/Users/emiliosanchez-harris/Documents/ClaudeMosh/service/sketch/fixtures "$APP" --selftest
```

6. Service, import, and relay checks:

```sh
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/service/scripts/fake_adapter_test.py
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/service/scripts/adapter_glue_test.py
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/service/scripts/resilience_test.py
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/service/flp/flp_cli_test.py
python3 -m pytest /Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/test_room.py /Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/test_server.py
MOSH_BIN="$APP" /Users/emiliosanchez-harris/Documents/ClaudeMosh/relay/run-mp-selftest.sh
```

7. Offline render-to-WAV proof:

```sh
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/verify-hardware/verify.py --bin "$APP"
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/verify-hardware/verify.py --bin "$APP" --sa3
```

8. Packaged app and installed-app proof:

```sh
cd /Users/emiliosanchez-harris/Documents/ClaudeMosh
./run-mosh.sh deploy
APP=/Applications/Mosh.app/Contents/MacOS/Mosh
MOSH_NO_AUDIO=1 "$APP" --selftest
python3 /Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/verify-hardware/verify.py --bin "$APP"
```

9. Live/hardware gates, run only with the right devices/permissions:

```sh
APP=/Applications/Mosh.app/Contents/MacOS/Mosh
"$APP" --voice-smoke
MOSH_AUDIO_OUTPUT_DEVICE="MacBook Pro Speakers" "$APP" --live-audio-smoke
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/verify-hardware/voice-loopback.sh "$APP"
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/blackhole-live-audio-gate.sh
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/iphone-companion-sim-gate.sh
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/iphone-companion-sim-media-gate.sh
/Users/emiliosanchez-harris/Documents/ClaudeMosh/scripts/iphone-companion-device-gate.sh
```

10. Optional Windows/CUDA port gate, not canonical macOS DAW merge proof:

```powershell
pwsh -NoProfile -File C:\path\to\ClaudeMosh\scripts\verify-pc-build.ps1 -Repeat 3
pwsh -NoProfile -File C:\path\to\ClaudeMosh\scripts\verify-pc-build.ps1 -RealSA3
```

## Likely Blind Spots And Stale Gates

- Legacy `build/` wrappers are stale unless explicitly overridden.
- `docs/CURRENT_STATUS.md` and `AGENTS.md` are not sufficient as current gate truth; prefer current `CMakePresets.json`, `CLAUDE.md`, `docs/PROGRESS.md`, and `docs/VERIFICATION.md`.
- Playwright e2e is frontend-contract e2e, not native packaged-app e2e.
- Full-library plugin scans are diagnostic, not deterministic CI/merge gates.
- Mic/voice, real recording, by-ear audio quality, plugin-editor visuals, physical iPhone install/launch, and two-window multiplayer visual sync remain hands-on/hardware proof.
- Python/service tests lack one top-level runner, so a plan should list them explicitly.
- Some low-level tests mirror schema constants; useful for invariant drift, weak as behavior proof.

## Slow, Hardware-Gated, Or Stateful Commands

- `./run-mosh.sh deploy`: stateful, removes/replaces `/Applications/Mosh.app`, restarts Finder/Dock, bundles service.
- `Mosh --selftest`: writes `~/Library/Mosh/session-selftest`, uses service port defaults unless isolated; concurrent worktrees can collide unless `MOSH_SELFTEST_SESSION`/`MOSH_SERVICE_PORT` are set.
- `MOSH_SELFTEST_SA3=1`: slow/model-gated; needs SA3 MLX wiring and local model assets.
- `MOSH_SELFTEST_TRANSCRIBE=1`: venv/model-gated Basic Pitch check.
- `MOSH_SELFTEST_SKETCH=1`: needs sketch setup and fixture directory.
- `scripts/verify-hardware/verify.py --sa3`: local model/service-gated and writes `verify-artifacts/`.
- `--live-audio-smoke`, `voice-loopback.sh`, `blackhole-live-audio-gate.sh`: device and macOS permission dependent; BlackHole script changes audio routing and may return ENV-BLOCKED.
- iPhone scripts: require Xcode, simulator runtimes; device gate requires physical phone, Apple Development signing, unlocked phone, trusted profile.
- `--scan-plugins-deep`: can be very slow or hang on hostile installed plugins; do not run as default e2e merge gate.
- Windows/CUDA verification: requires Windows, Visual Studio generator, CUDA/PyTorch SA3 venv/weights for `-RealSA3`.

## Recommended Runner Split

- Gate coordinator: runs preflight, coordinates env isolation (`MOSH_SELFTEST_SESSION`, `MOSH_SERVICE_PORT`), saves evidence paths.
- UI runner: typecheck, Vitest, Playwright, screenshots/report artifacts.
- Native runner: CMake, CTest, selftest, undo, command-log contract, deployed app smoke.
- Audio/model runner: offline WAV harness, SA3/transcribe/sketch gates, live audio only when devices are ready.
- Companion/port runner: iOS simulator/media/device gates and optional Windows/CUDA gate.

## Status

codeQualityStatus: BLOCK
recommendation: REQUEST_CHANGES
blockers:
- Do not approve a "thorough e2e plan" that uses legacy `build/` wrapper defaults without explicit current preset app paths.
- Reconcile or override stale docs (`AGENTS.md`, `docs/CURRENT_STATUS.md`) before treating them as the current source of truth.
- Label Playwright as frontend-contract e2e, not packaged-app/native e2e, and pair it with app binary and installed-app checks.
