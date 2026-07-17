# DAWN-pad companion verification — 2026-07-16

The five-button iPhone/Safari **DAWN pad** (PUT ME IN · KEEP · AGAIN · HEAR IT · MARKER · STOP)
drives the Mac's own recording through `RemoteCompanionServer` → MoshOps. It shipped
2026-07-06 (#239) and was restyled 2026-07-09 (#267) but had **zero green real-server
evidence** — every prior pass was a vitest mock or an iOS-simulator XCUITest against a
Python stub server, and PR #267's own live KEEP retest was blocked ("the lab server never
bound `127.0.0.1:47873`"). This pass root-causes that bind failure and produces the first
real-server proof.

## 1. Root cause of the "never bound 47873" failure

**It is not a bind bug in the companion server.** `startPairing` and `startLabFeed` call
the identical `listener->createListener(port, {})` on a JUCE `StreamingSocket`, which binds
`INADDR_ANY` with `SO_REUSEADDR` — no localhost-only or TIME_WAIT trap. Proven live below:
the production path binds 47873 fine on a clean machine.

The PR #267 symptom was an **environmental / startup-ordering** failure with three
contributing causes, all upstream of the bind:

1. **The bind happens late in GUI startup, and the lab-feed error was swallowed.** The
   lab feed binds inside the `MoshApplication` constructor, but only *after* the engine
   ctor + CoreAudio device init — ~20–30 s into a GUI launch. `Main.cpp` discarded the
   `startLabFeed` result, so an impatient `curl` (or a probe that gave up early) saw "not
   bound" and there was no log line to say whether the server had started, failed, or
   simply not been reached yet. A launch that never *received* `MOSH_LAB_FEED=1` looked
   identical from outside to a bind failure.

2. **Direct-binary launches get TCC-killed before the bind.** Injecting env vars by
   exec'ing `Mosh.app/Contents/MacOS/Mosh` directly (the natural way to pass
   `MOSH_LAB_FEED=1`/`MOSH_LAB_TOKEN`/`MOSH_AUDIO_INPUT_DEVICE`) launches the Mach-O
   without full LaunchServices bundle identity. macOS TCC then treats the speech
   authorization request as if `NSSpeechRecognitionUsageDescription` were absent (it is
   present in the bundle) and **SIGABRTs the process** — `__TCC_CRASHING_DUE_TO_PRIVACY_VIOLATION__`,
   reproduced twice today. The app dies before the constructor reaches the bind, so 47873
   never opens. Launching via `open -n Mosh.app --args …` (LaunchServices) carries the
   bundle's TCC identity and does **not** crash.

3. **A forced input device can CoreAudio-segfault at teardown.** One direct-exec attempt
   with `MOSH_AUDIO_INPUT_DEVICE="BlackHole 2ch"` SIGSEGV'd in
   `CoreAudioClasses::AudioIODeviceCombiner::restartAsync` on the HAL listener queue —
   again killing the process before/around the bind.

The production **topbar `iPhone` pairing button** is affected by *none* of this: it is
invoked from the already-running GUI (past all startup TCC, launched by LaunchServices),
binds on demand, and returns any error straight to the WebView — it is never silently
discarded. So the pad's real pairing path was never broken; the retest harness was.

## 2. Fix (observability, both paths)

Symptom-fixes were avoided; these make the failure diagnosable so it can't be
misattributed to a bind bug again:

- **`src/Main.cpp`** — the `MOSH_LAB_FEED` startup now logs the `startLabFeed` outcome to
  stderr either way: `companion server listening on port 47873` or `companion server
  FAILED to start: <reason>`.
- **`src/remote/RemoteCompanionServer.cpp`** — on a `createListener` failure both
  `startPairing` and `startLabFeed` now name the port and the accurate cause, e.g.
  `could not start remote companion server (port 47873: Address already in use)`. JUCE's
  `createListener` runs a cleanup `shutdown()`/`close()` that overwrites `errno` (ENOTCONN)
  before it returns, so the real cause can't be read back after the fact — the fix
  re-probes the port with a raw `bind()` to recover the true `errno` (EADDRINUSE etc.).
- **`tests/test_remote_companion.cpp`** — new `[remote][server][bind]` case: a second
  server on an in-use port fails with a message containing the port and "Address already
  in use". Full Catch2 suite: **374 assertions / 68 cases green** (`[remote]` = 76 / 9).

Both changes verified live on a freshly-built binary: launching it with `MOSH_LAB_FEED=1`
printed `MOSH_LAB_FEED: companion server listening on port 47873` to stderr, and the
Catch2 bind test emits `could not start remote companion server (port 47879: Address
already in use)`. (A first-launch build-tree binary binds ~90 s in — it runs a full VST3/AU
scan before the constructor reaches the bind; a deployed app with a cached scan binds in
~25–30 s. This latency is the same class of "looks unbound" trap as the PR #267 retest.)

## 3. What was proven live (first real-server evidence)

Against the **deployed `/Applications/Mosh.app`** (real MoshOps, not a stub), launched via
`open -n … --args --demo5` with `MOSH_LAB_FEED=1 MOSH_LAB_TOKEN=pad-verify`:

- Server bound `*:47873` (LISTEN), `GET /health` → `{"ok":true,"running":true,"port":47873}`.
- `GET /web` served the real DAWN pad (PUT ME IN / KEEP / AGAIN / HEAR / MARKER / STOP).
- Each pad button's exact `commandMap.ts` payload driven through `POST /command` reached
  real MoshOps and was recorded in `mosh-log.jsonl` with `source=phone_controller`:

  | Pad button | Command(s) logged | Result |
  | --- | --- | --- |
  | PUT ME IN | `arm_track`, `set_transport {action:record}` | ok (arm `applied:false` — no input device in this headless-audio session) |
  | HEAR IT | `set_transport {action:play}` | ok, `playing:true` |
  | MARKER | `mark_take` (label=flagged) | ok, logged |
  | AGAIN | `undo` (label=undone) | ok, logged |
  | KEEP | `keep_take` | graceful block `"no takes to keep"` (a tone clip has no take lanes; same path the pad guards client-side with `canKeep:false`) — not written to the log, correctly |
  | STOP | `set_transport {action:stop}` | ok |

This closes the "canKeep:true → keep_take path remains blocked" gap from PR #267 for the
**transport/marker/undo** buttons end-to-end. `keep_take` committing a *real captured
take* still needs live-recorded audio (owner step below) — the command surface is proven;
the take content is hardware-gated.

## 4. Remaining owner steps (physical phone, same-LAN)

Automation can't tap the physical phone (iPhone Mirroring tap-forwarding historically
doesn't reach the app), and `keep_take` needs a real recorded take. Owner checklist:

**Prerequisite:** phone and Mac on the **same Wi-Fi/LAN** (the server is same-LAN only —
no relay/NAT). Each playtest guest pairs **their own phone to their own Mac**.

1. In Mosh, click the **topbar iPhone button** → shows the Safari QR (`http://<mac>.local:47873/web?payload=…`).
2. On the phone, open the QR in **Safari** (guests need no app/signing). The pad loads and
   shows "Connected".
3. Arm a track with a real input (audio interface / mic), then tap **PUT ME IN** → the
   track arms and the **Mac** records through its own input.
4. Perform, then **STOP** (or **KEEP** while rolling).
5. Tap **KEEP** → confirm a `keep_take` line in
   `~/Library/Mosh/session/mosh-log.jsonl` and that the take committed on the track.
6. Tap **AGAIN** (undo + re-arm) and **MARKER** (drops a flagged marker) and confirm each
   in the log.
7. **Verify audio actually landed** on the track by ear / in the arrangement.

If the server doesn't appear: confirm same-LAN, and check the app's stderr for the new
`companion server listening on port 47873` line (or a `FAILED to start (port 47873: …)`
reason). A stale wedged instance holding 47873 now reports "Address already in use".
