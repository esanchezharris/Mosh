# Start page — the friends-first way into Mosh (2026-10-30)

| | |
|---|---|
| **Baseline** | `main` c5bb3480 + PR #794 (rebased) + PR #784 |
| **Kind** | UI feature on the V3 shell; no new MoshOps command |
| **Allowed writes** | `ui/src/v3/` (StartPage and its modules, Booth, shell, TopBar, FileMenu, MoshiFace), `ui/src/hooks/useFileDrop.ts`, `ui/src/hooks/useKeyboardShortcuts.ts`, `ui/src/settings/`, `ui/src/menuActions.ts`, the mock (`ui/src/bridge.mock.ts`, `ui/src/mock/`), `ui/src/bridge.ts` (mock routing only), e2e specs, additive `--selftest` sections, the docs below |
| **Forbidden** | New MoshOps commands; engine behaviour changes; design-lab, Finish My Song, R8 |
| **Owner input needed** | The listening pass on Clean Lead and Tuned Lead; a physical iPhone pairing; the notarized build (§8) |

## 1. Why

Owner direction, 2026-10-30: the first thing to ship to friends is Mosh as a DAW that helps a
novice rapper or singer record themselves as if a recording engineer were present. It should be
fast, and it should feel like a game. Every part already existed (the Booth loop, the phone pad,
two vocal presets, drag-and-drop, the vocal project template, the Moshi splat). What was missing
was a clear way in:

- The Booth was reachable only from File › Templates.
- The vocal preset picker lived only in the Studio inspector, per track, and had to be applied
  to both the Lead and its Takes lane.
- A dropped beat landed at the playhead on whatever track was selected and never set the tempo
  or a loop.
- Nothing said "put on headphones", and monitoring started on over laptop speakers.

## 2. Owner decisions

| Question | Decision |
|---|---|
| Page shape | Fresh installs open on the Start page. A **Start** button in the TopBar reaches it every launch. "Show this when Mosh opens" persists UI-locally. |
| Beat tempo | Detect, then confirm: `detect_clip_bpm` proposes, the singer confirms or nudges (÷2 / ×2) or types; confirming sets the tempo and loops the clip. Beats land at bar 1 on the Backing track, never on a vocal lane. |
| Default voice | Clean Lead (PR #784), with Tuned Lead one tap away; Tuned asks for a key. |
| Phone | Optional and last, with "Skip, use the keyboard" always visible. |
| Game feel | Tier 1: step progress and a "you're set" moment; a take counter, an input meter and a headphone check; the splat laughs on Keep. No scoring. |

## 3. The flow

A V3 posture, `"start"`, not a modal: it replaces the workspace (rail, arrangement, inspector and
dock are not rendered), owns the drop target, and leaves the TopBar, the device and recovery
notices and the modals in place. Logic lives in React-free modules (`startFlow.ts`,
`micCheck.ts`, `beatImport.ts`, `phonePairing.ts`, `vocalSetup.ts`); `StartPage.tsx` sequences
existing commands through `store.exec`.

| Step | What the singer does | Commands |
|---|---|---|
| Welcome | **Start a new song**, or **Continue** the project the engine reopened | Mic permission through the bridge's non-blocking calls FIRST; then `new_project {template:"vocal"}` (via `startVocalProject`), `loop_setup`, the speaker guard and Clean Lead on Lead and Takes (`setupVocalLoop`, the Booth's own recipe) |
| Beat | Drop a file, **Choose a file…**, or **No beat? Use a drum beat** | `import_clip` / `import_clip_data` to Backing at 0 (a second beat `remove_clip`s the first; a beat the engine put anywhere else is undone), `detect_clip_bpm`, then `set_tempo` and `set_transport {loop, loopStart, loopEnd}` |
| Voice | Clean Lead or Tuned Lead (+ key); room check: mic, headphones, Hear myself, meter | `switchVocalPreset`: one batch, every bundled stage removed highest index first, the preset applied, AutoTune Key/Scale set; `set_key` after; `arm_track` as the device check |
| Ready | "You're set." **Go to the Booth** or **Add your phone** | none (the splat laughs once) |
| Phone | **Show the code**, scan, or skip | `startRemotePairing`; the page never calls `remote_stop`; New code re-mints only before a phone connects |

Rules that came out of review and must hold:

- The macOS mic prompt is never raised inside `new_project`: the template arms the Vocal
  synchronously and a prompt there would freeze the app for up to two minutes.
- `new_project`'s ok never means "mic fine"; the page reads `loop_setup`'s `armed`.
- The Clean/Tuned switch undoes on failure only if a command inside it landed. An undo after an
  empty batch reverts the singer's previous edit.
- A chain is "clean" or "tuned" only with exactly that preset's stage count. After #794,
  projects saved while AutoTune was dropped bring back stacked AutoTunes; the page offers
  **Fix it**.
- The Booth ignores the transport loop (`loopStartCapture` forces looping off), so no copy
  promises "the beat loops while you sing".
- Clip-edit shortcuts are inert while the page covers the arrangement.

## 4. Failure paths

Each has detection, plain copy and a way forward: mic not decided, denied, restricted or timed
out; no input device or one that won't open; audio not ready; laptop speakers (a warning, never
a block); non-audio or very large drops; BPM undetectable or an octave off; presets missing
from the build; the Lead already has its own chain; a lost or stacked tuner; a switch that half
fails; an agent transaction or batch already open; the phone server failing to start; an
expired code; a phone that never arrives (same Wi-Fi, VPN, local-network prompt, the Mac's
address); a project replaced mid-flow. `ui/e2e/v3-start-failures.spec.ts` drives them through
`?mockFault=`.

## 5. What else changed

- The Booth runs the same `setupVocalLoop` and `useSpeakerGuard`; it gained a take counter, an
  input meter beside Hear myself, "← Start", and the splat's laugh on a landed Keep.
- `MoshiFace` no longer replays a laugh when it mounts after a celebration.
- V3's File menu gained **New Vocal Recording** and Templates › **Start page**.
- `startOnLaunch` is a UI-local setting, hidden from every Settings surface; its only control is
  the page's footer checkbox.

## 6. Verification

Automated (software evidence only):

- vitest: the pure modules, the page (`StartPage.test.ts`), the shared recipe, the mock knobs.
- Playwright: `ui/e2e/v3-start.spec.ts` (happy path, Tuned switch, beat replace, nudges, drops,
  drum fallback, the launch toggle across reload, every entry point, the Booth round trip,
  the phone step) and `v3-start-failures.spec.ts`.
- Native `--selftest` sections START-FLOW (the page's recipe on the real engine, including one
  undo for the switch) and START-RELAUNCH (a saved Tuned Lead project reopened cold keeps one
  real AutoTune per lane).

Owner rows (`docs/VERIFICATION.md`, "Start page" table): START-fresh, START-first-take,
START-beat, START-speakers, START-phone, START-mic-denied, and the listening pass.

## 7. Risks

- BPM detection on real beats is unmeasured; `BPM_SURE` (0.3) is tuned in START-beat.
- `pairingUrlHost()` takes the first non-loopback IPv4, which can be a VPN address; the page
  shows the address and the help text, but there is no interface picker.
- A Booth pass runs from the listening bar until Stop: a verse longer than the beat runs into
  silence.
- Drops travel as base64 over a synchronous bridge; above 64 MB the page points at
  **Choose a file…** instead.

## 8. Shipping blockers outside this work

1. **Notarized distribution.** The app is unsigned and unnotarized. A friend needs a notarized
   build and a hosted download, or the `xattr` step in `docs/TESTER_QUICKSTART.md`. Ad-hoc
   re-signing also resets the mic permission.
2. **The owner's listening pass** on Clean Lead (every friend's default) and Tuned Lead; both
   are `listening: not-run`.
3. **A physical PHONE-pair on the packaged app**, with `pad.html` staged by
   `cmake/BuildCompanion.cmake`.
4. **The local-network prompt:** there is no `NSLocalNetworkUsageDescription`
   (`cmake/InjectInfoPlistKeys.cmake`), and the firewall prompt has not been observed on a fresh
   Mac.
