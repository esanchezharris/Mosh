# THE LOOKBOOK — the catalog of who Moshi can be

*Curation over sliders (the user's call, 2026-06-12): a numbered, captioned walk
through personality × state × seed beats a panel of ranges. Every page is an
opinion. The live book is `playground/index.html`; this file is its record.*

## The looks (the current walk)

| # | family | state | the point |
|---|---|---|---|
| 01 | TAR | IDLE | THE CANONICAL — everyone starts here. obsidian, lime-veined. |
| 02 | TAR | RECORDING | REC lives in the face: ember + hot eyes. the matter never flinches. |
| 03 | DISCO | LISTENING | the flow runs through him while the track plays. he nods. |
| 04 | MOLTEN | IDLE | heavy gold. the patience of a planet. |
| 05 | GHOST | PAUSED | held breath — lids low, eyes down. the world can wait. |
| 06 | SILK | SLEEPING | pearl at rest. the waves slow to tide. |
| 07 | BREAKS | RECORDING | punched in and running hot. |
| 08 | CHROME | RENDERING | cooking — the work churns under the skin as light. |
| 09 | BUBBLE | IDLE | poke him. you know you want to. |
| 10 | PORCELAIN | IDLE | the paper look: bone body, ink eyes. lime keeps the grin. |
| 11 | DISCO seed .87 | IDLE | same family, different child — R rerolls inside the lines. |
| 12 | TAR | LISTENING | even obsidian moves when the music is on. |

Controls: ◀ ▶ / wheel turn pages · state chips re-pose the current look ·
**R** rerolls the seed · **C** = a take lands (celebrate) · click poke · hold pet ·
drag spin · RES chip walks the console dial · SIGNAL chip A/Bs the PS2 cable.

## The states (the agent's repertoire)

Doctrine: a state may **light** the body (flow bands, ember) and pose the face —
it never deforms the matter. `m.setState(...)`; hosts can override drives after.

| state | face | tempo | light | life |
|---|---|---|---|---|
| IDLE | resting grin, saccade wander | 1.0 | — | blinks, antics, lobe migration, sleeps if ignored |
| LISTENING | holds your eye, grin up | 0.9 | slow flow bands | nods on a 2s sine |
| RECORDING | ember core, lime eyes, fewer blinks | 1.0 | ember | gaze locked, antics off |
| PAUSED | lids 40%, eyes drift down | 0.45 | — | rare twitch — waiting, not sleeping |
| RENDERING | lids 55% (working with eyes closed) | 0.7 | fast flow + faint ember | occasional shiver |
| SLEEPING | lids 85% | 0.3 | — | auto after 45s ignored; any touch wakes |

One-shot: **`m.celebrate()`** — a take landed: double bounce, spin flair, grin
maxed, tongue out, veins flash. ~1.5s, then back to whatever he was doing.

## The families (nine, each a material + a temperament)

| family | material | temperament |
|---|---|---|
| TAR | neutral obsidian, full lime veins | the canonical; even keel |
| DISCO | rainbow palette, irid .9 | quick, blinky, restless .9 |
| MOLTEN | gold, glint .95 | slow, certain, restless .2 |
| GHOST | violet drift, big soft waves | airy, drifty |
| SILK | pearl swells, barely any skin | calm, level grin |
| BREAKS | rust-fire, choppy skin | fastest everything; cockiest mouth tilt |
| CHROME | cold silver, glint 1.0, fine ripple | precise |
| BUBBLE | aqua-green goo, springy k | bounciest spring, playful |
| PORCELAIN | bone body, **ink eyes** | still; the figurine |

Seeds jitter inside a family's curated ranges — different every time, ugly never.

## The console dial

| tier | buffer | wobble | reads as |
|---|---|---|---|
| PS1 | ≤380×240, /4 | 1.00 | the chunk; vertices swim |
| **PS2** (default) | ≤512×336, /3 | 0.45 | crunchy but composed — the target decade |
| PS2+ | ≤720×450, /2 | 0.15 | the screenshot tier; dither goes fine-grain |

Wobble scales inversely with fidelity: vertex swim is the PS1 tell — PS2 had
subpixel-stable geometry. Dither, bands and facets stay at every tier.

## The steals (credited)

- **14islands' Blob Mixer** (blobmixer.14islands.com, source via
  github.com/connorhvnsen/blob-mixer): the two-layer displacement grammar +
  named personality presets — the founding body-language steal (v1).
- **The user's web-Claude "MOSHI · SYMBIOTE LAB" artifact** (2026-06-12): four
  steals taken with thanks — **limb migration** (lobes that relocate, swap
  slots, and scatter, tucking in while they travel), **liquid flow bands**
  (distance/flow streaks, re-cast here as quantized state-light), **mouth
  tilt** (the family lean), and the **tongue**. Its GHOST preset (light body,
  dark face) inverted into our world as PORCELAIN.

## The record

- **v1 — THE MOSHI PASS** (2026-06-12, commits `a73f3e7`/`2d4ef28`): scorched
  earth; the component + stage born; 8 families; the column-lattice render bug
  (un-floored `bayer()` coords — latent since THE PIT v1) cornered and fixed,
  along with step-starvation fall-through and flat-field vein thresholds.
- **v2 — THE LOOKBOOK** (2026-06-12): agent states + celebrate; flow bands;
  lobe migration; mouth tilt + tongue; PORCELAIN; the console dial (PS1/PS2/PS2+,
  default moved off PS1-res to PS2); the stage became this catalog.

## Adding a look

Append to `LOOKS` in `playground/index.html`: `{ p: FAMILY, sd: seed, st: STATE,
cap: 'the point, in one line' }` — then add the row here. A look earns its page
by showing something no other page shows.
