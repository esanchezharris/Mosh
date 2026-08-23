# Mosh Re-Imagine VST3 — implementation evidence

Recorded on 2026-08-23 from `codex/stableaudioplugin` on the owner Apple-silicon
Mac. This separates hermetic/native bundle evidence from the still-manual Ableton
and by-ear acceptance gate.

## Green evidence

- `cmake --build build-macos-arm64 --target MoshReImaginePlugin_VST3
  MoshReImagineBundleSmoke MoshTests -j 6`
- Re-Imagine Catch2 focus: 98 assertions in 14 test cases, all passed, including
  the existing debug RT-allocation tripwire around Transfer/playback mapping.
- Full `MoshTests`: passed through CTest in 7.18 seconds.
- Actual bundle smoke: scanned and instantiated the built VST3, created its
  editor, processed dry stereo at 48 kHz and mono at 44.1 kHz, created two
  instances, and round-tripped state.
- Bundle identity checks: `studio.mosh.reimagine`, arm64, valid ad-hoc signature.
- Fake-service HTTP integration: protocol health/features, colors,
  submit/status/manifest, cancel, restart compatibility, and idle shutdown all
  passed.
- SA3 release-policy regression: 25 checks passed.
- DAW conformance scoreboard: fresh against committed inputs.
- `git diff --check`, shell syntax checks, and Python syntax checks passed.
- Final read-only code review: `codeQualityStatus: CLEAR`, recommendation
  `APPROVE` after the region-binding, asset-gating, equal-power, and
  removed-target regressions landed.

## Deliberately not claimed

- The canonical app gate and selftest x3 were not run: `memory-preflight.sh`
  failed closed because 84 direct Codex child processes exceeded the owner
  policy ceiling of 64. No active owner process was terminated and the ceiling
  was not overridden.
- A full six-test CTest attempt consequently had no built Mosh app fixture for
  `AudioRecoverySmoke` and `SessionAllocationFailure`; the other four tests ran,
  and the full `MoshTests` target was rerun green after the service-test cleanup
  fix.
- The explicit owner installer was not executed. Nothing was copied into Live's
  VST3 directory and the shared helper was not staged into Application Support.
- Live 11 rescan/load, real SA3 rendering, Colors/LoRAs by ear, physical A/B,
  Set reopen, shared-process observation, and model release remain owner-machine
  acceptance steps in `OWNER_ACCEPTANCE.md`.
