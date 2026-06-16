# Knowledge flywheel — lo-fi-hip-hop

**Brief:** lo-fi hip-hop beat, dusty boom-bap drums, warm Rhodes chords, mellow sub bass, vinyl crackle  ·  85 BPM · A minor  ·  generative: **real SA3**  ·  seeds [42,7]  ·  margin 0.02

Base prompt (naive): `lo-fi hip-hop beat, 85 BPM`

Each card appends a fragment to the base prompt; a card is **validated** iff it raises CLAP brief-match by ≥0.02, reproduced over ≥2 seeds, no hygiene regression. 2 validated → 3 in the product KB.

| card | kind | Δs42 | Δs7 | verdict | why |
|------|------|----|----|---------|-----|
| Dusty Boom-Bap Drums with MPC Swing (distill) | prompt | +0.032 | +0.025 | ✅ validated | improves brief-match, reproduced, no regression |
| Warm Rhodes Chords in A Minor (distill) | prompt | -0.045 | +0.013 | — rejected | regressed brief-match on a brief |
| Mellow Sub Bass with Vintage Tape Saturation (distill) | prompt | +0.040 | +0.056 | ✅ validated | improves brief-match, reproduced, no regression |
| Vinyl Crackle and Old Jazz Sample Aesthetic (distill) | prompt | -0.006 | +0.038 | — rejected | regressed brief-match on a brief |
| production_critique (selfplay) | prompt | +0.010 | +0.012 | — rejected | no brief improved by ≥0.02 |

## The validated guidance (what got baked)

- **Dusty Boom-Bap Drums with MPC Swing** — _when generating the drum loop via prompt_
  `dusty boom-bap drums, MPC swing`
- **Mellow Sub Bass with Vintage Tape Saturation** — _when generating the bass line via prompt_
  `mellow sub bass, vintage tape saturation`

## Capability gaps the producer wanted but the agent can't execute

- Built-in vinyl crackle generator (effect or sample)
- Bit crusher / lo-fi sampler degradation effect
- Randomized sample start offset to mimic old MPC chopping

_These are the empirical priority list for the deferred "capability-first" work (automation, named plugin params, sends/sidechain, bounce, swing)._
