# HOUSE STYLE v2.4 — "Y2K console crunch": signal chain · plate pass · HUD restraint · no rectangles

*v2, 2026-06-10. The v1 chrome overshot the decade: scanlines + terminal-green mono +
`steps()` motion read **80s/90s Terminator/WarGames** ("boomer malaise"). The target
is **2000s console nostalgia — Crash Bandicoot / PS2-era game UI**: chunky, plastic,
bouncy, FUN. The world rendering (dithered chunky 3D) was right and survives intact.*

## The register, in one line

**A PS2 game, not a mainframe** — flat-shaded low-poly world at quarter-res, wrapped
in chunky plastic game-menu chrome that bounces when you touch it.

## The decade test (pin this)

| reads 80s terminal — BANNED | reads 2000s console — REQUIRED |
|---|---|
| CRT scanline overlays | clean pixels; the chunk IS the texture |
| hairline 1px seams | bold 2px outlines + drop-block shadows (`0 3px 0 #000`) |
| sharp 2px corners everywhere | chunky rounded plastic (~10px radius) |
| all-mono green type | big rounded display headers; mono only for values |
| `steps()` robotic motion | **bounce** — overshoot bezier, squash & stretch |
| thin-line sliders | **segmented block meters** (SSX boost-bar language) |
| static chrome | press states — buttons physically depress |
| screensaver centerpiece | a **toy** — drag it, poke it, it reacts |

## World rules (3D / canvas — unchanged from v1, plus two)

1. **Quarter-res buffers, nearest-neighbor upscale** (`image-rendering: pixelated`).
2. **Bayer-dithered band shading** (4–6 bands), no gradients, no bloom — emission is
   a brighter band, never a halo.
3. **Animate on twos** — geometry time snaps at 12 fps; inputs and HUD run at 60.
4. **NEW — faceted normals:** quantize the surface normal before lighting
   (`n = normalize(floor(n * 3.0 + 0.5) / 3.0)`) → flat-shaded low-poly facets,
   the Crash-era silhouette.
5. **NEW — vertex wobble:** tiny rotation jitter per on-twos tick — PS1 edges swim.

## Chrome rules (the game menu)

6. **Plastic slabs:** dark dither-speckle fill, ~10px radius, 2px solid edge ring +
   `0 3px 0 #000` block shadow + 1px inner top-light. Panels look pickup-able.
7. **Game buttons:** 2px outline, block shadow; `:active` = translateY(2px) + shadow
   collapse (the button depresses). REC is a big lime button that breathes by
   *scaling*, not glowing.
8. **Segmented meters everywhere a value lives:** lime blocks on a dark well
   (repeating-gradient blocks), chunky notch thumbs. No thin lines.
9. **Type:** heavy rounded display for names/sections (big, occasionally skewed for
   speed); tabular mono strictly for timecode/BPM/values. Crisp — PS2 HUDs were sharp.
10. **Motion:** every entry/press uses overshoot (`cubic-bezier(.34,1.56,.64,1)`-class)
    with squash & stretch. Nothing eases linearly; nothing steps.
11. **Moshi is a 3D component** — `MoshiBlob` (experiment 010): mini raymarched SDF
    blob, faceted + dithered like the world, cursor-tracking eyes, beat squash,
    poke-to-squish, REC ember. The 2D sprite is retired.

## The signal chain (v2.1) — one cable for every surface

User: *"all surfaces should be filtered in the same way — we can't have components
that are crystal clear right next to this. A general antialiasing 2000s pass."*

12. **Whole-page PS2 pass:** an SVG filter on `body` — 0.35px blur (composite-cable
    softness) + **16-step discrete posterize** per channel — so DOM text, plastic
    chrome and the quarter-res GL world all arrive through the same video path.
    16 levels keeps LIME #CCFF23 *exact* (0.8 → 12/15 = 0.8). Plus
    `-webkit-font-smoothing: antialiased` everywhere (no subpixel fringing).
    Canonical copy: `tokens/ps2-pass.css`; every experiment inlines it + the SVG.
    `html.raw` disables it (the SIGNAL·PS2 chip on 009 is the A/B switch).
    It is SIGNAL, not SCREEN: no scanlines, no vignette, no curvature — wrong decade.

13. **Earned polychrome (the one palette exception):** the centerpiece artifact may
    earn a banded thin-film fringe (lime→cyan→magenta, dither-quantized) at full
    spectral completeness — beauty as a reward for finishing the song (009 v5).
    Chrome NEVER gets it. Five colors everywhere else, always.

## The plate pass (v2.2) — "more 2000s, less modern" on the panels

User: *"I want all of the UI panels to look more 2000s, less modern."* What still read
modern: flat single-tone fills, uniform border-radius, quiet type. The cure (SSX/THPS
menu language), shipped as shared CSS per page:

14. **Skewed lime title plates** (`.plate`): every panel/section name is an italic-900
    parallelogram plate (skewX(-12°), ink-on-lime, block shadow). The wordmark too.
15. **Plastic gloss:** hard two-stop vertical gradient (light upper, dark lower, hard
    stop at ~44%) + 1px specular inner top line on panels, chips, buttons. CHROME ONLY —
    the world keeps flat dither.
16. **Chamfered corners:** a 45° clip-path notch on one corner of major panels (skip any
    panel that animates its own clip-path, e.g. 008's drawers).
17. **Boxed numerals:** values sit in recessed mono wells, bigger.
18. **Hazard strip:** 45° lime stripe accent on panel footers, sparingly.
19. **Faces live in the shader.** DOM glyphs floating over a raymarched body read as a
    sticker on glass (the "sore thumb"). Eyes/mouths are SDF decals lit by the same
    facet bands and dithered by the same Bayer — they squash, blink and tremble WITH
    the matter. DOM faces are allowed only as the no-GL degraded fallback. (MoshiBlob
    010: GLYPH default; SOCKET and VISOR variants on the workbench deck.)
20. **Presence orbs:** people/processes appear as small dithered 2D-canvas orbs
    (Bayer-checker banding, on-twos wobble) — crew with lime detail, rivals as fog
    whose size is the only signal (011 THE SCENE). Zero GL contexts.
21. **Bounded reroll:** every "random look" control draws from curated ranges so the
    result is different every time and ugly never (009's THE LOOK + ⟳ REROLL; fringe
    hues via iq's cosine palette, lime-anchored).
22. **Intensity follows the music.** Default state is CALM; slams, wobble, fringe and
    energy scale with a `wild` signal derived from the song (sections in demo, levels
    on the engine link). The chaos is earned, not constant.

## HUD restraint (v2.3) — "the acid green is a lot on my eyes"

23. **Translucent chrome:** panels are HUD glass over the world (`rgba` fills ~.45–.78),
    not solid slabs. Outline plates (lime border + lime text on 13%-lime fill) replace
    solid lime plates. Meters, waveforms, clip borders all run dimmer. Solid lime is
    reserved for REC and true alerts — the non-negotiables keep their voltage.
24. **Knobs, not sliders:** continuous values are 38px plastic rotaries (vertical drag,
    lime tick, boxed numeral below). Long slider tracks read 2010-flat; knobs read rack
    hardware.
25. **The SOUND owns the visuals.** Never surface look/style controls to the user —
    the arrangement (clips, spectral fill, sections) derives the look from bounded
    seeded ranges. Play with the visuals by playing with the music.
26. **CRT bloom in the signal chain:** a phosphor-halo stage (≈1.6px blur at 40% alpha
    merged under the source) before the soften+posterize. Text fuzzes like a good
    monitor, not like damage. "More 2002 than 2010."
27. **The centerpiece is an organism.** Organic smin-lobed silhouettes with sparse
    crystal accents beat dense fractal lattices — beauty by restraint. Beats ease the
    body (lerp ~0.26, small jolts); nothing snaps. Moshi idles unless addressed —
    REC heat is the one standing coupling.

## No rectangles (v2.4) — controls live where their consequences live

28. **The page is world + instruments.** Panels are a legacy of screens that had
    nothing better to anchor to. We do: every control floats AT the thing it affects —
    the rack orbits the artifact (anchored to its live screen radius, bobbing on twos),
    the chain hangs in the tail of the lane it processes, the topbar is a scrim whose
    instruments float free, lanes are ghosts. The only boxes on screen are clips,
    because clips are content. Shipped on 009 first; every new surface starts here.

29. **Every parameter reaches the artifact** — to different degrees, in different
    ways; some as macros of others (MIX = the dry/wet of the whole transform, NAM =
    crystal drive). Turning any knob should be *felt* in the stone. And consequence
    never becomes a chore: debris is spectacle, not collectibles.
30. **States morph, never snap.** Section geology crossfades (the last ~18% of a
    section glides into the next seed). Anything seeded that changes over time gets
    the same treatment.

## Why this is still anti-slop

Banded dither + flat facets physically can't produce the soft-gradient "vibe-coded"
look; bounce + press states make the UI feel like a *thing*, not a dashboard; and
every rule ports to SkiaSharp/SKSL for the Avalonia future.

## Status

- **Full v2:** 009 THE PIT (faceted + wobble + interactive + 3D Moshi), 010 MOSHI
  (the component workbench), 008 POSSESSION (chrome + 3D Moshi).
- **Scanlines removed lab-wide** (they were the wrong decade); 001–007 keep res-crunch
  + dither and adopt full v2 chrome as each is revisited.
- Engine feed: 009 carries the reference client (`MOSH_LAB_FEED=1`, port 47873).
- **Context discipline:** browsers cap WebGL contexts (~8-16). The gallery runs pages
  hover-to-live only; every GL page handles `webglcontextlost/restored`; components
  degrade gracefully when a context can't be created. Never ship an always-on grid
  of live GL iframes.
