# FS-K1 — Sign + notarize + staple DMG

**Lane:** K (Ship kit) · **Registered bucket:** owner-merge (backlog
`files:["scripts/","CMakeLists.txt"]`) · **Status: DONE 2026-07-27** — first real signing
run against Apple's notary service.

Prior state: PR #405 landed the whole pipeline (`scripts/release/*`,
`docs/release/SIGNING_RUNBOOK.md`) but could only prove it with `--dry-run`, because the
machine had no Developer ID certificate. **O1 (Apple Developer enrollment) cleared**, so
this lane was never "build the pipeline" — it was *run* it, and fix what only a real run
could surface. Four bugs did surface; none were findable by dry-run.

## Result

```
Mosh.app  gatekeeper: accepted · source=Notarized Developer ID
          origin=Developer ID Application: EMILIO SANCHEZ-HARRIS (ZYT77F9B27)
          stapler validate: worked · codesign --deep --strict: satisfies its Designated Requirement
Mosh.dmg  gatekeeper: accepted · source=Notarized Developer ID · stapler validate: worked
```

Mounted the DMG and assessed the app *inside* it — the path a user actually takes —
`accepted / source=Notarized Developer ID`, drag-to-Applications symlink present, stapled
ticket validates (so it works with no network). Artifacts in `~/Library/Mosh/release/`
(13 MB DMG, 31 MB app). Embedded entitlements confirmed on the signed bundle: `allow-jit`,
`allow-unsigned-executable-memory`, **`disable-library-validation`** (the one that lets
third-party VST3/AU load), `device.audio-input`, `device.camera`.

## The four bugs a dry-run could not find

1. **`AMFIUnserializeXML: syntax error near line 17`.** `codesign` parses entitlements with
   AMFI's XML reader, which does not accept XML **comments** — and `entitlements.plist` is
   heavily commented by design. `plutil -lint` says OK, which is why it passed review: the
   file *is* valid XML; AMFI is just stricter. Fixed by normalizing through
   `plutil -convert xml1` into a temp file at sign time, so the documented source file
   survives. Proved with a minimal probe bundle: commented → error, stripped → signs.
2. **`resource fork, Finder information, or similar detritus not allowed`.** The default
   `MOSH_RELEASE_DIR` was `~/Desktop/Mosh-share`, and this Mac has iCloud "Desktop &
   Documents" syncing on, so the file provider stamps `com.apple.FinderInfo` on the bundle
   — *underneath* the script's own `xattr -cr`, so clearing does not stick. Default moved
   to `~/Library/Mosh/release` (never synced) and a fail-fast guard added **before** the
   build, path-based (a fresh synced dir has no fileprovider xattr *yet* — the xattr check
   alone misses exactly the case that later breaks).
3. **A false "rejected" on a good DMG.** Final verification ran `spctl -a -t open` without
   `--context context:primary-signature`, so spctl had no rule to apply and answered
   `rejected / source=Insufficient Context` on a notarized, stapled DMG. An assessment that
   cries wolf on success is worse than none. Fixed; the same DMG now reports `accepted`.
4. **Worktree build traps** (not the pipeline's fault, but they blocked it): the release
   build dir must be configured with the dep-cache recipe or `juceaide` dies on a stale
   cache, and `ui/node_modules` must be a **real** directory — the build runs `npm install`,
   which deletes a symlink mid-build. Both now documented in the runbook.

## Not covered by this lane

- **"On a clean macOS account"** — the acceptance's literal wording. Creating a second user
  account is an owner action; everything testable without one is verified above, and
  Gatekeeper's verdict does not vary by account.
- **Third-party plugins load / mic works / Moshi works** — GUI-interactive, and "Moshi works
  (proxy)" specifically depends on **FS-T1 + O4** (the brain-key proxy), a different lane.
  This build ships the owner's provider keys in `Contents/Resources/brain.env` by explicit
  standing decision (see CLAUDE.md § Standing policy) — Moshi has a live brain on launch.

## Unblocked by the same O1

**FS-K2** (Sparkle 2 auto-update scaffold) moved `blocked` → `ready`. `blockedOn: O1` was
also cleared from both rows so the board stops listing them under "Blocked on you".

## Reproduce

```bash
./run-mosh.sh release      # preflight → build → stage → sign → notarize → staple → DMG
```
Runbook: [`docs/release/SIGNING_RUNBOOK.md`](../../release/SIGNING_RUNBOOK.md).
