# HOUSE STYLE v3.0 — THE MOSHI PASS: one character, one register

*v3, 2026-06-12. The DAW-era chrome rules (plates, panels, lanes, instruments —
v2.0–v2.4 rules 6–32) retired with the UI they styled; git history keeps them.
What survives is everything that makes the CHARACTER: the world crunch, the
signal chain, the face doctrine, the morph rule — plus the new color doctrine
and two hard-won render-honesty rules.*

## The register, in one line

**A PS2 creature, not a screensaver** — a raymarched being, flat-shaded and
dithered at quarter-res, who happens to be alive.

## The decade test (pin this)

| reads 80s terminal — BANNED | reads 2000s console — REQUIRED |
|---|---|
| CRT scanline overlays | clean pixels; the chunk IS the texture |
| all-mono green type | rounded display face (NanumSquareRound); mono for values |
| `steps()` robotic motion | **bounce** — springs, squash & stretch |
| screensaver centerpiece | a **toy** — poke it, pet it, spin it, it reacts |
| default-sinister | cute with range; the music earns the menace |

## World rules (the crunch)

1. **Low-res buffers, nearest upscale** (`image-rendering: pixelated`) — on the
   CONSOLE DIAL: PS1 = /4 cap 380×240, **PS2 = /3 cap 512×336 (the default —
   user note 2026-06-12: quarter-res "looks PS1-ish")**, PS2+ = /2 cap 720×450.
2. **Bayer-dithered band shading** (3–4 bands), no gradients, no bloom in-shader —
   emission is a brighter band, never a halo.
3. **Animate on twos** — geometry time snaps at 12 fps; inputs and springs run at 60.
4. **Faceted normals** for lighting (`floor(n*2.5+0.5)/2.5`) — but **fresnel/rim from
   the SMOOTH normal**: faceted fresnel fires on interior planes and rains dither
   over the whole body.
5. **Vertex wobble scales INVERSELY with the dial:** full swim at PS1, 0.45× at
   PS2, 0.15× at PS2+ — the swim is the PS1 tell; PS2 geometry was subpixel-stable.
   Dither, bands and facets stay at every tier.
6. **Floor the dither coords.** `gl_FragCoord` sits at pixel CENTERS (x.5) — an
   un-floored Bayer matrix tops out at 1.31, and every `floor(x + dth)` then fires
   at x=0 in a column lattice. (This bug shipped quietly in every artifact since
   THE PIT v1; THE MOSHI PASS finally cornered it.)
7. **Dither needs a body under it.** A `floor(x*k+dth)` band promotion must land ON
   a visible surface — if the floor band is near-black, the promoted pixels read as
   rain on void, not texture. Keep the darkest band visible.
8. **Lines come from fields with gradient.** Thin features (veins) are iso-curves of
   a NOISE field, never near-zero thresholds of a fold/crack field — fold fields sit
   flat in wide basins and any threshold (or iso-shell) dithers the whole basin.
9. **Step-starved rays are surface.** A raymarcher that exhausts steps while grazing
   must hit at its closest approach, not fall through to the background — or the
   room paints through the body.

## The signal chain — one cable for every surface

10. **The PS2 pass carries the CHROME** (canonical: `tokens/ps2-pass.css`): phosphor
    bloom (≈1.6px halo at 40% under the source) → 0.5px soften → 16-step discrete
    posterize (keeps LIME #CCFF23 exact); `html.raw` is the A/B. It is SIGNAL, not
    SCREEN: no scanlines, no vignette. **The GL canvases live OUTSIDE the filtered
    subtree** (v3 perf rule): a filter wrapping an every-frame-animating canvas
    re-rasterizes the entire page through the chain per frame at device resolution —
    Chromium only caches filtered subtrees that hold still. The world's crunch is
    in-shader (dither, bands, facets), so it never needed the cable. Set the filter
    region to 0%/100% (the default −10%/120% allocates 1.44× the pixels).
11. **ONE glow source.** Never add text-shadows or CSS glows on top of the chain —
    doubled bloom reads as inconsistency (the v13 lesson).

## The character (THE SYMBIOTE doctrine)

12. **Two channels, one being.** FACE = the agent: GLYPH chevron eyes (gaze, blink,
    startle-wide, sleepy lids), the one-dial open grin (+ family tilt, + the tongue
    at full open), the heat ember. BODY = the work: lobes, two displacement layers,
    skin, veins, palette. Neither channel ever touches the other's pixels.
    **Corollary — agent STATES may LIGHT the body, never deform it:** the ember
    and the flow bands (LISTENING/RENDERING) are light; matter belongs to the work.
    States are bundles (face pose + tempo + light), they crossfade, and idle life
    (blinks, saccades, antics, lobe migration, sleep) is the IDLE state's business.
13. **Faces live in the shader.** Eyes and grin are SDF decals lit by the same bands
    and dithered by the same Bayer — they squash, blink and gaze WITH the body.
    DOM faces only as a no-GL fallback.
14. **Body language is Blob Mixer's grammar** (14islands, credited): layer 1 = low-freq
    body waves (the gait), layer 2 = high-freq surface skin (the texture), both
    face-protected (their poleAmount). Personalities are NAMED FAMILIES à la their
    Discobrain/T-1000/Slimebag: a full material + temperament per name.
    **Second credit line (2026-06-12):** the user's web-Claude SYMBIOTE LAB
    artifact contributed limb MIGRATION (lobes relocate/swap/scatter, tucking in
    while they travel), the liquid FLOW bands (re-cast as quantized state-light),
    the mouth tilt, and the tongue. Steal from anything good; write down where.
15. **The MORPH RULE.** States crossfade, never snap — and blends happen between
    FIXED endpoints only. Never re-derive (fract/sin/hash) from a blended value.
    **Corollary:** time-RATE parameters (wave speeds) cannot be lerped — integrate
    phases in JS (`phase += dt * rate`) and upload the phase, or the motion jumps
    when the rate changes.
16. **Idle life is the product.** Blink timers, saccade gaze wander, proximity
    affection, pet-purr, antics (shiver/stretch/glance/spin), lobe migration,
    sleep after neglect, proximity-gated startle wake. A character that only
    reacts is a widget.
16a. **ATTENTION is a decision, not a servo.** He watches the VIEWER by default
    (long center-biased holds); the cursor must EARN a glance by passing near him
    with speed; glances are brief and end with a return-to-you plus a cooldown;
    sometimes he pointedly ignores it — the snub sells sentience. Habituation
    dulls repeated stimuli. Saccades are BALLISTIC (a ~90ms burst, then a held
    fixation — eased drift reads dead); big saccades carry a blink and the body
    follows the eyes a beat later. (Sources: Eyes Alive SIGGRAPH '02 gaze
    statistics; PS2-era mascot idle ladders.)
16b. **The face is ON the body.** Drag him and the face goes with him — a
    view-anchored face breaks the object illusion. He *wants* to face you:
    rotation eases home (nearest full turn) when released, and the eyes
    counter-rotate to hold your gaze while the body is swung away.
16c. **Reactions are a repertoire, never a button.** A poke draws from
    temperament-weighted reactions (startle-hop, squash-oof, double-take,
    delight-bounce) and ESCALATES under spam — real startle, then genuine
    annoyance (squint, sulked grin, turned back, 6s of ignoring you). Petting
    forgives. The same input producing the same output is a vending machine.
16d. **THE SPLAT is the anatomy; POSES are its vocabulary.** The brand
    silhouette is a core + five gooey limbs (left arm, head, right arm, two
    legs). **He is 3D at rest and 2D when he speaks:** limbs carry seeded
    fore/aft tilts and sit absorbed in a round blob; emoting extends them and
    flattens everything into the sticker plane (he's on a 2D screen — the
    flat pose is how he projects). The core is never static: it leans into
    poses, breathes with them, and pose energy reaches the face (eyes widen,
    grin lifts, the face rides the lean) — one organism, no ball-with-arms.
    Poses blend per the MORPH RULE and return to the state's base.
16d′. **Motion is second-order dynamics** (t3ssel8r, credited): every pose
    transition runs through an f/ζ channel — anticipation, overshoot, settle,
    and smooth interruption for free. Per-pose temperament (startle snappy
    and underdamped; droop slow and overdamped). New triggers within 140ms
    queue instead of snatching. Hand-tuned smoothsteps are retired for
    anything the user watches move.
16e. **Drag is grab-the-surface.** The body follows the cursor under drag —
    the opposite mapping reads inverted (user note, 2026-06-12).
17. **Bounded reroll.** Seeds jitter INSIDE a family's curated ranges — different
    every time, ugly never.

## The STYLE dial (v4)

The register has TWO sanctioned renders, both in-shader: **PS2** (the default
crunch — dither, facets, banded light) and **TOON** (the sticker: dither
starved to 8%, two clean bands, smooth normals, crisp dark outline — the
user's flat reference art). The dial crossfades; everything else (anatomy,
poses, palettes, face) is identical across both.

## Color doctrine (v3.0 — the body goes polychrome)

18. **World and chrome stay ink + lime** (`tokens/moshi.css`, exact). Solid lime is
    reserved for REC-class signals.
19. **The BODY gets family palettes:** each personality carries its own iq cosine
    palette, rendered through the same bands and dither — Blob Mixer's gradient
    materials, our crunch. Iridescence = view-dependent palette shift; clearcoat =
    one hard white glint band.
20. **Lime is the brand constant on the body:** veins, ember, grin, and hot eyes are
    lime in EVERY family — the agent always shows through the material.

## The component doctrine

21. **Component-first.** Moshi ships as one self-contained file (`playground/moshi.js`)
    with semantic drives (`energy/mood/heat`) — never wired to transports, meters, or
    agent internals. Hosts feed scalars; the seam stays swappable.
22. **Size-adaptive:** the same component from presence-orb to centerpiece; resolution
    scales with the canvas, behavior is identical.
23. **Context discipline:** browsers cap WebGL contexts (~8–16). Handle
    `webglcontextlost/restored`; never ship an always-on grid of live GL instances.
24. **The pose updates at full frame rate; the CRUNCH stays on twos.** Quantizing
    user-driven rotation to the 12fps clock reads as dropped frames no matter how
    fast the GPU is — the wobble and texture clock keep the cadence, the easing
    does not. Corollaries: hoist frame-constant shader math (lobe centers, rotation
    matrices) to CPU uniforms — recomputing them per map() per step per pixel
    wastes ~10⁸ trig ops/frame; no layout reads (getBoundingClientRect) in the
    render loop — cache rects on resize/scroll; `preserveDrawingBuffer` off
    (defeats tile-discard on Apple Silicon) and opaque context when he owns the
    frame.

## Why this is still anti-slop

Banded dither + flat facets physically can't produce the soft-gradient "vibe-coded"
look; springs and squash make him a *thing*, not a dashboard; the palette families
are curated, not generated; and every rule ports to SkiaSharp/SKSL/Metal because
the register lives in the shader, not the DOM.
