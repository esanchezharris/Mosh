# Direct SA3 Re-Imagine scope decision — 2026-09-16

The owner approved a bounded direct generative operation inside the existing Mosh
application. The current loop is import/record → select one audio clip → Re-Imagine
→ prompt, amount and seed → generate → audition source/result → Keep or Reject →
edit, save/reopen and export. The user makes creative decisions.

This supersedes near-term autonomous production, recording/mixing agents,
reference-mix reconstruction, preference learning, autonomous ranking and the
older 90-day mixing experiment priorities. Existing recording, editing, MIDI,
plugin hosting and mixing remain. Deferred implementation and evidence are
preserved; their old “next” or “in progress” labels do not reopen them.

Song B was administratively closed on 2026-09-15. Accepted Runway2 R remains
accepted; B0's fixed-gain numerical check is preserved; K1 rendering and the
R/B0/K1 listening set remain deferred, not passed. K2, source material and failed
attempts remain untouched. The authoritative closeout is
`~/Library/Mosh/task-evidence/songb-reconstruction-execution-20260910/CLOSEOUT-20260915.md`.
Closed Mosh S2/S3/S4 qualification is not a prerequisite.

## Implementation boundary

Baseline: `5f9200961756abcace8a860437f442eb27eacf66`, selected from the clean
`codex/astaattempt` owner checkout. Candidate work is isolated on
`codex/direct-sa3-reimagine`; the installed application and owner sessions are
unchanged. `origin/main` is the canonical gate comparison base, not the
implementation baseline.

The Pro Tools entry reuses the shared drawer and MoshOps commands. New explicit
audio layers retain their original source and store pending/committed audio;
generation does not apply automatically. Audition substitutes one clip source
through existing routing, restores committed playback before persistence, and
never creates a second audible layer. Keep and Reject use Tracktion undo.
Requests bind to the edit, clip, layer, settings and staged source. macOS freezes
the request with an atomic filesystem clone before background staging; sources
on volumes that cannot provide that snapshot, and symbolic-link sources, fail
with a copy-into-project message. Source and pending-result content hashes are
verified off the UI thread before Keep or Result audition. Cancellation prevents
application; running inference may continue and returned files remain.

`stable_audio3` here means the existing local SA3 Medium MLX backend. Direct
requests require affirmative capability and provenance, bypass automatic scoring,
and never fall back to another provider. Amount is generation strength (normal
`nl=0.01–0.5`, default `0.4`), not dry/wet or a preservation guarantee. The direct
slice supports ordinary 2–240 second clips and their source offsets. Looping,
reverse, warping, auto-pitch and changed speed require a prior bounce. Ranges,
inpainting, splicing and secondary Color/LoRA UI are deferred.

## Acceptance boundary

Implementation is under verification. Evidence is kept in
`~/Library/Mosh/task-evidence/direct-sa3-reimagine-20260916/` and must identify the
exact candidate, binary and backend. Required focused tests, MoshTests, native UI,
canonical native gate and independent review remain separate from one frozen
four-second local real-model check. Only one identical-settings technical retry
is permitted. A fixture is labelled test output. No automated result establishes
owner listening acceptance. No push, merge, install or deployment is authorized.
