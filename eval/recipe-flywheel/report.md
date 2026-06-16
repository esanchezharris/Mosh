# In-the-box flywheel — symbolic conformance

2 arrangements [lofi-85-Am, dark-70-Cm] · a card is **conformant** iff the move took effect on EVERY arrangement (read from the snapshot), with no broken state. 5/5 conformant → 8 shippable in the product KB.

| card | task | lofi-85-Am | dark-70-Cm | verdict |
|------|------|----|----|---------|
| Boom-bap drum pattern (kick/snare/8th-hats) | drum_programming | ✓ 1.00 | ✓ 1.00 | ✅ conformant |
| MPC swing on the hats (~0.58) | drum_programming | ✓ 0.58 | ✓ 0.58 | ✅ conformant |
| Humanize the keys (subtle timing + velocity) | arrangement | ✓ 0.02 | ✓ 0.02 | ✅ conformant |
| Filter-open automation over the intro | mixing | ✓ 0.70 | ✓ 0.70 | ✅ conformant |
| Shared reverb on a send bus | mixing | ✓ -12.00 | ✓ -12.00 | ✅ conformant |

## What got baked (retrieved + injected at inference)

- **Boom-bap drum pattern (kick/snare/8th-hats)** — _programming a boom-bap or lo-fi hip-hop drum pattern from scratch_  ·  12 command(s)
- **MPC swing on the hats (~0.58)** — _the hats/drums feel too straight and need a swung, off-grid groove_  ·  1 command(s)
- **Humanize the keys (subtle timing + velocity)** — _a programmed keys/chord part sounds too quantized / robotic_  ·  1 command(s)
- **Filter-open automation over the intro** — _an intro/build needs movement — open the filter up over time_  ·  2 command(s)
- **Shared reverb on a send bus** — _the mix needs depth / space — a shared reverb the tracks send to_  ·  2 command(s)

_Conformance proves the move was APPLIED + REPRODUCED, not that it sounds better — quality is the deferred audio-quality layer (Audiobox guard + ears → a future MERT-probe)._
