# UI Reachability Ledger — the L3 lane of the DAW-parity program

*"We can do it in Mosh" means a producer with a mouse and keyboard can do it — not that a
MoshOps command exists (recording was native-complete and UI-unreachable for weeks; METER-001
was a missing toggle). This ledger maps each user-facing capability to its V3-shell
affordance and the e2e spec that exercises it. It is MACHINE-CHECKED: `ui/src/agent/reachability.test.ts`
parses this file and fails the cheap gate when a `reachable` row's selector no longer exists
in `ui/src/**`, a named spec is missing from `ui/e2e/`, or a `gap:` row references a backlog
item that has shipped (the row must then flip to `reachable`).*

*2026-11-23: V3 is the only shell. The rows were re-pointed at V3 when the Classic, v2, Live
and Pro Tools shells were retired (the old ledger is at tag `archive/shells-2026-11-23`).
Capabilities only those shells had a control for are `no-v3-ui`: the command is still
covered, through the bridge from a V3 boot, by the named spec, but a mouse-only V3 user cannot
reach it. Whether V3 gets each control is an owner decision
(`docs/SHELL-RETIREMENT-PLAN-2026-11-17.md` §4a).*

Row format (the guard parses these columns exactly):
- **status** — `reachable` (affordance exists), `gap:<backlog-id>` (agent/command-only; the
  backlog item is the affordance's ticket, its e2e spec ships as `test.fixme` = the
  definition of done), `no-v3-ui` (only a retired shell had the control; see above),
  `hardware` (needs a live device — owner runbook).
- **selector** — `testid:<data-testid>` (grepped in ui/src), `class:<className>` (grepped),
  or `role:<desc>` (not grepped — role/label-addressed controls).
- **spec** — the covering `ui/e2e/` file, or `—` (not spec-covered; the guard reports these
  as debt without failing).

| capability | commands | status | selector | spec |
|---|---|---|---|---|
| Clip fades (in/out + curve) | set_clip_fade | no-v3-ui | — | v3-clip-edit.spec.ts |
| Clip reverse | set_clip_reverse | no-v3-ui | — | v3-clip-edit.spec.ts |
| Clip normalize | normalize_clip | no-v3-ui | — | v3-clip-edit.spec.ts |
| Clip gain | set_clip_gain | no-v3-ui | — | v3-clip-edit.spec.ts |
| Clip gain curve / mute / rename | write_clip_gain_curve, set_clip_mute, rename_clip | no-v3-ui | — | — |
| Clip loop region | set_clip_loop | no-v3-ui | — | v3-clip-edit.spec.ts |
| Clip crossfade | set_clip_crossfade | no-v3-ui | — | — |
| Export (range / tail / format) | export_audio | reachable | testid:export-run | v3-session.spec.ts |
| Stem export | export_stems | reachable | testid:export-mode | v3-session.spec.ts |
| Master volume / pan | set_master_volume, set_master_pan | reachable | testid:master-strip | v3-tracks.spec.ts |
| Master plugin chain | load_master_builtin, bypass_master_plugin, remove_master_plugin | no-v3-ui | — | v3-tracks.spec.ts |
| Buses | create_bus | reachable | testid:v3-add-bus | v3-replay.spec.ts |
| Sends (add + level) | add_send, set_send_level | reachable | testid:v3-send-add | — |
| Send remove | remove_send | no-v3-ui | — | — |
| Track meters (per-track + master) | enable_track_meter | no-v3-ui | — | — |
| Warp / stretch (toggle, detect, fit-bars) | set_clip_warp, detect_clip_bpm, stretch_clip | no-v3-ui | — | v3-warp.spec.ts |
| Tempo / time-sig / metronome / key | set_tempo, set_time_signature, set_metronome, set_key | reachable | role:V3 top bar tempo + click, checklist key | — |
| Count-in | set_count_in | reachable | role:V3 top bar count-in select | — |
| Quantize (piano roll) | quantize_notes | reachable | testid:pr-quantize | v3-arrange-extra.spec.ts |
| Takes (switch + keep) | set_current_take, keep_take | no-v3-ui | — | — |
| Take region comp | promote_take_region | no-v3-ui | — | — |
| Record (transport, auto-arm) | set_transport, arm_track | reachable | testid:v3-record | v3-record.spec.ts |
| Per-track arm / input monitor / input picker | arm_track, set_input_monitor, set_track_input | reachable | role:V3 track header R button, Mix inspector input | v3-tracks.spec.ts |
| Automation (write mode + points) | set_track_automation_mode, write_automation_curve, add_automation_point, set_automation_point | no-v3-ui | — | v3-automation.spec.ts |
| Ripple delete | delete_time_range | no-v3-ui | — | v3-clip-edit.spec.ts |
| Group / ungroup tracks | create_group_track, ungroup_track | gap:G18 | — | — |
| Track colour / icon / reorder | set_track_color, set_track_icon, move_track | no-v3-ui | — | v3-track-ops.spec.ts |
| Live capture to a take (mic) | arm_track, stop_recording | hardware | — | — |

## Current debt (tracked)

- **G16** — automation surface: the write-arm control and the floating automation panel went
  with the retired shells, so V3 has neither (row `no-v3-ui`). The backlog item stands.
- **G18** — group/submix: `create_group_track` is reachable (`Mod+G` groups the whole
  selection, `menuActions.ts`), but `ungroup_track` has NO UI call site anywhere.
  Half-shipped, and the missing half is BLOCKED ON A DESIGN DECISION, not on effort:
  `ungroup_track` takes the GROUP's trackId, v2 filters group tracks out of the
  arrangement (`!t.isGroup`), and a member track carries no `groupId` in the snapshot — so
  there is currently no object on screen to hang the action on. Deciding where groups live
  in v2 (a mixer view? a collapsed lane? a header badge on members?) comes first; bolting
  an Ungroup onto something the producer cannot see would be worse than the gap.

CLOSED 2026-08-03 (verified against the code, not the ledger):

- **G15** — CLOSED by this branch. Per-track arm toggle in the track header
  (`v2-track-arm`, disabled with a written reason when no input is routed), the
  input-monitor control (`v2-input-monitor`, Inspector Mix tab), and the per-track
  AUDIO-input picker (`v2-track-input`) — the wave twin of the MIDI one, whose absence
  meant two sources could not reach two tracks, which is what multi-track recording means.
- **G17** — was ALREADY CLOSED and this ledger had not noticed: `v2-timerange-delete-ripple`
  in `TimeRangeBand.tsx` sends `delete_time_range {ripple:true}`, proven by
  `v2-timerange.spec.ts`. The row pointed at `v2-ripple-delete`, a testid guessed before
  the affordance was built and never reconciled with the one that shipped.
- **G19** — same story: `ExportControls.tsx` has a `mixdown | stems` mode select
  (`export-mode`) with a confirm gate. The row pointed at `export-stems-run`, which never
  existed.

The G17/G19 lesson is the one worth keeping: a ledger row that names a testid chosen
BEFORE the work is a prediction, and when the implementation picks a different name the row
silently keeps reading as a gap. Point rows at testids that exist, and re-verify a "gap"
against the code before trusting it.
- Spec debt (reachable, un-specced): tempo/time-sig/metronome/key topbar controls, count-in
  select, quantize buttons — candidates for a `topbar-project.spec.ts` in a later wave.
