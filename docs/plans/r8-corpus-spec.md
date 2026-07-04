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

## Addendum (2026-07-01, from the rated validity pack)

6. **Loop-start render artifact on seed-0 candidates.** The owner skipped every A/B containing a
   seed-0 clip ("awful wacky noise at the beginning of each loop"); all `*_0_*` renders carry it,
   seed-1 renders don't. Find and fix in the shared render path (`buildValidityPack`-style
   render harness) and CHECK whether any Gate C pack arm shared it before trusting those scores.
7. **Validity verdict context for r8:** on artifact-free clips the owner's ratings are flat
   across verifier tiers (4.33 vs 4.67 of 7) — corpus/musical-substance improvements, not
   verifier-score improvements, are what can move would_keep.

## Addendum (2026-07-02, from the rated owner-DNA audition)

8. **FL channel-root capture at import — the upstream register fix.** The owner rated ALL SIX
   owner-DNA beats "808 too high" (mean 2.83/5). Measured: 808 medians MIDI 54.5–65 vs the
   24–38 sub window, 0/50 notes inside; library-wide the owner scrape's 808/bass element
   medians center on 60.75 (2.6% in-window) vs the hand-authored seeds' 29 (80%). Root cause:
   `service/flp/flp_cli.py` never reads the FL channel sampler root (FL default C5 = raw 60),
   so sub-sounding piano-roll patterns import as C4–C5 absolute pitches and
   `motif.register_band` is computed from the wrong frame. r8's importer pass should emit the
   channel root/keyboard transposition from PyFLP into the IR and rebase note pitches (or at
   least store the root so generation can). The generation-time octave fold
   (`normalize_808_register`, landed 2026-07-02) makes existing data correct at assembly time,
   so this is data-quality debt, not a blocker.
9. **Per-element key verification** (carried from the audition): recipes' inferred source keys
   remain unreliable — chroma-verify per element at re-ingestion, not just per project.
10. **Mood-tag reliability (2 data points):** 06 "chill" CONFIRMED verbatim; 04 "emotional"
    rejected by the owner ("fire, but… idk if I would say it's 'emotional'"). Re-tagging wants
    more ratings before acting; keep collecting from listening-room CSVs.
11. **Element density / collision control:** beat 05 rated "messy but aggressive". No fix
    landed; candidate lever = per-role density budget or onset-collision thinning at assembly.
12. **Arrangement contrast (owner idea):** "a section where it [the 808] drops an octave" —
    section-level register/energy contrast as a future assembly feature. The default-low
    register fix (item 8 + normalize_808_register) supersedes the immediate need.
