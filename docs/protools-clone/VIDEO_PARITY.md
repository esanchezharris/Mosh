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

The titles and channel attribution for V01-V16 were rechecked through public
YouTube metadata on 2026-08-10. V01-V13 and V15-V16 report the author as
**Avid Pro Tools**, while V14 is published by Avid's verified corporate channel.

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
| V09 | [Track Views](https://www.youtube.com/watch?v=VyEEufPAZ5s) | 0:00 Track View selector; 0:04 audio Waveform; 0:11 automation; 0:21 Playlists; 0:26 instrument Clips/Notes; 0:40 Minus toggles audio Waveform/Volume; 0:53 Minus toggles instrument Clips/Notes; 0:56 automation-lanes disclosure. |
| V10 | [Playlist Comping](https://www.youtube.com/watch?v=8X3KQ3Cq8Co) | 0:00 comping definition; 0:12 vocal takes in separate playlists; 0:22 audition/select best parts into a comp; 0:28 word/syllable swaps; 0:33 guitar/drum use. Full-window frames show a main comp lane above aligned, waveform-bearing playlist rows. |
| V10B | [Pro Tools Tech Tips: Playlist Comping](https://www.youtube.com/watch?v=JnsKGu4ZqiU) | Official Avid visual corroboration: stacked vocal playlist lanes, timeline-aligned waveform alternatives, and assembled material in the main lane. It has music rather than useful narration, so V10 and Avid help remain the behavioral authority. |
| V11 | [Fast Start: Mixing Fundamentals](https://www.youtube.com/watch?v=MDcgJju4WOY) | 3:09 fader; 3:36 pan; 6:26 inserts; 7:23 existing vocal send; 7:28-7:48 several sources share one reverb return; 8:04 send selection; 8:08-8:13 send-fader increase; 8:22 shared-return CPU rationale; 8:32 mix bus; 9:02 mix-bus fader; 9:26 mix-bus inserts. |
| V12 | [Zoom](https://www.youtube.com/watch?v=hyPdxSg48M0) | 0:00 Zoom cluster; 0:05 horizontal controls; 0:11 Option/Alt-scroll; 0:18 R/T out/in with Edit Keyboard Focus; 0:28 presets 1-5; 0:35 Command/Control-click stores a preset; 0:41 lower scrollbar controls; 0:44 separate audio-waveform and MIDI-note vertical zoom. Full-window frames place the compact Zoom cluster between Edit Modes and Edit Tools. |
| V13 | [How to Use Memory Locations in Pro Tools](https://www.youtube.com/watch?v=0jC0h3AgC1g) | 0:20 add on Marker ruler; 0:27 multiple rulers; 0:41 keypad Enter; 1:00 ruler/list recall; 1:06 edit; 1:08 Option/Alt-delete; 1:13 stored selections/zoom/track visibility; 1:30 period-number-period exact recall; 1:37 period plus/minus stepping; 1:57 last-location recall; 2:14 chronological following; 2:42 filtering. Frames show a dark floating table over the Edit Window while marker rulers remain visible. |
| V14 | [Pro Tools 2018: Comp Together the Best Takes](https://www.youtube.com/watch?v=AEd0g84Ajz0) | 0:12 designate a target playlist in Waveform view; 0:16 send clip selections to it; 0:21 selector-menu and row target controls; 0:28 keyboard assignment; 0:33 cycle alternate takes and move/copy the best selection; 0:46 grouped drums/background vocals; 0:56 blue/orange target-state feedback; 1:06 cycle audio inside a clip selection; 1:13 audition a phrase while the surrounding comp remains visible; 1:24 original-audio feedback. This is the authority for Mosh's implemented Main-target selection cycle and the remaining arbitrary-target/group-comping gap. |
| V15 | [Fast Start — Chapter 5: Recording Vocals](https://www.youtube.com/watch?v=lAyDlRVwIwo) | 8:15 preserve the earlier performance while replacing the end; 8:25 pre-roll prepares the punch; 8:42 starting without context is jarring; 8:52 enable Pre-Roll; 8:59 a yellow pre-roll flag appears; 9:01 drag the flag to choose playback start; 9:08 playback starts at the flag while capture waits for the edit cursor; 9:17 the vocalist hears context and sings into the punch; 9:25 disable Dynamic Transport; 9:38 record the replacement. |
| V16 | [Pro Tools Quick Tips: Pre-Roll](https://www.youtube.com/watch?v=pfkpfIZcffs) | 0:00 pre-roll is a duration before a playback or recording start; 0:10 it gives the performer a cue; 0:14 overdubs and punch-ins are named uses; 0:17 edit the Transport pre-roll field; 0:22 enter a value; 0:27 the illuminated button confirms enabled state; 0:33 the button toggles it later; 0:38 its timebase follows the session. |
| V17 | [Fast Start — Chapter 4: Song Arrangement](https://www.youtube.com/watch?v=JuIzAVqrBl0) | 6:43 Slip mode permits a cut away from the grid; 6:56 zoom in to find the exact edit; 7:10 return to Grid; 8:02 choose the cursor/Selector; 8:04-8:08 drag a multi-track song section before acting on it. The full-window frame keeps the selection aligned to the ruler grid and visible across stacked lanes. |

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
| C07 | [OBEDIA: Link Timeline and Edit Selection](https://www.youtube.com/watch?v=vguoqEGS80k) | 1:01 linked state enabled; 1:04-1:16 a clip selection mirrors into the Timeline; 1:22 playback follows that span; 1:56 disable linking; 2:02 retain a clip selection while separately dragging a ruler selection over empty timeline; 2:48 recommends linked operation; 2:58 drag then play the intended span. This corroborates, but does not override, Avid's Timeline Selections help. |
| C08 | [OBEDIA: Edit Selection and Navigation](https://www.youtube.com/watch?v=_CiP7qsJIEg) | The tutorial distinguishes Timeline playback/record scope from Edit scope, demonstrates their link control, and identifies independent playback points while unlinked. It corroborates the separate view-state model and keyboard-accessible toggle; Avid help and menu documentation remain authoritative. |

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

## Tutorial parity packet

Each video-backed slice must leave one compact packet that a later reviewer can rerun:

| Field | Required evidence |
|---|---|
| Authority | Official Avid URL and current help-page link; third-party material is corroboration only. |
| Reference state | Version/date, full-window timestamp, viewport/crop, visible panels, selected track/clip, edit mode/tool, zoom, and keyboard-focus state. |
| Visual contract | Ordered zones, normalized geometry, control/state visibility, and any deliberate Mosh adaptation; never copied pixels or artwork. |
| Behavior contract | Given/When/Then with pointer and keyboard paths, intermediate feedback, cancellation, and final edit result. |
| Mutation seam | Exact `store.exec(command, args)` call, result-envelope handling, undo/redo, JSONL, replay, lock scope, and save/reload expectations. |
| Proof | Focused unit/component test, one real Chromium three-state trace, fresh 1440×900 and 720×720 captures, and a native test whenever audio, persistence, or Tracktion behavior is claimed. |
| Verdict | `MATCH`, `ADAPTED`, `PARTIAL`, `GAP`, `CONFLICT`, or `DEFERRED`, with residual gaps named in the same row. |

The source video is evidence, not the oracle by itself: current Avid documentation wins
on behavior, and Mosh passes only when the observable editing outcome and state feedback
match. Literal video-frame pixel diffs remain invalid because presenter crop, scaling,
compression, and Pro Tools version can change independently of the workflow.

## Pro Tools parity ledger

| Area | Evidence | Status | Mosh proof / next action |
|---|---|---|---|
| Edit Window zones | V01, V05, C01 | `MATCH` | `?shell=protools` Chromium zones test; fresh wide/compact producer-flow captures. |
| Edit modes/tools | V01, V02, C02 | `MATCH` | F1–F10 Chromium state proof and Smart Tool classifier tests. |
| Edit / Timeline selection | V02, V17, C07-C08 plus Avid Timeline Selections and Menus help | `MATCH/ADAPTED/PARTIAL` | Selector or Smart Tool drag in any visible timebase ruler, existing clip material, or empty primary-lane space writes the linked UI-local span by default. The labelled Link T/E toolbar control and Shift+/ shortcut can split that span: ruler gestures then own the Pro Tools-local Timeline playback/record range, clip/lane gestures keep the shared Edit range, and Punch consumes only the Timeline range. Unlinking clones the current Edit span; relinking makes the current Edit span authoritative without an engine command. Grid uses the active piecewise musical grid, Option/Alt temporarily bypasses it, and Slip remains exact. The Main Timebase ruler shows original blue boundary markers (record-red while any track is armed), while one continuous Edit band covers every lane. Shift+Arrow/Home/End is an accessible Mosh adaptation. Focused state/component tests prove defaults, project reset, pointer ownership, cancellation, keyboard control, independent Punch routing, and no edit command; serial one-worker Chromium proves divergent spans and Shift+/ relinking in fresh 1440x900 and 720x720 captures. Draggable selection-marker handles, direct counters, selected-track-only scope, and conductor-track Option/Alt semantics remain gaps. |
| Zoom navigation and media scaling | V12 plus Avid Zoomer/zoom-controls help | `MATCH/ADAPTED` | An original compact cluster sits between Edit Modes and Edit Tools; −/+, R/T with timeline focus, Option/Alt-wheel, and project-scoped presets 1-5 preserve a centered time anchor. Independent A−/A+ waveform and M−/M+ MIDI-note controls scale the two canvas families without changing clip gain, notes, or the command trace. F5 Zoomer click/drag previews and fits a time range, cancels on pointer cancellation or project replacement, and changes no project data. Repeated F5 toggles Normal/Single Zoom; the visible `1×` mode restores the exact previous Edit Tool or Smart Tool after one completed pointer or keyboard zoom. The lower-right control family mirrors horizontal zoom and proportionally scales every track header, primary lane, playlist row, and automation row through four bounded view-only levels. Focused Chromium proves Smart Tool restoration, both zoom axes, locked header/lane geometry, and increased waveform and MIDI/drum canvas ink at 200% versus 50%. The percentage readouts are accessible Mosh adaptations of Avid's graphical controls. |
| Memory Locations | V13 | `MATCH/PARTIAL` | The Marker ruler and nonmodal list use persisted beat-anchored annotations with chronological numbering, current-playhead add, direct recall, double-click/edit, Option/Alt-remove, name/number search, numeric-keypad Enter, period-number-period exact recall, and period plus/minus stepping. Creation/edit/removal/navigation stay on `create_annotation`, `edit_annotation`, `remove_annotation`, and `set_transport`, so undo, save/reload, JSONL, and multiplayer behavior remain canonical. Focused component tests cover modal focus/project invalidation; serial Chromium captures the wide floating table and compact full-width sheet. Multiple marker rulers, track markers, stored edit selections/zoom/track visibility, advanced filters/manage/import, and independently stored slot numbers remain gaps. |
| Recording/routing | V03, V04, V05 | `MATCH/ADAPTED` | Producer flow asserts unassigned/Auto/disarmed, routed/Monitor In/armed, active record, stopped take, and command trace. Track inspector replaces the full I/O matrix. |
| Punch / pre-roll | V15, V16 plus Avid Pre/Post-Roll and QuickPunch help | `ADAPTED/PARTIAL` | The transport exposes a persistent 0/1/2-bar engine pre-roll and a visible Punch state. A Smart Tool/Selector Edit selection becomes Tracktion's in/out range through `set_transport {loop:false, loopStart, loopEnd}` before `set_record_options {punchInOut:true}`; loop playback is explicitly disabled because the engine refuses simultaneous loop and punch recording. The timeline renders original PRE/PUNCH IN/OUT feedback. Focused browser proof covers ordering, refusal, error propagation, and project replacement; audible cue/capture boundaries still require native physical-device proof. Arbitrary pre/post-roll numeric entry, post-roll, movable play-start flag, Dynamic Transport, and instantaneous QuickPunch remain gaps. |
| Track controls | V03, V05, V11 | `ADAPTED` | Header exposes select/arm/solo/mute and actual output; inspector owns deeper routing, mix, and inserts. Expanded header density is optional follow-up. |
| Static clip gain | V06, C03 | `MATCH` | Selected-clip line/handle, local drag preview, keyboard control, dB-amplitude waveform response, epoch cancellation, inspector agreement, and `set_clip_gain` commit. |
| Dynamic clip gain | V06, C03 | `MATCH/PARTIAL` | A clip-local gain line supports Grabber line-click creation, vertical gain and horizontal timing moves, accessible breakpoint nudge/delete, rollback, undo, persistence, duplication, and `write_clip_gain_curve`. The shared waveform canvas applies static plus interpolated dynamic gain per horizontal sample, including local drag preview; focused Chromium reads the canvas and proves its pixel span expands after a boost. Packaged audible proof and non-linear curve-shape visualization remain open, so this is not yet a native `MATCH`. |
| Automation Smart Tool | V07 plus Avid help | `MATCH` | Authoritative top-25/lower-75 classifier and Command/Control breakpoint tests. |
| Automation range/node editing | V07 | `MATCH` | Lower-band persistent range, upper-band trim preview, numeric Nudge, direct node move, and Option/Alt or Delete removal have focused component tests plus one serial Chromium before/during/after command trace. |
| Automation clipboard/Pencil | V07 | `MATCH` | ⌘C/⌘X/⌘V and the accessible right-click menu own the selected automation range, including native macOS Edit-menu forwarding; Control-drag writes a line and Control+Command-drag writes one ordered freehand segment, each previewed locally and committed once. |
| Track Views | V09 plus Avid Track View help | `MATCH/PARTIAL` | Each header has a contextual Waveform/Playlists/Volume or Clips/Notes selector; the selected track follows the main-keyboard Minus toggle; Waveform/Clips use the full row by default, Volume is a full-height mixer-fader automation view, and the disclosure button adds a secondary Volume lane. Multiple simultaneous automation lanes, Warp, and direct inline note editing remain explicit follow-ups. |
| MIDI editor | V08 | `MATCH/PARTIAL` | Double-click opens the bottom piano roll/controller direction; multi-track editor selection needs deeper proof. |
| Inserts | V05, V11 | `ADAPTED` | Searchable catalog preserves load/open/bypass/remove/persistence behavior instead of copying nested menus. |
| Sends / Aux returns | V11 plus Avid Sends help | `ADAPTED/PARTIAL` | A source track can create a named Aux, assign/remove a post-fader send, edit its level, open/rename/delete the return, and use the return's fader, pan, output, and insert rack. Focused Chromium proves `create_bus`, `load_builtin`, `add_send`, and `set_send_level` in one trace at wide and compact sizes. Mosh currently has post-fader sends only; pre-fader switching, send mute/pan/automation, a dedicated Mix Window, and native audible proof remain gaps. |
| Playlists / comping | V10, V10B, V14 plus Avid alternate-take help and 2018.1 release notes | `MATCH/ADAPTED/PARTIAL` | Audio Track View expands the locked header/lane pair into a main clip row plus aligned waveform-bearing playlist rows. Lazy `list_takes` preserves per-take descriptions/peaks; clicking a row sends undoable `set_current_take` for whole-take audition. Dragging a non-current waveform selects a timeline range and exposes an accessible `↑ Main` promotion; Shift+Enter/Space selects the full clip without a pointer. In Waveform view, a Smart Tool/Selector range exposes `Target: Main`, previous/current/next state, and Command/Control+Shift+Up/Down cycling. Each cycle sends the exact bounded `promote_take_region` call, reselects the returned middle segment, preserves the surrounding comp, and cancels on Escape, pointer cancellation, or project replacement. The command validates a wave-only in-bounds range, copies the complete take tree through Tracktion splits, switches only the middle segment, returns recovery-rebindable ids, and records the edit as one undoable/replayable/clip-locked transaction. Focused mock/component tests prove take-index wrap, errors, stale responses, a Take 1 / Take 2 / Take 1 three-segment comp, undo/redo, JSONL, and snapshot immutability. Serial one-worker Chromium proves record → range → previous/next cycle with exact command envelopes and fresh 1440×900/720×720 captures. A compiled native selftest covers direct-file preservation plus undo/redo and awaits the canonical serial native gate, so native playback is not claimed by this slice yet. Mosh fixes the first target to Main and uses explicit text rather than copied Avid art or color semantics. Arbitrary target designation, copy-versus-move choice, atomic grouped-track comping, playlist ratings, and named playlist management remain gaps. |
| Universe overview | V01 | `DEFERRED` | Revisit after session-critical editing; do not displace timeline height by default. |

## Parity definition

Mosh reaches functional parity when a Pro Tools-trained user can predict where a
control is, perform the documented action or shortcut, see equivalent state feedback,
and obtain the same editing result. This does not require Avid artwork, trademarks,
exact colors, or private pixel geometry. Rows marked `GAP`, `PARTIAL`, or `DEFERRED`
remain honest scope rather than being silently counted as parity.
