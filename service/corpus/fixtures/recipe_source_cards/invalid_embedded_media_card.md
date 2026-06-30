# Recipe Source Candidate

## Identity

- `source_id`: bad-embedded-media-001
- `source_type`: walkthrough
- `title`: Unsafe Embedded Media Example
- `creator_or_owner`: Unknown
- `url_or_local_locator`: https://example.invalid/unsafe-media
- `accessed_at`: 2026-06-30

## Rights And Handling

- `rights_status`: unknown
- `media_handling`: local-only
- `local_evidence_path`: ./evidence/bad-embedded-media/
- `source_hashes`: sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
- `redistribution_notes`: do not copy media into the repo

## Musical Evidence

- `tempo_bpm`: 128
- `key_or_mode`: C minor
- `sections_observed`: intro, drop
- `musical_roles_observed`: kick, bass
- `timecoded_moments`: ![rack screenshot](assets/rack.png)
- `production_moves`: <video src="demo.mp4"></video>
- `recipe_extractability`: low

## Score

| Dimension | Score 0-3 | Notes |
| --- | ---: | --- |
| Rights and handling | 1 | unclear rights and local-only handling
| Musical specificity | 1 | only a minimal sketch
| Recipe extractability | 1 | not enough facts to author a safe recipe
| Recombination value | 1 | limited reuse
| Production relevance | 1 | loosely aligned
| Evidence quality | 0 | embedded media is not allowed
| Owner gate readiness | 0 | blocked by unsafe payload

- `total_score`: 5
- `vetoes_or_blockers`: embedded media, repo-local evidence path

## Owner Gate

- `owner_audition_gate`: blocked
- `owner_decision_date`: 2026-06-30
- `owner_notes`: rejected until the media is removed from the card
- `approved_roles_or_uses`: none
- `rejected_roles_or_uses`: all

## Decision

- `decision`: reject
- `recipe_authoring_next_step`: none
- `phase0_checks_to_run_after_authoring`: none
