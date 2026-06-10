# HOUSE STYLE v1 — "PS2 crunch"

*Decided 2026-06-10 from user direction: "chunky pixelation… nostalgic PlayStation 2
vibe… I kind of wish more of it matched the centerpiece's retro gaming console
sensibility. It just looks very sleek on every other surface." This is the register
for ALL lab surfaces until revised. Born in [009 THE PIT](concepts/009-the-pit.md).*

## The register, in one line

**Low-poly chunk + crisp HUD** — chunky dithered 3D the way a PS2 drew it, with sharp
mono text on top, exactly the way PS2 games drew *their* HUDs. No soft glows anywhere.

## Rules

### 3D / canvas surfaces (the world)
1. **Quarter-resolution buffers, nearest-neighbor upscale** (`canvas { image-rendering:
   pixelated }`, internal res = viewport/4; canvas-2D scenes may use /2 to keep
   in-canvas text legible).
2. **No gradients in shading.** Quantize to 4–6 bands through a **4×4 Bayer ordered
   dither** (the `bayer(gl_FragCoord.xy)` helper in 002/009). Posterize-with-dither at
   the end of the shader is the cheap retrofit: `col = floor(col * N + bayer) / N`.
3. **Animate on twos:** geometry/texture time snaps at **12 fps** (`floor(t*12)/12`)
   while input params and the HUD run at 60. Things lurch; they never glide.
4. **No bloom, no shadowBlur.** Emission is a brighter band, not a halo.

### Chrome (the HUD)
5. **Text stays crisp** — vector mono/display type is period-correct (PS2 HUDs were
   sharp over chunky worlds). Don't pixelate type.
6. **Hard edges:** 1px solid seams (`--seam: 0 0 0 1px #232812`-class), border-radius
   ≤ 3px, **zero box-shadow glows**.
7. **Dither fills on slabs:** 3px lime-speckle (`radial-gradient` dot grid) instead of
   flat fills.
8. **Square slider thumbs**, notched tick tracks (repeating-linear-gradient).
9. **UI animation in steps():** pulses `steps(2)`, entries `steps(4)`. Nothing eases
   smoothly.
10. **Scanline overlay** on every surface: 1px black @ 3px pitch, ~18% — the cheapest
    cohesion device in the whole register.
11. **Moshi is a sprite:** drawn into a ~46×40 buffer, pixel-snapped polygon, rect
    eyes/mouth, upscaled pixelated. No glow; state = outline color + mouth height +
    1-bit flicker.

## Why this register is RIGHT for Mosh (not just nostalgia)

- It's **anti-slop by construction** — the "vibe-coded" look is soft gradients +
  bloom; banded dither physically can't produce it.
- It's **honest about machinery** — quantization shows the grid, which suits a tool
  that says "there's a creature in the machine."
- It's **cheap and portable** — every rule above is trivial in SkiaSharp/SKSL
  (the Avalonia path), and quarter-res raymarching is laptop-friendly.
- It ties to the field notes: motif 5 (dither dust), riomadeit's CRT/WMP nostalgia,
  obtainer's RGB scatter.

## Status

- **Full treatment:** 009 THE PIT, 008 POSSESSION (chrome), 002 SPECIMEN, 001 HEARTH v2.
- **Light pass (res-drop + scanlines):** 003, 004, 006, 007. 005 scanlines only
  (DOM goo study — re-render in canvas when revisited).
- **Engine feed:** 009 carries the reference client (poll `127.0.0.1:47873`,
  `MOSH_LAB_FEED=1`). Copy it into other experiments as they're revisited.
