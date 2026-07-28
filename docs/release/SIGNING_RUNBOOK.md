# Signing & Notarization Runbook

How Mosh gets from a local build to a DMG/zip that a friend can download and open by
double-clicking — no Gatekeeper "unidentified developer" wall, no right-click-Open, no
`xattr` dance.

**Status: LIVE as of 2026-07-27.** The owner's Apple Developer enrollment is active and
the certificate is installed — `security find-identity -v -p codesigning` shows
`Developer ID Application: EMILIO SANCHEZ-HARRIS (ZYT77F9B27)` — and the `mosh-notary`
keychain profile authenticates against Apple's notary service. `sign-and-notarize.sh
--preflight-only` passes with both live-verified, so steps 1 and 2 below are **done**;
they are kept as the setup reference for a new machine or a CI runner.

> **Building in a git worktree?** Two traps, both hit on the first real run:
> 1. Configure the release dir with the dep-cache recipe or `juceaide` fails on a stale
>    cache — `cmake --preset macos-arm64-release
>    -DCPM_SOURCE_CACHE=$HOME/Library/Mosh/work/cpm-cache
>    -DFETCHCONTENT_SOURCE_DIR_TRACKTION_ENGINE=$HOME/Library/Mosh/work/deps/tracktion_engine-src`.
>    The presets deliberately do NOT hardcode these (the paths don't exist on CI).
> 2. `ui/node_modules` must be a REAL directory, not a symlink to the main checkout.
>    The build runs `npm install`, which deletes the symlink mid-build and then fails
>    (`npm warn reify Removing non-directory …/ui/node_modules`). Symlinking is fine for
>    worktrees you only run tests in; a worktree you *build* in needs its own install.

## How the pieces fit together

```
run-mosh.sh release              .github/workflows/release.yml (on a v* tag push)
        │                                          │
        └──────────────┬───────────────────────────┘
                        ▼
        scripts/release/sign-and-notarize.sh   (sign → notarize → staple → verify)
        scripts/release/make-dmg.sh            (package a drag-to-Applications DMG)
        scripts/release/check-plist-keys.sh    (Info.plist regression guard)
        scripts/release/entitlements.plist     (Hardened Runtime entitlements)
```

Both the local path (`./run-mosh.sh release`) and CI call the exact same
`scripts/release/*` scripts — there is one implementation of "how Mosh gets signed,"
not two that can quietly drift apart. Everything below applies to both; the "Running
via CI" section covers what's specific to GitHub Actions (getting real credentials
into an ephemeral runner).

## 1. One-time setup: the Developer ID Application certificate

You need a **Developer ID Application** certificate — not "Apple Development" and not
"Apple Distribution" (Xcode gives you those automatically for local dev/App Store work;
neither one can notarize a direct-download app). It requires an active Apple Developer
Program membership ($99/year).

1. Xcode ▸ Settings ▸ Accounts ▸ select your Apple ID ▸ **Manage Certificates…**
2. Click **+** ▸ **Developer ID Application**.
3. Confirm it's there:
   ```
   security find-identity -v -p codesigning
   ```
   You should see a line like:
   ```
   1) 1234ABCD... "Developer ID Application: Your Name (ZYT77F9B27)"
   ```

That's the *local* setup — the certificate now lives in your login keychain and
`scripts/release/sign-and-notarize.sh` will auto-discover it (no configuration needed
for local runs). For CI, see [§5](#5-running-via-ci-github-actions) — you'll export
this same certificate as a `.p12` and hand it to GitHub as a secret.

## 2. One-time setup: notarization credentials

Apple's notary service needs proof you're an authorized member of your Developer Team.
Two ways to provide it — `scripts/release/sign-and-notarize.sh` supports both,
auto-selecting whichever is configured (explicit env vars take priority over a
keychain profile if both happen to be set):

### Local (recommended): a `notarytool` keychain profile

One-time setup. First, make an **app-specific password** (NOT your Apple ID password)
at [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific
Passwords. Then:

```bash
xcrun notarytool store-credentials "mosh-notary" \
  --apple-id <you@example.com> --team-id <TEAMID> --password <app-specific-password>
```

This stores the credentials in your keychain under the profile name `mosh-notary` (the
default `scripts/release/sign-and-notarize.sh` looks for; override with
`MOSH_NOTARY_PROFILE` if you ever use a different name). Nothing is written to the repo.

### CI (required): explicit Apple-ID / Team-ID / app-specific-password

GitHub Actions runners are ephemeral — there's no persistent keychain to `store-credentials`
into ahead of time. Instead, set three repo secrets (same app-specific password as
above) and `sign-and-notarize.sh` uses them directly, no keychain profile involved. See
[§5](#5-running-via-ci-github-actions).

### Sanity-check either mode without spending a build

```bash
scripts/release/sign-and-notarize.sh --preflight-only
```

Validates whatever credentials are configured (env vars, falling back to the
`mosh-notary` keychain profile) with a live check against Apple, and tells you exactly
what's missing or wrong — before you spend 10+ minutes on a Release build. This is also
the first step `./run-mosh.sh release` runs internally.

## 3. Running locally

```bash
./run-mosh.sh release
```

This builds a Release app, stages it, bundles the Python service + your `ui/.env.local`
brain key (if you have one — see the note in §6), signs it (Hardened Runtime +
`scripts/release/entitlements.plist`), notarizes it, staples the ticket, packages a
drag-to-Applications DMG, signs/notarizes/staples *that* too, and zips the app for
AirDrop. Output lands in `~/Library/Mosh/release/` (override with `MOSH_RELEASE_DIR`).
The default is deliberately NOT the Desktop: with iCloud "Desktop & Documents" syncing on,
the file provider stamps `com.apple.FinderInfo` on the bundle and codesign then refuses it
("resource fork, Finder information, or similar detritus not allowed") — the release verb
fails fast on a cloud-synced destination rather than dying 10 minutes later at signing.

The whole thing typically takes several minutes, most of it waiting on Apple's notary
service (`--wait` blocks 1–5 minutes per submission, and there are two submissions —
the app and the DMG).

**Useful during iteration**, without spending notary time or needing real credentials
at all:

```bash
# Preview every codesign/notarytool/stapler command that would run, with a placeholder
# identity — safe on a machine with zero signing certs configured:
scripts/release/sign-and-notarize.sh --dry-run /path/to/Mosh.app

# Sign + verify only, skip notarize/staple (needs a real cert, not notary creds):
scripts/release/sign-and-notarize.sh --sign-only /path/to/Mosh.app

# Just the regression guard, against any bundle:
scripts/release/check-plist-keys.sh /path/to/Mosh.app
```

### If it fails

`sign-and-notarize.sh` is fail-closed and prints exactly what's missing (a certificate,
a notary profile, a mismatched identity type). If notarization itself is *rejected*
(not just unreachable — Apple actually looked at the binary and said no), the script
fetches and prints the rejection log automatically. To re-inspect later:

```bash
xcrun notarytool log <submission-id> --keychain-profile mosh-notary
# or, with explicit creds:
xcrun notarytool log <submission-id> --apple-id ... --team-id ... --password ...
```

Common rejection causes: an entitlement request that doesn't match what's actually in
the binary, an unsigned nested binary, or (very much NOT applicable here, but the
classic one) hardened runtime + a debug/`get-task-allow` binary — see
`scripts/release/entitlements.plist`'s own comments for what's deliberately excluded
and why.

## 4. What gets signed, and how

- **Hardened Runtime**, `--options runtime --timestamp`, is required for notarization.
- **Entitlements** (`scripts/release/entitlements.plist`) are Hardened Runtime
  *exceptions* — Mosh is not sandboxed (it's a direct-download DAW, not a Mac App Store
  app). Every entitlement is commented in the file itself with why it's there; the file
  also documents what was considered and deliberately excluded (`allow-dyld-environment-
  variables`, `get-task-allow`, App Sandbox keys, XPC-helper entitlements — none apply,
  each with the grep/audit that proved it). Re-read that file's header before adding
  anything to it; it's the single source of truth, not this doc.
- **Signing order**: inside-out — nested `.dylib`/`.framework`/helper-executable code
  first (no entitlements on nested code, per Apple's guidance), the app bundle itself
  last (with entitlements). The default build has no nested Mach-O (JUCE links
  statically); this matters for the `deploy-anira` variant, which bundles LibTorch +
  libanira dylibs — that variant isn't wired into `release`/CI yet (see §7).
- **The regression guard**: `scripts/release/check-plist-keys.sh` runs automatically at
  three checkpoints inside `sign-and-notarize.sh` — before signing, after signing, and
  after stapling — asserting the bundle still carries
  `NSSpeechRecognitionUsageDescription` (and the other two keys
  `cmake/InjectInfoPlistKeys.cmake` injects at build time). This exists because a
  missing speech-usage key doesn't degrade gracefully: macOS TCC **hard-crashes**
  (SIGABRT) the app the instant the always-on voice feature calls
  `SFSpeechRecognizer` — and that exact bug shipped once already in a hand-copied
  `/Applications/Mosh.app` (see `CLAUDE.md`, *"'Serum 1 load crash' was a TCC speech
  crash, not a plugin-host crash"*, 2026-06-27). The guard doesn't assume signing is
  "supposed to" leave the plist alone; it proves it, every release.

## 5. Running via CI (GitHub Actions)

`.github/workflows/release.yml` runs on a push of a tag matching `v*` (e.g. `v1.2.0`)
and on manual `workflow_dispatch` (which builds/signs/notarizes/packages and uploads
workflow artifacts, but deliberately never creates a public GitHub Release — that only
happens on a real tag push, so testing the pipeline can't accidentally publish
anything).

### Repo secrets to configure

Settings → Secrets and variables → Actions → New repository secret. Names are exactly
the env vars `scripts/release/sign-and-notarize.sh` reads (the workflow does a direct
1:1 mapping, no translation layer):

| Secret | What it is | How to get it |
|---|---|---|
| `MOSH_DIST_CERT_P12_BASE64` | base64 of the exported Developer ID Application `.p12` | Keychain Access → find the cert → right-click → Export → set an export password → `base64 -i DeveloperIDApplication.p12 \| pbcopy` |
| `MOSH_DIST_CERT_PASSWORD` | the password you set exporting that `.p12` | (you chose it in the step above) |
| `MOSH_NOTARY_APPLE_ID` | Apple ID email | — |
| `MOSH_NOTARY_TEAM_ID` | Developer Team ID | Xcode ▸ Settings ▸ Accounts, or [developer.apple.com/account](https://developer.apple.com/account) |
| `MOSH_NOTARY_PASSWORD` | an **app-specific** password | appleid.apple.com → Sign-In and Security → App-Specific Passwords (can reuse the one from §2, or make a dedicated one for CI so it's separately revocable) |

Optional:

| Secret | What it is |
|---|---|
| `MOSH_SIGN_IDENTITY` | pin an exact identity string instead of auto-discovery (only useful if the imported `.p12` somehow yields more than one Developer ID Application identity — a single cert export won't) |
| `MOSH_RELEASE_BRAIN_ENV_BASE64` | base64 of a `ui/.env.local`-shaped dotenv, to bundle a brain key into the *publicly distributed* app — see the callout below before setting this |

The workflow's own first step (**"Check required release secrets"**) fails fast with
the exact list of anything missing, before spending any build time.

### ⚠️ Brain key: local sharing vs. a public CI release are different risk profiles

`./run-mosh.sh release` run locally bundles your `ui/.env.local` brain key into the
notarized app by default — accepted, documented behavior for the owner sharing a build
directly with friends (a small, known audience, with a spend limit set on the LLM
provider key). **The CI workflow does NOT do this by default.** A tag push potentially
reaches anyone with push access to the repo, and the resulting GitHub Release is
public — bundling a real API key into that artifact is a materially larger exposure
than a personal AirDrop. `MOSH_RELEASE_BRAIN_ENV_BASE64` exists as an explicit opt-in
if you decide the tradeoff is worth it (e.g. a capped, disposable key made just for
this); leaving it unset ships every CI release **keyless** — the app still works, the
brain just falls back to the offline mock until the person running it supplies their
own key.

### Triggering a release

```bash
git tag v1.2.0
git push origin v1.2.0
```

Watch the run under the repo's **Actions** tab. On success it uploads `Mosh-v1.2.0.dmg`
+ `Mosh-v1.2.0.zip` both as workflow artifacts and attached to a new GitHub Release
titled "Mosh v1.2.0" with auto-generated notes.

### Testing the pipeline without cutting a release

Actions tab → **Release** workflow → **Run workflow** (this is `workflow_dispatch`).
Same build/sign/notarize/package sequence, but the DMG/zip only land as **workflow
artifacts** (Actions run page → Artifacts, 90-day retention) — no public Release is
created. Good for verifying secrets are configured correctly, or after any change to
the signing scripts, without touching what the public sees.

### CI-specific mechanics worth knowing

- **The certificate is imported into a fresh, throwaway keychain** created for that
  job run only (`security create-keychain`, added to the keychain search list so
  `security find-identity` finds it, a 6-hour lock timeout so it can't lock mid-build,
  `set-key-partition-list` so `codesign` can use it without a GUI prompt that would
  hang forever on a headless runner). It's deleted at the end of the job unconditionally
  (`if: always()`) — nothing outlives the run. GitHub-hosted runners are destroyed after
  every job regardless, so this is defense-in-depth rather than strictly load-bearing,
  but it's the same hygiene a self-hosted runner setup would require.
- **A `--selftest` smoke run** happens after the build and before any signing — the
  Release binary runs the full `Mosh --selftest` harness once (isolated session +
  port). This fails the job (and skips notarization entirely) if the build itself is
  broken, rather than discovering that after burning Apple notary quota/time.
- **CI may be flaky.** Every step is written to be safely re-run: nothing mutates state
  outside the job's own ephemeral keychain and `dist/` output directory, and
  `run-mosh.sh release` doesn't assume any prior partial run's leftovers — a re-run
  (re-push the tag after deleting it, or re-run the workflow) starts clean.
- **Logs**: the full `--selftest` output and the full `./run-mosh.sh release` output
  are uploaded as `selftest-log` / `release-log` artifacts on every run (success or
  failure — `if: always()`), so a failure deep in a 10-minute step doesn't require
  re-running with more verbosity to diagnose.

## 6. What's still manual / owner-gated

- **The actual first live run.** Nothing in this repo can verify real Apple
  signing/notarization without a real Developer ID Application certificate — that's
  the owner's Apple Developer account, not something any automated gate can stand in
  for. Run `scripts/release/sign-and-notarize.sh --preflight-only` locally once the
  cert + keychain profile exist (§1–§2) to confirm the credentials resolve, then a full
  `./run-mosh.sh release` for the real end-to-end proof.
- **Deciding whether to bundle a brain key into a CI release** (§5's callout) — a
  product/security tradeoff, not something this pipeline should default into silently.

## 7. Deliberately out of scope here

- **`deploy-anira` (real-time RAVE / LibTorch) is not wired into `release` or CI.** It's
  a much larger, slower build (LibTorch fetch) with a self-contained-dylib step
  (`selfcontain_anira` in `run-mosh.sh`) that hasn't been threaded through Developer-ID
  signing + notarization. `scripts/release/sign-and-notarize.sh`'s inside-out signing
  loop already *covers* nested dylibs/frameworks generically (it would sign
  LibTorch/libanira correctly if pointed at that build), but nobody has proven that
  end-to-end, and the CI workflow only builds the default (non-anira) target. A future
  `release-anira` verb / workflow variant is the natural next step if that build ever
  needs to ship notarized.
- **Publishing the appcast.** Auto-update itself IS built now (§8), but nothing in this
  repo uploads `appcast.xml` + the update zip anywhere — the host is a deliberate gap,
  not an oversight. See §8's "the one thing still owner-gated".

## 8. Auto-update (Sparkle 2) — FS-K2

The app embeds **Sparkle 2.9.4** and the release verb can generate a signed appcast.
Both halves are off unless configured, and they are configured independently:

| What | Where it comes from | Default |
|---|---|---|
| Sparkle in the bundle | `-DMOSH_ENABLE_SPARKLE` (CMake) | **ON** (macOS) |
| The feed the app checks | `-DMOSH_SPARKLE_FEED_URL` → `Info.plist` `SUFeedURL` | **empty → no updater at all** |
| The key updates are verified against | `-DMOSH_SPARKLE_PUBLIC_KEY` → `SUPublicEDKey` | the project key (below) |
| Generating an appcast at release time | `MOSH_SPARKLE_DOWNLOAD_PREFIX` (env) | unset → skipped, loudly |

With no feed URL, the app carries Sparkle but never checks anything and the
**Check for Updates…** item is not added to the application menu — an item that can
never find an update is worse than no item.

### The keys

Generated 2026-07-27 with Sparkle's `generate_keys`. The **private** key lives only in
the owner's login Keychain (Keychain Access → "Private key for signing Sparkle
updates"). It is not in the repo, not in CI, and **not recoverable if that Keychain is
lost** — losing it means every existing install is permanently unable to update, and the
only fix is shipping a new build with a new key by some other channel. Back it up:

```bash
# reveals the private key — treat like a signing cert, store it in a password manager
scripts/release/sparkle-tools.sh --print-bin   # then: <bin>/generate_keys -x /path/to/backup
```

The **public** key is `95F1BbVbpmGsAzS9Cr3Brzwl6/gAncabM6NhnZM1b1g=`, baked into
`cmake/Sparkle.cmake` as the default. Public by construction — it belongs in the repo
and in every shipped `Info.plist`; that is what pins updates to this project's key.

### Cutting an update

```bash
cmake --preset macos-arm64-release -DMOSH_VERSION=0.0.2 \
      -DMOSH_SPARKLE_FEED_URL=https://<host>/appcast.xml
MOSH_SPARKLE_DOWNLOAD_PREFIX=https://<host>/ ./run-mosh.sh release
```

That produces `$MOSH_RELEASE_DIR/updates/` containing `appcast.xml` and
`Mosh-0.0.2.zip`; upload both to `<host>`. The zip is made from the app **after**
signing, notarizing *and* stapling — order matters: an update zipped before stapling
installs an app that must reach Apple on first launch and fails Gatekeeper offline.

Sparkle compares `CFBundleVersion`, which comes from `MOSH_VERSION`. An update whose
version is not strictly greater is simply never offered.

### Signing the framework

Sparkle's binary release is **ad-hoc signed** (`TeamIdentifier=not set`), so
`sign-and-notarize.sh` re-signs the whole framework tree with our Developer ID:
`XPCServices/*.xpc`, `Updater.app`, the loose `Autoupdate` helper, then the framework.
This is not optional politeness — Sparkle refuses to launch an installer whose team ID
does not match the host app's, and notarization rejects the bundle outright.

`Autoupdate` is the one that bites: it is not a dylib, not a bundle, and not under
`Contents/MacOS`, so it falls through every "obvious" signing loop. Verify it directly
after any change to that script:

```bash
codesign -dv "Mosh.app/Contents/Frameworks/Sparkle.framework/Versions/B/Autoupdate" 2>&1 | grep TeamIdentifier
```

### The one thing still owner-gated

**Where the appcast is hosted.** `zeke431/Mosh` is private, so GitHub Pages needs a paid
plan and release-asset URLs need auth Sparkle cannot present; R2 is owner task O4. And
a public feed means publishing signed builds publicly, which this build is not ready for
(it seals provider keys into the bundle by standing decision — CLAUDE.md § Standing
policy). Pick a host, then it is two flags. Everything downstream of that choice is
built and proven — see `docs/first-stranger-program/lanes/fs-k2.md`.

## Quick reference

```bash
# Local: full release
./run-mosh.sh release

# Local: just check credentials are ready (no build)
scripts/release/sign-and-notarize.sh --preflight-only

# Local: preview commands with zero real credentials
scripts/release/sign-and-notarize.sh --dry-run /path/to/Mosh.app

# Local: regression-check any already-built bundle
scripts/release/check-plist-keys.sh /path/to/Mosh.app

# CI: cut a real release
git tag vX.Y.Z && git push origin vX.Y.Z

# CI: test the pipeline without publishing
# (Actions tab → Release → Run workflow)
```
