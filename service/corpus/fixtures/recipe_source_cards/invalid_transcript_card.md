# Recipe Source Candidate

## Identity

- `source_id`: bad-transcript-001
- `source_type`: tutorial
- `title`: Unsafe Transcript Payload Example
- `creator_or_owner`: Example Channel
- `url_or_local_locator`: https://example.invalid/transcript
- `accessed_at`: 2026-06-30

## Rights And Handling

- `rights_status`: educational-only
- `media_handling`: metadata-only
- `local_evidence_path`: ~/mosh-recipes/source-review/bad-transcript-001/
- `source_hashes`: sha256: abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
- `redistribution_notes`: keep only short factual notes

## Musical Evidence

- `tempo_bpm`: 132
- `key_or_mode`: D minor
- `sections_observed`: intro, verse, hook
- `musical_roles_observed`: kick, snare, hat, 808
- `timecoded_moments`: 00:12 intro, 00:18 verse, 00:24 hook, 00:30 bridge, 00:36 outro, 00:42 coda, 00:48 tag
  the full transcript goes here in a long block and should be rejected because it is effectively
  copied evidence, not a compact musical note. It repeats timestamps and keeps describing every
  bar in prose, which is exactly the intake payload this helper must refuse.
- `production_moves`: filtered intro, rising snare, doubled hats
- `recipe_extractability`: medium

## Score

| Dimension | Score 0-3 | Notes |
| --- | ---: | --- |
| Rights and handling | 3 | metadata-only intake
| Musical specificity | 2 | enough structure to be useful
| Recipe extractability | 2 | facts are available but the payload is unsafe
| Recombination value | 2 | drums and transitions are reusable
| Production relevance | 2 | aligned with the beat lane
| Evidence quality | 0 | transcript-like payload is not allowed
| Owner gate readiness | 1 | needs cleanup before review

- `total_score`: 12
- `vetoes_or_blockers`: transcript-like payload

## Owner Gate

- `owner_audition_gate`: not-ready
- `owner_decision_date`: 2026-06-30
- `owner_notes`: shorten to factual notes and remove the copied prose
- `approved_roles_or_uses`: kick, snare, hat
- `rejected_roles_or_uses`: pasted transcript, long prose

## Decision

- `decision`: reference-only
- `recipe_authoring_next_step`: clean the card and resubmit
- `phase0_checks_to_run_after_authoring`: recipe schema, compile smoke, render smoke, audition notes
