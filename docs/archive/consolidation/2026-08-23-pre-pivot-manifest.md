# Pre-pivot consolidation archive manifest

This is the preservation record for the 2026-08-23 pre-pivot consolidation.
It deliberately records a **pre-pivot snapshot**, not a defined next product
direction. The annotated tag `pre-pivot-baseline-2026-08-23` identifies the
final docs-only baseline after its final verification and publication. Its SHA
is intentionally absent here because the tag is made only after the
documentation-only commit and verification.

At the start of the documentation baseline, the selected product-merge frontier
was `main` at `7eb0d6179095ecc5b596fa93fea113fc5aa96f6f` (PR #668). The final
baseline tag will additionally contain the documentation-only consolidation
commit.

## Product work merged to `main`

All six selected product PRs were owner-merged normally after their local native
gates. No hosted-check bypass, auto-merge, or administrator merge was used.

| PR | Merge commit | Disposition |
| --- | --- | --- |
| #663 | `8ad7a0e5fbd92e3912f80abe4c0a31de52c25811` | Owner-Mac recovery merged; original candidate remains tagged. |
| #664 | `f51dc0be3942af14aeadfe57d2a61a99329acf17` | Owner music-night recovery merged; original candidate remains tagged. |
| #665 | `967040aaa53f42103274baa3c9e8191efa5c3f9b` | Serum live-playback recovery merged; physical BlackHole/Serum acceptance remains pending. |
| #667 | `d56e6b6fcdb5bb66ad4353bd53da87ce7cb8eed0` | Live 11 grid candidate merged; its ledger remains `not-parity` and installed Live proof remains pending. |
| #666 | `201ffa94108eb94420e979d335f7a8f7cfc720e8` | Re-Imagine VST3 merged; native gate evidence is recorded in [its implementation record](../../reimagine-plugin/IMPLEMENTATION_EVIDENCE.md). |
| #668 | `7eb0d6179095ecc5b596fa93fea113fc5aa96f6f` | DAWN Bridge merged; Live 11, iPhone, audio, and undo acceptance remain pending. |

## Immutable Git preservation points

The following pushed archive tags preserve the original or gated source tips.
An anchor tag is an archival recovery point; it does not mean that its exact
pre-rebase commit was merged unchanged.

| Tag | Peeled commit | Purpose |
| --- | --- | --- |
| `archive/pre-pivot-2026-08-23/owner-mac-first-recovery` | `9ac7d8a90709390b3cb5e75c1f48fc5d22434304` | Original #663 candidate. |
| `archive/pre-pivot-2026-08-23/owner-music-night` | `cd90708b964edd09addefe69b50d03f3fea0fca8` | Original #664 candidate. |
| `archive/pre-pivot-2026-08-23/serum-live-recovery` | `152a355dacea91d8e046fe11ee4f572726191092` | Original #665 candidate. |
| `archive/pre-pivot-2026-08-23/live11-grid-parity` | `bb9ed7e33284f0eb24b880c7415bf47072c04686` | Original #667 candidate. |
| `archive/pre-pivot-2026-08-23/reimagine-base` | `0961dcfde3d9e5cdf4007df8dd85ce5e84f592b3` | Re-Imagine source before current WIP integration. |
| `archive/pre-pivot-2026-08-23/reimagine-rebased-candidate` | `fd76abed777e79cd5c7ae42e8d668084fa7bcd79` | Rebased Re-Imagine candidate with paused-transport regression coverage. |
| `archive/pre-pivot-2026-08-23/reimagine-gated-candidate` | `1996f8d99e02c44c6beb81fde88d2da73e48a13c` | Re-Imagine candidate after smoke-target preset correction. |
| `archive/pre-pivot-2026-08-23/reimagine-isolated-gate-candidate` | `33913d68a8a010febe35b80d7098afd1a26f6dda` | Final gated #666 source candidate. |
| `archive/pre-pivot-2026-08-23/ableton-dawn-bridge` | `ae2b8003aa1854b66664fdc0159d081ac5330190` | Original DAWN candidate. |
| `archive/pre-pivot-2026-08-23/ableton-dawn-bridge-rebased-candidate` | `537cec0d366dae53d587893ad46ee5f51a2a9899` | Final gated #668 source candidate. |
| `archive/pre-pivot-2026-08-23/r8-size-ladder-takeover` | `d1396285bbc5fac6a5adc66869ac6551a9da79a7` | Paused R8 size-ladder source. |
| `archive/pre-pivot-2026-08-23/moshi-owner-cockpit` | `94b80c8c7436562dec2af53f26bb110b91870e25` | Legacy cockpit / closed draft PR #524 salvage point. |
| `archive/pre-pivot-2026-08-23/playtest-578-physical-recovery` | `5ef9480db980c0d9e880d9f4aa684ad4c715c4b3` | Closed physical-repair lineage. |
| `archive/pre-pivot-2026-08-23/ableton-session-foundry` | `e170be1831f06bf344716e23aaf64ee5545f319d` | Session Foundry source-only archive. |
| `rescue/codex-voice-to-midi-salvage` | `a2c46ab6e5bc2e15e1df9014301fa868f41f4cfd` | Existing voice-to-MIDI salvage tag retained unchanged. |

All archive tags above were pushed and resolved against `origin` during the
consolidation. `design-lab` remains protected and untouched.

## Archived and retired work

- **Session Foundry:** preserved as source and plan only at
  `archive/pre-pivot-2026-08-23/ableton-session-foundry`; its Swift `.build`
  output was excluded and the work was not merged to `main`.
- **R7/R8 evaluation and retirement:** training/configuration/evaluation
  evidence is preserved at
  `/Users/emiliosanchez-harris/Library/Mosh/archives/pre-pivot-2026-08-23/r7-r8-evidence`.
  `ARCHIVE_FINAL_SHA256SUMS` verifies the archive. The final retirement record
  at `retirement-final-20260824T010406Z` retains final logs, configuration
  paths, artifact hashes, and the corrected non-self-hashing manifest. Only
  the orphan R7 dashboard and named R8 dashboard/continuation services were
  retired; ports 8787 and 8788 were confirmed closed. Model, adapter,
  checkpoint, and evaluation evidence was not deleted.
- **Grid/DAWN ignored evidence:** the external archive at
  `/Users/emiliosanchez-harris/Library/Mosh/archives/pre-pivot-2026-08-23/grid-dawn-ignored-evidence-20260824T023234Z`
  retained the copied Grid and DAWN evidence; its archive verification passed
  144/144 before original ignored material became eligible for cleanup.
- **First-Stranger:** the program is paused and dated material is preserved at
  [docs/archive/first-stranger-program-2026-08-23](../first-stranger-program-2026-08-23/README.md).
  Its former entrypoint is now the
  [archived-program tombstone](../../first-stranger-program/README.md); there
  are no active lanes, schedules, worktree launchers, or implementation
  instructions there.
- **Legacy cockpit and physical recovery:** draft PR #524 was closed with an
  archive-for-later-salvage note only after the cockpit tag was verified. The
  closed physical-repair lineage remains separately tagged above.

## Recoverable cleanup dispositions

No archive record authorizes destructive deletion of user data. The following
reproducible artifacts were moved to Trash only after their source or archive
checks succeeded, so they remain recoverable until the owner empties Trash.

| Trash location | Disposition |
| --- | --- |
| `~/.Trash/mosh-pre-pivot-session-foundry-build-20260823` | Reproducible Session Foundry Swift build output; source-only archive tag retained. |
| `~/.Trash/mosh-pre-pivot-dawn-playwright-visual-qa-20260823` | Original DAWN Playwright evidence after verified external archive copy. |
| `~/.Trash/mosh-pre-pivot-owner-music-night-fetchcontent-20260824` | Worktree-private, reproducible FetchContent cache invalidated by the confirmed Tracktion source-path mismatch. |
| `~/.Trash/mosh-pre-pivot-reimagine-fetchcontent-20260824` | Obsolete Re-Imagine candidate FetchContent cache, removed only after candidate tags were remote-verified. |
| `~/.Trash/mosh-pre-pivot-reimagine-build-20260824` | Obsolete Re-Imagine candidate build output, removed only after candidate tags were remote-verified. |

The two explicitly rejected machine-path benchmark scoreboards are not archive
evidence and are excluded from the baseline; their removal belongs to the final
primary-checkout cleanup after the source baseline is safely tagged.

## One-time gate exception

On 2026-08-23 the owner authorized exactly one consolidation-scoped exception:
`MOSH_MAX_CODEX_CHILDREN=1000`. It was used only for the pre-pivot native-gate
runs after normal preflight repeatedly observed more direct active Codex
children than the repository's default limit of 64. It does not change that
default, does not relax normal owner-process policy, and was not used to
terminate the owner router or current Codex/ChatGPT processes.

## Remaining truth boundary

This consolidation merges selected source and preserves divergent work; it does
not introduce a product API or schema change by itself. Native gates, generated
scoreboards, screenshots, dashboards, and CI are not substitutes for pending
manual physical/audio acceptance. The next product direction is intentionally
not defined in this record.
