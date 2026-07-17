# FS-K3 — Sentry crash reporting (opt-in)

**Lane:** K (Ship kit) · **Spec:** SPEC.md §5 K3 · **Registered bucket:** owner-merge
(touches `cmake/`, `CMakeLists.txt`, `src/app/`, the release script) · **First-session verdict
(2026-07-12): GAP OPEN — build warranted; scaffold + local proof land now, the
"appears-in-Sentry-symbolicated" leg is BLOCKED-ON-OWNER (Sentry account + auth token).**

Backlog row (unchanged, present in `backlog.jsonl`):
`{"id":"FS-K3","lane":"K","class":"native","size":"M","status":"ready","order":40,`
`"files":["cmake/","src/app/"], … "notes":"Adds a dependency (cmake pins) + release-script wiring →`
`excluded → owner-merge bucket. Free tier (5k events/mo) is enough."}`

---

## Context

K3 gives the team eyes on release-build crashes during the playtest window. Spec §5 K3 scope:
**Sentry Native SDK (crashpad backend, out-of-process handler); dSYM upload in the release script;
first-run opt-in consent copy; PII scrubbing on crash payloads.** Gate: *an induced crash in a
release build appears in Sentry, symbolicated; opt-out honored.* Free tier (5k events/mo, §10) is
sufficient for invite-only.

Two hard structural constraints shape the whole design and must be read before touching a file:

1. **`cmake/Dependencies.cmake` is a hard-REJECT file** (loop rulebook: *"cmake/Dependencies.cmake +
   version pins … A diff touching any of these is a hard REJECT (needs-human), never an owner PR"*).
   The classifier confirms it (`scripts/auto-loop/classify.sh:39` flags
   `cmake/Dependencies.cmake|cmake/CPM*.cmake|cmake/*patch*`). **Therefore the Sentry pin must NOT be
   added to `Dependencies.cmake`.** It lives in a NEW `cmake/Sentry.cmake`, gated behind an
   **OFF-by-default** `MOSH_ENABLE_SENTRY` option — the exact pattern `MOSH_ENABLE_ANIRA` already
   uses for the heavy RAVE/LibTorch dep (`cmake/Dependencies.cmake:51` `option(... OFF)`). OFF by
   default ⇒ the canonical build is byte-identical ⇒ every baseline is preserved.

2. **Sentry init runs at process start, before MoshOps/engine exist** (crashpad must be installed as
   early as possible to catch startup crashes). So the *consent decision* is a persisted user
   preference that the reporter **reads read-only** at startup; the *write* (user flips the toggle)
   goes through the MoshOps mutation seam. Reading a prefs file at launch is not a mutation, so §0's
   "MoshOps is the sole mutation seam" holds. **Default is OFF (opt-in):** on a fresh install, before
   any consent, the reporter stays disabled and nothing leaves the machine.

### Gap verification (spec §0 — confirmed STILL OPEN, 2026-07-12)

- `grep -rniE 'sentry|crashpad|breakpad|crash.?report' src cmake scripts service ui/src CMakeLists.txt
  run-mosh.sh` → **the only hit is a comment** in `cmake/InjectInfoPlistKeys.cmake:15` (describing the
  unrelated TCC speech-crash class). **No Sentry / crashpad / breakpad SDK, no init, no handler.**
- `grep -rniE 'dsym' src cmake scripts CMakeLists.txt run-mosh.sh` → **NONE.** No dSYM upload in the
  release/DMG path (`run-mosh.sh`).
- The `crash` references in `ui/src` (`RecoveryNotice.tsx`, `types.ts` A2/A3 fields, `store.ts`) are
  the **local autosave / crash-recovery** feature (FS-T2 territory) — *"restore my session after an
  unclean exit,"* an entirely different thing from *"report the crash to Sentry."* The `crash`
  entries in `drumGrid.ts`/`drumPatternUtil.ts` are the crash-cymbal drum lane. **No telemetry /
  opt-in / consent surface exists** (`grep -rniE 'opt.?in|opt.?out|telemetry|consent'` finds only
  CSS/UX-unrelated hits).
- **Conclusion: `gapExists = true`.** No crash-reporting SDK, no dSYM upload, no consent surface, no
  PII scrubber is present.

---

## Exact gate(s) that prove this lane

Reuse the existing gate surfaces; add the minimum new hermetic checks. All locally runnable (§0).

1. **Baseline-preservation gate — PRIMARY (default build, `MOSH_ENABLE_SENTRY` OFF).** Because the
   option is OFF by default and all Sentry code is `#if MOSH_HAVE_SENTRY`-guarded to a no-op, the
   canonical build recipe
   `cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache`
   `-DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`
   must keep every baseline green: **`--selftest` ≈1254–1260 ×3 deterministic, Catch2 ≈494,
   vitest ≈874, Playwright e2e 125/125** (isolated config / port 5191 if `:5173` is owned),
   **`tsc` clean.** No configure-time fetch happens (option OFF), so a machine with no network still
   builds. This is the safety gate the loop runs.
2. **PII-scrubber gate — NEW, hermetic (no DSN, no network).** The `before_send` scrubber is a
   **pure function** over an event dict/tree. A new Catch2 case (`tests/test_crash_scrub.cpp`,
   tagged `[crashscrub]`) + a `--selftest` `CRASH-PII` section feed a synthetic event carrying a home
   path (`/Users/<name>/…`), a key-shaped env var (`…_KEY=sk-…`), and the per-install UUID, and
   assert the output: home dirs → `~`, any `MOSH_*KEY` / provider-key / `Authorization`-shaped field
   dropped, UUID absent-or-hashed, no project/lyric/audio path leaks. RED-proven by disabling the
   scrubber. Deterministic ×3.
3. **Consent-default gate — NEW, hermetic.** A `--selftest` `CRASH-CONSENT` section asserts:
   (a) with **no** consent flag on disk (fresh install) `CrashReporter::wouldInitialise()` is
   **false** (opt-in default OFF); (b) with the flag set to opt-**out**, init is a no-op; (c) with
   opt-**in**, `wouldInitialise()` is true. Runs in the default (Sentry-OFF) build against the pure
   consent-reader — no SDK required.
4. **`strings` no-secret gate — NEW, mirrors T1.** A scripted check over the packaged `Mosh.app`
   finds **no Sentry auth token** and no `sentry-cli` credential. (The **DSN is a public client
   ingest key** and MAY ship; the *upload* auth token MUST NOT.) Wire into the deploy path next to
   K1's future `strings` check.
5. **Sentry-ON build + local minidump gate (owner/local, gated).**
   `cmake --preset macos-arm64-release -DMOSH_ENABLE_SENTRY=ON …` links `sentry-native` + crashpad;
   a **debug-only induced crash** (`Mosh --crash-selftest`, guarded so it can never fire in normal
   use) in a **release** build produces a crashpad minidump under `~/Library/Mosh/crashpad/` and the
   out-of-process handler survives the parent's death. This proves the SDK path end-to-end **without**
   a Sentry account.
6. **End-to-end acceptance gate — BLOCKED-ON-OWNER (needs a real Sentry project).** The literal
   spec-§5-K3 gate — *"induced crash in a release build appears in Sentry, symbolicated; opt-out
   honored"* — needs the owner's DSN + a dSYM upload auth token (see BLOCKED-ON-OWNER). The
   symbolicated-in-dashboard leg + the dSYM-upload leg run once O4 lands; opt-out-honored is provable
   locally now (gate 3 + a live run with the flag off ⇒ zero events sent, verified via the SDK's
   transport log).

---

## Files to change

| path | change |
|---|---|
| `cmake/Sentry.cmake` | **NEW.** `option(MOSH_ENABLE_SENTRY … OFF)`; when ON, `FetchContent`/`CPMAddPackage` a **pinned** `getsentry/sentry-native` (crashpad backend: `SENTRY_BACKEND=crashpad`); expose a `mosh_sentry` interface + `MOSH_HAVE_SENTRY`. **NOT `Dependencies.cmake`** (hard-reject, see Context). |
| `CMakeLists.txt` | `include(cmake/Sentry.cmake)`; link `mosh_sentry` and define `MOSH_HAVE_SENTRY` on the app target **only when enabled** (excluded path → owner-merge; NOT a rulebook file). |
| `src/app/CrashReporter.h` / `src/app/CrashReporter.mm` | **NEW.** `init()` (read the opt-in flag from `~/Library/Mosh/`; if opted-in, `sentry_init` with crashpad handler + `before_send` PII scrubber + release/version tag), `shutdown()`, `wouldInitialise()`, and the pure `scrubEvent()` used by the test. All bodies `#if MOSH_HAVE_SENTRY`; the default build compiles a no-op. `.mm` so it can use the bundle-relative crashpad handler path. |
| `src/Main.cpp` | Call `CrashReporter::init()` early in `initialise()` — **after** the scan-child guard (tier wall: a scan child returns before any of this) and **before** the engine — and `CrashReporter::shutdown()` on exit. Add the debug-only `--crash-selftest` CLI for gate 5. |
| `src/app/SelfTest.cpp` | New hermetic `CRASH-PII` + `CRASH-CONSENT` sections (gates 2, 3). |
| `tests/test_crash_scrub.cpp` + `tests/CMakeLists.txt` | **NEW** Catch2 case for `scrubEvent()` (gate 2), wired into `MoshTests`. |
| `run-mosh.sh` | In the release/DMG path only: a dSYM-upload step (`sentry-cli upload-dif`) **gated on the auth-token env being present** — a no-op when absent, so the canonical `deploy` is unaffected. Excluded path → owner-merge. |
| `ui/src/…` (consent surface) | First-run **opt-in** consent dialog + a Settings toggle; the toggle **writes the preference through the MoshOps settings command path** (the `set_project_settings`/`cmdSetProjectSettings` family — or a dedicated `set_crash_consent` bool command, since crash consent is app-global, not project-scoped). Mock backend + a vitest for the copy/flow. `ui/` is safe-allowlist, but the PR bundles `src/`+`cmake/`+`run-mosh.sh` ⇒ the whole change routes owner. |
| `docs/first-stranger-program/lanes/fs-k3.md` | This plan. |

**Explicitly NOT touched:** `cmake/Dependencies.cmake` (hard-reject), `cmake/CPM.cmake`,
`cmake/*patch*`, `cmake/InjectInfoPlistKeys.cmake` / `Mosh.entitlements` beyond what a mic/crash
string strictly needs (the MoshFixInfoPlist TCC-key pipeline stays intact — §0), `patches/`,
`.github/**`, specs `00`–`06`, `CLAUDE.md`, `scripts/auto-loop/*`, `arena/`, the SA3 LoRA branch,
FMS spike worktrees, `PROGRAM_STAGE1`.

### Design notes for the execute step (not built this session)

- **Consent storage.** Crash consent is app-global, so it does **not** belong in the project
  `ValueTree`. Persist a one-line flag file under `~/Library/Mosh/` (never `~/Documents` — §0),
  written by the MoshOps command handler when the user toggles it, read read-only by `CrashReporter`
  at launch. Default-absent ⇒ OFF (opt-in).
- **PII scrubber (`before_send`).** Strip: home-dir → `~` in every path/string; drop any field whose
  name matches `*_KEY`/`Authorization`/`token`/the brain-provider vars; never send the bundled/proxy
  key, clipboard, lyric text, audio paths, or the raw per-install UUID (hash it if a correlation id
  is wanted). Attach only: app version, macOS version, arch, the minidump. This is the same
  no-secret-leaves-the-box discipline as T1.
- **Tier wall / RT safety.** Crashpad is **out-of-process** — the in-process code only *installs* the
  handler at startup; there are **zero Sentry calls on the audio thread**, no allocation in
  `applyToBuffer`. Init lives in `Main`/`app` only, never in engine/audio TUs, so no RT-safety
  regression is possible by construction. (If any breadcrumb hook is ever added, it must be gated off
  the audio thread — call it out in the RT-safety review at execute time.)
- **DSN vs auth token.** DSN = public client ingest key, safe to bake into the build (or read from a
  bundled non-secret config). The **dSYM-upload auth token is a secret** — env-only in the release
  script, asserted absent from the bundle by gate 4.

---

## §0 rules binding this lane

- **One lane per worktree.** FS-K3 only; no other lane's files.
- **MoshOps is the sole mutation seam.** The consent *decision* is written via a MoshOps command;
  `CrashReporter::init()` only **reads** the persisted flag at startup (read-only ≠ mutation). No
  second mutation path is introduced.
- **Tier wall / threading.** Out-of-process crashpad handler; no model/SDK work on the audio thread;
  no RT allocation. Init is app-layer only.
- **Nothing a build reads lives under `~/Documents`.** Consent flag + crashpad minidump scratch live
  under `~/Library/Mosh/` (`crashpad/`).
- **Build recipe.** `cmake --preset macos-arm64-release -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/`
  `cpm-cache -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/`
  `tracktion_engine-src`. The default (Sentry-OFF) configure adds no fetch; `-DMOSH_ENABLE_SENTRY=ON`
  is the only extra flag for gate 5.
- **Info.plist TCC keys intact.** The `MoshFixInfoPlist` / `InjectInfoPlistKeys.cmake` pipeline is not
  disturbed; crash reporting needs no new TCC key.
- **Never edit the rulebook.** **DO NOT touch `cmake/Dependencies.cmake`** — the Sentry pin goes in a
  NEW `cmake/Sentry.cmake` to avoid the hard REJECT. No changes to `scripts/auto-loop/*`, `CLAUDE.md`,
  specs `00`–`06`, `cmake/Dependencies.cmake`/version pins, `.github/**`.
- **Do not touch parked threads.** `arena/`, SA3 LoRA branch, FMS spike worktrees, `PROGRAM_STAGE1`.

---

## Expected merge BUCKET: **owner**

Every code path here is excluded / native: `CMakeLists.txt` (`classify.sh:40`), the release script
`run-mosh.sh` (`:41`), and `src/*`/`cmake/*` (native, `:56`). It also **adds a third-party dependency
with a new version pin** and wires the release/packaging path — squarely the README's Owner bucket
("packaging, `cmake`, adds-a-dependency"). The loop runs Plan → implement → full gate → hostile
review, then opens a **`needs-owner-merge` PR**; it never auto-merges. **Bucket = owner.**

> Rulebook caveat to flag in the PR: even though the pin lives in the new `cmake/Sentry.cmake` (not
> `Dependencies.cmake`), the rulebook's *"version pins"* clause may be read by the reviewer as
> covering **any** new dependency pin. If so, the PR is `needs-human`, not merely owner-review — which
> is fine (the owner is approving the dependency + secret anyway). The design deliberately keeps the
> hard-reject file (`Dependencies.cmake`) untouched so the diff is an owner PR, not an auto-reject.

## BLOCKED-ON-OWNER

- **Sentry account + secrets (O4-adjacent — "Accounts & secrets").** The literal §5-K3 gate needs:
  (1) a Sentry **project + DSN** (public client key — the owner creates it and hands over the DSN),
  and (2) a **dSYM-upload auth token / `sentry-cli` credentials** (a SECRET — never ships). Until
  these exist, the *scaffold + local minidump proof* (gates 1–5) lands now; the
  **"appears in Sentry, symbolicated"** and **dSYM-upload** legs (gate 6) run once the owner provides
  them. Do not improvise around this blocker (§0) — ship the gated scaffold and report.
- **New-dependency + version-pin sign-off.** The owner approves adding `sentry-native` + crashpad and
  its pin (see the rulebook caveat above).
- **Consent-copy wording.** The first-run opt-in privacy copy is user-facing; the owner approves the
  exact wording before the consent surface merges.
