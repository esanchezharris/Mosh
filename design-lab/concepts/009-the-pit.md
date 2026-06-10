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

## v5 (2026-06-10) — THE ARTIFACT (the user's thesis, made literal)

User: *"as a producer, as you build up the track you'll add more color and beauty…
as you fill out the spectral range you'll create a unique beautiful more complete
artifact, and the piece of music is tied to that artifact. As a rapper the beat would
be complete but subdued, and when you laid down your lines it would become vibrant."*

- **The arrangement feeds the stone.** Every lane carries a band (DRUMS/BASS → low,
  GTR/PAD → mid, VOX → high); clip coverage per band = spectral fill, smoothed so
  matter *accretes* rather than snapping. Topbar gains LOW/MID/HI segmented meters.
- **Growth mapping:** `u_complete` scales the whole SDF (0.45 → 1.0 — nugget to
  monument); lows add a slow heavy breath; mids densify the ridge labyrinth;
  highs drop the shard threshold (more crystal) + rim sparkle.
- **Earned light:** every lime emission term is scaled by completeness — an empty
  session is a *monochrome* nugget. Beauty arrives with the song.
- **Earned polychrome (the bold call):** at full highs, shard edges + grazing rim get
  a banded thin-film fringe (lime→cyan→magenta, dither-quantized). The artifact is
  the ONE surface allowed past the five-color palette — the reward for filling the
  spectrum. All chrome stays exact.
- **Unique stone per song:** the arrangement hashes into the fold seed (`u_aseed`) —
  change the clips, change the geology.
- **▶ BUILD** (topbar): strips the session bare, then lands clips lows-first every
  ~2.3s — the producer build — ending with the vox hook: the bloom. ↺ resets.
- **Engine link:** completeness = active-track count from the levels feed (no
  per-band data in the feed yet; honest proxy).
- **The rapper story holds:** beat-only session (DRUMS+BASS+GTR live, VOX muted)
  reads complete-but-subdued — full mass, half light, no fringe. Punch the vox in
  and it goes vibrant. Same mapping, no special case.

## v6 (2026-06-10) — chill default · THE LOOK · bounded reroll

User: *"it honestly is a bit much right now — I kinda liked it when it was more chill,
but if somebody's making a super crazy song it may well look like that… there should be
a degree of customization by the user but also a real randomness that still looks
beautiful every time. Feel free to borrow other people's ideas online."*

- **The violence budget follows the MUSIC (`wild`):** the demo song has dynamics now
  (calm INTRO/OUT, hard HOOKs via `SECT_WILD`); engine mode follows real levels. `wild`
  scales beat-slam strength, rotation jolts, PS1 wobble amplitude, fringe intensity,
  and the energy floor (down from 0.30 to 0.14). A quiet track = a calm beautiful
  stone; a banger earns the chaos.
- **THE LOOK** (second rack section): FORM (blend toward a gyroid-carved lattice —
  the classic TPMS implicit `dot(sin p, cos p.yzx)`, shadertoy canon), WEAR (erosion
  bite), LUME (light budget on all emission), HUE (fringe family). Persists in
  localStorage.
- **⟳ REROLL** — seeded LCG over **bounded ranges** (form ≤ 0.6, wear 0.2–0.8, lume
  0.7–1.4, hue free, ±small geology offsets into the kifs rotations). Different every
  time, ugly never — the register does the rest. SEED readout on the plate.
- **Fringe hues via iq's cosine palette** (`a + b·cos(2π(c·t + d))`,
  iquilezles.org/articles/palettes — c integer for clean cycling, d anchored so HUE=0
  band-0 is LIME). One knob now spins an infinite family of harmonious iridescence
  instead of one fixed cyan/magenta.
- Borrowed-and-credited: iq cosine palettes, gyroid/TPMS implicit; smin/onion operators
  reviewed (iquilezles.org/articles/distfunctions) — onion shells considered, parked.

## v7 (2026-06-10) — ORGANISM · the sound owns the look · HUD

User notes: beats "less jerky"; Moshi idles (no beat coupling); "less visually busy…
maybe organic looking, like Moshi himself"; acid green "a lot on my eyes" — declutter,
HUD-like, knobs not sliders; visual controls should NOT be surfaced ("they should play
with the visuals by playing with the sound"); fuzz the crystal-clear text — CRT,
tastefully; "more 2002 than 2010."

- **ORGANISM base:** the silhouette is now seeded smin lobes — Moshi's grammar grown
  large; the kifs fold survives only to decide where the veins run. Sparse crystal
  (fissure exp 70→95, higher shard/vein thresholds), bigger calmer facets (2.5),
  tighter fringe zone. The stone reads as a BODY with kintsugi seams.
- **Beats subtle:** rotation jolts halved and eased (0.26 lerp, no snap), slam squash
  0.22→0.10, onset envelope reduced. Moshi idles — REC heat is the only coupling left.
- **THE LOOK panel is gone.** The arrangement hash derives form/wear/lume/hue/geology
  from bounded ranges on every respec — change the clips, change the stone. The sound
  is the only visual instrument.
- **Knobs replace sliders** in CHAIN and THE RACK (38px plastic rotaries, vertical
  drag, lime tick) — panels shrink to 210/250px.
- **HUD declutter:** translucent panels over the world, outline plates instead of
  solid lime, dimmed waveforms/meters/borders.
- **CRT in the signal chain:** a phosphor-bloom stage (1.6px halo at 40% merged under
  the source) + 0.5px softening before the posterize — text fuzzes tastefully.

## v8 (2026-06-10) — NO RECTANGLES: controls live where their consequences live

The HUD idea taken to its end state: the page is **world + instruments**.

- **THE RACK orbits the artifact.** GRIT/AIR/EPIC are free-floating knobs on an arc
  around the mass — anchored to its *actual screen radius*, so the controls breathe
  with the thing they sculpt (nugget = tight orbit, monument = wide). They bob on
  twos. RENDER and the whisper ride the lower arc.
- **THE CHAIN hangs off its lane.** NAM/MIX are mini knobs in the tail of the VOX
  lane body — the insert lives ON the thing it processes.
- **The last rectangles dissolved:** the topbar is a scrim gradient (its instruments
  float), lane heads are floating names, lane bodies are 16%-alpha ghosts. The only
  boxes left are clips — and clips are content, not chrome.
- Verified: orbit widens with completeness; knobs drag correctly while orbiting
  (pointer events float above the stage); console clean.

## v9 (2026-06-10) — the secondary artifact · every param reaches the stone

User: the artifact "looks so fucking cool… but it's kind of a mess right now"; kill the
pickup mechanic; actually try the transparent workflow; "it might not be our
centerpiece anymore — it might be our secondary artifact"; "ALL of our parameters
should affect this thing… some can be macros of others"; smooth the section
transitions.

- **The artifact steps aside.** It now lives in the right-lower quadrant — the kiln
  beside the workbench. The arrangement owns the page; the orbit rides along.
- **Every parameter reaches the stone:** GRIT/AIR/EPIC sculpt (as before), spectral
  fill feeds, wild drives violence, REC splits — and now **NAM drives the crystal
  hotter** (emission ×0.72–1.27) and **MIX is the macro**: the dry/wet of the whole
  re-imagine — at 0 the plain rock (form/wear/geology-offsets zeroed, lume floor),
  at 1 fully transformed. Different degrees, different ways, macros of others.
- **Section transitions morph.** u_sect is continuous; the last 18% of each section
  crossfades its geology seed into the next (wrap-aware) — the stone glides between
  forms instead of snapping. The remaining section jolt is a small accent.
- **The pickup mechanic died.** Slams still chip shards off the artifact — they arc,
  land, and fade. Consequence without chores. The ◆ counter is gone.
- **Transparency, actually tried:** clips at 55% alpha, lanes ghosts, no panels.

## v10 (2026-06-10) — THE LISTENER · the real voice · the de-glitched morph

- **The lab hears.** Drop any audio file on 009 (or hit ♪ LOSERFACE for the bundled
  track) and an AnalyserNode drives everything for real: 3-band energy → spectral
  fill, low-band flux → slams, track position → the playhead. Priority:
  TRACK > ENGINE > DEMO. Verified live against LoserFace.wav (99.6s): bands
  l/m/h = .85/.97/.97 at the drop.
- **The morph glitch, diagnosed and fixed:** v9 derived `sd2 = fract(sd·91.7)` from
  the *blended* seed — fract wraps ~92 times across the crossfade, spraying
  discontinuities. Rule: blend derived seeds between FIXED endpoints, never derive
  from a blend. Window widened to 25%, section jolt removed entirely.
- **The display voice:** Nanum Square Round (user-supplied, OFL) — rounded-square
  2000s console type, lab-wide (EB=800/B=700, canonical stack in tokens/moshi.css).
- Philosophy formalized: [seeded-geology.md](seeded-geology.md) (per the
  algorithmic-art skill's discipline; expressed in the 009 shader, not p5).
- Parked next: a bitmap face for HUD numerals from ianhan/BitmapFonts (user link);
  the real per-band engine feed in src/ (user approved).
