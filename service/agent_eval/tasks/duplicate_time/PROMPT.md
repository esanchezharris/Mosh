# Duplicate Time

Status: draft. This task must not be executed until the observable behavior below is complete and the task manifest is changed to `ready`.

## Stakeholder goal

Add a named Duplicate Time operation for the arrangement time selection. It must be reachable through the shared action system and behave as one undoable MoshOps mutation, with the normal event, JSONL-log, result-envelope, replay, and multiplayer-lock guarantees.

## Public behavior already settled

- The input is the existing non-empty arrangement time selection.
- The operation is named Duplicate Time and uses the existing `Shift+Mod+D` Live-style shortcut.
- The WebView may shape arguments but must not mutate Tracktion directly.
- The complete operation is one Tracktion undo transaction.
- Undo and redo must restore the complete affected timeline state.
- Failure must leave the project unchanged and return a normal MoshOps error envelope.

## Public behavior still unresolved

- Whether the duplicate is inserted immediately after the selection or overlaid at another destination.
- Whether later timeline material moves to open space.
- Whether the operation applies to every track or only selected tracks.
- Exact boundary behavior for clips crossing the start or end of the selection.
- Copy and shift rules for automation, tempo and time-signature changes, sections, annotations, and the loop range.
- The post-operation time selection and playhead state.

The task author must resolve every item above, add reproducible public checks, calibrate the private grader against a reference patch and deliberately broken mutants, and only then mark the manifest ready.
