# Recipe Source Candidate

## Identity

- `source_id`:
- `source_type`:
- `title`:
- `creator_or_owner`:
- `url_or_local_locator`:
- `accessed_at`:

## Rights And Handling

- `rights_status`:
- `media_handling`:
- `local_evidence_path`:
- `source_hashes`:
- `redistribution_notes`:

## Musical Evidence

- `tempo_bpm`:
- `key_or_mode`:
- `sections_observed`:
- `musical_roles_observed`:
- `timecoded_moments`:
- `production_moves`:
- `recipe_extractability`:

## Score

| Dimension | Score 0-3 | Notes |
| --- | ---: | --- |
| Rights and handling |  |  |
| Musical specificity |  |  |
| Recipe extractability |  |  |
| Recombination value |  |  |
| Production relevance |  |  |
| Evidence quality |  |  |
| Owner gate readiness |  |  |

- `total_score`:
- `vetoes_or_blockers`:

## Owner Gate

- `owner_audition_gate`:
- `owner_decision_date`:
- `owner_notes`:
- `approved_roles_or_uses`:
- `rejected_roles_or_uses`:

## Decision

- `decision`:
- `recipe_authoring_next_step`:
- `phase0_checks_to_run_after_authoring`:

## Skill Source

Bounded projection into a `SourceCardV1` for the Skill Foundry (`teach-moshi project-skill-source`).
This section is independent of the recipe-mining rubric above — it feeds skill provenance, not
recipe scoring. `source_id` above is reused as the skill source card ID and must be a safe lowercase
slug (`[a-z0-9]+(?:-[a-z0-9]+)*`).

- `source_version`:
- `rights`: <!-- one of: official_public_documentation | creator_authorized | user_owned_or_licensed | manual_paraphrase_only -->
- `acquisition`: <!-- one of: official_https_page | creator_authorized_file | user_supplied_local_file | manual_viewing_notes -->
- `platform_handling`: <!-- one of: metadata_and_short_paraphrases_only | local_locator_only -->
- `evidence_sha256`:
- `reviewer`:
- `reviewed_at`:
- `source_state`: <!-- one of: current | stale | superseded | revoked -->
- `dependent_ids`:

## Claims

1-10 unique short paraphrased claims. `origin` is one of: `source_text | owner_observation |
asr_ocr | codex_inference`.

| Claim ID | Origin | Workflow Moment | Paraphrase | Boundary |
| --- | --- | --- | --- | --- |
|  |  |  |  |  |
