# I2c — the calibration sitting stops being a competition (2026-07-26)

The FMS lyrics-bench calibration sitting is the HALT gate: until some automated
judge column agrees with the owner's labels, no arm optimization is allowed. Two
sittings failed to clear it for **instrument** reasons rather than judge reasons,
and this pass replaces the instrument.

## What the owner said

Mid-sitting, two objections, both correct:

1. **Flow is unjudgeable on a page.** Syllable counts are not cadence. Without
   hearing the track you cannot tell whether a bar sits right. He needed the
   songs un-blinded so he could play them.
2. **Forced choice is the wrong question.** "In most cases real bar vs. written
   bar isn't going to be a head to head competition — rather I would just say
   that the generated bar works as well as the real bar does."

A third argument settled the first one: **blinding is unenforceable once he
presses play.** He would hear the real bar. The honest choice was never
blind-vs-un-blind; it was un-blind-and-record versus a silent mix of blinded and
accidentally-un-blinded labels with no record of which was which.

## The change

Each bar is rated on its own — `keep` / `passable` / `no` — instead of one being
picked over the other. Song, artist, section and a listen link are shown; `heard`
is recorded per pair.

The load-bearing detail is that **the pairwise label is derived, not discarded**:
better-rated side wins, equal is a genuine tie. So `elect()`, Cohen's κ, the
majority-class baseline and the pre-registered 0.65 bar all keep working exactly
as frozen. Acceptability rates are the *product* read; the gate stays on the
derived pairwise labels. The LLM panel still judges blind pairwise — un-blinding
is owner-side only, or judge columns stop being comparable across sittings.

Provenance is never in the DOM. He may infer it by ear on tracks he plays (hence
`heard`), but a page that *labelled* it would contaminate the pairs he did not
play. The page payload is now built by whitelist rather than by stripping, so a
field added upstream cannot leak in by default.

Controls: ~25% of pairs keep their song hidden, so a later low agreement number
can be attributed to the judges rather than to the ruler having moved. The
ceiling — how often the real bar itself reads as working — is computed from the
**anchor stratum only**: under per-fill rating the human bar gets rated on every
`vs_truth` pair for free, but the disagreement-selected ones are a deliberately
unusual subset, and using them all would buy a tighter interval around the wrong
number.

## Three bugs the un-blinding exposed in its first five minutes

None was reachable by a unit test. All three were visible the instant real artist
names were rendered — which is the whole argument for the preflight step.

1. **The sitting was unplayable.** All 22 songs were long-tail artists nobody has
   heard of (Linoskiii, El Bandito, Nayim Edwards…), so "listen to the flow" was
   impossible on every single pair. The corpus is ~88% long-tail and nothing had
   ever selected against it. Fixed with `run --min-views`. **Calibration only** —
   fame is the memorization confound, so arm evaluation keeps the low-fame bucket
   as its headline. Findable-first buys rater validity; applied to arms it would
   buy a biased number.
2. **The ceiling had a sample size of zero.** `mint_mixed` allocated arm-vs-arm
   pairs from the front of the ordered item list — exactly where the anchor
   stratum sits — consuming every anchor and leaving `anchor vs_truth = 0`. Kinds
   are now split *within* each stratum. RED-proven: the fixture reported
   `{anchor: {vs_arm}, disagreement: {vs_truth}}` before the fix.
3. **Song spread was capped at ~11.** Every granularity group walked the songs in
   the same hashed order, so each re-picked the same leading songs: a 40-item
   draw over 99 eligible songs hit 11 of them — close to the single-song collapse
   that voided sitting 1. `sampling.balanced(max_per_spread=)` caps per-song
   contribution globally; the same draw now reaches 20 songs at **no extra API
   cost**. Same class as the earlier `--limit` alphabetical-bias bug, and fixed
   in `sampling` rather than at the call site for the same reason: a fix applied
   inline is a fix that will recur at the next call site.

## A vacuous test, caught by sabotage

The first version of "a hidden control pair carries no identity" passed against a
sabotage that ignored the `identityHidden` flag entirely — because the fixture's
hidden pair had no identity fields to leak. The fixture now carries a full
identity *and* the flag, so only the flag can suppress it. Re-sabotaged: 2 checks
fail. `self_consistency` had the same shape of hole — it compared a `choice`
field that per-fill rows do not have, scoring every repeat as identical and
reporting a flat 1.0; now keyed on `(pairId, side)` and RED-proven on a flipped
repeat.

## Verified

All 18 bench suites green under system `python3`; `grep SABOTAGE` clean. New
guards RED-proven before implementation and, for the two that matter most
(identity suppression, payload whitelist), sabotage-proven after. One flake:
`scrape_test`'s rate-limiter timing check fails under heavy background load and
passes 3/3 when quiet — `scrape.py` is untouched by this pass.

Zero C++ or UI, so `--selftest` is unchanged by construction.
