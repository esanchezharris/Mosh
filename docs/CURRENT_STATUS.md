# Mosh current status and ownership handoff

Last refreshed: **2026-08-02 14:04 PDT**

Canonical trunk: `origin/main` at `01adca369f20a1a96e3d34e2d9c6b4aaf2f5a9b9`

This is the rolling engineering handoff. GitHub remains the source of truth for
state that can change after the timestamp above. Refresh PR and issue metadata
before acting; do not infer merge readiness from the word “ready” in GitHub's
draft-state field.

## Executive state

- Production v2 is the default product surface.
- The production-v2 usability campaign is **time-boxed, not release-certified**.
  Its durable evidence ledger is
  [`playtest-prep/PRODUCTION_V2_AUDIT_2026-07-30.md`](playtest-prep/PRODUCTION_V2_AUDIT_2026-07-30.md).
- The latest exact merged-SHA showcase/audit evidence was collected at
  `0b32091eb0d559f63ebbeb543a0d0c0f635efea5`. PR #596 subsequently moved trunk
  to `01adca36`, so that evidence is useful history, not final certification.
- The showcase produced a portable 66.98-second project, full 24-bit WAV,
  aligned stems, loop/section/custom exports, Moshi/generative exercises, and
  save/reload proof. Raw media and machine-specific evidence remain outside the
  repository under `~/Library/Mosh/audits/production-v2-20260730/`.
- The raw Release bundle still had a strict codesign resource-seal mismatch in
  the audit build. Do not describe the current source tree as distribution-ready
  solely because the released v0.1.0 artifact is signed and notarized.
- The owner checkout contains unrelated untracked work and was intentionally
  preserved. Resume engineering in a fresh worktree from `origin/main`.
- The owner ended the audit loop to prioritize repository transfer and a job
  application. No additional long-running gates are requested by this handoff.

## Safe resume rules

1. Fetch `origin/main` and create an isolated worktree. Do not clean, reset, or
   repurpose the owner's checkout.
2. Re-read this file, the live GitHub PR/issue lists, and the plan for the lane
   being resumed.
3. Keep user-visible mutations on the MoshOps seam and snapshot/event changes
   additive.
4. Do not merge protected owner-gated drafts #523, #524, #575, or #581 as part
   of routine cleanup.
5. Treat physical audio, signing, permissions, repair, and rollback as owner
   gates. Hosted checks or screenshots cannot substitute for them.
6. The generated First-Stranger board is dated 2026-07-28. Regenerate it from
   `docs/first-stranger-program/backlog.jsonl` before selecting a lane.

## Open PR catalog

Complete as of the refresh timestamp: **28 open PRs**. “Ready” below means only
that the PR is not marked draft on GitHub.

| PR | GitHub state | Relationship | Transfer disposition |
|---|---|---|---|
| [#599](https://github.com/EmilioSzH/Mosh/pull/599) ownership handoff catalog | Draft | Documentation-only; based on `01adca36` | This PR. Merge it first if the handoff catalog is accepted; no build or test suite was run. |
| [#598](https://github.com/EmilioSzH/Mosh/pull/598) rapid slider intent | Draft | Based on `01adca36`; closes #597 | Active handoff candidate. Cheap and Linux checks passed; focused tests, typecheck, and 2,314 UI tests passed. Native AX retest/native gate were intentionally skipped. Keep draft until the next owner accepts that waiver or supplies the native evidence. |
| [#581](https://github.com/EmilioSzH/Mosh/pull/581) bounded startup recovery | Draft | Stacked on #524; issue #578 | **Protected owner gate. Do not merge.** Preserve for physical-device review. |
| [#575](https://github.com/EmilioSzH/Mosh/pull/575) physical recovery gate | Draft | Stacked on #524; issue #574 | **Protected owner gate. Do not merge.** Preserve for physical-device review. |
| [#524](https://github.com/EmilioSzH/Mosh/pull/524) Moshi + Codex owner cockpit | Draft | Base for #575 and #581 | **Protected owner work. Do not merge during cleanup.** Review the whole stack together. |
| [#523](https://github.com/EmilioSzH/Mosh/pull/523) Vocal Map program control | Draft | Independent program-control branch | **Protected owner work. Do not merge during cleanup.** |
| [#515](https://github.com/EmilioSzH/Mosh/pull/515) FMS lyrics bench | Ready | Independent research/evaluation work | Rebase and review as an owner-only lab artifact, or park it. Do not mix it into production-v2 cleanup. |
| [#514](https://github.com/EmilioSzH/Mosh/pull/514) Graphite shell | Draft | Alternate/older shell direction | Park until an explicit product decision; do not infer that it replaces current production v2. |
| [#507](https://github.com/EmilioSzH/Mosh/pull/507) selftest scaffold | Ready | Bottom of #507 → #508 → #510 | Re-evaluate the full stack on current main; merge bottom-up or close the stack together. |
| [#508](https://github.com/EmilioSzH/Mosh/pull/508) selftest chapters 1/2 | Ready | Stacked on #507 | Do not merge independently. |
| [#510](https://github.com/EmilioSzH/Mosh/pull/510) selftest chapters 2/2 | Ready | Stacked on #508 | Do not merge independently. |
| [#497](https://github.com/EmilioSzH/Mosh/pull/497) clip renderer extraction | Ready | Bottom of #497 → #500 | Rebase and review the two-PR stack together, or close both if current v2 work supersedes it. |
| [#500](https://github.com/EmilioSzH/Mosh/pull/500) Arrange reachability ratchet | Ready | Stacked on #497 | Do not merge independently. |
| [#478](https://github.com/EmilioSzH/Mosh/pull/478) broad ship kit | Ready | Signing, updates, licensing, brain-key scope | Split or re-scope before merge; it overlaps later release and First-Stranger work. |
| [#475](https://github.com/EmilioSzH/Mosh/pull/475) FS-K4 packaging/BOM gate | Ready | First-Stranger lane | Reconcile against current `DEPENDENCY_BOM.md`, current main, and the live backlog before deciding. |
| [#473](https://github.com/EmilioSzH/Mosh/pull/473) FS-K3 Sentry | Ready | First-Stranger lane | Reconcile against current consent/privacy/release policy before deciding. |
| [#471](https://github.com/EmilioSzH/Mosh/pull/471) FS-T2 plugin safe mode | Ready | First-Stranger lane | Reproduce on current main, then rebase or close. |
| [#472](https://github.com/EmilioSzH/Mosh/pull/472) agent type vocabulary | Ready | Independent agent-quality change | Rebase and rerun its focused evaluation before merge. |
| [#470](https://github.com/EmilioSzH/Mosh/pull/470) instrument affordance | Ready | Independent v2 UX change | Reproduce against current production v2; rebase or close. |
| [#468](https://github.com/EmilioSzH/Mosh/pull/468) Actions billing note | Ready | Dated documentation | Close if current documentation already reflects recovered Actions billing; otherwise refresh rather than merging stale prose. |
| [#466](https://github.com/EmilioSzH/Mosh/pull/466) overflow-menu reachability | Ready | Independent v2 fix | Reproduce on current v2; rebase or close if superseded. |
| [#465](https://github.com/EmilioSzH/Mosh/pull/465) hermetic lyric-bench test | Ready | FMS lab infrastructure | Keep with the FMS lab; rebase and run only its focused proof before deciding. |
| [#464](https://github.com/EmilioSzH/Mosh/pull/464) replay-capture guard | Ready | Small e2e test change | Rebase and confirm the commands still exist; merge separately or close. |
| [#463](https://github.com/EmilioSzH/Mosh/pull/463) packaging usage-key gate | Ready | Packaging | Compare with merged #576/#577 and current release workflow before rebasing; avoid duplicate policy. |
| [#462](https://github.com/EmilioSzH/Mosh/pull/462) Universal 2 | Ready | Conflicts with the current arm64-only mission | Park or close unless platform scope is deliberately changed. |
| [#322](https://github.com/EmilioSzH/Mosh/pull/322) Used2/FMS checkpoint | Draft | Bottom of #322 → #358 → #363 | Park as an owner-only research stack; resume and rebase as a unit only after a model/product decision. |
| [#358](https://github.com/EmilioSzH/Mosh/pull/358) FMS mechanism verification | Draft | Stacked on #322 | Do not merge independently. |
| [#363](https://github.com/EmilioSzH/Mosh/pull/363) FMS ground-truth bench | Draft | Stacked on #358 | Do not merge independently. |

## Recent production-v2 campaign merges

These are already on `main`; keep them as regression history rather than
reopening them during PR cleanup.

| PR | Merge SHA | Result |
|---|---|---|
| #519 | `364cb6fe` | Continuous ruler/navigator scrubbing |
| #520 | `f3e68992` | Clear stale clip context when selecting a track |
| #522 | `6c3687db` | Fail visibly when the Moshi brain is unavailable |
| #526 | `379bd6a1` | Keep agent-drawer pixels visible with its AX surface |
| #528 | `e520550b` | Recover Settings after a bounded CoreAudio timeout |
| #560 | `06dea1c1` | Isolate audit storage from owner state |
| #558 | `317220ef` | Land recording takes from v2 stop controls |
| #566 | `bbe3069c` | Initialize a cold audio graph from Record |
| #569 | `1d2bb1e9` | Public cleanup |
| #571 | `95ab6ea7` | Restore parity gate after public cleanup |
| #567 | `1e9dcb85` | Prevent silent export after disabling a clip loop |
| #573 | `ddc2e543` | Adopt AGPL-3.0 licensing |
| #572 | `e50912c0` | Reject empty export source windows |
| #576 | `5e8b81d5` | Repair entitlements plist parsing |
| #577 | `1e07ff35` | Strip resource-fork/xattr signing detritus |
| #580 | `86936716` | Bound browser scans off the UI thread |
| #582 | `83889d58` | Synchronize Browser first-open width |
| #583 | `fc1ffb8a` | Expire silent collaboration peers |
| #584 | `7253c47e` | Record collaboration session controls in JSONL |
| #585 | `0576f3da` | Keep Normalize inside the inspector rail |
| #586 | `9dfe8256` | Invalidate stale lyric-flow analysis |
| #587 | `2466aa89` | Stop slider arrow keys from nudging clips |
| #588 | `68c613e7` | Make arrangement clips keyboard accessible |
| #589 | `7156739a` | Record native plugin-editor mutations |
| #590 | `c49a9459` | Keep section timing in beats |
| #591 | `000e8be9` | Expose snap controls and drag bypass |
| #592 | `926cbd8c` | Publish the v0.1.0 release link |
| #593 | `0b32091e` | Make Moshi undo restore the last saved edit |
| #596 | `01adca36` | Isolate accessible track selection from nested controls |

## Open issue and future-work catalog

Complete as of the refresh timestamp: **18 open issues**.

| Issue(s) | Class | Recommended disposition |
|---|---|---|
| [#516](https://github.com/EmilioSzH/Mosh/issues/516) | Production-v2 campaign tracker | Keep open while the audit is explicitly time-boxed. Close only with a written waiver or a completed final exact-SHA certification. |
| [#597](https://github.com/EmilioSzH/Mosh/issues/597) | MAJOR rapid keyboard/AX slider regression | Draft fix is #598. Decide whether to supply native proof or accept the documented waiver. |
| [#561](https://github.com/EmilioSzH/Mosh/issues/561), [#562](https://github.com/EmilioSzH/Mosh/issues/562), [#574](https://github.com/EmilioSzH/Mosh/issues/574), [#578](https://github.com/EmilioSzH/Mosh/issues/578) | Physical audio recovery, repair, and rollback | Owner-gated. Preserve evidence and do not claim completion without a signed candidate, real device recovery, checkpoint restoration, single-process ownership, and rollback. Related protected drafts: #575 and #581. |
| [#563](https://github.com/EmilioSzH/Mosh/issues/563) | Release workflow invalid on every push | Resolve before relying on automated release publication. This is higher priority than cosmetic audit findings. |
| [#564](https://github.com/EmilioSzH/Mosh/issues/564) | MAJOR multi-input partial capture | Preserve surviving takes and add per-input diagnostics; independent of the merged recording-stop fix. |
| [#529](https://github.com/EmilioSzH/Mosh/issues/529) | MINOR duplicate degraded-audio banner | Presentation/accessibility cleanup after the physical recovery path is settled. |
| [#543](https://github.com/EmilioSzH/Mosh/issues/543) | MINOR silent camera-permission denial | Add visible recovery guidance if camera collaboration is promoted into the demo. |
| [#544](https://github.com/EmilioSzH/Mosh/issues/544) | MINOR narrow-window clipping | Reproduce and fix only if the target demo/window size requires it. |
| [#547](https://github.com/EmilioSzH/Mosh/issues/547) | MINOR Browser ignores Escape | Small interaction follow-up; safe to schedule after release/physical gates. |
| [#550](https://github.com/EmilioSzH/Mosh/issues/550), [#551](https://github.com/EmilioSzH/Mosh/issues/551), [#552](https://github.com/EmilioSzH/Mosh/issues/552), [#553](https://github.com/EmilioSzH/Mosh/issues/553), [#554](https://github.com/EmilioSzH/Mosh/issues/554) | T0 feature gaps | Roadmap issues, not automatic audit-scope expansion. Promote only when they block the chosen showcase or product promise. |
| [#559](https://github.com/EmilioSzH/Mosh/issues/559) | Reset-quarantine retention policy | Define bounded retention and recovery before automated cleanup is enabled. |

## Recommended transfer order

1. Decide #598: keep draft, merge with an explicit native-test waiver, or run
   only the missing native AX proof before merging.
2. Fix or retire the invalid release workflow (#563), then resolve the physical
   audio/recovery cluster with the owner on real hardware.
3. Triage the 22 older open PRs by stack. Close superseded work before rebasing
   anything; never merge the middle of a stack.
4. Choose one demo/product slice. Pull in only the minor issues or T0 gaps that
   block that slice.
5. Run a final exact-SHA production audit only if release certification is still
   a goal. Do not rerun the entire campaign merely to clean up the queue.

## Status sources

- Production-v2 evidence:
  [`docs/playtest-prep/PRODUCTION_V2_AUDIT_2026-07-30.md`](playtest-prep/PRODUCTION_V2_AUDIT_2026-07-30.md)
- First-Stranger program:
  [`docs/first-stranger-program/README.md`](first-stranger-program/README.md),
  [`SPEC.md`](first-stranger-program/SPEC.md), and
  [`backlog.jsonl`](first-stranger-program/backlog.jsonl)
- Verification policy: [`docs/VERIFICATION.md`](VERIFICATION.md)
- Feature/conformance inventory: [`docs/FEATURE_AUDIT.md`](FEATURE_AUDIT.md)
- Release material: [`docs/release/`](release/)
