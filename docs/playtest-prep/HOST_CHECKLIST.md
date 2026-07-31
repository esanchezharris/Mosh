# Host checklist — remote two-Mac playtest

*The owner's pre-playtest runbook. Run this on YOUR Mac before the guest ever opens the app.
For what to tell the guest, see [`docs/TESTER_QUICKSTART.md`](../TESTER_QUICKSTART.md) —
this doc doesn't repeat that content, it points at it.*

## 1. Mint the guest zip

Run exactly this:

```bash
MOSH_BRAIN_ENV_ZIP=ui/.env.local bash scripts/playtest/package-guest-zip.sh
```

**Why the `MOSH_BRAIN_ENV_ZIP=ui/.env.local` prefix is explicit:** the owner's
shell profile exports `MOSH_BRAIN_ENV` to a path that no longer exists (the
2026-07-16 checkout-move landmine — see CLAUDE.md's working notes). If you run the
script bare, `package-guest-zip.sh` still protects itself (it explicitly `unset`s any
inherited `MOSH_BRAIN_ENV` and reads `ui/.env.local` directly — see the script's own
"CRITICAL landmine" comment), so a bare run is actually *safe by construction* against that
specific landmine. `MOSH_BRAIN_ENV_ZIP` is the script's dedicated override and makes the
chosen proxy dotenv explicit at the call site.

**What the script does (10 steps, all fail-closed — see the script for the authoritative
list):** builds a fresh Release `Mosh.app` (or reuses one with `SKIP_BUILD=1`); stages a
*copy* under `dist/stage/` — it never touches `/Applications/Mosh.app`; bundles the Python
service + proxy configuration (loaded from the `MOSH_BRAIN_ENV_ZIP` path, never the ambient
`MOSH_BRAIN_ENV`) by reusing the
literal functions out of `run-mosh.sh` (so this can't drift from the real deploy path);
strips every machine-local `.*.env` pointer file so the zip never pins the guest's Mac to
your paths; copies `setup-guest.sh` + `collect-diagnostics.sh` into
`Contents/Resources/`; re-signs ad-hoc; verifies the bundle (TCC plist key, brain key
present, all service module dirs non-empty, vendored SA3 files present); runs `--selftest`
on the staged app; zips to `dist/Mosh-guest-<YYYYMMDD>-<shortsha>.zip`; then — the important
part — **extracts that exact zip into a scratch dir, attaches a synthetic quarantine flag,
runs `unquarantine.sh` against it, and re-runs `--selftest` from the extracted copy** (the
"guest simulation," step 9/10). If anything in verification or the guest simulation fails,
the script refuses to produce a zip (or deletes the one it just wrote) rather than hand you
something broken — a zip existing on disk is itself proof it passed everything.

**Output:** `dist/Mosh-guest-<date>-<sha>.zip`, plus a paste-ready Discord message printed
at the end and a copy of `docs/TESTER_QUICKSTART.md` at `dist/READ-ME-FIRST.txt`.

The zip may embed `MOSH_BRAIN_PROXY_URL` plus a scoped publishable
`MOSH_BRAIN_PROXY_APIKEY`. Both remain extractable by anyone who receives the zip, so scope
and revoke the proxy credential for the playtest. The packager refuses direct-provider API
keys and multiline proxy values. If the proxy pair is missing, the zip ships without
`brain.env` and Moshi edits fail visibly without mutation.

## 2. Verify before sending

```bash
bash scripts/playtest/preflight.sh
```

Expects **all-green** (4/4): command-surface `--selftest`, UI unit tests (vitest), the
multiplayer relay round-trip (`relay/run-mp-selftest.sh`), and a real render-to-WAV
(automatically includes SA3 if `service/.sa3.env` exists on your Mac). This checks your
*current build*, independent of the zip.

The package script's own **guest simulation** (step 9/10 above — re-extract, synthetic
quarantine, `--selftest` from the extracted copy) is the strongest single proof that a
*specific zip* is good, since it's literally testing the artifact you're about to send, not
just your build tree.

Optional extra paranoia — prove the quarantine round-trip on a copy that's actually been
through Apple's Gatekeeper flagging (AirDrop applies a slightly different quarantine
attribute than the synthetic one the script writes):
```bash
# AirDrop the zip to yourself, then:
unzip -q ~/Downloads/Mosh-guest-*.zip -d /tmp/mosh-guest-check
xattr -dr com.apple.quarantine /tmp/mosh-guest-check/Mosh.app
open /tmp/mosh-guest-check/Mosh.app
# confirm it opens, then quit and rm -rf /tmp/mosh-guest-check
```

## 3. Both Macs

- [ ] Install `Mosh.app` to **`/Applications`** on **both** machines — yours and the
  guest's. This matters because the bundled drum-kit paths are baked in at
  `.../Mosh.app/Contents/Resources/drumkits/...`; if both installs live at the identical
  `/Applications/Mosh.app` path, a committed `SamplerPlugin` sound pointing at the built-in
  kit resolves correctly on the peer's Mac too. Running from `~/Downloads` (or any other
  location) can break that path resolution and leave the guest with silent drum pads. (See
  [`KNOWN_LIMITS_v0.md`](KNOWN_LIMITS_v0.md) — custom/non-kit samples don't transfer yet
  regardless of install location; only the *built-in kit* benefits from matching paths.)

## 4. Two-window live dry run — on YOUR Mac, first

This is the **irreducible final gate** — nothing hermetic (selftest, the relay round-trip,
even the guest-simulation zip check) proves two humans on two separate machines actually
have a good time. Do this before the guest ever joins:

- [ ] Open Mosh **twice** on your Mac (`open -na /Applications/Mosh.app` twice, or launch
  once normally and once more from Finder).
- [ ] In window A: open the multiplayer launcher → **Create** a session → copy the room
  code it displays (the v2 Create/Join modal from PR #350 keeps the code visible and
  copyable the whole time a session is active).
- [ ] In window B: open the multiplayer launcher → paste the code → **Join**.
- [ ] Confirm the **roster** shows both peers with names/colors (not blank/nameless).
- [ ] Lay a quick **MIDI drum pattern** in one window (`add_drum_pattern` or just click
  around) and confirm it **replicates** to the other window after you move off the track
  (commit-on-move — see [`docs/MULTIPLAYER.md`](../MULTIPLAYER.md) for the lock/commit
  model).
- [ ] Try a **re-imagine** on a clip and confirm the rendered **audio syncs** to the other
  window (this exercises the real stem-transfer path, not just structural sync).

If all of that works on one Mac with two windows, the two-*machine* run should behave the
same modulo real network latency — that's the whole point of the dry run.

## 5. Session guidance to relay to the guest

Most of this already lives in [`docs/TESTER_QUICKSTART.md`](../TESTER_QUICKSTART.md) — send
them that doc (it's also bundled as `dist/READ-ME-FIRST.txt` inside the zip). The short
version to say out loud on the call:

- [ ] Start with **MIDI + the built-in kit/instruments** — most-tested path, zero audio
  transfer, syncs instantly.
- [ ] **One person per track** — park on a track, move off it when you're done to flush
  your changes to the other person.
- [ ] **Agree tempo/key out loud up front** — it's last-writer-wins if you both change it at
  once.
- [ ] **Renders are auditions.** Build whatever you plan to actually export or bounce out of
  MIDI + instrument tracks, not audio/re-imagined clips.
- [ ] **Optional real SA3** (not required for the playtest): from Terminal,
  `bash /Applications/Mosh.app/Contents/Resources/setup-guest.sh --all` (10–30 min, ~10 GB,
  needs `xcode-select --install` first if they don't already have Apple's command-line
  tools). Quit and reopen Mosh afterward; the engine badge in the generative panel flips
  from "preview" to "SA3".
- [ ] **If something breaks:**
  `bash /Applications/Mosh.app/Contents/Resources/collect-diagnostics.sh` drops a zip on
  their Desktop — have them send it to you.

See also [`KNOWN_LIMITS_v0.md`](KNOWN_LIMITS_v0.md) for the specific rough edges worth
knowing about going in, and [`SWEEP_2026-07-17.md`](SWEEP_2026-07-17.md) for the full
bug-sweep ledger this checklist and the known-limits doc were distilled from.
