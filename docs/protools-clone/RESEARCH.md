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
| [Edit Tools](https://apps.avid.com/proToolsFirstHelp/version12.0/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.12.html) | Zoomer, Trimmer, Selector, Grabber, Scrubber, Pencil, and the multifunction Smart Tool form the editing tool set. | Linked Edit tools and Smart Tool figures. |
| [Timebase Rulers](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/Arr1.conductors.31.03.html) | Bars|Beats is tempo-relative. Minutes:Seconds is absolute. Rulers define timeline and edit selections. | Linked Bars|Beats and Minutes:Seconds ruler figures. The Avid glossary and reference guide also define Samples and Timecode timebases. |
| [Edit Window and Mix Window keyboard shortcuts](https://apps.avid.com/ProToolsFirstHelp/version2019.5/enu/keyshortcuts.6.10.html) | Space starts/stops. F1-F4 choose Shuffle, Slip, Spot, Grid. F5-F8 and F10 choose Zoomer, Trimmer, Selector, Grabber, Pencil. Tab locates the next transient when enabled and the next clip boundary when disabled. | Shortcut table, sections "Playback," "Edit Modes and Edit Tools," and "Edit Selection, Definition, and Navigation." |
| [Pro Tools Quick Tips: Edit Window](https://www.youtube.com/watch?v=3L_UeAZuSik) | Official Avid video tour showing the live hierarchy and density of the Edit Window. | Published 2022-04-26 by Avid Pro Tools. Review the toolbar/rulers opening view and the later list and lane demonstrations. No frames are copied. |

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
- Tab changes navigation target according to Tab to Transients. When transient data is unavailable in Mosh, a clip-boundary fallback is honest and matches the documented disabled behavior.

## Mosh adaptations and explicit non-claims

- The bottom status strip is a Mosh continuity affordance. No authoritative Avid status-bar contract was found, so it must not be presented as a pixel clone.
- The requested Classic theme uses a `#C0C0C0` base as a Mosh interpretation of older gray Pro Tools surfaces. It does not copy Avid textures, icons, logos, or artwork.
- Compact behavior will collapse or overlay supporting lists before shrinking the timeline below usability. This is a responsive adaptation for Mosh's WebView, not a claim about Pro Tools mobile behavior.
- Exact Spot dialog behavior, per-clip gain, and Memory Locations are intentionally outside this delivery.

## Design consequences

- Direction: dense operational editor, low visual variance, minimal decorative motion, strong tonal hierarchy.
- Signature: a dimensional two-tier editing toolbar above a ruler stack, with the left track controls visually locked to the scrolling lane field.
- Color story: charcoal surfaces (`#1E1E1E` through `#2D2D2D`), cool gray text (`#C0C0C0`), selection blue (`#4A90D9`), and grid gray (`#3A3A3A`).
- Asset rule: reuse Mosh's existing icon primitives and rendered clip content. Do not trace or reproduce Avid icons or branded graphics.
