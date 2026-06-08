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

Post-reboot CUA inspection works, but CUA action calls did not execute in this
tool session. `get_app_state(app="Mosh")` reliably identified the demo6
arrangement and demo3 native editor window, but `click(app="Mosh", ...)`,
coordinate click, and secondary action calls returned:

`Computer Use is not active for 'Mosh'. You first must call get_app_state...`

Earlier in the same branch, after the macOS developer-tool permission prompt was
cleared, basic Play/Stop clicks worked when addressed as `app="Mosh"`; addressing
the window as `studio.mosh.app` or by bundle path returned the inactive-session
error. After reboot, even `app="Mosh"` no longer executed action calls.

Result: post-reboot CUA inspection evidence is accepted; post-reboot click/drag
automation is not marked as passing. Behavioral coverage remains the
command-surface gates, strict plugin-host evidence, and BlackHole live-audio
proof. Drag automation and full edit workflows still need a future CUA session
where action calls execute.
