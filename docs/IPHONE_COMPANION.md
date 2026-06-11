# MOSH iPhone Companion

This is the first native iPhone companion slice for nearby, same-network use.
The Mac remains the only DAW/audio/model engine. The iPhone controls MOSH,
records phone mic takes, and can run hold-to-talk voice commands when on-device
speech recognition is available.

## Mac Remote Server

- The `RemoteCompanionServer` is off by default.
- The desktop topbar `iPhone` control starts pairing and binds high port `47873`.
- Restricted ports are refused in `RemoteCompanionProtocol`.
- While pairing is active, the Mac advertises `_moshcompanion._tcp` via Bonjour
  when the system Bonjour symbols are available.
- Local Network permission metadata is merged into the macOS app plist.

Remote endpoints are JSON over HTTP:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Server status, no mutation. |
| `GET /web` | No-signing Safari companion shell; actions still require token. |
| `POST /snapshot` | Returns the MoshOps snapshot. |
| `POST /command` | Executes one existing MoshOps command. |
| `POST /events` | Polls queued MoshOps events since a sequence number. |
| `POST /take/start` | Creates a temporary phone-take staging file. |
| `POST /take/chunk` | Appends one sequenced PCM16 chunk. |
| `POST /take/finish` | Writes the WAV and imports it through `import_clip`. |
| `POST /take/cancel` | Removes staged take audio. |
| `POST /monitor/ping` | Authenticated timing sample for diagnostics. |
| `POST /monitor/start` | Starts a hidden synthetic monitoring spike. |
| `POST /monitor/chunk` | Returns one ordered 48 kHz mono PCM16 probe chunk. |
| `POST /monitor/report` | Persists network/acoustic latency summary JSON. |
| `POST /monitor/stop` | Ends a hidden monitoring spike. |

All endpoints except `/health` require the current pairing token in the JSON
body. Phone takes stay invisible until `/take/finish`, where the Mac imports the
finished WAV through MoshOps so undo, snapshot invalidation, and command logging
remain on the same path as desktop UI actions.

`GET /health` is intentionally redacted: it reports server status without the
pairing token, native deep-link URL, or Safari web URL. The in-app Mac popover
still receives both token-bearing URLs through the native WebBridge path and can
render either one as a QR code.

## iOS Companion

The Xcode project lives at:

```sh
ios/MoshCompanion/MoshCompanion.xcodeproj
```

Implemented first screens:

- Pairing: Bonjour discovery list plus `mosh://pair?...` URL entry.
- Session: transport play/stop, target track picker, recent receipts.
- Render decisions: artifact-ready render layers from the Mac snapshot appear as
  phone targets, and Accept/Reject execute the real MoshOps commands.
- Voice: hold-to-talk surface gated on on-device Speech availability.
- Takes: phone mic recorder that chunks PCM16 to the Mac and commits on stop.
- Diagnostics: DEBUG-only latency spike runner that reports network/playout and
  acoustic loopback summaries; it is not product monitoring UI.

Local build smoke:

```sh
xcodebuild test -project ios/MoshCompanion/MoshCompanion.xcodeproj \
  -scheme MoshCompanion -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO
```

Physical device gate:

```sh
scripts/iphone-companion-device-gate.sh
```

The script keeps the personal team ID out of git. It first tries to auto-detect
a team ID from an existing Apple Development certificate, which works for the
free Xcode Personal Team path after Xcode creates the certificate. If detection
fails, set `MOSH_IOS_TEAM_ID` only in the shell:

```sh
export MOSH_IOS_TEAM_ID=ABCDE12345
scripts/iphone-companion-device-gate.sh
```

Paid Apple Developer Program enrollment is not required for a local Xcode
Personal Team install, but Xcode still needs a normal Apple Account added under
Settings > Accounts. The script verifies Developer Mode, builds to
`build/ios-device`, installs with `devicectl`, and launches
`studio.mosh.companion`.

## Safari Web Companion Fallback

The Mac popover now has two QR modes:

- **Native**: `mosh://pair?...`, for the SwiftUI iPhone companion.
- **Safari**: `http://<mac>.local:<port>/web?payload=...`, for no-signing local
  use when the Apple Developer Program or Xcode signing is blocked.

The Safari page is intentionally compact: transport, track target, record/upload
take, rendered-layer target, Accept, Reject, and receipts. It uses the same
`/snapshot`, `/command`, and `/take/*` endpoints as the native app, so there is
still one mutation path through MoshOps.

Reliability comparison:

| Capability | Native iPhone app | Safari web companion |
| --- | --- | --- |
| Install path | Requires Xcode signing; Personal Team is enough for local testing. | No signing or install; scan Safari QR. |
| Pairing | Deep link into app plus Keychain storage. | Token in page URL; expires with pairing window. |
| Commands | Most reliable; app state can reconnect. | Good for nearby control while page is open. |
| Phone mic take | Best path: `AVAudioEngine` PCM chunks. | Uses Web Audio live mic when Safari allows it; file-capture upload is the fallback. |
| Voice control | On-device Speech availability gate. | Not first-class; browser speech APIs are less predictable. |
| Monitoring spike | DEBUG-only native diagnostic path. | Not exposed; browser timing is less useful for acoustic proof. |

## Live Monitoring

Live Mac-to-iPhone monitoring is still not product UI. The current implementation
adds only a hidden diagnostic spike using synthetic probe audio. It reports
network/playout median, p95, jitter, plus acoustic loopback median, p95, and
jitter when the phone mic can capture the probe.
