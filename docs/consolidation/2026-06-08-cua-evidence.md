# ClaudeMosh CUA Evidence - 2026-06-08

## Consolidated UI Inspection

Launch: `open -n build/Mosh_artefacts/Debug/Mosh.app --args --demo6`

CUA identified bundle `studio.mosh.app` with the `Mosh` window and WebView URL
`juce://juce.backend/`.

Visible/accessibility-backed surfaces:
- Transport buttons: Play, return-to-start, loop.
- Topbar: time readout, reserved `B-5`, export, theme toggle.
- Arrangement toolbar: add track/test tone/MIDI, move/split/snap, zoom, undo/redo, save/reload.
- Track headers and mixer controls: Drums, Gtr, Pad with mute/solo and volume sliders.
- Arrangement clips: tone clips with render-layer markers.
- Chain panel: hosted plugin card and plugin/neural/MIDI add buttons.
- Generative panel: fake adapter, NL slider, Lab, seed, Render, disabled Accept/Reject.

## Native Plugin Editor Inspection

Launch: `open -n build/Mosh_artefacts/Debug/Mosh.app --args --demo3`

CUA identified the native plugin editor window `Serum 2`. The plugin window
rendered a license dialog: "This machine is not yet authorized for Serum 2" with
OK and Help buttons. This confirms the native editor pop-out path opens a real
plugin-provided window; it does not prove license-specific interaction.

## Action Automation

Post-reboot CUA inspection works. CUA action calls initially returned the
inactive-session error after `get_app_state(app="Mosh")`:

`Computer Use is not active for 'Mosh'. You first must call get_app_state...`

Refreshing the Computer Use app registry with `list_apps`, then calling
`get_app_state(app="Mosh")`, made actions execute again. Addressing the same
window as `studio.mosh.app` or by bundle path still returned the inactive-session
error, so action calls should use display name `Mosh`.

Verified action paths:
- Play/Stop: `click(app="Mosh", element_index="5")` changed Play to Stop,
  advanced the playhead, then returned Stop to Play on the second click.
- Theme: `click(app="Mosh", element_index="10")` switched the app to the light
  theme and changed the icon from moon to sun.
- Zoom: Zoom + and Zoom - clicks changed the timeline scale and then restored it.
- Tool mode: Split and Move clicks visibly changed the active tool state.
- Arrangement drag: `drag(app="Mosh", from_x=270, from_y=331, to_x=350,
  to_y=331)` moved the `tone-196` clip right on the Pad lane.
- Generative Render: Render click executed and displayed the visible
  `generative service unavailable` banner; Accept/Reject remained disabled, so
  those actions were not marked passing.

Result: CUA inspection, click, and one drag path are accepted for the built app
when the app registry is refreshed and actions are addressed as `Mosh`.
Behavioral coverage remains backed by the command-surface gates, strict
plugin-host evidence, and BlackHole live-audio proof.
