# Pro Tools Edit Window research

Research date: 2026-08-09

Scope: layout and interaction evidence for Mosh's additive `protools` shell. Pro Tools is not installed on this machine. This artifact records source links and figure references only. No Avid artwork, icons, screenshots, or other proprietary assets are copied into the repository.

## Primary Avid sources

| Source | Evidence used | Figure or frame reference |
|---|---|---|
| [Avid Pro Tools documentation hub](https://kb.avid.com/pkb/articles/en_US/user_guide/Pro-Tools-Documentation) | Current release index. The hub lists the Pro Tools 2026.4 Reference Guide and current release documentation. | Hub last updated 2026-04-28. Use the linked 2026.4 guide as the current authority when legacy help and current behavior differ. |
| [Pro Tools Reference Guide 2026.4](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Reference_Guide_2026.4.pdf) | Current reference guide for Edit Window, rulers, tracks, Clip List, Track List, modes, tools, and MIDI Editor behavior. | Use the Edit Window overview and the Edit Modes and Tools chapter. The file is linked rather than vendored. |
| [Introduction to Pro Tools](https://resources.avid.com/SupportFiles/PT/Intro_to_Pro_Tools.pdf) | The Edit Window is the timeline workspace. The top-to-bottom hierarchy is toolbar, rulers, tracks, and timeline. Track height is variable. Timebase choice controls the main scale and grid. | PDF page 6 (guide page 5), labeled Edit Window diagram. PDF page 10 (guide page 9), "Edit window after adding multiple new tracks." PDF page 11 (guide page 10), Main Counter, Timeline, and Timebase Rulers figures. PDF pages 29-30 (guide pages 28-29), Instrument and MIDI tracks in the Edit Window. |
| [Edit Window](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/sess2.windows.13.03.html) | The timeline displays audio, MIDI, and automation. Each track exposes record, solo, mute, and automation controls. Edit Window views are independently showable. | Linked "Pro Tools Edit window" figure on the page. |
| [Edit Window Toolbar Controls and Displays](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/sess2.windows.13.05.html) | Toolbar groups include Edit Modes, Edit Tools, counters and selection indicators, MIDI indicators, Grid, and Nudge. | Linked Edit mode buttons, Edit tools, and Edit window indicators figures. |
| [Edit Modes](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.02.html) | Shuffle, Slip, Spot, and Grid change clip/note placement and editing behavior. | Linked Edit mode buttons figure. |
| [Spotting Clips](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/Arr3.clips.33.13.html) | With Spot mode enabled, clicking an existing clip with the Grabber opens the Spot dialog. The dialog chooses a Time Scale, accepts a precise locate value, and moves the clip when confirmed. | Linked Spot dialog figure. Mosh uses the documented Start locate field; Sync Point, Original Time Stamp, and User Time Stamp require clip metadata Mosh does not expose. |
| [Edit Tools](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.12.html) | Zoomer, Trimmer, Selector, Grabber, Scrubber, Pencil, and the multifunction Smart Tool form the editing tool set. | Linked Edit tools and Smart Tool figures. |
| [The Smart Tool in Automation and Controller Views](https://apps.avid.com/protoolsfirsthelp/version12.3/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.42.html) | Selector owns the bottom 75% of an automation or controller view, Trim owns the top 25%, and Command/Control temporarily exposes the Grabber for breakpoint creation. | This authoritative split takes precedence over simplified “upper/lower half” narration in short tutorial videos and confirms Mosh's 25/75 classifier. |
| [Timebase Rulers](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/Arr1.conductors.31.03.html) | Bars|Beats is tempo-relative. Minutes:Seconds is absolute. Rulers define timeline and edit selections. | Linked Bars|Beats and Minutes:Seconds ruler figures. The Avid glossary and reference guide also define Samples and Timecode timebases. |
| [Edit Window and Mix Window keyboard shortcuts](https://apps.avid.com/ProToolsFirstHelp/version2019.5/enu/keyshortcuts.6.10.html) | Space starts/stops. F1-F4 choose Shuffle, Slip, Spot, Grid. F5-F8 and F10 choose Zoomer, Trimmer, Selector, Grabber, Pencil. Tab locates the next transient when enabled and the next clip boundary when disabled. | Shortcut table, sections "Playback," "Edit Modes and Edit Tools," and "Edit Selection, Definition, and Navigation." |
| [Pro Tools Quick Tips: Edit Window](https://www.youtube.com/watch?v=3L_UeAZuSik) | Official Avid video tour showing the live hierarchy and density of the Edit Window. | Published 2022-04-26 by Avid Pro Tools. Review the toolbar/rulers opening view and the later list and lane demonstrations. No frames are copied. |
| [Learn Pro Tools in 1 Hour](https://www.youtube.com/watch?v=2ywNbOLePOo) | Official current-version production walkthrough covering tracks, audio routing and recording, clip editing, inserts, mixing, buses, sends, and automation in one coherent session. | Review 10:25 clips, 22:27 audio recording, 31:48 arrangement/mix, 35:08 clip editing, 51:05 mixing, 56:06 inserts/dynamics, and 1:01:25 automation. |
| [Pro Tools Quick Tips: Recording Audio](https://www.youtube.com/watch?v=lG7JXfc8Hl8) | Track input/output, record mode, track and global record enable, edit-cursor placement, and Space/F12 recording behavior. | Review 0:00 routing, 0:25 record mode, 0:36 arming, and 0:46 record/stop. |
| [Pro Tools Quick Tips: I/O Setup](https://www.youtube.com/watch?v=U45vpVRYr38) | Hardware-dependent input/output paths, path naming/defaulting, and the routes made available to tracks. | Review 0:12 path grid, 0:40 path management, and 0:54 track outputs. Mosh adapts the workflow into track-level menus rather than cloning the full matrix. |
| [How to Use Clip Gain in Pro Tools](https://www.youtube.com/watch?v=-jQceBZ8tPI) | Current official evidence for static and dynamic clip gain: selected-clip control, visible gain line, waveform amplitude response, and breakpoint editing. | Review 0:16 selected-clip control, 0:42 dynamic gain, 0:58 gain line, and 1:04 breakpoints. Static inline feedback is the immediate Mosh parity target; dynamic gain is additive follow-up scope. |
| [Pro Tools Quick Tips: Editing Automation](https://www.youtube.com/watch?v=HjoNFBxyXYg) | Smart Tool selection/trim workflow, node nudge and movement, modifier deletion, and Pencil clutching. | Review 0:15 selection, 0:24 trim, 0:40 nudge, 0:45 node move, and 0:56 delete. Use the 25/75 help-page contract for exact hit geometry. |
| [Pro Tools Quick Tips: MIDI Editor](https://www.youtube.com/watch?v=FDqKlSMKCGw) | Double-click MIDI clip opening, independent tools/modes, vertical keyboard, controller/velocity lane, and multi-track editing. | Review 0:00 open behavior, 0:34 keyboard, 0:43 controller lane, and 0:51 Track List. This directly supports Mosh's bottom editor direction. |

## Reputable visual cross-check

| Source | Evidence used | Screenshot reference |
|---|---|---|
| [Emerson College: What's in the Edit Window?](https://support.emerson.edu/hc/en-us/articles/21708900503451-Whats-in-the-Edit-Window) | Independent instructional overview of the same layout, four modes, editing tools, rulers, Track List, and Clips List. Its full-window image is useful for checking density and dimensional dark headers. | [Edit_Window_DSF.jpg attachment](https://support.emerson.edu/hc/article_attachments/21708868709531), plus the Edit Modes, Ruler, Track List, and Clips List figures embedded in the article. |

## Evidence-backed layout contract

- A fixed Edit Window toolbar sits above the timeline and groups modes, tools, counters, Grid, and Nudge.
- One or more timebase rulers stack directly above the lanes. Mosh will expose Bars+Beats, Timecode, Minutes:Seconds, and Samples as independently toggleable rows.
- Track controls form a fixed-width column on the left. Track lanes extend and scroll horizontally to the right.
- Track heights vary. The header and lane for a track must remain vertically aligned while scrolling.
- Track List and Clip List are supporting navigation surfaces, not a Live-style content browser.
- The MIDI Editor can appear as a pane inside the Edit Window in addition to the track pane. Mosh's bottom editor is therefore consistent with documented Pro Tools structure.
- Smart Tool is contextual. Its pointer affordance and action must follow media type and pointer region rather than act as a cosmetic toggle.
- In Spot mode, activating a clip through its Grabber intent opens a modal placement surface instead of beginning a free drag. The placement value uses the selected Time Scale and commits the clip Start through the normal move command.
- Tab changes navigation target according to Tab to Transients. When transient data is unavailable in Mosh, a clip-boundary fallback is honest and matches the documented disabled behavior.

## Mosh adaptations and explicit non-claims

- The bottom status strip is a Mosh continuity affordance. No authoritative Avid status-bar contract was found, so it must not be presented as a pixel clone.
- The requested Classic theme uses a `#C0C0C0` base as a Mosh interpretation of older gray Pro Tools surfaces. It does not copy Avid textures, icons, logos, or artwork.
- Compact behavior will collapse or overlay supporting lists before shrinking the timeline below usability. This is a responsive adaptation for Mosh's WebView, not a claim about Pro Tools mobile behavior.
- The first Spot dialog slice supports precise Start placement in the four shell time scales. Timecode follows the shell's existing fixed 30 fps ruler until project timecode-rate metadata exists; Sync Point and timestamp recall remain explicit adaptations until Mosh exposes those fields additively.
- Static per-clip gain uses Mosh's existing `set_clip_gain` command and is behaviorally grounded by Avid's current Clip Gain walkthrough. Inline gain feedback must remain original Mosh DOM/CSS/canvas work; dynamic breakpoint gain and Memory Locations remain outside this delivery.

## Design consequences

- Direction: dense operational editor, low visual variance, minimal decorative motion, strong tonal hierarchy.
- Signature: a dimensional two-tier editing toolbar above a ruler stack, with the left track controls visually locked to the scrolling lane field.
- Color story: charcoal surfaces (`#1E1E1E` through `#2D2D2D`), cool gray text (`#C0C0C0`), selection blue (`#4A90D9`), and grid gray (`#3A3A3A`).
- Asset rule: reuse Mosh's existing icon primitives and rendered clip content. Do not trace or reproduce Avid icons or branded graphics.
