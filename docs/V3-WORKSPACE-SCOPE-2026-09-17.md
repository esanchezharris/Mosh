# General V3 workspace repair — 2026-09-17

The owner requested general V3 verification and useful fixes beyond generation.
The isolated `codex/v3-general-ui` candidate starts at
`5ae96d57d53d7f38a71ab3ebdaea336526936856`; the owner checkout and previous branch
remain preserved. No SA3 generation or autonomous runtime work is authorized here.

## Bounded implementation

- Connect Mixer to the existing shared mixer and return to arrangement.
- Open existing MIDI clips in the shared PianoRoll with double-click or Enter.
- Select tracks through their headers; offer Audio track, MIDI track, MIDI clip
  and browser import actions, including an explained empty state.
- Connect count-in to `set_count_in`; display current transport play/pause state.
- Route the V3 Settings shortcut correctly; support Escape, keyboard Templates,
  and modal focus containment/restoration. Remove the unsupported static claim
  that the optional runtime agent is on.
- Preserve V3 tokens, other shells and all engine mutation/undo seams.
- Repair Settings text contrast when the shared application theme is light;
  native screenshot inspection exposed the inherited foreground mismatch.

## Acceptance and boundary

Focused component and browser regressions, native Release interaction, the
canonical native gate against the recorded `origin/main`, independent review and
fresh screenshots bind to the exact candidate/binary. Verify editing/mixer undo,
save/reopen and export on disposable material. Evidence and preserved failures:
`~/Library/Mosh/task-evidence/v3-general-ui-20260917/`.

This is a workspace reachability repair, not a full DAW completion claim. The
pre-existing simplified timeline scaling/gestures, MIDI-file browser import,
advanced routing, physical input recording and owner listening are separate
follow-up work or manual acceptance. Previous SA3 and Song B evidence stays intact.
No model calls, installations, owner audio, push, merge or deployment.
