# MOSH iPhone Companion

This is the iPhone companion for nearby, same-network use. The Mac remains the
only DAW/audio/model engine. The iPhone controls MOSH, records phone mic takes,
and can run hold-to-talk voice commands when on-device speech recognition is
available.

**The primary phone workflow is now the DAWN recording pad** (below, #239/#267)
— a no-install web controller served at `/web` that drives the whole
vocal-take loop from the phone. The native SwiftUI app remains the richer
surface for mic takes and on-device speech.

## DAWN Recording Pad (primary phone workflow)

The phone recording-loop controller (PR #239, restyled in #267) ports the
owner's DAWN workflow onto the companion server as the `/web` controller —
getting the recording session off the MacBook keyboard entirely:

- **One pad, five actions:** `PUT ME IN` / `KEEP` / `AGAIN` / `HEAR IT` /
  `STOP` drive record → keep-take → re-take → playback → stop, wired to the
  **existing** MoshOps commands (`set_transport` record/play/stop/seek,
  `arm_track`, `keep_take` — real Tracktion take lanes, undoable). No new C++
  commands.
- **Arrangement navigator:** filled vocal-take regions plus a draggable
  playhead to seek.
- **iOS-style FLIP rearrange:** long-press enters edit mode; the dragged tile
  lifts and the others reflow; the order persists to `localStorage`.
- **Code:** `ui/src/companion/` (pure logic in testable TS modules —
  `commandMap`, `navMath`, `layout` — plus a thin DOM shell; `net.ts` speaks
  the same `/command`/`/snapshot`/`/events` endpoints with the token in the
  body). `vite.companion.config.ts` (`npm run build:companion`) emits one
  self-contained HTML; `cmake/BuildCompanion.cmake` stages it to
  `Resources/companion`, and `RemoteCompanionServer` serves the staged page at
  `/web`, falling back to the prior inline page when absent.

Pairing is unchanged: start pairing from the Mac topbar `iPhone` control and
scan the Safari QR.

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
| `GET /web` | No-signing Safari companion shell — now the DAWN recording pad (see above); actions still require token. |
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

Local simulator gate:

```sh
scripts/iphone-companion-sim-gate.sh          # build + CompanionClientTests
MOSH_IOS_SIM_GATE_MODE=build scripts/iphone-companion-sim-gate.sh   # build-only smoke
scripts/iphone-companion-sim-media-gate.sh    # QR/app-handoff + media seam ladder
```

The script is the hardware-free, CI-ready gate: it auto-selects an available
iPhone simulator, then runs the equivalent of

```sh
xcodebuild test -project ios/MoshCompanion/MoshCompanion.xcodeproj \
  -scheme MoshCompanion -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  CODE_SIGNING_ALLOWED=NO
```

with code signing disabled, so it needs no Apple Account, provisioning profile,
or device. It catches the real compile/typecheck and Swift 6 concurrency errors
that `swiftc -parse` cannot (parse only checks syntax, not cross-file symbol
resolution). The simulator is the required local gate for ordinary companion
hardening. It covers app launch, deep-link pairing, local server connectivity,
stale/offline recovery, receipts, command suppression, and non-hardware UI flow.
`scripts/iphone-companion-sim-media-gate.sh` adds the hardware-dependency
ladder: it renders and decodes a QR PNG for the native pairing URL, opens that
same URL into the installed simulator app against a local Mac stub server, and
runs the fixture-backed recorder, transcript, and synthetic monitoring tests.
Physical iPhone proof remains a manual hardware gate for camera focus/scanning,
real microphone takes, Apple on-device Speech behavior, and acoustic monitoring
through the actual iPhone speaker/mic path.

Physical device gate:

```sh
scripts/iphone-companion-device-gate.sh
```

After the phone has been paired with this Mac for development, the gate can use
CoreDevice over the local network; the iPhone does not need to stay plugged in
as long as Xcode can see it as a paired local-network device. A cable may still
be needed for first-time pairing, trust prompts, charging, or network recovery.

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
Settings > Accounts. The script verifies Developer Mode, builds with DerivedData
under the local temp directory by default, installs with `devicectl`, and
launches `studio.mosh.companion`. This keeps device signing away from
file-provider metadata that can make `codesign` reject app bundles. Set
`MOSH_IOS_DERIVED_DATA=/path/to/derived-data` only when you need a retained
device build directory.

### Wireless Device Troubleshooting

Use the simulator as the required local regression gate, then use the physical
phone only for manual hardware proof. A paired iPhone can be installed and
launched wirelessly when CoreDevice can establish a local-network tunnel:

```sh
xcrun devicectl list devices
xcrun devicectl device info details --device <device-identifier>
xcrun devicectl device info lockState --device <device-identifier>
```

Healthy signs:

- `connectionProperties.transportType` is `localNetwork`.
- `connectionProperties.pairingState` is `paired`.
- `connectionProperties.tunnelState` is `connected`.
- `deviceProperties.developerModeStatus` is `enabled`.
- `device info details` lists `Install Application` and `Launch Application`
  capabilities.

If wireless launch fails:

- Unlock the iPhone once after boot and leave it nearby on the same network.
- Open iPhone Mirroring only after locking the iPhone; Apple requires the phone
  to be nearby and locked for mirrored control.
- Re-run `scripts/iphone-companion-device-gate.sh`; it uses CoreDevice and does
  not require USB after pairing.
- Plug in over USB only for first-time trust/pairing, charging, or when the
  local-network tunnel stays disconnected.
- If `device info details` reports `ddiServicesAvailable: false`, or
  `xcodebuild` says the developer disk image could not be mounted, unlock the
  phone, connect it over USB, open Xcode's Devices window once, and wait for
  device preparation to finish before retrying the gate. A healthy local-network
  tunnel is not enough when CoreDevice cannot mount the developer disk image.
- If signing fails with resource-fork or Finder metadata errors, keep
  DerivedData out of the synced `Documents` tree or set
  `MOSH_IOS_DERIVED_DATA` to a clean local path.

For URL-based pairing without scanning a QR, launch the installed app with a
payload URL:

```sh
xcrun devicectl device process launch \
  --device <device-identifier> \
  --terminate-existing \
  --payload-url 'mosh://pair?payload=<base64-json>' \
  studio.mosh.companion
```

## Safari Web Companion Fallback

The Mac popover now has two QR modes:

- **Native**: `mosh://pair?...`, for the SwiftUI iPhone companion.
- **Safari**: `http://<mac>.local:<port>/web?payload=...`, for no-signing local
  use when the Apple Developer Program or Xcode signing is blocked.

The Safari page served at `/web` is the DAWN recording pad (see the section at
the top). When the staged companion bundle is absent, the server falls back to
the prior compact inline page (transport, track target, record/upload take,
rendered-layer target, Accept, Reject, receipts). Either way it uses the same
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
