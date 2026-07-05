# Phone Take Controller — DAWN's recording loop on iPhone buttons → Ableton Live

The old **DAWN** voice loop ("put me in" / "keep that" / "try again" / "let me hear that"),
with the voice replaced by five big buttons on the phone. Gets the recording session off the
MacBook keyboard entirely.

```
iPhone Safari ──HTTP over Wi-Fi──▶ server.py (:8123) ──OSC udp 11000/11001──▶ AbletonOSC ──▶ Live
```

Stdlib-only Python; nothing to install on the phone.

## How takes work (Session view)

Each take records into its own **clip slot** on the armed track; keepers stack down the
column. This is exactly what DAWN's Reaper scripts did — stash every keeper, delete-and-redo
for retries. (The arrangement/take-lane route was tried first and rejected: in Live one audio
record is 2+ undo steps, so "try again"=undo left junk fragments, and take-lane state can't be
read back over OSC to drive the phone. Session slots are clean, deterministic, and verifiable —
proven end-to-end in the phase-0 spike.)

## One-time setup

1. **AbletonOSC** must sit in `~/Music/Ableton/User Library/Remote Scripts/AbletonOSC`
   (already installed on this Mac) and be selected in Live:
   **Settings → Link / Tempo / MIDI → Control Surface (any slot): AbletonOSC**.
   Live's status bar flashes "AbletonOSC: Listening for OSC on port 11000" when it's live.
2. Live set, in **Session view**:
   - Your **beat looping in Arrangement** (drop the beat in, set an arrangement loop, hit play)
     — or any clip you leave playing. It plays continuously underneath while you punch takes.
   - An **armed audio track** with your mic input (that's the take target). Arm it (the record
     button on the track). The controller auto-detects the first armed track.
3. Count-in / launch quantization: Live's defaults are fine — takes start on the next bar,
   which keeps them in time with the beat.

## Run the demo

```bash
python3 scripts/phone-take-controller/server.py --open-qr
```

Scan the QR (or type the printed URL) on a phone that's on the same Wi-Fi.

## The loop

| Button | What it does (DAWN equivalent) |
| --- | --- |
| **PUT ME IN** | Record a fresh take into the next empty slot ("put me in") |
| **KEEP** | This take stays as a clip, drop to the next slot and roll again ("keep that") |
| **AGAIN** | Delete this take (clean single delete) and re-record the same slot ("try again") |
| **HEAR IT** | Play the current take back ("let me hear that") |
| **STOP** | Stop everything ("stop / hold on") |
| **− / +** | Move between takes (to re-hear or redo an earlier one) |

The banner shows Live's *actual* transport state (via OSC listeners), the current take and
kept-count, and the OSC round-trip latency.

## Notes / posture

- Demo rig: binds the LAN interface, **no auth** — don't run it on a network you don't trust.
  (A future Mosh companion version rides the existing paired/tokened RemoteCompanionServer.)
- Auto-detects the first armed track; override with `PTC_TRACK=<index>` if needed.
- Ports: HTTP `8123` (`PTC_HTTP_PORT`), OSC send/recv `11000/11001` (AbletonOSC defaults).
- The QR page (`/qr`, Mac-side) uses a CDN QR generator; offline it just shows the URL to type.
