# FS-K3 — Sentry crash reporting (opt-in)

**Lane:** K (Ship kit) · **Spec:** SPEC.md §5 K3 · **Registered bucket:** owner-merge
(touches `cmake/`, `CMakeLists.txt`, `src/telemetry/`, the release script, adds a third-party
dependency + pin).

**Session history**
- **First session (2026-07-12): GAP OPEN, plan written.** Scoped the whole feature — SDK, consent
  surface, PII scrubber, dSYM upload — because none of it existed.
- **Second session (2026-07-27): SCOPE NARROWED, then executed.** PR #406 (`a1373197`,
  *"feat(telemetry): opt-in crash reporting + usage telemetry, default OFF"*) landed in the
  interim and **closed two of the four sub-gaps**. This document was rewritten against the tree as
  it actually stands today. See *Gap re-verification* below — the narrowing is recorded as a table
  so the scope change is auditable, not silent.

Backlog row (unchanged, present in `backlog.jsonl`):
`{"id":"FS-K3","lane":"K","class":"native","size":"M","status":"ready","order":40,`
`"files":["cmake/","src/app/"], … "notes":"Adds a dependency (cmake pins) + release-script wiring →`
`excluded → owner-merge bucket. Free tier (5k events/mo) is enough."}`

---

## Context

K3 gives the team eyes on release-build crashes during the playtest window. Spec §5 K3 scope:
**Sentry Native SDK (crashpad backend, out-of-process handler); dSYM upload in the release script;
first-run opt-in consent copy; PII scrubbing on crash payloads.** Gate: *an induced crash in a
release build appears in Sentry, symbolicated; opt-out honored.*

Three hard structural constraints shape the design and must be read before touching a file:

1. **`cmake/Dependencies.cmake` is a hard-REJECT file** (loop rulebook: *"cmake/Dependencies.cmake +
   version pins … A diff touching any of these is a hard REJECT (needs-human), never an owner PR"*;
   `scripts/auto-loop/classify.sh:39`). **Therefore the Sentry pin must NOT be added to
   `Dependencies.cmake`.** It lives in a NEW `cmake/Sentry.cmake`, gated behind an
   **OFF-by-default** `MOSH_ENABLE_SENTRY` option — the exact pattern `MOSH_ENABLE_ANIRA` already
   uses for the heavy RAVE/LibTorch dep (`cmake/Dependencies.cmake:51`). OFF by default ⇒ the
   canonical build is byte-identical ⇒ every baseline is preserved by construction.

2. **The consent gate already exists and must be REUSED, not rebuilt.** `TelemetryConfig::isOptedIn()`
   (PR #406) is the single opt-in bit — presence of `~/Library/Mosh/telemetry.optin`, default absent
   ⇒ OFF. It is already written through the `set_telemetry_optin` WebBridge seam from a shipped UI
   settings toggle. Sentry init reads that same bit. **No new command, no second consent flag, no
   second mutation path.** (This also sidesteps the "a new MoshOps command needs THREE registrations"
   trap — K3 adds no command.)

3. **On macOS, Crashpad installs a Mach exception handler, which pre-empts BSD signals.** PR #406's
   local report is written from POSIX `sigaction` handlers for SIGSEGV/SIGBUS/etc. Mach exception
   ports are serviced *before* BSD signal delivery, so naively calling `sentry_init` would let
   crashpad swallow hardware faults and **silently kill the existing local-diagnostics report** — a
   regression a passing selftest would not catch (in an OFF build that check keeps passing
   regardless). Handled explicitly: see *Design* §D3.

### Gap re-verification (spec §0 — re-run 2026-07-27, against this worktree)

Commands and their actual output:

- `grep -rniE 'sentry|crashpad|breakpad' src cmake scripts CMakeLists.txt run-mosh.sh ui/src`
  → **zero hits.** No SDK, no init, no handler, no vendored source.
- `grep -rniE 'dsym' src cmake scripts CMakeLists.txt run-mosh.sh` → **zero hits.** No dSYM
  upload anywhere in the release/DMG path.
- `grep -n 'sentry' docs/DEPENDENCY_BOM.md` → row 42 exists (`sentry-native SDK | MIT (repo
  LICENSE) | OK | none | …`) — the licence research is done and must not be re-derived (§5 K4).

**What PR #406 already closed (do NOT rebuild):**

| §5 K3 sub-gap | status | evidence |
|---|---|---|
| First-run **opt-in consent** copy + surface | **CLOSED** | `src/telemetry/TelemetryConfig.{h,cpp}` (flag file, default-absent = OFF), `src/webview/WebBridge.cpp:203` `set_telemetry_optin`, `ui/src/settings/telemetryOptIn.test.ts`, `docs/telemetry/PRIVACY.md` |
| **Local** crash report + breadcrumb redaction | **CLOSED** | `src/telemetry/CrashHandler.{h,cpp}` (POSIX + `set_terminate`, writes `~/Library/Mosh/diagnostics/`, zero network I/O in-handler), `Breadcrumbs`, `CrashReportFormatter::sanitizeCommandName` |
| **Sentry Native SDK**, crashpad backend, out-of-process handler | **OPEN** | zero hits, above |
| **dSYM upload** in the release script + symbolication | **OPEN** | zero hits, above |
| **PII scrubbing on the Sentry crash payload** | **OPEN** | #406's redaction covers the *local report's* breadcrumb field only. A Sentry event is a different, much larger object (env vars, module paths, thread state, `contexts`) with its own leak surface and needs its own `before_send` scrubber. |

**Conclusion: `gapExists = true`, but narrowed.** Remaining scope = **SDK + dSYM/symbolication +
`before_send` PII scrubbing**. The 07-12 plan's line items for a consent surface, a consent-default
gate, and a from-scratch flag file are **struck** — that work shipped in #406, and rebuilding it
would have been exactly the already-closed-gap failure §0 exists to prevent.

---

## Design

### D1. Dependency pin — `cmake/Sentry.cmake` (NEW)

`option(MOSH_ENABLE_SENTRY … OFF)`. When ON, fetch **`getsentry/sentry-native` 0.15.4** from the
**release asset** `sentry-native.zip` (not the git tag): the plain source tarball omits the
`external/crashpad` submodule, whereas the release asset vendors crashpad + breakpad + third-party,
so the crashpad backend builds with no submodule recursion at configure time.

- **URL + sha256, verified by download** (2026-07-27):
  `https://github.com/getsentry/sentry-native/releases/download/0.15.4/sentry-native.zip`
  `sha256 = c0bf6fafd4b6a33a1701f61a9b7659d08f0541fa363b7d584008d232acc2067d` (8,977,596 bytes;
  unzipped, `external/crashpad/` confirmed present; `LICENSE` = MIT, matching BOM row 42).
- **Version choice:** 0.16.0 exists but was published **the same day** as this session
  (2026-07-27). 0.15.4 (2026-07-21) is the latest patch of a matured minor — the conservative pin.
- Build config: `SENTRY_BACKEND=crashpad` (out-of-process, per spec), `SENTRY_BUILD_SHARED_LIBS=OFF`
  (static ⇒ no dylib to re-sign and no `LC_RPATH` entry that could bake a build-machine absolute
  path into the shipped bundle), examples/tests/benchmarks OFF.
- Exposes an INTERFACE target `mosh_sentry` carrying `MOSH_HAVE_SENTRY=1`.
- **Not** `Dependencies.cmake` (hard-reject, see Context §1).

> **Note on the stale reference in the task brief.** The brief said to pin "the way
> `cmake/Sparkle.cmake` pins Sparkle (URL + sha256 read from a shared pin file)". **That file does
> not exist** — on any branch (`git log --all --diff-filter=A -- cmake/Sparkle.cmake` → empty), and
> FS-K2 (Sparkle) is `status: blocked` in `backlog.jsonl`. This is exactly CLAUDE.md's *"a written
> reason is a claim about the code, and it ages"*. The **URL + sha256** shape it describes is
> nonetheless right and is adopted here; the "shared pin file" indirection is not invented for a
> single consumer. The actually-existing precedent followed for the option/fetch gating and the
> INTERFACE-target shape is **`MOSH_ENABLE_ANIRA`** (`cmake/Dependencies.cmake:51–88`).

### D2. `src/telemetry/SentryReporter.{h,cpp}` (NEW)

**Unconditionally compiled; `MOSH_HAVE_SENTRY` gates the bodies, not the file's existence** — the
`RaveEngine.cpp` precedent already documented in `tests/CMakeLists.txt`. This is what lets the
default build and `MoshTests` compile and test the pure logic with no SDK present.

Always-compiled pure functions (the testable core):
- `juce::String scrubText (const juce::String&)` — every `/Users/<name>` → `~`, plus `/home/<name>`.
- `bool isSensitiveKey (const juce::String&)` — `*_KEY`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`,
  `Authorization`, `Cookie`, the brain-provider vars, `installId`/`install_id`.
- `juce::var scrubEvent (const juce::var&)` — recursive walk over the event tree: drops
  sensitive-named fields entirely, rewrites every remaining string through `scrubText`.
- `bool wouldInitialise()` — `TelemetryConfig::isOptedIn() && dsn().isNotEmpty()`.

Gated (`#if MOSH_HAVE_SENTRY`): `initSentryReporter()` / `shutdownSentryReporter()` —
`sentry_options_set_dsn`, database path under `~/Library/Mosh/crashpad/` (**never `~/Documents`**),
`sentry_options_set_handler_path` resolved **at runtime from the running bundle**, `before_send`
trampoline into `scrubEvent`, release/version tag. In the default build both are no-ops.

**DSN:** a Sentry DSN is a *public client ingest key* and may ship; the **dSYM-upload auth token is a
secret and must never ship**. DSN resolution: `MOSH_SENTRY_DSN` env, else a bundled non-secret
`Resources/sentry.dsn`. Absent ⇒ `wouldInitialise()` false ⇒ no init, no network. Since the owner has
no Sentry project yet, absent is the current real state and is a tested behaviour, not a stub.

### D3. The Mach-vs-POSIX hazard — and what the SDK actually permits

**The plan changed here after reading the SDK header; recorded rather than quietly rewritten.**
The intent was to register sentry's `on_crash` hook so a Sentry-ON build would *also* write the #406
local report, keeping both artifacts. `include/sentry.h` at the pinned version rules that out:

> `on_crash` … *"Platform-specific behavior: **does not work with crashpad on macOS**."*
> `before_send` … *"If you have set an `on_crash` callback … `before_send` will no longer be invoked
> for crash-events"* — and with crashpad the minidump is written and uploaded by the out-of-process
> handler, outside either callback.

So on macOS + crashpad **no client callback runs on a hard crash**, and two things follow:

1. **The local report cannot be re-attached from a hook** — so the open question became whether
   crashpad *swallows* it. The reasoning said it might: crashpad's Mach exception port is serviced
   before BSD signal delivery, so a hardware fault could reach crashpad and never generate the
   signal #406's handler is waiting on. **G5 measured it, and the pessimistic reasoning was wrong:
   both fire.** A real `EXC_BAD_ACCESS` in the Sentry-ON Release build produced a 422 KB crashpad
   minidump *and* `~/Library/Mosh/diagnostics/crash-*.txt`, whose backtrace frame 1 is literally
   `mosh::telemetry::(anonymous)::onPosixSignal` → `_sigtramp`. Crashpad does not suppress BSD
   delivery here, so nothing #406 shipped is lost. Recorded because the plausible-sounding
   prediction and the measurement disagreed, and only one of them is evidence.
2. **"PII scrubbing on crash payloads" has to mean something achievable.** It is implemented as
   (a) *minimise at source* — no user context, no environment block, no attachments,
   command-names-only breadcrumbs (#406), so the minidump never sees the data in the first place
   (note: `sentry_options_set_send_default_pii` is **Nintendo-Switch-only** in sentry.h —
   `#ifdef SENTRY_PLATFORM_NX` — and does not compile on macOS; found by compiling, not by reading);
   plus (b) the tested `scrubEvent()` installed as `before_send`, which does run for every non-crash
   event. A minidump still contains stack memory by construction — that is what a crash report *is*,
   and G5 confirmed it empirically (the username appears 10× in the dump's strings, 0× in the
   structured event). `docs/telemetry/PRIVACY.md` says exactly this rather than implying the dump is
   scrubbed.

3. **A leak the design did not predict, caught by inspecting the payload (G5, first run).**
   sentry-native mints its own random UUID at `<db>/installation_id` and attaches it as the event's
   **`user.id`** — a stable handle correlating every crash from one installation, i.e. exactly the
   class of identifier `scrubEvent()` already drops by name. It is **not** derived from the machine,
   the account, or Mosh's #406 `installId` (verified: different values), but `before_send` cannot
   remove it, because that callback does not run on the crashpad crash path. Fixed in-process with
   `sentry_remove_user()` immediately after `sentry_init`; **re-measured**, and the event now carries
   only `event_id`, `level`, `platform`, `release`, `environment` and the SDK version — no `user` key
   at all. **Stated cost:** Sentry's "N users affected" degrades to an event count. That is a
   genuine product tradeoff and an OWNER decision (added to BLOCKED-ON-OWNER); the privacy-preserving
   side is the right default while no decision exists, and reverting is deleting one line.
   *The lesson worth keeping: "we attach no PII" was true of our own code and still false of the
   payload. Only reading the bytes on the wire settled it.*

### D4. dSYM upload — `scripts/release/upload-dsyms.sh` (NEW) + `run-mosh.sh release`

Gated on `SENTRY_AUTH_TOKEN` + `SENTRY_ORG` + `SENTRY_PROJECT` being present in the environment;
a **clean no-op with an explanatory line when absent**, so the canonical `release` verb is unchanged
for anyone without Sentry creds. Never accepts a token as argv (argv is world-readable via `ps`).
Deliberately the OPPOSITE stance to `sign-and-notarize.sh`'s fail-closed one: an unsigned build is a
broken artifact that must never ship silently, whereas a build with no symbols uploaded is a good
artifact that is merely harder to debug.

**A second gap found by running the script rather than trusting it (D4b).** With the script wired
up, `release` still had nothing to upload: the `macos-arm64-release` preset is Ninja +
`CMAKE_BUILD_TYPE=Release`, i.e. `-O3` with **no `-g`**, so no `.dSYM` is ever produced and
symbolication could never work — the upload step would have been hollow. Fixed by
`mosh_sentry_emit_dsym()` in `cmake/Sentry.cmake`, which adds `-g` and runs `dsymutil` **only in a
`MOSH_ENABLE_SENTRY=ON` build** (adding `-g` unconditionally would change the default binary and
break this lane's byte-identical-default property). `-g` changes the DWARF emitted alongside, not
the optimisation level. The dSYM lands *next to* the `.app`, never inside it — a dSYM is large and
hands anyone a full symbol map.

---

## Exact gate(s) that prove this lane

All locally runnable (§0 — Actions is billing-dead).

| # | gate | status |
|---|---|---|
| **G1** | **Baseline preservation, default build (`MOSH_ENABLE_SENTRY` OFF).** `--selftest` ×3 deterministic, Catch2 via `ctest`, `npm run typecheck && npm test`. The option is OFF and every SDK call is `#if`-guarded, so configure adds no fetch and the app is behaviourally unchanged. | primary |
| **G2** | **PII-scrubber gate — NEW, hermetic, no DSN/network.** `tests/test_sentry_scrub.cpp` feeds a synthetic event carrying a home path, an `…_KEY=sk-…` field, an `Authorization` header, and a raw install UUID; asserts home→`~`, sensitive fields **absent**, nesting handled. **RED-proven** by neutering the scrubber. | primary |
| **G3** | **Opt-out honored, hermetic.** With no opt-in flag (fresh install) `wouldInitialise()` is **false** even when a DSN is present; with the flag set it flips true; with a flag but no DSN, false. Uses `MOSH_TELEMETRY_DIR` for isolation. **RED-proven.** | primary |
| **G4** | **No-secret gate.** `strings` over the built app finds no `SENTRY_AUTH_TOKEN` / `sentry-cli` credential. (DSN may ship; the upload token may not.) | primary |
| **G5** | **Sentry-ON build + real out-of-process minidump.** `-DMOSH_ENABLE_SENTRY=ON` links sentry-native + crashpad; an induced crash in a **Release** build yields a crashpad `.dmp` **and** the #406 local report (D3). Proves the SDK path end-to-end **without a Sentry account.** | primary |
| **G6** | **"Appears in Sentry, symbolicated."** Needs the owner's DSN + dSYM-upload token. | **BLOCKED-ON-OWNER** |

---

## Files to change

| path | change |
|---|---|
| `cmake/Sentry.cmake` | **NEW.** `MOSH_ENABLE_SENTRY` (OFF); pinned URL+sha256 fetch; `mosh_sentry` INTERFACE target + `MOSH_HAVE_SENTRY`. **NOT `Dependencies.cmake`.** |
| `CMakeLists.txt` | `include(cmake/Sentry.cmake)`; compile `SentryReporter.cpp` unconditionally; link `mosh_sentry` only when enabled; stage `crashpad_handler` into the bundle when enabled. |
| `src/telemetry/SentryReporter.{h,cpp}` | **NEW.** Pure scrubber + gated init/shutdown (D2). |
| `src/telemetry/CrashHandler.cpp` | One call to `initSentryReporter()` in `installCommon()`, after the POSIX handlers (D3). No change to Main.cpp — #406's one-line contract holds. |
| `tests/test_sentry_scrub.cpp`, `tests/CMakeLists.txt` | **NEW** Catch2 case (G2, G3). |
| `scripts/release/upload-dsyms.sh` | **NEW**, env-gated, no-op without creds (D4). |
| `run-mosh.sh` | Call the dSYM step in the `release` verb only. |
| `docs/DEPENDENCY_BOM.md` | Flip the sentry-native row from hypothetical to **live** (version, pin, obligation), as the spec requires when a BOM dep actually ships. |
| `docs/telemetry/PRIVACY.md` | Document the Sentry path + that it is build-gated OFF. |
| `docs/first-stranger-program/lanes/fs-k3.md` | This plan + Result. |

**Explicitly NOT touched:** `cmake/Dependencies.cmake` (hard-reject), `cmake/CPM.cmake`,
`cmake/*patch*`, `patches/`, `.github/**`, specs `00`–`06`, `CLAUDE.md`, `scripts/auto-loop/*`,
`arena/`, the SA3 LoRA branch, FMS spike worktrees, `PROGRAM_STAGE1`.

---

## §0 rules binding this lane

- **One lane per worktree.** FS-K3 only.
- **MoshOps is the sole mutation seam.** K3 adds **no** command and **no** new persisted user state:
  it *reads* #406's existing opt-in bit. Consent writes keep going through `set_telemetry_optin`.
- **Tier wall / threading.** Crashpad is out-of-process; in-process code only *installs* the handler
  at startup. Zero Sentry calls on the audio thread, no RT allocation. App/telemetry layer only.
- **Nothing a build reads lives under `~/Documents`.** Crashpad DB under `~/Library/Mosh/crashpad/`.
- **Build recipe.** `cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`; `-DMOSH_ENABLE_SENTRY=ON` is the only extra flag, for G5.
- **Never verify a native change with a pre-existing binary** — build from committed source.
- **RED-prove every new guard**; `grep SABOTAGE` before finishing.

## Merge BUCKET: **owner**

Native + `cmake/` + `CMakeLists.txt` + release script, and it **adds a third-party dependency with a
new version pin** — squarely the Owner bucket. The loop opens a `needs-owner-merge` PR; it never
auto-merges. The hard-reject file (`Dependencies.cmake`) is deliberately left untouched so the diff
is an owner PR rather than an auto-reject, but a reviewer may still read the rulebook's *"version
pins"* clause as covering any new pin — which is fine, the owner is approving the dependency anyway.

## BLOCKED-ON-OWNER

- **Sentry project + DSN** (public client key) and a **dSYM-upload auth token** (SECRET, env-only,
  never ships). Until both exist, G6 cannot run. Everything else (G1–G5) lands now. Per §0 the
  blocker is reported, not improvised around.
- **New-dependency + version-pin sign-off** for `sentry-native` 0.15.4 + vendored crashpad
  (Apache-2.0 crashpad means K1's acknowledgements surface owes a NOTICE file if a Sentry-ON build
  ever ships — recorded in the BOM row).
- **"Users affected" vs. a per-install correlation handle.** `sentry_remove_user()` currently drops
  the SDK's own installation UUID (Design §D3.3), which costs Sentry's *N users affected* metric.
  Default chosen on the privacy-preserving side because no owner decision exists; if the owner wants
  the metric, delete that one line. Flagged rather than decided.

---

## Result

**Closed 2026-07-27. G1–G5 PASS. G6 remains BLOCKED-ON-OWNER (no Sentry project exists yet).**
Everything below was run locally on this Mac (Actions is billing-dead), from source built in this
worktree — no pre-existing binary was used for any native claim.

### Gate outcomes

| gate | result |
|---|---|
| **G1** baselines, default build (`MOSH_ENABLE_SENTRY` OFF) | **PASS.** `--selftest` **2037/2037 ×3, byte-identical output, rc=0** (isolated via `MOSH_SELFTEST_SESSION`; the `MOSH_SELFTEST_BASELINE` floor is 1656). `ctest` green — **2354 assertions in 236 cases**. `npm run typecheck` clean; vitest **1999 passed, 1 skipped**. |
| **G2** PII scrubber | **PASS, RED-proven.** 7 cases / 47 assertions. Sabotaging `scrubEvent` to the identity function failed `REQUIRE(! obj->hasProperty("MOSH_BRAIN_KEY"))`; restored → green; `grep SABOTAGE` clean. |
| **G3** opt-out honored | **PASS, RED-proven.** Dropping the `isOptedIn()` term from `wouldInitialise()` failed `REQUIRE(! wouldInitialise())`; restored → green. |
| **G4** no-secret | **PASS.** No `SENTRY_AUTH_TOKEN` / `sntrys_` / `sentry-cli` strings anywhere in `Mosh.app`. Bonus: the default binary contains **0** occurrences of `sentry_init`/`crashpad` — the OFF gate is real, not nominal. |
| **G5** induced crash → out-of-process minidump | **PASS, both arms.** See below. |
| **G6** appears in Sentry, symbolicated | **BLOCKED-ON-OWNER.** Needs a DSN + a dSYM-upload token. Everything upstream of it is built and proven. |

### G5 in detail (`-DMOSH_ENABLE_SENTRY=ON`, Release)

Build: sentry-native 0.15.4 + crashpad compiled from the pinned archive; `crashpad_handler`
(1,105,040 B) staged into `Mosh.app/Contents/MacOS/`; `Mosh.app.dSYM` emitted beside the bundle.

- **Arm 1 — opted OUT (no flag file) with a DSN set:** process ran to completion, **rc=0**, and
  `~/…/crashpad/` was **never created**. Note what this proves: the induced-crash hook sits *behind*
  the consent gate, so opting out meant the process did not even reach the fault. Opt-out honored.
- **Arm 2 — opted IN with a DSN set:** **rc=139** (SIGSEGV from a genuine `EXC_BAD_ACCESS`, not a
  `kill -SEGV`, which would travel the BSD path and never exercise crashpad's Mach handler).
  Produced a **422,096-byte minidump** in `crashpad/pending/` with magic `4d444d50` (`MDMP`),
  written by the out-of-process handler after the parent died — **and** #406's local report, whose
  backtrace frame 1 is `mosh::telemetry::(anonymous)::onPosixSignal` → `_sigtramp`.

### What this lane found that the plan had wrong

Four corrections, all made against the source or the measured bytes rather than the brief:

1. **`cmake/Sparkle.cmake` does not exist** on any branch (FS-K2 is `blocked`). Followed the real
   `MOSH_ENABLE_ANIRA` precedent; kept the URL+sha256 shape the brief described.
2. **`sentry_options_set_send_default_pii` is Nintendo-Switch-only** (`#ifdef SENTRY_PLATFORM_NX`) —
   a compile error on macOS. Removed, along with the three docs that had already repeated the claim.
3. **The Mach-vs-POSIX prediction was wrong.** Crashpad does *not* swallow the BSD signal here;
   both artifacts are produced. Corrected in D3 — the prediction was plausible and the measurement
   disagreed.
4. **The SDK shipped an identifier we thought we weren't sending.** `user.id` = sentry-native's own
   `installation_id`, unreachable by `before_send`. Removed with `sentry_remove_user()` and
   re-measured; the event now carries no `user` key. "We attach no PII" was true of our code and
   false of the payload.

Plus one gap found by *running* the deliverable rather than trusting it: the release preset is `-O3`
with no `-g`, so **there were no dSYMs to upload** and symbolication could never have worked. Closed
with a gated `dsymutil` step (`mosh_sentry_emit_dsym`).

### What the owner gets, and what is still owed

Shipped: the SDK behind an OFF-by-default option (default build byte-unaffected, proven by G1+G4);
a tested PII scrubber; opt-out that wins over a configured DSN; a dSYM pipeline that skips cleanly
until credentials exist; BOM + PRIVACY.md updated to match the code, including the parts that are
uncomfortable.

Owed by the owner before G6 can run: a **Sentry project + DSN** (public, may ship) and a **dSYM
upload token** (secret, env-only). One product decision is flagged rather than taken — see
BLOCKED-ON-OWNER on "users affected".

**Not done, deliberately:** no `--selftest` checks were added. The new logic is pure and belongs in
Catch2; adding harness checks would have moved a count that CLAUDE.md warns is environment-dependent,
for no extra coverage.
