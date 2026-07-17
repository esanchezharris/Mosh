# FMS Phase B build plan — the three green-lit lanes (2026-07-17)

**Evidence base:** Phase V verdicts (`../specs/2026-07-16-fms-mechanism-verify-verdict.md`).
Owner green-lit lanes (a)+(b)+(c); render-engine articulation naturalness stays PARKED
until after first-stranger. Branch: `claude/fms-mechanism-verify`.

## Lane (a) — kill the per-word snap (subtraction; ~half day) — FIRST

V3: per-word snap ranked WORST in both blind passages while raising env_corr; V0-S3: it
adds +30…50ms vowel lateness and squeeze. Phrase alignment is at-worst neutral.

- `service/soulx/perform.py::snap_render_to_take` → phrase alignment ONLY (drop the
  `snap_to_events` stage). `snap_to_events`/`event_lags` stay as functions (`event_lags`
  feeds honest residual reporting; `snap_to_events` feeds the V3 ablation harness) with
  docstrings marking the product verdict.
- `service/adapters/soulx_adapter.py::_snap_output_to_take` — docstring only;
  `sylSnapMedianMs` already measures the RESIDUAL after snapping, so its semantics carry
  over as "residual after phrase alignment" unchanged.
- TDD: update `perform_test.py` §6 FIRST (RED): pin snap_render_to_take == the
  apply_shifts phrase-only result; identity/empty-clip no-ops and 3× determinism kept;
  DROP the "residual event lags near zero" pin (that was the condemned behavior).
  Adapter suite should pass unchanged (aligned-take residual stays small).

## Lane (c) — B2-capped + B3 metric (~1–2 days) — SECOND

V1 fired the cap (words sang fine): B2 = the cram-policy kill + melisma tol-±1 only, no
bigger lyric surgery. V4b PASS makes melisma (note_type=3) the flex mechanism.

- **B2.1 kill the surplus-word cram** (`service/soulx/score.py::_word_units`): the
  "surplus words share the LAST slot evenly" policy is a mechanical unnaturalness
  generator. Replace: an off-count line NEVER reaches the author (stage-2's count-exact
  gate already guarantees this in practice — make the author REJECT surplus instead of
  cramming, surfacing the authoring bug instead of singing it).
- **B2.2 melisma tol-±1** (`service/lyrics/` count gate): accept count−1 lines by holding
  the last stressed syllable across the orphan slot (note_type=3 continuation — V4b-proven),
  accept count+1 by the existing multi-syllable fold. Soft ranker terms (open-vowel-on-
  longest-slot bonus, cluster×tempo penalty) only if cheap; the cap rules out deep work.
- **B3 metric** (`scripts/fms-killshot` + adapter reporting): the verify/report gate
  becomes VOWEL-ONSET alignment (pyin voicing onset, the V0 estimator) + duration
  plausibility (dur_ratio vs the take), replacing any use of word-start snap medians as a
  quality claim. Product adapter keeps `sylSnapMedianMs` as residual observability but the
  HARNESS pages (fresh-render/finish.py class) report vowel-onset medians.

## Lane (b) — B1-lite: stage-3 duration derivation (~3–5 days) — THIRD

V2: gold durations beat verbatim slots blind (vowel error 40→10ms) — real, partial win.

- The take stays the spec at PHRASE level: phrase start/end + note pitches per slot.
- Inside a phrase, durations are DERIVED, not transferred: anchor stressed/downbeat vowel
  onsets to their nuclei with onset consonants budgeted BEFORE the anchor (V4a: that is
  the model's training convention; magnitudes from V0's est_cluster_dur distribution);
  between anchors a deterministic zero-sum rule layer (stressed-rime lengthening,
  function-word compression, phrase-final lengthening, articulability floor × cluster).
- Parameters FITTED from the owner's gold lines (gold-line2 now; line-1 re-record when it
  lands) — measured stressed:unstressed ratios, function-word compression, final
  lengthening. Fitting script extends `oracle_duration.py`'s gold extraction.
- Ships as a stage-3 MODE (`durations:"derived"|"verbatim"`, derived default-off until an
  owner ear round on a full section confirms), so the A/B stays one flag.
- Exit: one owner ear round — derived vs verbatim on the u2 back half through the
  (a)-fixed chain. Expectation set honestly by V2: better, not closed.

## Order & verification

(a) → (c) → (b), each RED→GREEN with its suite ×3 + the neighboring soulx/lyrics suites;
nothing touches `--selftest` surfaces (service-py only). Each lane lands as its own
commit(s) on this branch; product landing to main stays a later consolidation per the
2026-07-13 plan.
