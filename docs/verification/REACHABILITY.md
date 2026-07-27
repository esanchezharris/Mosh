# UI Reachability Ledger — the L3 lane of the DAW-parity program

*"We can do it in Mosh" means a producer with a mouse and keyboard can do it — not that a
MoshOps command exists (recording was native-complete and UI-unreachable for weeks; METER-001
was a missing toggle). This ledger maps each user-facing capability to its v2-shell
affordance and the e2e spec that exercises it. It is MACHINE-CHECKED: `ui/src/agent/reachability.test.ts`
parses this file and fails the cheap gate when a `reachable` row's selector no longer exists
in `ui/src/**`, a named spec is missing from `ui/e2e/`, or a `gap:` row references a backlog
item that has shipped (the row must then flip to `reachable`).*

Row format (the guard parses these columns exactly):
- **status** — `reachable` (affordance exists), `gap:<backlog-id>` (agent/command-only; the
  backlog item is the affordance's ticket, its e2e spec ships as `test.fixme` = the
  definition of done), `hardware` (needs a live device — owner runbook).
- **selector** — `testid:<data-testid>` (grepped in ui/src), `class:<className>` (grepped),
  or `role:<desc>` (not grepped — role/label-addressed controls).
- **spec** — the covering `ui/e2e/` file, or `—` (reachable but not yet spec-covered; the
  guard reports these as debt without failing).

| capability | commands | status | selector | spec |
|---|---|---|---|---|
| Clip fades (in/out + curve) | set_clip_fade | reachable | testid:v2-clip-fadein | clip-edit-fades.spec.ts |
| Clip reverse | set_clip_reverse | reachable | testid:v2-clip-reverse | clip-edit-fades.spec.ts |
| Clip normalize | normalize_clip | reachable | testid:v2-clip-normalize | clip-edit-fades.spec.ts |
| Clip gain / mute / rename | set_clip_gain, set_clip_mute, rename_clip | reachable | testid:v2-clip-gain | clip-edit-fades.spec.ts |
| Clip loop region | set_clip_loop | reachable | testid:v2-clip-loop | clip-edit-fades.spec.ts |
| Clip crossfade | set_clip_crossfade | reachable | testid:v2-clip-crossfade | clip-edit-fades.spec.ts |
| Export (range / tail / format) | export_audio | reachable | testid:export-run | export-dialog.spec.ts |
| Stem export | export_stems | gap:G19 | testid:export-stems-run | export-dialog.spec.ts |
| Master volume / pan | set_master_volume, set_master_pan | reachable | testid:v2-master-volume | master-bus.spec.ts |
| Master plugin chain | load_master_builtin, bypass_master_plugin, remove_master_plugin | reachable | testid:v2-master-add-plugin | master-bus.spec.ts |
| Sends / buses | create_bus, add_send, set_send_level, remove_send | reachable | testid:v2-add-bus | master-bus.spec.ts |
| Track meters (per-track + master) | enable_track_meter | reachable | class:v2-meter | master-bus.spec.ts |
| Warp / stretch (toggle, detect, fit-bars) | set_clip_warp, detect_clip_bpm, stretch_clip | reachable | testid:v2-warp-toggle | warp.spec.ts |
| Tempo / time-sig / metronome / key | set_tempo, set_time_signature, set_metronome, set_key | reachable | role:topbar proj-meta inputs | — |
| Count-in | set_count_in | reachable | role:topbar count-in select | — |
| Quantize (piano roll / MIDI tab) | quantize_notes | reachable | testid:v2-open-pianoroll | — |
| Takes (switch + keep) | set_current_take, keep_take | reachable | role:inspector Takes tab (dynamic testid v2-insp-tab-takes) | record-arm.spec.ts |
| Record (transport, auto-arm) | set_transport, arm_track | reachable | testid:v2-record | record-arm.spec.ts |
| Per-track arm / input monitor / input picker | arm_track, set_input_monitor, set_track_input | gap:G15 | testid:v2-track-arm | record-arm.spec.ts |
| Automation editing in v2 (write-arm + lanes) | set_track_automation_mode, write_automation_curve, add_automation_point | gap:G16 | testid:v2-automation-arm | automation-write.spec.ts |
| Automation point editing (classic shell) | add_automation_point, set_automation_point | reachable | testid:open-automation | polish.spec.ts |
| Ripple delete | delete_time_range | gap:G17 | testid:v2-ripple-delete | ripple-delete.spec.ts |
| Group / ungroup tracks | create_group_track, ungroup_track | gap:G18 | testid:v2-group-tracks | ripple-delete.spec.ts |
| Live capture to a take (mic) | arm_track, stop_recording | hardware | — | — |

## Current debt (tracked)

- **G15** — v2 per-track record affordances: arm toggle, input-monitor control, per-track
  audio-input picker. Native `arm_track`/`set_input_monitor`/`set_track_input` are complete;
  the transport `v2-record` auto-arm fallback works but a producer cannot choose WHICH
  track records, monitor the input, or see armed state per track.
- **G16** — v2 automation surface: the classic shell's automation panel never made it into
  the v2 Inspector; write-mode exists natively (#414) with no v2 arm control or lane view.
- **G17** — ripple delete shipped natively (#424/#425) with no UI affordance (no modifier,
  no menu item).
- **G18** — group/submix tracks shipped natively (Wave D: `create_group_track`/`ungroup_track`)
  with no UI affordance.
- **G19** — stem export shipped natively (#410) but ExportControls has no stems action —
  `export_stems` is agent-only (found by this ledger's authoring pass).
- Spec debt (reachable, un-specced): tempo/time-sig/metronome/key topbar controls, count-in
  select, quantize buttons — candidates for a `topbar-project.spec.ts` in a later wave.
