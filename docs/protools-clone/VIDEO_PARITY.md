# Pro Tools video parity ledger

Research date: 2026-08-10

This ledger turns tutorial footage into reproducible visual and behavioral evidence for
Mosh's additive `protools` shell. Source video and extracted frames stay in a private,
ignored cache. The repository stores links, timestamps, observations, measurements,
and Mosh tests only; it does not redistribute Avid media, artwork, icons, or audio.

## Authority and conflict policy

1. Current Avid reference documentation defines behavior.
2. Current official Avid videos demonstrate it in an operating session.
3. Older official videos fill gaps when the documented behavior is unchanged.
4. Reputable third-party tutorials corroborate workflows but cannot override Avid.
5. Mosh-specific adaptations are labeled rather than presented as Pro Tools behavior.

When sources disagree, record the versions and dates, resolve the difference against
current Avid documentation, and keep the discrepancy in this ledger. For example, the
short automation video describes an approximate upper/lower split, while Avid's
[Smart Tool help](https://apps.avid.com/protoolsfirsthelp/version12.3/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.42.html)
specifies Trim in the top 25%, Selector in the lower 75%, and Command/Control for the
Grabber. Mosh follows the documented 25/75 contract.

## Primary official corpus

The titles and channel attribution for V01-V08 were rechecked through YouTube's
oEmbed metadata on 2026-08-10; each reports the author as **Avid Pro Tools**.

| ID | Avid video | Timecoded evidence |
|---|---|---|
| V01 | [Edit Window](https://www.youtube.com/watch?v=3L_UeAZuSik) | 0:05 modes/tools; 0:19 configurable toolbar; 0:34 Universe and rulers; 0:55 Track List left, Clips List right, lanes center. |
| V02 | [Edit Tools](https://www.youtube.com/watch?v=bKZkz6yMLZQ) | 0:02 F6/F7/F8 tools; 0:20 Trim; 0:25 Selector; 0:45 Grabber; 0:58 multi-select. |
| V03 | [Recording Audio](https://www.youtube.com/watch?v=lG7JXfc8Hl8) | 0:00 input/output; 0:25 record mode; 0:36 track/global arm; 0:46 cursor plus record/stop; 1:05 F12. |
| V04 | [I/O Setup: Inputs and Outputs](https://www.youtube.com/watch?v=U45vpVRYr38) | 0:00 device-dependent I/O; 0:12 path grid; 0:40 rename/create/default paths; 0:54 outputs exposed to tracks. |
| V05 | [Learn Pro Tools in 1 Hour](https://www.youtube.com/watch?v=2ywNbOLePOo) | 0:58 tracks; 10:25 clips; 22:27 audio recording; 31:48 arrange/mix; 35:08 clip editing; 51:05 mixing; 56:06 inserts; 1:01:25 automation. |
| V06 | [How to Use Clip Gain](https://www.youtube.com/watch?v=-jQceBZ8tPI) | 0:04 clip versus track volume; 0:18 lower-left gain control; 0:42 dynamic gain; 0:58 gain line; 1:04 Grabber breakpoints; 1:13 vertical gain/horizontal timing. |
| V07 | [Editing Automation](https://www.youtube.com/watch?v=HjoNFBxyXYg) | 0:00 Smart Tool; 0:15 selection; 0:18-0:25 cut/copy/paste; 0:24 trim; 0:40 nudge; 0:45 node move; 0:56 delete; 1:03 Control line Pencil; 1:09 Control+Command freehand. |
| V08 | [MIDI Editor](https://www.youtube.com/watch?v=FDqKlSMKCGw) | 0:00 double-click MIDI clip; 0:27 independent modes/tools; 0:34 keyboard; 0:43 controller lane; 0:51 Track List; 1:13 Smart Tool. |
| V09 | [Track Views](https://www.youtube.com/watch?v=VyEEufPAZ5s) | Track display and automation-view selection. |
| V10 | [Playlist Comping](https://www.youtube.com/watch?v=8X3KQ3Cq8Co) | Playlist-based take comping; additive follow-up scope. |
| V11 | [Fast Start: Mixing Fundamentals](https://www.youtube.com/watch?v=MDcgJju4WOY) | Fader, pan, inserts, sends, buses, and mix hierarchy. |

V05 (2025) and V06 (2026) take precedence over older visuals when the interface
differs. Full documentation and non-video references live in [RESEARCH.md](./RESEARCH.md).

## Corroborating tutorials

| ID | Tutorial | Useful coverage |
|---|---|---|
| C01 | [Alexander Reyes: Edit Window Demystified](https://www.youtube.com/watch?v=FFCUUDf1DIY) | 0:40 overview; 3:11 Track column; 4:26 Clip column; 5:12 Grid; 7:15 tools; 8:20 counter. |
| C02 | [Wayne.wav: Edit Modes](https://www.youtube.com/watch?v=y045uFZprSc) | 2:29 Shuffle; 5:55 Grid; 7:59 Relative Grid; 9:19 Spot; 11:47 Slip. |
| C03 | [Paul Maunder: Clip Gain Guide](https://www.youtube.com/watch?v=e6RXbSY0Fh4) | 2:03 static versus dynamic; 4:23 shortcuts; 5:24 Pencil; 6:04 nudge. |
| C04 | [Production Expert: Crossfades](https://www.youtube.com/watch?v=OdviYzQlQ6U) | Crossfade creation and adjustment. |
| C05 | [Production Expert: Edit Window Shortcuts](https://www.youtube.com/watch?v=ZYOh9DO2x3o) | Operator-focused Edit Window shortcuts. |
| C06 | [Production Expert: Nudge](https://www.youtube.com/watch?v=X5VQaUsE9z4) | Nudge configuration and use. |

## Copyright-safe comparison method

For each claim, record the URL, timestamp, publication date, visible Pro Tools version,
crop/zoom state, precondition, action, intermediate feedback, result, matching Mosh
fixture, command assertion, and status. Use `MATCH`, `ADAPTED`, `GAP`, `CONFLICT`, or
`DEFERRED`.

Visual comparison uses uncropped full-window frames and normalized ratios rather than
source pixels:

- toolbar height / viewport height;
- ruler stack height / viewport height;
- track-header width / viewport width;
- track-row height / viewport height;
- Clips List width / viewport width;
- ordering and visibility of modes, tools, counters, Grid, and Nudge.

The deterministic Mosh fixture is captured at 1440×900 and 720×720 with the same track
count, media type, selection, zoom, and panel state. Structural zones should remain
within five percentage points of the reference unless the ledger documents an
accessibility or compact-layout adaptation. Semantic ordering and state visibility are
exact requirements. Mosh retains its own accessible tokens and original primitives.

Video compression, presenter crops, scaling, and version changes make literal
screenshot pixel diffs invalid evidence.

## Behavioral comparison method

Behavior is stricter than appearance. Each implemented tutorial behavior needs a
three-state browser trace:

1. **Before** — required routing, selection, mode, arm, and monitoring state.
2. **During** — pressed, dragging, recording, preview, or modal feedback.
3. **After** — snapshot result plus the expected `store.exec(command, args)` trail.

Focus, Escape/cancel, pointer cancellation, `projectEpoch` replacement, undo, save and
reload are explicit where applicable. Browser evidence does not replace packaged,
native, physical-device, or audio-output acceptance.

## Pro Tools parity ledger

| Area | Evidence | Status | Mosh proof / next action |
|---|---|---|---|
| Edit Window zones | V01, V05, C01 | `MATCH` | `?shell=protools` Chromium zones test; fresh wide/compact producer-flow captures. |
| Edit modes/tools | V01, V02, C02 | `MATCH` | F1–F10 Chromium state proof and Smart Tool classifier tests. |
| Recording/routing | V03, V04, V05 | `MATCH/ADAPTED` | Producer flow asserts unassigned/Auto/disarmed, routed/Monitor In/armed, active record, stopped take, and command trace. Track inspector replaces the full I/O matrix. |
| Track controls | V03, V05, V11 | `ADAPTED` | Header exposes select/arm/solo/mute and actual output; inspector owns deeper routing, mix, and inserts. Expanded header density is optional follow-up. |
| Static clip gain | V06, C03 | `MATCH` | Selected-clip line/handle, local drag preview, keyboard control, dB-amplitude waveform response, epoch cancellation, inspector agreement, and `set_clip_gain` commit. |
| Dynamic clip gain | V06, C03 | `MATCH/PARTIAL` | A clip-local gain line supports Grabber line-click creation, vertical gain and horizontal timing moves, accessible breakpoint nudge/delete, rollback, undo, persistence, duplication, and `write_clip_gain_curve`. The engine curve is independent of track volume and static clip gain. Per-segment waveform-amplitude redraw and packaged audible proof remain open, so this is not yet a full visual/native `MATCH`. |
| Automation Smart Tool | V07 plus Avid help | `MATCH` | Authoritative top-25/lower-75 classifier and Command/Control breakpoint tests. |
| Automation range/node editing | V07 | `MATCH` | Lower-band persistent range, upper-band trim preview, numeric Nudge, direct node move, and Option/Alt or Delete removal have focused component tests plus one serial Chromium before/during/after command trace. |
| Automation clipboard/Pencil | V07 | `MATCH` | ⌘C/⌘X/⌘V and the accessible right-click menu own the selected automation range, including native macOS Edit-menu forwarding; Control-drag writes a line and Control+Command-drag writes one ordered freehand segment, each previewed locally and committed once. |
| MIDI editor | V08 | `MATCH/PARTIAL` | Double-click opens the bottom piano roll/controller direction; multi-track editor selection needs deeper proof. |
| Inserts | V05, V11 | `ADAPTED` | Searchable catalog preserves load/open/bypass/remove/persistence behavior instead of copying nested menus. |
| Playlist comping | V10 | `DEFERRED` | Requires additive take/playlists project-model work. |
| Universe overview | V01 | `DEFERRED` | Revisit after session-critical editing; do not displace timeline height by default. |

## Parity definition

Mosh reaches functional parity when a Pro Tools-trained user can predict where a
control is, perform the documented action or shortcut, see equivalent state feedback,
and obtain the same editing result. This does not require Avid artwork, trademarks,
exact colors, or private pixel geometry. Rows marked `GAP`, `PARTIAL`, or `DEFERRED`
remain honest scope rather than being silently counted as parity.
