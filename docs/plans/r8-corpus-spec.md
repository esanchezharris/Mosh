# r8 corpus — spec note for the generation-lane thread (Codex)

*From the 2026-07 training audit (Stage 1 contribution — spec only; the restart thread owns the
engineering). Context: `docs/plans/moshi-training-audit-2026-07.md` §3, `docs/RESTART_HANDOFF.md`.*

## Why r8

The formal Gate C run (owner-scored 18/18 blind, 2026-07-01) measured retrieved-adapted WINNING
distinctiveness (4.17 vs seed 3.33 vs exact 3.00, one 5/5 "wow") but LOSING would_keep (2.17 vs
seed 2.83). The r7 corpus's metadata corruption is a plausible direct cause: **all 48 mined
recipes carry `tempo_bpm=140` (uniform, evidence `ingest-midi --bpm`) and `key=None`** — while
their own filenames declare 130/171/103 bpm and f_m/d_m/bm keys. With key=None, `_interval`
returns 0 ⇒ **transposition silently no-ops** and recombined leads/pads/plucks land in clashing
source keys (only the 808 is rescued by `bind_808_to_chords`); tempo-distance retrieval scoring
is equally inert. Fixing this is the cheapest credible shot at moving would_keep.

## r8 requirements (each verifiable)

1. **Re-ingest with real key/tempo.** Parse bpm + key from (a) the MIDI file's tempo/key meta
   events where present, (b) the filename convention (`…_fm_130_…`, `…_f_m_171…`) as fallback,
   (c) refuse (recipe gets `confidence: 0` on that field) rather than default. **Zero recipes
   with uniform-default tempo; zero `key=None` where the filename carries a key.**
   Audit check: histogram of `tempo_bpm.value` over the corpus must not have a single spike.
2. **Rights-eligible sources only in the active corpus.** `training_eligible=false` material
   (current r7: all 48, "tracked-research-only, missing proof_of_rights") may not feed anything
   that trains or ships. Either clear the packs' licenses (bought packs w/ receipts → record
   proof_of_rights) or replace with clearly-licensed/owner-owned sources. Commercial
   licensability is a program hard constraint.
3. **Honest `reconstruction_class`.** `deterministic` is contractually "high-confidence
   screen-read extraction"; pack-ingests and hand transcriptions are NOT that. Introduce/use a
   class that says what they are (e.g. `partial` or a new `ingested`), and stop diluting the
   anchor class the flywheel was designed to trust.
4. **Gate C re-run, same protocol** (blind, n≥6/group, distinctiveness + would_keep), target:
   **would_keep ≥ 2.83** (the seed baseline it lost to). One owner listening session (~45 min)
   is budgeted for this from the training-audit owner-time ledger.
5. **Duplicate hygiene.** The moshfx library carries 48 untracked "` 2.json`" Finder duplicates;
   `load_library()` globs `*.json` ⇒ double-loading biases retrieval in that checkout. Clean or
   glob-exclude before any Gate C render.

## Explicitly out of scope for r8

- Video mining (synth-param recall ≈0 measured; stages absent from main) — parked.
- Any learned reward / RL — frozen (PR #176).
- Slot-fill generation tooling — being built on the training-program side; will consume the r8
  library as its structure source when both land.
