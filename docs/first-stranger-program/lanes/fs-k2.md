# FS-K2 — Sparkle 2 auto-update scaffold

**Lane:** K (Ship kit) · **Registered bucket:** owner-merge (backlog `files:["cmake/","resources/"]`)
· **Status: DONE 2026-07-27** — unblocked by the same O1 (Apple Developer enrollment)
that cleared [FS-K1](fs-k1.md), and gated the same day.

## §0 gap evidence (checked 2026-07-27, before building)

SPEC §0 requires confirming the gap still exists. It does — completely:

```
$ grep -rn "sparkle\|Sparkle" src/ ui/src/ cmake/ CMakeLists.txt
(no matches)
```

The only pre-existing mentions in the tree are **prose**, not code:
`docs/DEPENDENCY_BOM.md` (a licence row: Sparkle 2 / MIT / OK), `docs/first-stranger-program/SPEC.md`
(§K2 itself), and `docs/release/SIGNING_RUNBOOK.md:298`, which states outright that auto-update
"is NOT built" and names the hook point. Nothing to salvage, nothing to avoid rebuilding.

## Pin

**Sparkle 2.9.4**, the official binary release tarball (the project ships a prebuilt
`Sparkle.framework`; building from source is not required and not worth the configure cost).

```
https://github.com/sparkle-project/Sparkle/releases/download/2.9.4/Sparkle-2.9.4.tar.xz
sha256 ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9
```

Framework is 3.0 MB. Licence MIT — already a BOM §1 row, so K4's enforcement needs no new entry,
only the notice retention it already records.

**It ships ad-hoc signed** (`codesign -dv` → `TeamIdentifier=not set`), so the release path must
re-sign the whole framework — including `Versions/B/Autoupdate`, `Versions/B/Updater.app` and
`Versions/B/XPCServices/*.xpc` — with our Developer ID, inside-out. Sparkle itself enforces this at
runtime: its own diagnostics carry the string *"your app must be signed with a matching team ID"*.
`sign-and-notarize.sh`'s existing loop signs `*.dylib`, `*.so`, `*.framework` and
`Contents/MacOS|Helpers` executables — it would **miss** all three of those, so that loop is
extended by this lane.

## Plan

1. **`cmake/Sparkle.cmake`** — `MOSH_ENABLE_SPARKLE` (Apple-only), FetchContent the pinned
   tarball with `URL_HASH`, link the framework, embed it into `Contents/Frameworks` with `ditto`
   (`cmake -E copy_directory` follows symlinks and would flatten the versioned framework layout
   and destroy its `_CodeSignature`), add the `@executable_path/../Frameworks` rpath Sparkle's
   `@rpath/Sparkle.framework/Versions/B/Sparkle` install name needs.
2. **Info.plist** — `SUPublicEDKey` + `SUFeedURL` + check interval, threaded through
   `cmake/InjectInfoPlistKeys.cmake`. That file exists because JUCE's `PLIST_TO_MERGE` is honoured
   *only* by the Xcode generator and silently drops keys under the Ninja generator this repo uses;
   a Sparkle key added the naive way would vanish from the shipped bundle exactly the way
   `NSSpeechRecognitionUsageDescription` once did.
3. **EdDSA keys** — Sparkle's `generate_keys`; private key lives in the owner's login Keychain,
   public key is a build input (never a secret).
4. **`src/app/SparkleUpdater.{h,mm}`** — Obj-C++/ARC host around `SPUStandardUpdaterController`,
   mirroring the `NativeSpeech.mm` pattern, plus a stub TU for non-Apple / `MOSH_ENABLE_SPARKLE=OFF`.
   Surfaced as a **Check for Updates…** menu item. Deliberately NOT a MoshOps command: it mutates
   nothing in the session, so the one-mutation-path directive doesn't apply and the agent catalog /
   `uiReachability` contract is untouched.
5. **`generate_appcast`** in the release path, producing a signed `appcast.xml` next to the DMG.
6. **Round-trip proof.**

## The feed host is the one genuinely owner-gated piece

The acceptance says "static appcast (GitHub Pages or S3/R2)". Both named options are unavailable
to a session right now, for reasons worth recording rather than improvising around:

- **GitHub Pages** — `zeke431/Mosh` is `PRIVATE` (`gh repo view` → `"visibility":"PRIVATE"`), and
  Pages for a private repo needs a paid plan. Release-asset URLs on a private repo need auth, which
  Sparkle cannot present.
- **R2** — is exactly owner task **O4** (Cloudflare R2 + Supabase secrets), still open.

Standing up a *public* mirror to host the feed is not a substitute: publishing a signed DMG at a
public URL **is** distribution, and this build seals the owner's provider keys into the bundle by
explicit standing decision (CLAUDE.md § Standing policy). That decision is fine for a build that
lives on the owner's own machines; a public download link is a different act, and it is the owner's
call, not a session's.

So the scaffold takes the feed URL as a **build input** (`MOSH_SPARKLE_FEED_URL`), defaulting to
empty — with no feed configured the app simply has no updater, and the **Check for Updates…**
item is not added to the application menu at all (an item that can never find an update is
worse than no item; it reads as a promise the app cannot keep). The
round-trip gate is proven against a local static server, which exercises every part of the chain
that the eventual public host will exercise (appcast parse → EdDSA verify → download → team-ID
check → install → relaunch). Only the hostname differs. Swapping in the real URL later is a
one-line build flag, and that is deliberately the *only* thing left owner-gated.

## Result — GATE PASSED 2026-07-27

The acceptance's round-trip, run end to end on this Mac:

```
before   installed Mosh.app  0.0.1   accepted · Notarized Developer ID · stapled
feed     127.0.0.1 - - [27/Jul/2026 20:39:50] "GET /appcast.xml HTTP/1.1" 200
         127.0.0.1 - - [27/Jul/2026 20:39:50] "GET /Mosh-0.0.2.zip HTTP/1.1" 200
after    installed Mosh.app  0.0.2   accepted · Notarized Developer ID · stapled
                             codesign --verify --deep --strict: OK
                             stapler validate: worked  (so it is valid offline)
```

Both versions were built, Developer-ID signed, notarized by Apple and stapled through the
real `./run-mosh.sh release` path — **Apple's notary service accepted the bundle with the
re-signed Sparkle.framework inside**, which was the main unknown going in.

Proof it was a genuine bundle swap and not a plist rewrite — the installed executable's
hash became bit-identical to the 0.0.2 release and differs from 0.0.1:

```
installed  845caf21b4cd8e5983ec1a1dda6121bb15e0ed72c3ae9fb0c59df19bc87446fc
rel-0.0.1  3a68cf5db0cb80eb7af6b1d6addbaf202d11fd9fb6e3dfb6c238a1421043ba78
rel-0.0.2  845caf21b4cd8e5983ec1a1dda6121bb15e0ed72c3ae9fb0c59df19bc87446fc   ← match
```

The swapped 0.0.2 bundle then launched and stayed up, with `Autoupdate` still carrying
`TeamIdentifier=ZYT77F9B27`.

**Driven without a single click.** Sparkle's own automatic path (`SUEnableAutomaticChecks`
+ `SUAutomaticallyUpdate` in the app's user defaults) downloads in the background and
installs on quit, so the whole gate is scriptable — no Accessibility permissions, no
synthetic UI events. Those defaults were cleared afterwards; they key on the bundle id and
would otherwise have applied to the owner's real `/Applications/Mosh.app` too.

**What the local feed does and does not prove.** `http://127.0.0.1:8765/` exercises appcast
parse → EdDSA verify → download → team-ID check → install → relaunch. Only the hostname
differs from a real host. It does not prove TLS or a CDN. (Sparkle warns about non-HTTPS
feeds but explicitly exempts local-network testing; ATS does not apply to loopback.)

## Four bugs found by running it

1. **The deploy step silently deleted the Sparkle keys.** `run-mosh.sh`'s `install_app`
   re-runs `InjectInfoPlistKeys.cmake` on the staged copy as a TCC safety net, with no
   build context. The injector treated "caller said nothing about Sparkle" the same as
   "caller said Sparkle is off" and removed `SUFeedURL` + `SUPublicEDKey` from every
   staged release. The build put them in; the copy took them straight back out. Nothing
   errored, the log was clean, and the shipped app simply could never find an update.
   Fixed by making the injector three-state (`if (DEFINED …)` distinguishes *unset* from
   *set-empty*), and pinned by `scripts/release/plist-keys-selftest.sh` case 1 — RED-proven
   by deleting the guard.
2. **`Autoupdate` shipped ad-hoc signed.** The new inside-out signing loop used
   `! -path '*.app/*'` to skip nested bundles — but find's `-path` glob lets `*` match `/`,
   so that pattern matched the *outer* `Mosh.app` and excluded everything. The loop ran and
   signed nothing. Caught only by reading `TeamIdentifier` off `Autoupdate` afterwards; the
   run looked identical either way. Exclusions are now anchored after `.framework/Versions/`.
3. **A build-machine path leaked into the shipped binary.** Passing the `.framework` path to
   `target_link_libraries` makes CMake add its directory to `LC_RPATH`, baking
   `~/Library/Mosh/work/fc/<worktree-hash>/sparkle-src` into the app — dangling everywhere
   else. Linking by name (`-framework Sparkle` + `-F`) leaves exactly one rpath, ours.
4. **`-DMOSH_ENABLE_SPARKLE=OFF` would have broken the build.** `MoshEmbedSparkle` is named
   in `CMakePresets.json`, and a build preset that names a target the configure did not
   create fails outright. The disabled path now creates a no-op target of the same name — an
   escape hatch that breaks the build is not an escape hatch.

## Gate (local, 2026-07-27)

| step | result |
|---|---|
| `--selftest` ×3 | **2045/2045, 0 failed, ×3 identical** |
| `--selftest-undo` | 18/18 |
| Catch2 | 2321 assertions in 233 cases, all pass |
| `tsc --noEmit` (+ e2e project) | clean |
| vitest | 2020 passed, 1 skipped |
| Playwright e2e (isolated, :5191) | 254 passed, 8 skipped, **1 failed — `replay-capture`, pre-existing** |
| `-DMOSH_ENABLE_SPARKLE=OFF` | configures; `MoshEmbedSparkle` still resolves (no-op) |
| `grep SABOTAGE` | clean |

**The e2e failure is not this branch's.** A `main`-HEAD probe worktree fails
`replay-capture` too. Separately, three specs (`agent-loop`, `walkthrough`, part of
`templates`) failed *only* in this worktree — because `ui/.env.local` is a symlink to real
provider keys, so the Vite dev proxy reaches a live LLM and `loopBrainMock`'s deterministic
script never runs. Move that file aside and they pass. Recorded in CLAUDE.md's gotchas; it
cost a bisect against `main` before the cause was obvious.

## Reproduce

```bash
cmake --preset macos-arm64-release -DMOSH_VERSION=0.0.2 \
      -DMOSH_SPARKLE_FEED_URL=http://127.0.0.1:8765/appcast.xml
MOSH_SPARKLE_DOWNLOAD_PREFIX=http://127.0.0.1:8765/ \
MOSH_RELEASE_DIR=~/Library/Mosh/work/sparkle-rt/rel-0.0.2 ./run-mosh.sh release
# serve $MOSH_RELEASE_DIR/updates/ on :8765, then launch the older installed build
```

Runbook: [`docs/release/SIGNING_RUNBOOK.md` §8](../../release/SIGNING_RUNBOOK.md).
