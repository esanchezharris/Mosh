# Round changelog — what changed between each listening sitting

Hand-maintained; build_journal.py folds each section into the training journal.

## r1
First blind audition of 6 generated beats (recipe pipeline v1: retrieve→recombine→
transpose→bind). Verdict driver: "808 too high" on all six.

## r2
808 register normalization (whole-octave fold into the C1–D2 sub window) + sub-register
render gate (PR #201). Owner recalibrated his star scale mid-round ("these all sound
better than last round").

## r3ab
Palette pitch-truth pass — measured sample roots replaced trusted labels; verified
binding + audibility floor (PR #202). A/B vs r2: preferred 4–1–1.

## r4ab
Arrangement tiling fix — patterns repeat to the arrangement end ("trails off" fixed,
PR #203). A/B vs r3: preferred 6/6. The per-fix listening loop retired here.

## pack-001
Beat factory era begins (PR #204): 72-candidate grid → hard gates → auto mix-balance →
14-beat taste pack, keep/kill + defect chips. 7/14 kept.

## pack-002
Pack-001 fixes (PR #205): Audiobox axes protocol repair, melodic-variety floor,
open-hat rule, kick↔808 sub-tail pairing, clip-guard/mix-audibility fixes, per-sample
pack cap. Two reprises shipped — measured bit-identical (lesson: delta-gate every A/B).
8/12 kept.

## pack-003
Scale-reference MIDI dumps found poisoning the library ("all the notes hitting at
once") — pruned 930→542 with rhythm + grid guards (PR #206, #207 next round). 6/14 kept;
notes shifted from defects to taste direction.

## pack-004
The method-upgrade round (PRs #207–#213): grid-lock snapping, owner keep/kill source
priors, the 4 named styles, TOP PICK replaces stars, delta-gated FX polish (drum OTT +
808 density), song-form A A′ B A with the direction-conditional B 808-flip, FX-KB
scrape pilot (NO-GO on its strict audit). 10/14 kept — and the top pick: "I love it."

## pack-005
The latent-space pass: persistent CLAP+MuQ embedding store, taste ranker v1
(LOPO 0.52 vs the 0.65 bar → ADVISORY mode, predictions on cards only),
more-like-your-top-pick slots, style tags re-grounded in the owner's confirmed
exemplars (multi-tag), 808-always-in-key under disrespectful, this journal.
