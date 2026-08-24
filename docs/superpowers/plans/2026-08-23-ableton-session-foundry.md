# Ableton Session Foundry Backup Prototype

## Outcome

Give the owner a passive, local-only way to record a natural Ableton Live 11 session, debrief it later, and turn one approved workflow into a portable Mosh skill plus its linked workflow-parity fix.

## Reviewable slices

1. Owner-local capture: ScreenCaptureKit video, separate system and microphone audio, privacy-bounded input events, hashed `.als` save snapshots, marks, 15-minute chunks, and a two-hour ceiling.
2. Deterministic preparation: media verification, local transcription, event-aligned review artifacts, `.als` comparisons, and a complete candidate backlog.
3. Skill runtime and certification: explicit-request routing for declarative owner skills and three scratch-session replays through the MoshOps script seam.
4. Linked proof: one owner-approved skill and one Live-11 workflow blocker, verified in a matched Ableton/Mosh task.

## Safety invariants

- Raw capture remains under `~/Library/Mosh/teach/sessions` and never enters Git.
- The capture helper does not change CoreAudio routing.
- Input evidence stores key codes and modifiers, never interpreted text or clipboard contents, and only while Ableton Live 11 is frontmost.
- Every session starts only after a 30 GiB free-space preflight and ends by two hours.
- Deletion is a separate reviewed action; no capture command removes evidence.
- Learned procedures execute only through existing MoshOps commands and only after an explicit owner request.
