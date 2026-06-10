# 001 · HEARTH — the stage centerpiece

**Thesis.** When you're not in passthrough, the screen shouldn't show you software — it
should show you *the inside of the thing that's fused to you*. HEARTH is Moshi's
dream-state filling the room: matte ink flesh, bioluminescent lime veins, breathing on
a ~7-second cycle. It earns the "fire / 2009 screensaver" role because it is genuinely
autonomous (it drifts and dreams with no input at all) but *leans toward the music*
the moment there is any.

**The fiction, literally.** You're looking *through* Moshi's body. The veins are its
nervous system; energy makes them run hot, brightness makes them whiter and denser,
a transient sends a pressure ring through the flesh.

**The two non-negotiables.**
- *Where am I:* a luminous front sweeps the field left→right once per 8 bars — you read
  position the way you read weather, peripherally. (Plus a tabular `BAR x.y` whisper.)
- *Am I recording:* HEARTH is the resting surface; recording hands off to the creature
  states (002). In a composed product the vein heat itself carries arm/record.

**Feel.** Calm, expensive, a little hypnotic. The thing you leave on the studio TV.

**Risks.** Must never become a "visualizer" cliché — the discipline is *slowness*:
nothing in HEARTH moves fast except when the music does.

**Steal even if killed.** The breathing cycle; the vein heat = energy mapping; the
bar-front as ambient position. All shader-portable (GLSL→SKSL 1:1).

---

## v2 (2026-06-09) — presence in fog

Rebuilt per [FIELD_NOTES](../inspiration/FIELD_NOTES.md) "what this changes" item 1.
What changed and why:

- **Veins-everywhere → ONE presence** (motif 3: MCHX17, sabosugi). A single mass,
  low in the frame, luminance *earned by energy*. It drifts in and out of bilateral
  symmetry — the fog almost resolves into a creature, then lets go. That oscillation
  is the new core mechanic: pareidolia as ambience.
- **Spectral fringe on the membrane** (motif 1: marioecg). Razor-thin, constant
  screen-width (`fwidth`), lime-white core splitting to a cyan whisper inside and
  magenta outside — *only* on the iso-edge. The streaks were deliberately separated
  from the fringe field: streaks rake the luminance, the fringe traces one clean
  membrane (first build had them coupled — instant "veins everywhere" relapse).
- **Heat opens the core** (specoolar). Recording doesn't brighten the mass — it
  inverts it: a true void wearing a doppler-bright accretion ring, pulsing 1.1 Hz.
  Unmistakable across a room, which is the whole job of a REC state.
- **Position = tide** — the fog leans toward the bar position once per 8 bars;
  the mono `BAR x.y` stays for the skeptic.
- Film-grain dither added (soft fields band horribly in 8-bit without it).

v1 (the domain-warped vein field) is preserved at [v1.html](../playground/experiments/001-stage/v1.html).
