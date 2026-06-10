# 009 · THE PIT — the song as matter

**Thesis.** Direct response to user feedback on HEARTH v2: *"where did my daw go /
something 3d / rougher, weirder, less vibe-coded / I need my controls."* The DAW
skeleton (008's, intact: lanes, clips, chain, rack, transport, deeds, whisper line)
stays fully operational — and the empty stage between the lanes and the slabs becomes
**the pit**, where the song itself stands as matter: a raymarched obsidian mass,
kifs-folded and noise-bitten, that **slams on the beat**.

**The fiction, literally.** Moshi doesn't visualize your song — it *sculpts* it. The
mass is the track's sonic body. Heavier music = gnarlier matter. And the name does
double duty: the empty center of the DAW is a mosh pit, and the thing in it dances.

**The anti-vibe-coded rendering stack** (this is the point):
- **No gradients anywhere.** Diffuse light quantized to four bands through a 4×4
  Bayer ordered dither; hard-stepped rim light. The texture is demoscene, not
  Instagram.
- **Quarter-resolution buffer, nearest-neighbor upscaled** — chunky pixels on purpose
  (field-notes motif 5, obtainer/p1xelfool dust).
- **Animated on twos:** rotation and surface noise snap at 12 fps while the UI runs
  at 60 — the Spider-Verse "crunchy" pop from the earlier research, finally used.
- **Beat jolts:** every beat kicks a random rotation step (hard on the downbeat) +
  a squash; the mass never glides, it *lurches*.

**The unlock — the Rack sculpts it.** GRIT drives fold angle + surface noise
(jaggedness), AIR loosens the fold (drift), EPIC grows the mass. The neural
transform's invisible work finally has a body: drag a slider, watch the matter
change. RENDER flares it molten for a moment (re-imagining = re-smelting).

**The two non-negotiables.** REC = the mass **splits**, molten core showing through
the gap, room edges run hot (+ lime REC chip). Position = one full revolution per
8 bars + the lume playhead in the lanes + mono `BAR x.y`.

**Risks.** Fractal legibility: kifs folds can read as noise at small sizes — the
bounding-sphere cut (which also fixed an unbounded-fractal bug: kifs fills all of
space without it) doubles as the "carved chunk" look. Beat-sync without real audio
is a demo fiction; the engine's onset feed is the Wave-3 wiring.

**Steal even if killed.** The dither/posterize/on-twos rendering stack as Mosh's
house 3D style; rack-sculpts-the-centerpiece as the Color Rack's reason to exist.

---

## v2 (2026-06-10) — house style + engine link

- The PS2-crunch register born here is now codified in [HOUSE_STYLE.md](../HOUSE_STYLE.md)
  and applied lab-wide (user direction: the chrome was "too sleek" next to the mass —
  now: hard 1px seams, dither-speckle slabs, notched tracks, square thumbs, steps()
  motion, scanlines, sprite Moshi).
- **Engine link:** with `MOSH_LAB_FEED=1`, the page polls the companion server —
  real transport position replaces the demo clock, master meters drive energy,
  level flux drives the slam. `ENGINE ●` chip in the transport shows link state.
- **The song is geology:** each section reseeds the kifs fold — a different chunk
  of matter per section, so *where you are* is *what the rock looks like*.

## v3 (2026-06-10) — Y2K console correction + toy physics

- Chrome de-aged 20 years per user note (80s terminal -> 2000s console): scanlines
  killed, plastic bevels + block shadows, segmented SSX-style meters, press states,
  bounce motion. See HOUSE_STYLE v2.
- Mass: **faceted normals** (flat low-poly light) + **PS1 vertex wobble** on twos;
  fissures hardened into **embedded crystal shards** (treasure, not circuitry).
- **It's a toy now:** drag orbits the mass, a tap pokes it (jolt + squash).
- Moshi upgraded to the 3D component (010), bouncing with the beat beside the pit.

## v4 (2026-06-10) — the music's character, and hardening

- **GRIT grows reaction-diffusion ridges** — labyrinth contour-band displacement on
  the hide; valleys shade, crests catch light. GRIT 0 = smooth chunk, GRIT 100 =
  brain coral.
- **AIR bores hollows** — three seeded tunnels carved from the body; at high AIR you
  see the room straight through the song. Hollow mouths glow faint lime.
- **Slams eject collectible shards** (crash-crate energy): hard beats throw chunky
  lime debris that arcs, lands, and bobs as pickups — sweep your cursor to collect;
  the ◆ counter in the topbar pops. Pokes eject too.
- **Hardening pass** (user: "keeps glitching out in my preview panel"): the gallery
  ran 11 always-on WebGL iframes — past the browser's context cap, which kills the
  oldest contexts (the glitch). Gallery is now hover-to-run (posters at rest, ≤1 live
  page). Every GL page also gained context-loss recovery (preventDefault + clean
  reload-on-restore, retry when a context can't be created), MoshiBlob degrades to a
  face-only stub instead of crashing the page, and the pit buffer is capped at
  380×240 so huge windows can't balloon the raymarch.
