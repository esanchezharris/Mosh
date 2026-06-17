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
first rendered a license dialog: "This machine is not yet authorized for Serum
2" with OK and Help buttons. After user authorization, CUA identified the same
native editor window rendering the full Serum UI with OSC/MIX/FX/MATRIX/GLOBAL
tabs, the `-Init-` preset header, oscillator panels, modulation controls, and
keyboard. This confirms the native editor pop-out path opens a real
plugin-provided editor after authorization.

## Action Automation

Post-reboot CUA inspection works. CUA action calls are session-sensitive and can
return the inactive-session error even after `get_app_state(app="Mosh")`:

`Computer Use is not active for 'Mosh'. You first must call get_app_state...`

Refreshing the Computer Use app registry with `list_apps`, then calling
`get_app_state(app="Mosh")`, made actions execute again. Addressing the same
window as `studio.mosh.app` or by bundle path still returned the inactive-session
error, so action calls should use display name `Mosh` when using CUA.

Verified action paths:
- Play/Stop: `click(app="Mosh", element_index="5")` changed Play to Stop,
  advanced the playhead, then returned Stop to Play on the second click.
- Theme: `click(app="Mosh", element_index="10")` switched the app to the light
  theme and changed the icon from moon to sun.
- Zoom: Zoom + and Zoom - clicks changed the timeline scale and then restored it.
- Tool mode: Split and Move clicks visibly changed the active tool state.
- Arrangement drag: `drag(app="Mosh", from_x=270, from_y=331, to_x=350,
  to_y=331)` moved the `tone-196` clip right on the Pad lane.
- Generative Render without service preflight: Render click executed and
  displayed the visible `generative service unavailable` banner; Accept/Reject
  remained disabled.
- Native Serum editor: after authorization, CUA inspection saw the full native
  Serum UI. Pixel clicks on the FX tab still returned the inactive-session error
  for both `app="Mosh"` and the exact bundle path, so native-editor click
  automation is not marked passing.

## macOS UI Automation Fallback

Because CUA inspection is reliable but CUA action sessions are flaky, added a
deterministic local fallback gate:

`scripts/macos-ui-automation-gate.py`

Evidence:
`_preserved_artifacts/2026-06-08-consolidation/claudemosh/macos-ui-automation-20260608-131212`

Method:
- Starts a fast FakeAdapter service with `MOSH_ENABLE_SA3=0` if
  `http://127.0.0.1:8770/health` is not already healthy. This avoids the known
  `open` launch boundary where repo cwd/env is not propagated to the GUI app.
- Uses macOS AX to find Mosh WebView control bounds, then clicks the exact
  screen-point centers with Quartz CGEvents.
- Uses `screencapture -l` for visual evidence.
- Uses `~/Library/Mosh/session/mosh-log.jsonl` as the deterministic behavioral
  proof for Accept/Reject after GUI clicks.
- Uses Quartz window-relative clicks for Serum, whose native plugin internals
  are not fully exposed through AX.

Passed checks:
- `demo6_play_click`: Play changed to Stop, then back to Play.
- `demo6_theme_click`: theme changed to light.
- `demo6_zoom_plus`: timeline scale changed.
- `demo6_tool_modes`: Split and Move state changed.
- `demo6_clip_drag`: Pad clip moved from AX x `204.0` to `284.0`.
- `demo6_render_click`: Render enabled Accept/Reject with the FakeAdapter
  service running.
- `demo6_accept_click`: JSONL `accept_render` recorded after GUI click.
- `demo6_reject_click`: JSONL `reject_render` recorded after GUI click.
- `demo3_serum_matrix_tab`: native Serum editor tab switch from OSC to MATRIX
  produced visual diff `19.69`.

Conclusion: CUA is accepted for inspection and main-window action evidence when
the registry/session is fresh and calls are addressed as `Mosh`, but it is not
reliable enough to be the only autonomous action runner. The completed local
automation loop is CUA inspection plus the macOS AX/Quartz fallback gate, with
command-log validation for behavior that must persist. Strict command gates,
plugin-host evidence, and BlackHole live-audio proof remain the release gates.
