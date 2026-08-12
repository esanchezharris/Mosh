# Pro Tools tutorial parity audit — 2026-08-10

Base: `f900934d` (`origin/main` after PR #639)

Updated 2026-08-11 on `codex/protools-sa3-tutorial-parity`: the send-control,
automation, and final-branch-meter slice is complete. This pass reranks only the
remaining tutorial-backed behavior and separately records a Mosh-specific Re-imagine
reachability defect. Native audible routing, physical QuickPunch, and real-SA3 output
remain deliberately unclaimed.

This is a behavior audit of the V01–V20 catalog in
[`VIDEO_PARITY.md`](./VIDEO_PARITY.md), not a pixel-clone claim. Avid documentation
defines behavior; official Avid tutorials demonstrate operator sequence and visible
feedback. Mosh has no locally installed Pro Tools reference, so browser evidence proves
Mosh behavior only. No tutorial media or proprietary asset is stored in the repository.

## Result

The core producer path is covered: Edit/Mix navigation, routing and recording, static
and dynamic clip gain, fades, automation, playlists, inserts, sends/Aux returns, Memory
Locations, MIDI editing, groups, zoom, and session actions. The send slice no longer
occupies the implementation queue. Remaining tutorial gaps are deeper recording,
comping, automation, and source-handle contracts rather than missing top-level chrome.

| Rank | Tutorial-backed gap | Producer value | Existing safe seam | Decision |
|---:|---|---|---|---|
| 1 | QuickPunch plus arbitrary pre/post-roll and a movable play-start flag (V15/V16). | Very high for overdubs and vocal punch workflows. | Bounded Punch, count-in, transport ranges, and the frozen additive contract. | **Next native priority, not a shell simulation.** [`QUICKPUNCH_PREPOST_CONTRACT.md`](./QUICKPUNCH_PREPOST_CONTRACT.md) defines continuous-source recording, state, commands, recovery, locks, accessibility, and guarded physical-device acceptance. |
| 2 | Arbitrary playlist targets and atomic grouped-track comping (V10/V14). | High for vocals and phase-aligned multitrack drums. | `promote_take_region` currently targets Main on one track; Track Groups already carry stable membership. | Add one atomic multi-track promotion command only after source-range, recovery-id, lock, and undo semantics are frozen. |
| 3 | Multiple simultaneous automation lanes plus independent MIDI-editor modes/tools (V07–V09). | Medium-high for detailed mix and MIDI editing. | Primary/secondary generic automation lanes and the shared docked Piano Roll exist. | Extend the lane model without duplicating command ownership; keep one explicit MIDI edit target until multi-target writes are defined. |
| 4 | Direct crossfade resize/nudge, source-handle placement, and audition (C04/C04B). | Medium-high for dialogue and vocal comp cleanup. | Persisted fades, overlap-aware crossfades, remembered defaults, and timeline handles. | Define hidden-source bounds and audition ownership first; never imply Pre/Centered/Post when media handles cannot support it. |
| 5 | Full Memory Location properties: arbitrary slot numbers, pre/post-roll, advanced filters, and import (V13). | Medium navigation and recall gain. | Persisted annotation metadata plus safe UI-local recall. | Add only properties with a durable project contract; keep imported/current-Pro-Tools formats out until mapped explicitly. |
| 6 | Expanded send/mix variants: A–J banks, follow-main-pan, mono/stereo format controls, narrow/wide strips, VCA/HEAT/EQ/delay compensation, and floating windows (V11/V20). | Medium; useful in larger mixes but below recording/comping. | Sends A–E, one stereo balance, Edit/Mix banks, real meters, and supported engine concepts. | Preserve explicit partial parity and add modeled behaviors incrementally; do not draw inert controls for unsupported engine concepts. |

## Mosh-specific session-readiness finding: direct Re-imagine reachability

This is not an Avid tutorial-parity item. It is a Mosh workflow defect found while
checking whether the Pro Tools shell can remain the producer's primary surface:

- The shared `GenDrawer` already owns Compile, truthful SA3/preview selection,
  Re-imagine amount, colors, LoRA, Render, Live, A/B, Freeze, Reset, seed, and
  layer removal through existing MoshOps commands.
- Before this branch, Pro Tools exposed only the free-form Ask Moshi composer; the
  direct rack was mounted by other shells and could not be reached from the Pro Tools
  Edit Window.
- This branch adds one nonmodal, keyboard-reachable toolbar drawer around that shared
  component. It resolves the current selected clip without snapshot mutation, closes
  on project replacement, and cannot overlap Ask Moshi.
- Mock Chromium can prove the exact `create_render_layer`/`render_layer` envelopes and
  honest engine badge. It cannot prove that a configured Stable Audio 3 service rendered
  useful or audible audio; that remains a separate guarded native/service acceptance lane.

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
