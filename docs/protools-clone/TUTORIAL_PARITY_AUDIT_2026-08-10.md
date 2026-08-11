# Pro Tools tutorial parity audit — 2026-08-10

Base: `ce1a33d2` (`origin/main` after PR #637)

This is a behavior audit of the V01–V20 catalog in
[`VIDEO_PARITY.md`](./VIDEO_PARITY.md), not a pixel-clone claim. Avid documentation
defines behavior; official Avid tutorials demonstrate operator sequence and visible
feedback. Mosh has no locally installed Pro Tools reference, so browser evidence proves
Mosh behavior only. No tutorial media or proprietary asset is stored in the repository.

## Result

The core producer path is covered: Edit/Mix navigation, routing and recording, static
and dynamic clip gain, fades, automation, playlists, inserts, sends/Aux returns, Memory
Locations, MIDI editing, groups, zoom, and session actions. Remaining gaps are variants
or deeper native contracts rather than missing top-level surfaces.

| Rank | Tutorial-backed gap | Producer value | Existing safe seam | Decision |
|---:|---|---|---|---|
| 1 | The no-dialog fade shortcut still uses a fixed 10 ms Linear preset instead of the last selected Fades settings. Avid's current Shortcuts Guide says Command+Control+F uses the last selected fade shape; C04/C04B establish the repeated edit workflow. | High for vocal cleanup and comp edits because it removes repeated modal setup. | `set_clip_fade`, `buildProToolsFadePlan`, schema-backed UI preferences. | **Implement now.** Persist the last successfully applied length and In/Out shapes; use them for the existing shortcut. Length persistence is a labelled Mosh adaptation because current Mosh fades do not extend hidden source handles from an arbitrary selection. |
| 2 | QuickPunch plus arbitrary pre/post-roll and a movable play-start flag (V15/V16). | Very high for overdubs. | Only `set_count_in` 0/1/2 bars and bounded Punch exist. | Defer to a native recording slice with physical-device proof; shell-only simulation would be unsafe. |
| 3 | Send mute, pre-fader switching, pan, and automation (V11/V20). | High for effect A/B and cue mixes. | Snapshot already exposes send mute; only level/add/remove commands ship. | Next engine-backed mixing slice. Add commands, undo/locks/mock coverage, and audible routing proof together. |
| 4 | Arbitrary playlist targets and atomic grouped-track comping (V10/V14). | High for vocals and multitrack drums. | `promote_take_region` targets Main on one track. | Defer until one atomic multi-track command can preserve alignment, locks, recovery ids, and undo. |
| 5 | Memory Locations recalling edit selection, zoom, and track visibility (V13). | Medium-high navigation gain. | Annotations persist marker identity/time only; view state is shell-local. | Requires additive marker metadata plus save/reload and multiplayer tests. |
| 6 | Multiple automation lanes and independent MIDI-editor modes/tools (V07–V09). | Medium; important in advanced editing, not session-blocking. | One Volume lane and the shared docked Piano Roll exist. | Split into automation-target and MIDI-editor lanes after the audio-first gaps. |
| 7 | Mix narrow/wide modes, floating windows, VCA/HEAT/EQ/delay-compensation panels (V20). | Medium; improves density and specialized mixing. | Main Mix bank is complete for Mosh-supported track types. | Keep explicit partial parity; do not draw inert controls for engine concepts Mosh does not model. |

## Implemented packet: remembered Default Fade settings

- **Authority:** [Avid Pro Tools Shortcuts 2025.10](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Shortcuts_2025.10.pdf) documents Command+F and the no-dialog shortcut using the last selected fade shape. [Avid Smart Tool help](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.39.html) says Smart Tool fades use Default Fade Settings.
- **Before:** fresh settings resolve to 10 ms, Linear In, Linear Out; a successful Fades dialog operation may choose another valid length and shapes.
- **During:** dialog drafts remain local. Invalid input, command rejection, Escape, or project replacement does not replace the remembered preset.
- **After:** only a successful apply stores the three UI-local preferences. Command+Control+F reads them and sends the same `set_clip_fade` plan through `store.exec`; snapshots are never mutated.
- **Adaptation:** Mosh remembers edge length with the shapes because its safe existing-overlap model does not expose Pro Tools' source-handle extension. It does not claim Fade Settings file import/export, audition, or exact Avid preset geometry.
