# Mosh Re-Imagine VST3 — pre-pivot implementation evidence

This record separates the reproducible implementation evidence incorporated by
PR #666 from the remaining owner-machine listening and Ableton acceptance work.
It is recorded under the annotated baseline tag
`pre-pivot-baseline-2026-08-23`, created after final documentation verification.
The broader preservation record is in the
[pre-pivot archive manifest](../archive/consolidation/2026-08-23-pre-pivot-manifest.md).

## Provenance

- PR #666, **Mosh Re-Imagine VST3 for Ableton Live 11**, merged to `main` as
  `201ffa94108eb94420e979d335f7a8f7cfc720e8`.
- The final gated source candidate was
  `33913d68a8a010febe35b80d7098afd1a26f6dda`, preserved before merge as
  `archive/pre-pivot-2026-08-23/reimagine-isolated-gate-candidate`.
- Earlier distinct candidate states remain immutable archive tags rather than
  rewritten history: `reimagine-base`, `reimagine-rebased-candidate`, and
  `reimagine-gated-candidate` (listed in the manifest).

## Reproducible native evidence

The final candidate passed the native gate with the owner-authorized,
consolidation-only `MOSH_MAX_CODEX_CHILDREN=1000` override. That exception did
not alter the repository's normal preflight policy.

- CTest: **7/7** passed, including `MoshReImagineBundleSmoke` and
  `MoshReImagineEditorSmoke`. The test presets now build both smoke targets, so
  the gate exercised the registered bundle and editor checks rather than
  merely listing them.
- Focused `MoshTests` Re-Imagine coverage: **16 test cases / 109 assertions**
  passed, including the paused-transport regression that keeps the selected
  take dry while transport is stopped.
- Native app `--selftest` ran three times: **[3305, 3305, 3305]** checks, with
  **0 failed** and **0 JUCE assertions** in every run.
- `scripts/verify-hardware/verify.py`: **35/35** checks passed.
- Generated DAW conformance: **205 rows, 0 in-scope failures**. The UI suite
  recorded **4,272 passed, 1 skipped**.
- The bundle/editor smoke coverage includes arm64 VST3 bundle discovery and
  instantiation, editor construction, dry audio processing, multiple-instance
  and state-round-trip paths. The fake service adapter integration check also
  passed during the focused candidate build.

The candidate also isolates explicitly named harness service handshakes by
session and service port. This prevents one concurrent gate from adopting a
stale global service handshake; the ordinary owner/shared-service path remains
unchanged.

## Deliberately not claimed

- A real Ableton audio-track Transfer render through the installed Stable Audio
  service remains pending.
- Colors and LoRA selection, stacking, strength, and their audible result
  remain pending by-ear acceptance.
- Physical A/B, timeline playback behavior in an owner Set, Set reopen, and
  model-release/shared-process observation remain pending owner-machine checks.
- An earlier controlled Live 11 browser discovery and plug-in instantiation is
  installation/host evidence only. It is not physical-audio, rendered-audio,
  or listening acceptance.

The manual sequence and its explicit boundaries remain in
[OWNER_ACCEPTANCE.md](OWNER_ACCEPTANCE.md). Screenshots, bundle smoke, native
tests, dashboard output, and hosted checks do not strengthen those unresolved
claims.
