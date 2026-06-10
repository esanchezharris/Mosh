# HOUSE STYLE v2 — "Y2K console crunch"

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
