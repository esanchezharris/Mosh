# Moshi phone pad

The local phone pad uses the DAWN companion design and a typed version-1 API.
`ui/phonepad-dist/index.html` is the complete embeddable page; it has no
external assets or runtime package/CDN requests. Mosh stages it into the app
bundle as `pad.html` and serves it as `text/html` at public `GET /pad`.

## Build and tests

From `ui/`:

```sh
npm run build:phonepad
npm test -- phonepad
npm run test:phonepad
```

`package.json` pins the directly used versions. Chrome is required for the
browser suite. Its HTTP fixtures bind ephemeral loopback ports; they never
connect to Mosh, an audio device, or a paid endpoint.

## Host contract

Open `/pad#token=HEX` from the pairing QR on the same LAN. The fragment is
removed with `history.replaceState` before the first request. Tokens are
32–128 hex characters and exist only in page memory; reload requires a new QR
scan. No local storage, session storage, cookies, telemetry, or token logging.
Rescanning into an existing page also consumes a new fragment, retires the old
controller, and prevents late responses from the old pairing from changing UI.

The pad sends Bearer authentication on `GET /api/state` and `POST /api/action`.
Schemas are in `src/contract.ts`. GET is polled 200 ms after each response while
visible, with a 1500 ms timeout. Hidden pages cancel the state read, stop polling,
and disable controls. Foregrounding requires a fresh state response. POST has a
2500 ms timeout and no retries. Each user action gets a random 128-bit request ID
via `crypto.getRandomValues`, which works on ordinary same-LAN HTTP pages.

Each mutation includes `version`, `requestId`, `sessionId`, `projectId`, `authority`
and `action`; take actions include `targetId`, and navigation includes `bar`.
The UI validates the POST envelope but uses a fresh GET as the live state source
so delayed mutation responses cannot roll the displayed state backward.

An uncertain mutation remains locked until its receipt becomes terminal or the
session/project changes. Changes to the host's opaque `authority` do not erase
pending receipts. Stop remains available while busy; a new explicit Stop is
allowed after an earlier Stop request finishes or times out. Repeated taps while
that Stop HTTP request is in flight are coalesced. There is no automatic replay.
Other actions allow only one pending mutation. Unauthorized responses discard
the transport and require pairing again. HTTP 4xx and structured rejection
responses release the action lock without retrying.

During recording, Keep/Again/Review target `currentId`. Outside recording, Keep
and Again use the preserved-take selection before `auditionedId` and `lastId`.
Review Selected Take requires an explicit selection. The Again accessible name
and subtitle identify its exact target. Play All never carries a selected target:
it plays backing, keepers, and the latest stopped unkept contribution. During
capture it finalizes first, then plays from that attempt's listening start.

`home` goes to the project beginning; `navigate` accepts displayed integer bars
1–1,000,000. `lead_in` carries `leadQn` (0–256 quarter-note beats). These controls
are stopped-only. Navigation preserves the chosen lead-in. Keep advances by
`max(previous listening start, kept ending - lead-in)` in musical beats.
`playbackScope` distinguishes `none`, `arrangement`, and `selected`.
Engagement and setup remain desktop responsibilities. The phone has no voice
or audio capture.

The two-track arrangement keeps whole contributions on LEAD, including real
overlaps, and uses collapsed RECORDING history lanes for rejected and older
unkept material. Lane order never identifies a target. Explicit restoration
retains the original item/take/source identities. No automatic overlap splitting
or silence trimming is performed.

## Verification boundaries

The browser suite exercises the real production bundle in real Chrome against
explicit HTTP wire fixtures. It is frontend/transport evidence, not live host,
microphone, same-LAN iPhone, or by-ear acceptance. The visibility regression
controls the document visibility input; actual mobile backgrounding remains a
device check. Manual CUA browsing was attempted but returned `No browser is
available`. No independent visual reviewer was spawned under the bounded task.

For an isolated manual fixture, run `npm run phonepad:fixture`, then open its
reported loopback `/pad` URL with `#token=` plus 64 lowercase `a` characters.
This is a synthetic test token. The fixture acknowledges actions and reports
their selected target; it never performs host actions. Stop it with Ctrl-C.

For live acceptance, pair from Mosh and verify: Go to Start then Play All; an
intact vocal beginning across earlier material; Keep/Again; selected history
review followed by Play All; stopped navigation preserving the explicit
lead-in; Stop during an in-flight action; Wi-Fi loss/recovery; foreground refresh;
pairing revocation; and reload requiring a new scan. Verify actual preserved
audio in Mosh's arrangement (Lead / Takes tracks) separately from the page's
receipt text.
