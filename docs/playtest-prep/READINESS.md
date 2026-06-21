# Playtest readiness — go/no-go

**Date:** 2026-06-21 · **For:** tonight's live 2-player playtest (remote, Discord for voice).
**Prepared on:** `claude/playtest-prep-0621` (de-risk-only; nothing merged to main).

## Verdict: 🟢 GO

The build is sound, the audio is real, and two **separate processes** were proven to
collaborate over the **cloud relay** (structure + audio-clip blob round-trip). Tonight is
still the first **human two-window** run — do the 10-minute dry run below first.

## Evidence (all run on a fresh Release build of `main`'s commit `f8295fb`)
| Check | Result |
|---|---|
| UI unit tests (vitest) | **423 passed**, 1 skipped |
| Command-surface `--selftest` ×3 | **893/893**, deterministic, 0 failed |
| Multiplayer selftest (local relay) | **912/912** |
| Multiplayer selftest (CLOUD relay) | **912/912** (relay round-trip 6.07 s vs 0.03 s local → real network) |
| Two-process live MP smoke (cloud) | **PASS** — guest got both tracks + downloaded the audio stem |
| Render-to-WAV incl. **real SA3** | **5/5** — SA3 `pq 6.933`, drums peak 0.91, neural A/B diff-RMS 0.485 |
| `scripts/playtest/preflight.sh` | **🟢 GO (4/4)** |

## Before your friend joins — owner pre-flight
1. **Run the one-command check:** `bash scripts/playtest/preflight.sh` → expect 🟢 GO.
2. **Two-window dry run (the irreducible manual step):** open the deployed app twice
   (`open -na /Applications/Mosh.app` twice), Create a session in one, Join from the other,
   and confirm tracks/MIDI/plugins/mix replicate and the guest sees the host's clip.
3. **Test real audio out** on your speakers (the headless gates don't open the device).
4. **(If you want Moshi)** add an LLM key to `ui/.env.local` and launch via `./run-mosh.sh`
   (not a Finder double-click). See [`agent-setup.md`](agent-setup.md).
5. **Send the app to your friend** and have them run the un-quarantine step.

## Your friend's setup
Give them [`docs/PLAYTEST_SETUP.md`](../PLAYTEST_SETUP.md): AirDrop `Mosh.app` →
`xattr -dr com.apple.quarantine /Applications/Mosh.app` (or
`scripts/playtest/unquarantine.sh`) → open the 2-player panel → paste your room code → Join.

## Suggested session flow (plays to what's solid)
- Get on **Discord** for voice. Agree tempo + key first (tempo is last-writer-wins).
- Build with **MIDI + built-in instruments** (drums kit + 4OSC) — this syncs instantly with
  zero audio transfer and is the most-tested path.
- Each person takes a **track** (one editor per track; move off it to flush to your peer).
- Try a **real SA3 "re-imagine"** on a clip (the host, who has SA3 bundled) — it lands as a
  new audio clip and syncs to the guest over the cloud relay.
- Each person plays back **locally** (independent playheads); talk over Discord.

## Honest unproven / caveats (read these)
- **Two humans, two machines, live, by ear** — not yet done; the dry run is the proxy. Code +
  two-process headless sync are proven; the live UI feel (latency, lock responsiveness) is
  empirical. You're the first real test.
- **A joined GUEST hangs on `export_audio`** (host export is fine). Workaround: **the host does
  any export/bounce.** Confirm in the GUI during the dry run. Details: [`followups.md`](followups.md).
- **Pre-join audio:** a guest who joins *after* clips already exist sees those audio clips as
  `sourceMissing` until the host re-commits that track (MIDI is fine). Commits made *after* the
  guest is present DO deliver audio (proven). Workaround: host nudges audio tracks post-join.
- **Moshi agent / voice** need an LLM key (host-side) + mic/Speech grants; without a key Moshi
  is a mock. Core DAW + multiplayer + SA3 need none of that.
- **Stem transfer** briefly freezes the UI on large files (it's on the message thread).

## What this pass changed (all additive, on the branch — NOT merged)
- New docs: `docs/MULTIPLAYER.md`, `docs/PLAYTEST_SETUP.md`, `docs/playtest-prep/*`.
- New scripts: `scripts/playtest/{preflight,mp-live-smoke,unquarantine}.sh`.
- Doc links added to `ARCHITECTURE.md` + `docs/INDEX.md`. **Zero C++/engine changes.**
- Deployed a clean `/Applications/Mosh.app` (main `f8295fb`, SA3 bundled) for the dry run + distribution.
