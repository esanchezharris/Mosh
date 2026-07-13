# Secret-free macOS gate worker design

Status: implementation-ready design contract only. This repository does not
provision a VM, enable this backend, install credentials, create an opt-in
sentinel, or schedule a job.

## Purpose and trust boundary

The current Codex-native supervisor deliberately stops at `needs-human` before
running a production lane gate. A future gate worker may remove that manual
step only if it can run the unchanged `scripts/auto-loop/gate.sh` without access
to owner credentials, owner-home files, or owner-local network services.

The worker is a disposable Apple Silicon macOS VM started from an owner-pinned,
immutable image. Its account is non-admin and has no iCloud, Keychain, GitHub,
OpenAI, signing, SSH, or package-registry credentials. The VM has no owner-home
mounts or inherited host environment. Its network adapter is absent or disabled
before job input is attached; loopback remains available for the unchanged
Playwright gate. A result from a VM with an enabled adapter is never accepted.

This design uses structural integrity binding, not a secret-bearing signature
or remote-attestation claim. The job and receipt schemas bind every accepted
result to exact inputs and digests. Authentication of the pinned worker image
and transfer channel remains an owner provisioning responsibility.

## Job input

Each run receives a fresh mode-700 input directory containing exactly:

- `manifest.json`, validated against `schemas/gate-worker-job.json`;
- `repo.bundle`, a Git bundle whose SHA-256 is in the manifest.

The manifest binds the job and lane IDs, exact 40-character base and head SHAs,
fixed bundle ref names, bundle digest, expected worker-image identity, arm64
architecture, disabled-network posture, gate class, selftest floor, and both the
Git blob OID and SHA-256 of the unchanged gate script. The transfer producer
creates the bundle from the exact local objects and verifies it with
`git bundle verify` before transfer. The worker rejects extra top-level input
files, unexpected bundle refs, submodules, expired jobs, or a head that cannot
be proven to descend from the declared base.

The fixed bundle refs are:

```text
refs/mosh-gate/base
refs/mosh-gate/head
```

No branch name or remote credential is needed inside the VM.

## Worker protocol

1. Boot a fresh snapshot and verify the pinned image identity, arm64 hardware,
   non-admin account, empty credential stores, absent owner-home mounts, and
   disabled network adapter. A failed or indeterminate check ends the job.
2. Copy the two inputs to an internal mode-700 directory, detach the shared
   input, validate the manifest schema, recompute the manifest and bundle
   SHA-256 digests, and run `git bundle verify`.
3. Initialize an internal repository, fetch only the two fixed refs, and verify
   their object IDs exactly equal the manifest. Check out the declared head in
   detached state. Reject submodules, alternate object stores, replace refs,
   hooks, unexpected refs, or a dirty checkout.
4. Hash `scripts/auto-loop/gate.sh` as both a Git blob and raw bytes. Both values
   must match the manifest. Do not copy, patch, wrap, or reimplement the gate.
5. Run exactly:

   ```sh
   MOSH_SELFTEST_BASELINE=<manifest floor> \
     bash scripts/auto-loop/gate.sh <manifest class> <internal checkout> <base SHA>
   ```

   The process receives a fixed system PATH, a fresh private HOME/TMP/cache,
   locale and timezone pins, no inherited secrets, and no network adapter.
6. Capture stdout and stderr as local artifacts. Validate stdout as exactly one
   gate JSON object and require the process exit status, `pass`, class,
   selftest floor, failed-check count, assertion count, and all step results to
   agree. Recheck the detached HEAD and tracked-worktree status after the gate.
7. Emit `receipt.json` conforming to
   `schemas/gate-worker-receipt.json`, copy only the declared receipt/artifacts
   out, then destroy the VM snapshot and per-job transfer directory.

The worker never fetches, pushes, opens a PR, writes supervisor state, or makes
a routing decision.

## Receipt and acceptance

The receipt binds the schema version, job and lane IDs, manifest digest, worker
image, architecture, exact base/head SHAs, bundle digest, gate blob/hash/class,
selftest floor, gate output digests and typed result, exit status, tracked status,
network-disabled evidence, timestamps, and every exported artifact digest.
Artifact paths are relative names with no parent traversal or absolute path.

The supervisor may accept a receipt only when all of these are true:

- both schemas validate with unknown fields rejected;
- every identity, SHA, digest, class, baseline, and image value exactly matches
  the still-current local job state;
- the network adapter was disabled, the worker account was non-admin, and no
  owner-home mount or credential source was present;
- the gate exited zero, emitted `pass:true`, met the selftest floor, reported
  zero failures and assertions, and every gate step is successful;
- detached HEAD is still the declared head and tracked status is empty;
- each artifact's recomputed size and SHA-256 matches the receipt.

Any missing field, malformed value, schema drift, hash mismatch, mutation,
enabled or indeterminate network, stale SHA, unexpected artifact, failed gate,
or worker error routes the lane to `needs-human` before hostile review, push, or
PR creation. There is no retry that weakens these checks.

## Enablement prerequisites

Production support remains disabled until an owner separately provisions the
credential-free image and transfer mechanism, pins an image identity, performs
escape and network-isolation tests, and approves a supervisor implementation.
That implementation must remain additive, preserve PR-only behavior, invoke the
unchanged authoritative gate, and require a separate explicit owner opt-in.
This design does not authorize installation, scheduling, merging, or unattended
execution.
