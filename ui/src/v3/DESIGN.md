# V3 design contract

## 1. Identity
Preserve the compact dark studio, waveform lanes, stacked inspector and lime selection. Repair the existing shell without a new visual direction.

## 2. Color
Use `tokens.css`: `--bg`, `--surface`, `--surface2`, `--insp`, `--text`, `--muted`, `--fog-line`, `--line`, `--accent`, `--warn`. Honor all four colorways. Shared controls must not inherit another shell's palette.

## 3. Typography
Keep the system font and existing dense studio scale. Direct fields and explanations use 12px with 1.4 line height; numbers are tabular. Clip names use ellipsis and full accessible labels.

## 4. Layout
Keep transport, rail, arrangement and inspector. Inspector and arrangement each own their vertical scroll; no nested Re-Imagine scrollbox. Native desktop is the acceptance surface. Phone DAW layout is outside this repair.

## 5. Components and states
Reuse direct GenDrawer. Open requires exactly one audio clip and pins it until Close. Project replacement or deletion invalidates the target. Show backend/test badge, source identity, prompt, amount, seed, actual job status, audition and decisions. Empty, unavailable, busy, failed, cancelled, pending and kept states stay readable. Buttons wrap, fields shrink and long names wrap. Timeline and keyboard edits share selection.

## 6. Motion
Retain existing short `--ease-out` transitions; no new animation.

## 7. Accessibility
Label controls and clips; use keyboard selection, visible focus, pressed audition buttons and live status. Close restores committed playback. Disabled controls remain distinguishable.

## 8. Verification
Fresh native Release screenshots: baseline, selection, direct tool, pending, cancelled, kept and offline. Check persistence/export, width containment and long names. Fixtures are software evidence, not model or listening acceptance.

## 9. General workspace repair (2026-09-17)
Reuse the existing Mixer and PianoRoll, with the same V3 tokens. Mixer is a reversible workspace toggle; Browser and Plugins stay independent. Track names select their track; MIDI clips open the shared editor on double-click or Enter. The arrangement toolbar exposes Audio track, MIDI track, MIDI clip and Import audio through existing actions. Empty sessions explain these starting actions. Count-in reads the engine setting, and Settings/menu/history respond to Escape. Preserve the current layout and palettes; do not redesign timeline gestures, routing or the generation engine in this slice.

Native acceptance covers empty start, added audio/MIDI tracks, MIDI editing and undo, mixer level/mute changes and undo, Browser/Plugins reachability, Booth/count-in, Settings/Escape, save/reopen and exported scratch content. Capture the repaired states at the built Release identity; browser fixtures additionally check narrow containment and colorways.
