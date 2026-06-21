# Multiplayer live smoke — two real processes over the cloud relay

**Date:** 2026-06-21 · **Branch:** `claude/playtest-prep-0621` · **Binary:** fresh Release build
**Script:** [`scripts/playtest/mp-live-smoke.sh`](../../scripts/playtest/mp-live-smoke.sh)

## What this proves (beyond `--selftest`)

`Mosh --selftest MOSH_SELFTEST_MP=1` runs **two simulated peers in one process**. This smoke
runs **two separate OS processes** (`Mosh --run-script`) that meet **only through the cloud
relay** (the baked default `…supabase.co/functions/v1/relay`, no `MOSH_RELAY_URL` set — the
exact path tonight's remote playtest uses):

- **Process A** creates a session → builds a **drum track** (MIDI) + a **tone track** (a
  file-backed audio clip) → claims + commits each → stays alive (`__wait`) to answer the joiner.
- **Process B** joins with A's room code → waits for sync → `save`s its edit.

## Result: ✅ PASS

```
room code: p4QhghDtPJjvacIliYnqnQ
A uploaded stem hash: fbe0bfd3b1ae28234ddfebc7fbab19eb9cca5a66f2fc2603577935aa7435af63
B by-hash stems: ~/Library/Mosh/session-pp-mpB-*/audio/by-hash/fbe0…af63.wav
B applied tracks (saved edit): SmokeDrums=1  SmokeTone=1
RESULT: PASS — B (separate process) received A's MIDI track + audio track
        AND downloaded the audio stem over the cloud relay.
```

Three independent confirmations across the process boundary:
1. **Structure synced:** B's saved `session.tracktionedit` contains **both** `SmokeDrums` and
   `SmokeTone` — A's track/clip/instrument graph reached B.
2. **Audio blob round-trip:** A's tone clip was content-addressed + uploaded (A's commit
   reported `audioRefs:[{hash: fbe0…}]`); the identical hash file appears in **B's** session
   `audio/by-hash/` — B fetched it from the cloud relay.
3. **Cloud path, not local:** no `MOSH_RELAY_URL` was set, so this exercised the real cloud
   relay incl. the signed-URL blob endpoints (the local stdlib relay has none).

### Corroborating in-process result
`MOSH_SELFTEST_MP=1 Mosh --selftest` (no `MOSH_RELAY_URL`) → **912/912**, with the relay
round-trip section taking **6.07 s** vs **0.03 s** against the local relay — i.e. it really
went over the network (*"commit blob survived the relay round-trip byte-for-byte"*, *"track
restored from the relayed commit (end-to-end over HTTP)"*).

## One real finding: a joined GUEST hangs on `export_audio`

While building the smoke, an earlier version had B `export_audio` after joining — **B hung
indefinitely in `export_audio`** (0-byte file, never returned). Characterization:

| Scenario | export_audio |
|---|---|
| No session (plain producer loop, `verify.py`) | ✅ completes |
| **Host** session (created, not joined) + export | ✅ completes (265 KB WAV, `renderMode: fast`) |
| **Guest** session (joined) + export | ❌ **hangs** |

So it's **specific to a joined guest**, not export-in-a-session generally. Root cause
undetermined (likely the apply/poll machinery interacting with the synchronous render — and
possibly amplified by the headless `--run-script` manual message-pump). Logged in
[`followups.md`](followups.md). **Workaround for tonight: the HOST does any export/bounce**, or
a guest leaves the session before exporting. **Verify in the GUI during the dry run** (the
GUI's real thread model may or may not reproduce it).

## What still needs a HUMAN

This smoke drives the engine headlessly; it does **not** exercise the real UI. Before the
playtest, do the **two-window dry run** (one Mac, two `Mosh.app` instances): Create in one,
Join from the other, and visually confirm drag/edit/clip/mix replicate and that a guest sees
the host's clips. Synthetic UI clicks are blocked by macOS Accessibility, so this one is
irreducibly manual. See [`docs/PLAYTEST_SETUP.md`](../PLAYTEST_SETUP.md).
