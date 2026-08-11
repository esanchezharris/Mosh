# Pro Tools tutorial parity audit — 2026-08-10

Base: `256f19bf` (`origin/main` after PR #638)

Updated 2026-08-11 on `codex/protools-send-automation-meters`: the selected
mixing follow-up now has native source/self-test, focused UI, and serial Chromium
evidence. Native audible routing and physical QuickPunch remain deliberately unclaimed.

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
| 2 | QuickPunch plus arbitrary pre/post-roll and a movable play-start flag (V15/V16). | Very high for overdubs. | Only `set_count_in` 0/1/2 bars and bounded Punch exist. | **Contract complete; native work deferred.** [`QUICKPUNCH_PREPOST_CONTRACT.md`](./QUICKPUNCH_PREPOST_CONTRACT.md) freezes additive state/commands, continuous-source semantics, accessibility, recovery, locks, and the guarded physical-device matrix. Shell-only simulation remains prohibited. |
| 3 | Send mute, pre-fader switching, pan, automation, and metering (V11/V20). | High for effect A/B and cue mixes. | AuxSend's real parameter/graph seam plus the existing 30 Hz level rail. | **Implemented; native audible proof pending.** Level, Pan, and Mute are generic automation targets addressed from the physical AuxSend plug-in. Edit and Mix show its final delivered stereo branch. Native self-test, focused UI tests, and serial Chromium cover persistence, addresses, lifecycle, accessibility, and visible response; a physical output trace remains required before audible parity is claimed. |
| 4 | Arbitrary playlist targets and atomic grouped-track comping (V10/V14). | High for vocals and multitrack drums. | `promote_take_region` targets Main on one track. | Defer until one atomic multi-track command can preserve alignment, locks, recovery ids, and undo. |
| 5 | Memory Locations recalling edit selection, zoom, and track visibility (V13). | Medium-high navigation gain. | Persisted annotations plus shell-local selection/zoom/visibility state. | **Implemented.** Additive nested metadata is validated, undoable, save/reload-safe, replayable, and multiplayer-broadcast; recall is result- and epoch-gated and filters deleted tracks. Focused native/mock/component and serial Chromium evidence cover the contract. |
| 6 | Multiple automation lanes and independent MIDI-editor modes/tools (V07–V09). | Medium; important in advanced editing, not session-blocking. | One Volume lane and the shared docked Piano Roll exist. | Split into automation-target and MIDI-editor lanes after the audio-first gaps. |
| 7 | Mix narrow/wide modes, floating windows, VCA/HEAT/EQ/delay-compensation panels (V20). | Medium; improves density and specialized mixing. | Main Mix bank is complete for Mosh-supported track types. | Keep explicit partial parity; do not draw inert controls for engine concepts Mosh does not model. |

## Implemented packet: remembered Default Fade settings

- **Authority:** [Avid Pro Tools Shortcuts 2025.10](https://resources.avid.com/SupportFiles/PT/Pro_Tools_Shortcuts_2025.10.pdf) documents Command+F and the no-dialog shortcut using the last selected fade shape. [Avid Smart Tool help](https://apps.avid.com/proToolsFirstHelp/version12.3/enu/Pro%20Tools%20First%20Help/ed2.ModesTools.24.39.html) says Smart Tool fades use Default Fade Settings.
- **Before:** fresh settings resolve to 10 ms, Linear In, Linear Out; a successful Fades dialog operation may choose another valid length and shapes.
- **During:** dialog drafts remain local. Invalid input, command rejection, Escape, or project replacement does not replace the remembered preset.
- **After:** only a successful apply stores the three UI-local preferences. Command+Control+F reads them and sends the same `set_clip_fade` plan through `store.exec`; snapshots are never mutated.
- **Adaptation:** Mosh remembers edge length with the shapes because its safe existing-overlap model does not expose Pro Tools' source-handle extension. It does not claim Fade Settings file import/export, audition, or exact Avid preset geometry.

## Implemented packet: send control state

- `set_send_mute` preserves the remembered level rather than encoding mute as
  negative-infinity gain.
- `set_send_pan` balances only the copied stereo send branch; it does not move the
  source track pan.
- `set_send_pre_fader` reorders the send plug-in around the actual track fader, so
  its snapshot state reports engine placement rather than a cosmetic switch.
- The three commands are validated, undoable, replayable, JSONL-recorded, and
  track-locked. Browser evidence verifies Edit inspector and Mix strip agreement;
  a physical output trace is still required before audible parity is claimed.

## Implemented packet: send automation and final-branch meters

- Each assigned send exposes the real AuxSend plug-in index plus Level, Pan, and
  Mute parameter indices. The existing generic automation commands own every
  breakpoint, curve replacement, undo entry, replay record, and JSONL line.
- The Pro Tools Track View header offers ordered `Volume`, `<Bus> · Level`,
  `<Bus> · Pan`, and `<Bus> · Mute` targets. Removing a remembered send falls
  back to Volume; `projectEpoch` replacement clears target choices.
- A Tracktion `LevelMeasurer` wraps the final post-mute, post-pan, post-level send
  branch. The optional `levels.payload.sends` entries are keyed by track and bus;
  legacy track/master consumers retain their exact event shape.
- Edit and Mix meters read the ephemeral send map imperatively in one animation
  loop per mounted meter. They expose a non-focusable `meter` role and stereo
  dBFS text without a live region, so 30 Hz telemetry does not create React or
  screen-reader announcement churn.
- Serial Chromium proves moving stereo readings, all three exact generic command
  addresses, mute-to-floor behavior, removal fallback, and 720×720 reachability.
  This is Mosh/browser behavior evidence, not a claim that a physical Aux return
  was heard or calibrated against Pro Tools.

## Implemented packet: Memory Location view recall

- New/Edit offers opt-in Edit selection, horizontal Zoom, and Track visibility;
  marker-only locations retain their old payload.
- The nested annotation payload is normalized before native/mock mutation and
  persists through save/reload and Undo.
- Recall first awaits `set_transport`, checks `projectEpoch`, filters deleted track
  ids, and then restores the shell-local view without mutating the snapshot.
- The compact Memory Locations sheet remains keyboard reachable. Independently
  assigned slot numbers, advanced filtering/import, and pre/post-roll properties
  remain gaps.
