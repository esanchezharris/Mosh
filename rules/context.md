# Context Rules

- Implement collaboration demo work on `codex/final-leg-demo-gates`.
- Keep dirty primary checkouts and untracked local scripts untouched.
- All user-visible mutations enter through `MoshOps::execute`.
- iPhone, React, Moshi, and peer sync are command sources, not schema owners.
- Do not add iPhone-specific command names or validators.
- Snapshot and event changes must be additive.
- Remote playhead presence is ephemeral relay data.
- Presence must not touch `Edit`, `ValueTree`, command schemas, or sync merge logic.
- Golden fixtures canonicalize volatile IDs/paths only.
- Golden failures write `.actual.xml`; humans diff and update fixtures deliberately.
- Two-Mac/two-iPhone proof is manual hardware proof, never inferred from Storybook.
- If devices are unavailable, mark the smoke checklist `not run` with the blocker.
