# Secret-free macOS gate worker design

Status: implementation-ready design contract only. This repository does not
provision a VM, enable this backend, install credentials, create an opt-in
sentinel, or schedule a job.

## Purpose and trust boundary

The current Codex-native supervisor deliberately stops at `needs-human` before
running any real model session, and separately disables production lane gates.
This contract addresses only the latter boundary: a future gate worker may run
the unchanged `scripts/auto-loop/gate.sh` only if it has no access to owner
credentials, owner-home files, or owner-local network services. It does not run
Codex and does not make the native supervisor safe for model execution.

The worker is a disposable Apple Silicon macOS VM started from an owner-pinned,
immutable image. Its account is non-admin and has no iCloud, Keychain, GitHub,
OpenAI, signing, SSH, or package-registry credentials. The VM has no owner-home
mounts or inherited host environment. Its network adapter is absent or disabled
before job input is attached; loopback remains available for the unchanged
Playwright gate. A result from a VM with an enabled adapter is never accepted.

The immutable image contains the complete offline gate toolchain and dependency
layer. Its content digest and two generated manifests are pinned in every job:

- Apple clang, CMake, Ninja, Git, Bash 3.2, jq, Python, NumPy, Node 24.16.0,
  npm, the guarded npm wrapper, and the Playwright Chromium binary;
- a lock-stamped `ui/node_modules`, CPM source cache, exact Tracktion source,
  and every package needed by CMake/FetchContent while the adapter is disabled.

The toolchain manifest records each executable's path, version, mode, and
SHA-256. The dependency manifest records canonical paths, tree digests, the UI
lockfile digest, CPM package commits, Tracktion commit, and Playwright browser
revision. All paths are immutable image paths readable by the worker account.
An image missing any entry is not a usable worker image.

This design uses structural integrity binding, not a secret-bearing signature
or remote-attestation claim. The untrusted guest never constructs the accepted
receipt. A controller outside the VM captures process status and output,
observes hypervisor configuration, inspects the stopped guest disk read-only,
and constructs the receipt from those observations. The job and receipt schemas
bind every accepted result to exact inputs and digests. Authentication of the
pinned worker image, controller, and transfer channel remains an owner
provisioning responsibility.

## Job input

Each run receives a fresh mode-700 input directory containing exactly:

- `manifest.json`, validated against `schemas/gate-worker-job.json`;
- `repo.bundle`, a Git bundle whose SHA-256 is in the manifest.

The manifest binds the job and lane IDs, a cryptographically random nonce,
exact 40-character base and head SHAs, fixed bundle ref names, bundle digest,
worker-image content digest, toolchain and dependency manifest digests, arm64
architecture, disabled-network posture, gate class, selftest floor, resource
limits, and both the Git blob OID and SHA-256 of the unchanged gate script. The
transfer producer creates the bundle from the exact local objects and verifies
it with `git bundle verify` before transfer. The worker rejects extra top-level
input files, unexpected bundle refs, submodules, expired jobs, or a head that
cannot be proven to descend from the declared base.

The fixed bundle refs are:

```text
refs/mosh-gate/base
refs/mosh-gate/head
```

No branch name or remote credential is needed inside the VM.

## Worker protocol

1. Boot a fresh snapshot and verify the pinned image ID and content digest,
   toolchain/dependency manifest digests, arm64 hardware, non-admin account,
   empty credential stores, absent owner-home mounts, declared CPU/memory/disk
   limits, and disabled network adapter. A failed or indeterminate check ends
   the job.
2. Copy the two inputs to an internal mode-700 directory, detach the shared
   input, validate the manifest schema, recompute the manifest and bundle
   SHA-256 digests, and run `git bundle verify`.
3. Initialize an internal repository, fetch only the two fixed refs, and verify
   their object IDs exactly equal the manifest. Check out the declared head in
   detached state. Reject submodules, alternate object stores, replace refs,
   hooks, unexpected refs, or a dirty checkout.
4. Verify the checkout's `ui/package-lock.json` against the dependency manifest.
   Construct `ui/node_modules` as a local directory of read-only links into the
   immutable lock-stamped dependency tree, with only its stamp local. Create a
   private `MOSH_AUTOLOOP_HOME/auto-loop.env` that sets `AL_CPM_CACHE` and
   `AL_TRACTION_SRC` to the pinned image paths. Put the pinned npm guard before
   the immutable Node/npm toolchain on PATH and set the pinned Playwright browser
   path. Any dependency drift is a job failure; the disabled adapter is never
   enabled for installation.
5. Hash `scripts/auto-loop/gate.sh` as both a Git blob and raw bytes. Both values
   must match the manifest. Do not copy, patch, wrap, or reimplement the gate.
6. Run exactly:

   ```sh
   MOSH_SELFTEST_BASELINE=<manifest floor> \
     bash scripts/auto-loop/gate.sh <manifest class> <internal checkout> <base SHA>
   ```

   The process receives the pinned PATH and offline-cache variables, a fresh
   private HOME/TMP/cache, locale and timezone pins, no inherited secrets, and
   no network adapter. The controller enforces the manifest's wall-clock,
   CPU-count, memory, disk, process-count, and output-byte limits. Timeout or
   resource exhaustion terminates the VM and yields `needs-human`.
7. The controller captures stdout and stderr through hypervisor-owned pipes or
   devices that the guest cannot reopen or rewrite, and records the process exit
   status independently. The guest does not write `receipt.json`.
8. Stop the VM, attach its per-job disk read-only, and use a controller-owned,
   non-executing repository verifier. The verifier ignores guest Git config,
   refs, hooks, filters, alternates, and executables; it reconstructs the
   expected tree from the hashed input bundle and byte-compares every tracked
   path in the stopped checkout. It independently verifies detached HEAD and
   produces `tracked-status.txt`. Any unreadable, linked, special, missing,
   extra, or changed tracked path is a failure.
9. The controller validates captured stdout as exactly one gate JSON object and
   requires the independently observed exit status, `pass`, class, selftest
   floor, failed-check count, assertion count, and every step result to agree.
   Cheap jobs require exactly `typecheck`, `vitest`, `e2e`, `py_tests`, and
   `swappability`; native jobs require exactly `cmake_configure`, `build_app`,
   `build_tests`, `info_plist_tcc_keys`, `catch2`, `selftest_x3`, `verify_py`,
   `daw_conformance`, and `vitest`. A dependency-install step is forbidden
   because the image must already match the lockfile.
10. The controller emits `receipt.json` conforming to
   `schemas/gate-worker-receipt.json`. It exports exactly three bounded regular
   files in schema order: `gate.stdout`, `gate.stderr`, and
   `tracked-status.txt`. Symlinks, hard-link aliases, special files, duplicate
   names, and extra artifacts are rejected. It then destroys the VM snapshot
   and per-job transfer directory.

The worker never fetches, pushes, opens a PR, writes supervisor state, or makes
a routing decision.

## Receipt and acceptance

The controller-produced receipt binds the schema version, job and lane IDs,
nonce, manifest digest, worker image and content digest, toolchain/dependency
manifest digests, architecture, exact base/head SHAs, bundle digest, gate
blob/hash/class, selftest floor, resource-limit observations, gate output
digests and typed result, independently observed exit status,
controller-verified tracked status, hypervisor-observed network state,
timestamps, and every exported artifact digest. Artifact names and order are
fixed by schema rather than supplied by the guest.

The supervisor may accept a receipt only when all of these are true:

- both schemas validate with unknown fields rejected;
- every identity, SHA, digest, class, baseline, and image value exactly matches
  the still-current local job state;
- the nonce is fresh, the receipt arrives before manifest expiry, timestamps
  are ordered and within the declared wall-clock limit, and the supervisor
  atomically consumes the job ID and nonce before advancing lane state;
- the network adapter was disabled, the worker account was non-admin, and no
  owner-home mount or credential source was present;
- the gate exited zero, emitted `pass:true`, met the selftest floor, reported
  zero failures and assertions, and every gate step is successful;
- detached HEAD is still the declared head and tracked status is empty;
- the receipt producer and every isolation/repository evidence source identify
  the pinned controller protocol, never a guest assertion;
- every declared resource cap matches the controller configuration and no
  timeout or limit violation occurred;
- `gate.stdout` and `gate.stderr` hashes equal their matching receipt fields,
  the empty tracked-status hash equals the fixed empty-file SHA-256, and every
  exported artifact is one canonical regular file whose recomputed size and
  SHA-256 matches the receipt;
- the receipt has `outcome:passed`, an empty reasons list, a non-empty step list,
  and all cross-field pass/class/baseline/exit/cleanliness constraints agree.

Any missing field, malformed value, schema drift, hash mismatch, mutation,
enabled or indeterminate network, stale SHA, unexpected artifact, failed gate,
timeout, replayed or expired nonce, resource violation, dependency-install
attempt, or worker error routes the lane to `needs-human` before hostile review,
push, or PR creation. There is no retry that weakens these checks.

## Enablement prerequisites

Production support remains disabled until an owner separately provisions the
credential-free image and transfer mechanism, pins the content-addressed image,
toolchain and dependency manifests, performs escape, resource, timeout, replay,
and network-isolation tests, and approves a supervisor implementation.
That implementation must remain additive, preserve PR-only behavior, invoke the
unchanged authoritative gate, and require a separate explicit owner opt-in.
This design does not authorize installation, scheduling, merging, or unattended
execution.
