# ADR: Mac Canonical Baseline and Node24 Actions Runtime - 2026-06-09

## Status

Accepted.

## Decision

The Mac `main` branch is the product and UI source of truth for ClaudeMosh.
PC and Windows work must converge to this canonical product line rather than
forking product behavior, public protocol shape, replay semantics, or UI
contracts.

Platform differences belong behind adapters, scripts, or platform-specific
gates. Codex and other agents may create synchronization pull requests, but
they should not directly mutate protected branches. Protected branches should be
updated through reviewed and checked merge paths.

Shared contracts must stay shared:

- MoshOps command envelopes and command-log schema.
- Snapshot, event, and replay semantics.
- React UI behavior and public interaction contracts.
- Deterministic selftests and command-surface gates.
- Evidence policy for release claims.

## Mac-Green Baseline

PR #4 establishes the current Mac-green release policy for live audio:

- BlackHole remains a CoreAudio HAL virtual loopback proof, not a physical
  speaker or microphone proof.
- Independent AVFoundation capture through `ffmpeg` is the BlackHole release
  authority.
- Mosh's own input callback is diagnostic only because runner and TCC context
  can hide input channels while external BlackHole capture still receives
  non-silent audio.
- A silent external capture remains a release blocker.

The `mac-green-2026-06-09` tag is the sync point PC sessions should use after it
is pushed. PC sessions should sync from that tag or its target commit, then
propose adapter or gate changes back toward Mac `main`.

## Trunk Policy After PC Promotion

PR #7 promoted the PC portability layer into `main` and the
`cross-platform-green-2026-06-09` tag marks that baseline. From this point:

- `main` is the only development trunk for ClaudeMosh.
- `codex/claudemosh-alignment` is retired as an active development branch.
- Future Windows work must branch from `main`, not from the retired alignment
  branch.
- PC-specific changes must land through pull requests into `main` after the
  relevant Windows gates pass.

## Node24 GitHub Actions Runtime Note

GitHub is migrating JavaScript actions from Node20 to Node24. The app build
already installs Node 24 through `actions/setup-node`, but that is separate from
the runtime used by JavaScript actions themselves.

Current workflow audit:

| Workflow action | Current version | Runtime risk |
| --- | --- | --- |
| `actions/checkout` | `v4` | JavaScript action, audit for Node24-compatible replacement |
| `actions/setup-node` | `v4` | JavaScript action, audit for Node24-compatible replacement |
| `actions/upload-artifact` | `v4` | JavaScript action, audit for Node24-compatible replacement |

Policy:

- Prefer action versions that declare compatibility with the GitHub Actions
  Node24 runtime.
- Test workflows with `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` before the
  migration becomes the default.
- Keep hosted smoke CI and self-hosted full Mac gates separate; Node runtime
  migration checks do not replace local CoreAudio, plugin, GUI, or SA3 proof.
- Verify the self-hosted runner operating system and runner version before
  forcing Node24.

Current local runner check:

- Runner: `2.335.0`.
- Host OS: macOS `26.4.1`, arm64.
- Policy result: suitable for a Node24 runtime trial.

References:

- GitHub Changelog, "Deprecation of Node 20 on GitHub Actions runners":
  https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/
- GitHub Docs, "Metadata syntax for GitHub Actions", JavaScript action runtimes:
  https://docs.github.com/actions/creating-actions/metadata-syntax-for-github-actions

## Non-Goals

- No PC-specific implementation is started by this ADR.
- No Windows CI is required by this ADR.
- No source behavior changes are made by this ADR.
