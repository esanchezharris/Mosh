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

1. **Quarter-res buffers, nearest upscale** (`image-rendering: pixelated`), cap ~380×240.
2. **Bayer-dithered band shading** (3–4 bands), no gradients, no bloom in-shader —
   emission is a brighter band, never a halo.
3. **Animate on twos** — geometry time snaps at 12 fps; inputs and springs run at 60.
4. **Faceted normals** for lighting (`floor(n*2.5+0.5)/2.5`) — but **fresnel/rim from
   the SMOOTH normal**: faceted fresnel fires on interior planes and rains dither
   over the whole body.
5. **Vertex wobble:** tiny rotation jitter per on-twos tick — PS1 edges swim.
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

10. **Whole-page PS2 pass** (canonical: `tokens/ps2-pass.css`): phosphor bloom
    (≈1.6px halo at 40% under the source) → 0.5px soften → 16-step discrete
    posterize (keeps LIME #CCFF23 exact). DOM and GL arrive through the same cable;
    `html.raw` is the A/B. It is SIGNAL, not SCREEN: no scanlines, no vignette.
11. **ONE glow source.** Never add text-shadows or CSS glows on top of the chain —
    doubled bloom reads as inconsistency (the v13 lesson).

## The character (THE SYMBIOTE doctrine)

12. **Two channels, one being.** FACE = the agent: GLYPH chevron eyes (gaze, blink,
    startle-wide, sleepy lids), the one-dial open grin, the heat ember. BODY = the
    work: lobes, two displacement layers, skin, veins, palette. Neither channel
    ever touches the other's pixels. Heat/REC never moves matter.
13. **Faces live in the shader.** Eyes and grin are SDF decals lit by the same bands
    and dithered by the same Bayer — they squash, blink and gaze WITH the body.
    DOM faces only as a no-GL fallback.
14. **Body language is Blob Mixer's grammar** (14islands, credited): layer 1 = low-freq
    body waves (the gait), layer 2 = high-freq surface skin (the texture), both
    face-protected (their poleAmount). Personalities are NAMED FAMILIES à la their
    Discobrain/T-1000/Slimebag: a full material + temperament per name.
15. **The MORPH RULE.** States crossfade, never snap — and blends happen between
    FIXED endpoints only. Never re-derive (fract/sin/hash) from a blended value.
    **Corollary:** time-RATE parameters (wave speeds) cannot be lerped — integrate
    phases in JS (`phase += dt * rate`) and upload the phase, or the motion jumps
    when the rate changes.
16. **Idle life is the product.** Blink timers, saccade gaze wander, proximity
    affection, pet-purr, antics (shiver/stretch/glance/spin), sleep after neglect,
    startle wake. A character that only reacts is a widget.
17. **Bounded reroll.** Seeds jitter INSIDE a family's curated ranges — different
    every time, ugly never.

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

## Why this is still anti-slop

Banded dither + flat facets physically can't produce the soft-gradient "vibe-coded"
look; springs and squash make him a *thing*, not a dashboard; the palette families
are curated, not generated; and every rule ports to SkiaSharp/SKSL/Metal because
the register lives in the shader, not the DOM.
