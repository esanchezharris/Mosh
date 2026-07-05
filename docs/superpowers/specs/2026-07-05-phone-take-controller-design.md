# Phone Take Controller — DAWN's recording loop on iPhone buttons → Ableton Live

*Design + verified build notes. 2026-07-05.*

## Context

The owner's old **DAWN** project (a voice-controlled take loop for Reaper) let a vocalist run
a whole recording session by voice — "put me in", "keep that", "try again", "let me hear
that", "stop". The goal here: demo that same loop with the voice replaced by **a few big
buttons on the iPhone**, so the recording session runs entirely off the MacBook keyboard,
driving **Ableton Live** (owner's DAW of choice). Everything else in DAWN (speech parsing, FX
automation) is out of scope — this is a focused UX prototype for the future Mosh companion
recording flow.

## Architecture (all new; zero coupling to Mosh product code)

```
iPhone Safari ──HTTP over Wi-Fi──▶ server.py (:8123) ──OSC udp 11000/11001──▶ AbletonOSC ──▶ Live
```

Lives in `scripts/phone-take-controller/`:
- **`server.py`** — stdlib-only Python 3 (http.server + socket + threading; no venv, no pip):
  a ~40-line OSC encoder/decoder, a synchronous OSC query path, a DAWN-style state machine,
  and the HTTP surface (`/` phone page, `/qr` Mac-screen QR, `POST /action`, `GET /state`,
  `GET /url`).
- **`index.html`** — one mobile page: five thumb buttons (PUT ME IN / KEEP / AGAIN / HEAR IT /
  STOP) + a take navigator (− / +) + a live state banner. Polls `/state` at 2 Hz.
- **`qr.html`** — QR of the LAN URL for the Mac screen (CDN generator; falls back to the
  typed URL offline).
- **`README.md`** — setup + demo runbook.

The bridge is **AbletonOSC** (a free, installed remote script) — chosen over MIDI-map +
keystrokes because it gives real programmatic control (record, clip ops, transport,
listeners) and works even when Live isn't the frontmost window.

## Take workflow: Session view (changed from the initial plan)

The plan opened with **Arrangement + take lanes**. The phase-0 spike (real takes recorded
over OSC in Live 12.4) **disproved that as the robust choice** and it was changed to
**Session view**, with the owner's sign-off:

- **Arrangement + undo** is fragile: one audio record in Live is **2+ undo steps**, so
  "AGAIN"=undo left a ~0.6 s junk fragment instead of cleanly wiping the take. Take-lane
  stashing for "KEEP" also can't be read back over OSC, so the phone can't reflect it.
- **Session view is clean and deterministic** — and closer to what DAWN's Reaper scripts
  actually did (stash every keeper, delete-and-redo for retries; DAWN never used undo or take
  lanes). Each take records into its own **clip slot** on the armed track; keepers stack down
  the column.

### Button → OSC (session model)

| Button | State machine | OSC to Live (armed track `t`, slot `s`) |
|---|---|---|
| PUT ME IN | → RECORDING, fresh slot | `clip_slot/stop t cur` → `clip_slot/fire t s` (next empty) |
| KEEP | → RECORDING, next slot | `clip_slot/stop t cur` (commits take) → `clip_slot/fire t s+1` |
| AGAIN | → RECORDING, same slot | `clip_slot/stop t cur` → `clip_slot/delete_clip t cur` → `clip_slot/fire t cur` |
| HEAR IT | → PLAYING | `clip_slot/fire t cur` (slot has a clip → plays) |
| STOP | → PAUSED | `song/stop_playing` + `clip_slot/stop t cur` |
| − / + | move active slot | (no OSC; re-hear / redo an earlier take) |

The controller tracks slot occupancy itself (a `filled` set) rather than querying Live per
action — it is the only thing creating/deleting these clips, so its own bookkeeping is
authoritative and needs no round-trips. The armed track is auto-detected (first armed track;
`PTC_TRACK` overrides). The state banner is driven by Live's real transport via OSC listeners
(`is_playing` / `beat` / `tempo`), plus a 2 s heartbeat that also yields an OSC round-trip
readout.

## Known constraint: AbletonOSC `clip_slot` GET reply bug

This AbletonOSC build (commit `0ca6821`) has a logging bug in the `clip_slot` GET handler
(`self.logger.info(track_index, clip_index, rv)` passes ints as the log *message*), which
makes `clip_slot/get/*` **query replies** unreliable — Live processes the query and logs the
value, but the reply often doesn't return. This affects only reads; `fire`/`stop`/
`delete_clip` methods and `song`/`track` GETs are unaffected. **The controller deliberately
avoids `clip_slot` GET at runtime**, so it is immune; only an external verification harness
that reads `has_clip` is affected. The AbletonOSC install is third-party and left unmodified.

## Verification (done)

- **No-Live:** all endpoints via `curl`; state-machine transitions; mobile-viewport render +
  live button→server→UI round trip (screenshotted); QR page renders.
- **Live integration (ground truth = AbletonOSC log):** full loop driven through the phone
  HTTP API against Live 12.4 — record → keep → again → stop — produced the exact OSC op
  sequence (`fire` / `stop` / `delete_clip` / `stop_playing`) and left real clips
  (`has_clip = True` in slots 0 and 1). Clean single-op delete-and-redo confirmed. OSC
  round-trip 28 ms (≤100 ms under load).
- **Owner taste gate (remaining):** run a real vocal session from the phone over Wi-Fi —
  record/keep/redo/audition by thumb. This is the by-ear demo gate.

## Posture / out of scope

Demo rig: binds the LAN interface, **no auth token** (documented; a future Mosh companion
version would ride the existing paired/tokened `RemoteCompanionServer`). Out of scope: voice/
speech, FX automation, command parsing, Reaper support (DAWN's Lua + Reaper's built-in OSC
remain a near-free fallback lane), Mosh iOS-companion integration, multi-phone.
