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

> **First real-server verification + the 47873 bind-failure root cause (2026-07-16):**
> [`docs/2026-07-16-dawn-pad-verification.md`](2026-07-16-dawn-pad-verification.md). The
> pad drives the **Mac's own** recording via `arm_track` / `set_transport record` /
> `keep_take` / `mark_take` / `undo` — distinct from the phone-mic `/take/*` import flow
> documented below.

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

Live Mac-to-iPhone monitoring is still not product UI in the deep sense — the
full latency spike (`MonitoringDiagnosticRunner`, `DiagnosticsView`) that plays
synthetic probe audio through the speaker and measures acoustic loopback stays
`#if DEBUG`-only hardware-proof tooling, not something a producer taps mid-take.

What **is** now product UI: a small always-visible connection-quality pill next
to the pairing status in the controller header (`SessionView.swift`,
`ControllerView.statusStrip`) — a colored Wi-Fi glyph plus a rough round-trip
number (`"42ms"`), or `lost` when a probe fails outright. It is driven by
`CompanionStore.refreshConnectionQuality()`, a lightweight background heartbeat
(`CompanionStore.startHeartbeat()`, every 4s while paired) against the existing
`POST /monitor/ping` endpoint — no audio session, no microphone, just a JSON
round trip, so it can run for the whole life of a connected session including
the silent middle of a take where nothing else would otherwise touch the
network. Thresholds: `<120ms` good, `<350ms` marginal, otherwise poor;
`ConnectionQuality.classify(roundTripMs:)` in `CompanionModels.swift` is the
single source of truth and is unit-tested directly.

The full diagnostic spike report (network + acoustic median/p95/jitter,
persisted to a JSON file on the Mac) is unchanged and remains reachable from
the speedometer icon in `ControllerView.chrome`, DEBUG builds only.

## Discovery & Windows Parity

Pairing itself (the token exchange) never depends on Bonjour — it is carried
entirely in the `mosh://pair?payload=...` deep link or the equivalent
`http://<host>:<port>/web?payload=...` Safari URL, both generated by
`RemoteCompanionProtocol::beginPairing` and shown as a QR code / copyable link
in the Mac popover. That path is platform-agnostic today and works identically
whether the Mac-side host is macOS or (per the standing Windows-port policy in
`CLAUDE.md`) a future Windows build: scan the QR with the system Camera app (it
deep-links into the installed native app) or paste the link into **Pairing
URL** in `PairingView`.

What is **not** cross-platform is the "Nearby Macs" convenience list in
`PairingView`, which is pure Bonjour/mDNS auto-discovery
(`BonjourBrowser.swift`, browsing `_moshcompanion._tcp`) and only ever shows a
name — it carries no token and cannot itself complete pairing. The
corresponding advertiser, `RemoteCompanionServer::startBonjour()`
(`src/remote/RemoteCompanionServer.cpp`), is explicitly `#if JUCE_MAC`-guarded:
it calls `DNSServiceRegister` via `dlsym` against the system Bonjour library,
which has no equivalent wired up for `JUCE_WINDOWS` in this codebase today.
Concretely: **a Windows-hosted MOSH instance pairs and controls exactly like a
Mac one, but will never appear in the "Nearby Macs" list** — it is a purely
cosmetic reassurance gap, not a functional one.

This was investigated (2026-08) for a real fix — a self-rolled UDP
broadcast/multicast beacon over `juce::DatagramSocket` (which is already
cross-platform, so it would need no `#if WIN32` fork at all) was the leading
candidate, since it would satisfy the project's "parallel target, one
codebase" Windows policy more literally than a second `DNSServiceRegister`-style
port. It was deliberately **not** built in this pass: it adds a new wire
protocol with no way to verify Windows-side behavior from this fully-macOS
worktree (no PC available in this environment), and network discovery of that
kind is exactly the class of change `CLAUDE.md` flags as prone to vacuous
verification — "a test that cannot fail looks identical to one that passes."
Landing an unverified discovery beacon would trade a documented, honest gap for
an undocumented, unverified one. If a PC test lane is available later (see the
project's `ssh pc` verification lane in agent memory / `docs/WINDOWS_RUNBOOK.md`),
that is the point to revisit this.

Until then, the mitigations shipped instead (`PairingView.swift`):

- The empty "Nearby Macs" section now explicitly says only macOS hosts appear
  there automatically, and points at the QR/URL fallback instead of leaving a
  silently-empty list to imply pairing is broken.
- A **Paste** button next to **Pair** reads `UIPasteboard.general.string` and
  pairs immediately when it looks like a `mosh://pair` link — cutting the
  friction of retyping a base64 payload by hand, which was the actual
  usability cost of "manual pairing," not the absence of an auto-discovery
  entry.

## Wider-Distribution Readiness (TestFlight / App Store)

Audited 2026-08 against the checked-in Xcode project
(`ios/MoshCompanion/MoshCompanion.xcodeproj`) and `Info.plist`. This is a
**concrete blocker list**, not a "looks fine" sign-off — several items below
must be resolved before any TestFlight build can even be uploaded.

### Real blockers (must fix before the first TestFlight build)

1. **No app icon asset catalog exists at all.** `find ios/MoshCompanion -iname
   '*.xcassets'` returns nothing — there is no `Assets.xcassets`, no
   `AppIcon.appiconset`, not even a placeholder. App Store Connect validation
   rejects a build with a missing 1024×1024 marketing icon, and Xcode's own
   archive validation will flag it before upload. This needs a real icon
   designed and an asset catalog added to the target (`GENERATE_INFOPLIST_FILE
   = YES` targets currently have nothing wiring `ASSETCATALOG_COMPILER_APPICON_NAME`
   either).
2. **`DEVELOPMENT_TEAM` is empty on every build configuration**
   (`project.pbxproj`: six occurrences — 3 targets × Debug/Release — all `DEVELOPMENT_TEAM = "";`) and
   `CODE_SIGN_STYLE = Automatic`. That is correct for the free
   Personal-Team simulator/device gates this repo already relies on
   (`scripts/iphone-companion-device-gate.sh`), but TestFlight/App Store
   distribution requires a **paid Apple Developer Program membership**
   ($99/yr) and a real team ID set for the Release configuration, plus a
   distribution certificate and provisioning profile (or automatic signing
   pointed at that paid team in Xcode Organizer at archive time). Nothing in
   the repo currently encodes which team that will be — by design, per the
   device-gate script's own comment about keeping the personal team ID out of
   git — so this is a one-time manual step in Xcode/App Store Connect, not a
   code change.
3. **No export-compliance answer is pre-declared.** `Info.plist` has no
   `ITSAppUsesNonExemptEncryption` key, so App Store Connect will prompt the
   encryption-use questionnaire on every build upload. The honest answer here
   is very likely "exempt" (the app only uses standard iOS URLSession HTTP —
   there is no custom cryptography, and `NSAppTransportSecurity` /
   `NSAllowsLocalNetworking` shows it does not even use TLS on the local
   companion link), but that is a product decision to confirm, not something
   to assert in this pass. Adding `<key>ITSAppUsesNonExemptEncryption</key>
   <false/>` once confirmed removes the repeated manual prompt.

### Already in good shape (verified, not just assumed)

- **Privacy usage strings are present and specific**, contrary to what you
  might expect from a "diagnostics is DEBUG-only" codebase:
  `NSMicrophoneUsageDescription`, `NSLocalNetworkUsageDescription`, and
  `NSBonjourServices` (scoped to
  `_moshcompanion._tcp`) all exist in `Info.plist` with real, user-facing
  copy — no boilerplate placeholder text. Nothing to do here.
- `CFBundleURLTypes` correctly declares the `mosh://` scheme used by deep-link
  pairing.
- `IPHONEOS_DEPLOYMENT_TARGET = 17.0` and `SWIFT_VERSION = 6.0` are set
  consistently across every configuration — no stray target mismatches to
  reconcile.
- `MARKETING_VERSION = 0.1` / `CURRENT_PROJECT_VERSION = 1` are present and
  consistent; bumping them is a normal release step, not a structural gap.

### App Review considerations specific to the "needs a paired Mac" model

This app is functionally inert without a MOSH instance running on the same
LAN — `PairingView` is the entire experience until paired, and it cannot
demonstrate anything else. That is a real App Review risk under Guideline 2.1
(App Completeness) precedent for companion/accessory apps that require
separate hardware or a paired host to do anything:

- **Provide reviewer instructions and a demo path in App Store Connect's "App
  Review Information" notes** — at minimum a screen-recorded video of a full
  session (pair → record a take → keep it), since the reviewer will not have a
  Mac running MOSH on the same network. Precedent apps in this shape (smart-
  home companions, AV-console remotes) that get rejected almost always fail
  because the review notes did not make the "you need X nearby" requirement
  and workaround explicit up front.
- **Consider whether a scripted demo/offline mode is worth building** for
  review purposes only — not required, but the single highest-leverage thing
  that would de-risk this category of rejection if the video-only path stalls
  in review.
- **App Store listing copy must say up front** that this is a companion app
  requiring MOSH running on a Mac on the same network — Guideline 2.3.1
  (accurate metadata) risk if the listing reads like a standalone
  recorder/DAW.
- The current Local Network / Bonjour usage strings are good raw material for
  review notes explaining *why* the app needs `NSLocalNetworkUsageDescription`
  and `NSBonjourServices` at first launch — reviewers reject apps that request
  permissions with no visible reason in the flow they test, and pairing is
  exactly the flow that triggers the OS's Local Network prompt.
