# r7 Research Promotion Decision

Date: 2026-07-01

Decision: the r7 MIDI-derived recipe JSON corpus may be tracked in `service/recipes/library/` for internal research and generation experiments.

Scope:
- Allowed: recipe JSON containing musical facts, inline note events, role metadata, source IDs, and content hashes.
- Not allowed: raw MIDI files, audio files, sample or palette paths, screenshots, transcripts, local evidence files, or redistributed media.
- Public distribution, packaged media release, and any rights-sensitive commercial use require a separate rights and packaging decision.

Basis: owner instruction after Gate C scoring was to promote the r7 recipes and continue scaling the method for research. Gate C directionally validated the r7 retrieval/recombination substrate on musical distinctness, while keep/readiness remains a production and arrangement problem.

Required checks for this decision to clear the source-policy blocker:
- Gate A MIDI audit passes for the promoted corpus.
- Gate C is scored before reveal and the verdict is recorded.
- The tracked library contains only safe recipe JSONs with no raw media paths or local evidence paths.
- `docs/auto-loop/STOP` remains present; no automation loop is restarted.
