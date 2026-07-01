# Real-Recipes Source Selection

This is the Phase 0 intake rubric for choosing tutorials, walkthroughs, and
source references that can bootstrap recipe-library material without committing
or redistributing copyrighted media. It supports the real-recipes substrate:
recipes should carry musical body, per-element provenance, recombination-ready
motifs, and local render/audition evidence before any reward or training loop
uses them.

## Scope

Use this for source selection only. It does not authorize scraping, publishing,
or training on media. It records why a source is worth owner review, what can be
extracted as facts or hand-authored recipe structure, and what must stay local.

Good Phase 0 sources are references that help author a small seed recipe library:

- tutorials that expose arrangement decisions, drum/bass/melody roles, and
  concrete production moves
- project walkthroughs where the relevant musical elements can be described as
  structure, not copied audio
- owner-owned or licensed local packs that can supply audition-only one-shots
- public educational material that can be cited by URL while media remains local

Do not use this rubric to ingest full songs, stems, sample packs, or videos into
the repo. The committed artifact is metadata, a score, and an owner decision.

## Intake Fields

Each candidate review should fill these fields. Use
[`docs/templates/recipe-source-candidate.md`](templates/recipe-source-candidate.md)
for one source at a time. Validate cards with
`python3 service/corpus/recipe_source_intake.py validate <card-or-dir>` and emit
a safe review index with `python3 service/corpus/recipe_source_intake.py index <card-or-dir>`.

| Field | Required | Notes |
| --- | --- | --- |
| `source_id` | yes | Stable slug, for example `yt-dark-trap-808-walkthrough-001`. |
| `source_type` | yes | `tutorial`, `walkthrough`, `project`, `sample-pack`, `midi-pack`, `owner-reference`, or `other`. |
| `title` | yes | Human-readable title. |
| `creator_or_owner` | yes | Channel, author, vendor, or local owner. |
| `url_or_local_locator` | yes | Public URL or private local locator. Never commit raw media paths if they expose private material. |
| `accessed_at` | yes | Date reviewed, in `YYYY-MM-DD`. |
| `rights_status` | yes | `open`, `licensed-owner-local`, `royalty-free-no-redist`, `educational-only`, `unlicensed`, `unknown`, or `blocked`. |
| `media_handling` | yes | Must state `local-only`, `metadata-only`, or `do-not-use`. |
| `local_evidence_path` | optional | Directory outside the repo for notes, screenshots, hashes, and audition renders. |
| `source_hashes` | optional | SHA-256 for local files when useful for re-finding them; hashes are metadata, not permission. |
| `musical_roles_observed` | yes | Roles such as kick, snare, hat, clap, 808, bass, chords, lead, pad, transitions, mix. |
| `timecoded_moments` | optional | Short timestamps and factual notes. Do not transcribe long copyrighted passages. |
| `recipe_extractability` | yes | `high`, `medium`, `low`, or `blocked`, with a reason. |
| `owner_audition_gate` | yes | `not-ready`, `queued`, `approved`, `rejected`, or `blocked`. |
| `decision` | yes | `candidate`, `author-recipe`, `reference-only`, `reject`, or `blocked`. |

## Scoring Rubric

Score each candidate from 0 to 3 per dimension. A candidate should normally
reach 14+ out of 21 before it becomes recipe-authoring input. A low rights or
local-handling score can veto the candidate even when the music is useful.

| Dimension | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| Rights and handling | Blocked or unknown redistribution risk | Usable only as private inspiration | Clear local-only or no-redist handling | Open, owner-owned, or explicitly licensed for intended use |
| Musical specificity | Vague taste reference | One useful sound or gesture | Several concrete roles or sections | Full arrangement/body with roles, timing, and variation |
| Recipe extractability | Cannot express as recipe facts | Requires heavy interpretation | Extractable motifs with some gaps | Clear element-level facts: tempo, key, roles, rhythms, notes, sections |
| Recombination value | One-off or too idiosyncratic | Narrowly useful | Useful for one or two roles | Strong reusable motifs across drums, 808/bass, chords, melody, or transitions |
| Production relevance | Not aligned with current beat goals | Adjacent style only | Good genre/style match | Directly targets the desired Phase 0 sound and audition goals |
| Evidence quality | No durable notes | Basic source note only | Timestamps, role notes, and owner comments | Full review card, hashes where applicable, audition notes, and follow-up |
| Owner gate readiness | Owner cannot review | Needs cleanup before review | Ready for owner listen/read | Owner approved exact role/use and next extraction step |

## Owner-Gated Workflow

1. Triage the source with the intake template. Record only metadata and short
   factual notes in git.
2. If media must be downloaded or captured, keep it outside the repo under a
   local evidence directory such as `~/mosh-recipes/source-review/<source_id>/`.
3. Compute hashes for local files when reproducibility matters, but do not treat
   a hash as a license grant.
4. Summarize recipe-relevant facts: tempo, key, sections, roles, onset patterns,
   note contours, sample roles, and production moves.
5. Queue owner review only when the source has a clear rights posture and a
   concrete extraction target.
6. During owner audition, capture the decision as metadata: approved roles,
   rejected elements, and any by-ear comments needed for recipe authoring.
7. Author seed recipes from facts and owner-approved observations. Do not copy
   source media, long transcripts, screenshots, stems, MIDI files, or loops into
   the repo.
8. Before using a new recipe for generation or reward work, run the matching
   Phase 0 checks from the real-recipes substrate when available: recipe schema,
   compile/render smoke, recombination provenance, and owner audition set.

For a local MIDI-pack corpus, generate a safe promotion packet before moving
recipes from `.cache/` into a tracked library or broader staged runtime:

```bash
service/teardown/.venv/bin/python scripts/verify-hardware/midi_corpus_promotion_packet.py \
  --root .cache/mosh-teardown/midi-ingredients/2026-07-01-r7-curated \
  --source-policy research-tracked \
  --owner-decision docs/research-policy/2026-07-01-r7-research-promotion.md \
  --out .cache/mosh-teardown/midi-ingredients/2026-07-01-r7-curated/promotion-packet.json
```

The packet intentionally reports source path classes and role counts only, not
raw MIDI paths or media. `research-tracked` clears the owner source-policy blocker only
when it points at a durable tracked owner-decision artifact. As of 2026-07-01, that
artifact is `docs/research-policy/2026-07-01-r7-research-promotion.md`: it approves the
r7 MIDI-derived recipe JSONs for tracked research-library promotion after Gate C scoring.
This does not authorize raw MIDI/audio redistribution or public packaged-media release;
those still require a separate rights and packaging decision.

## Local-Only Media Rules

- Keep tutorial videos, extracted audio, screenshots, stems, MIDI, sample packs,
  and audition WAVs out of git.
- Commit URLs, rights status, hashes, timecoded notes, and owner decisions only.
- Prefer describing musical facts over copying expression: "snare on 2 and 4,"
  "808 sustains through bar 1 beat 3," "hat density doubles in hook" are useful;
  copied MIDI, lyrics, or long transcript passages are not.
- Private sample paths may appear in local evidence notes, but checked-in docs
  should use stable source IDs or redacted locators.
- If the rights status is `unknown`, `unlicensed`, `educational-only`, or
  `royalty-free-no-redist`, the source can still inform local owner review, but
  the repo must not contain the media or derived media.

## Phase 0 Acceptance

A source-selection batch is ready to hand to recipe authoring when it has:

- at least one completed review card per approved source
- no checked-in media files or private sample paths
- a rights status and media-handling posture for every candidate
- owner-gated `approved` or `reference-only` decisions for any source used
- enough musical facts to author recipes without copying source media
- a follow-up note identifying which Phase 0 recipe/render/audition checks should
  run after the recipe is authored
