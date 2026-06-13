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
- **v3 — HE GETS A MIND (and 60fps)** (2026-06-12, workflow-reviewed): the user's
  frame drops were a 12Hz pose-update bug (rotation easing lived on the on-twos
  clock) + the page filter re-rasterizing the animating canvas — fixed (full-rate
  easing; the cable now carries chrome only; lobe math hoisted to CPU uniforms;
  displacement gated to the near field; rect caching; preserve/alpha context
  flags). The face moved ONTO the body (drag him, it goes with him; he eases
  home and his eyes counter-rotate to keep watching you). Gaze became ATTENTION
  (viewer-default, earn-a-glance, deliberate snubs, habituation, ballistic
  saccades, eyes-lead-body-follows, blink-as-punctuation). Pokes became a
  REPERTOIRE (startle-hop / squash-oof / double-take / delight-bounce,
  temperament-weighted) with escalation to genuine annoyance; petting forgives.

## The poses (the body's vocabulary)

| pose | reads as | fires on |
|---|---|---|
| NEUTRAL | at rest | base (IDLE-class states) |
| SPLAY | startle! limbs flare wide | startle-hop poke, real startle |
| ARMS_UP | a take landed | celebrate(), delight-bounce poke |
| TUCK | oof — short and chubby | squash-oof poke |
| DROOP | everything sags | SLEEPING base, annoyance |
| WAVE | one arm up, wiggling | manual / greetings |
| REACH | an arm extends toward the thing | double-take poke, cursor glances |

Poses crossfade per the MORPH RULE and auto-return to the state's base pose.
`m.setPose(name, hold)` — REACH/WAVE mirror to whichever side he's looking.

- **v4 — THE SPLAT PASS** (2026-06-12): the body returned to the brand
  silhouette (user reference images): a core + five capsule limbs in the camera
  plane, z-flattened — the same topology as their web-Claude artifact. POSES
  shipped (above) wired into pokes/states/celebrate; drag-spin INVERTED to
  grab-the-surface (body follows the cursor); the STYLE dial added (PS2 crunch
  ↔ TOON: dither starved, 2 clean bands, smooth normals, dark outline — the
  sticker look); the mouth got its gleam. Brain demo decision: provider-
  agnostic OpenAI-compatible client (`MOSHI_BRAIN_URL/_KEY/_MODEL` — DeepSeek
  or OpenAI keys both fit), built when a key lands.

- **v5 — IN THE ROUND** (2026-06-12, user notes): the pancake died — limbs
  live in 3D at rest (seeded fore/aft tilts, mild flatten, absorbed lengths)
  and SNAP FLAT into the sticker plane when he emotes ("a 3D blob guy who
  emotes in 2D when he needs to get it across" — the user's settled design).
  Three live ANATOMY variations on the ANAT chip (A: 3D blob w/ flat emotes ·
  B: always volumetric · C: sea-star max contrast) for the user to pick by
  eye. The static-center disconnect fixed: the core LEANS into poses and
  breathes with them, pose energy reaches the face (eyes widen, grin lifts,
  the whole face rides the lean), the body goes gooier at rest. The face went
  BIG like the reference art (eyes ~37% larger, mouth ~27%). Motion moved to
  SECOND-ORDER DYNAMICS (t3ssel8r's procedural-animation controller,
  credited) — per-pose frequency/damping, natural overshoot/settle, smooth
  interruption, pose queueing — the fix for "jerky transitions". The oil
  border thinned (edge fill + thin outline ring). Stage defaults = the user's
  frontrunner: STYLE·TOON at RES·PS2+ on the PS2 signal cable.

- **v6 — FLUID & FACE-ON** (2026-06-12, user notes): rotation rebuilt as
  yaw+pitch (was yaw + in-screen roll, which read inverted on his left side) —
  consistent both sides, grab-the-surface, face-on like the reference art. The
  confusing mouth "dot" (the gleam) removed. The face stopped being static:
  slow grin/eye breath, gaze micro-tremor, bigger gaze travel, pose energy
  widening eyes + lifting grin. The pose engine became a momentum-preserving
  VECTOR second-order system (the per-change reset was the jerk) with
  impact-frame SEQUENCES — pokes now anticipate (a TUCK wind-up) then hit the
  peak (SPLAY/ARMS_UP) then settle, the user's "transition to a state and back"
  idea. `m.playSeq` internal; `setPose` unchanged.
- **v7 — TWO NEW RENDER LANGUAGES** (2026-06-12, user refs: point-e + Gaussian
  splats, and the Humongous baked-lighting adventure games): the STYLE dial
  grew from 2 to 4. **POINTS** — point cloud / Gaussian splat: the lit surface
  becomes soft jittered dots whose size tracks shading (lit = solid, shadow =
  sparse), bg through the gaps; Moshi literally being a splat, it fits. **BAKED**
  — Putt-Putt / Pajama Sam soft baked lighting: smooth wrap key + cool fill,
  SDF ambient occlusion in the crevices, warm/cool split, value lifted to
  friendly clay, no dither. Render-only (`u_mode`); anatomy/poses/face
  unchanged. `m.setStyle('ps2'|'toon'|'points'|'baked')`; STYLE chip cycles all four.

## Adding a look

Append to `LOOKS` in `playground/index.html`: `{ p: FAMILY, sd: seed, st: STATE,
cap: 'the point, in one line' }` — then add the row here. A look earns its page
by showing something no other page shows.
