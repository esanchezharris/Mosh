# Mosh Design Lab

The workspace where Mosh's next-generation interface — the **Moshi symbiote** premise —
is generated, browsed, critiqued, and promoted. The app build (`/src`, `/ui`, CMake) is
deliberately untouched by anything in here: the lab is upstream of the product.

> The interface is not an app you look at. It's what the world looks like when a
> creature that happens to be a world-class audio engineer is riding along inside
> your senses. See [BRIEF.md](BRIEF.md) — the canonical seed for every concept.

## Map

| path | what |
|---|---|
| [BRIEF.md](BRIEF.md) | The fiction + hard constraints. Feed it whole to any designer, human or model. |
| [TOOLS.md](TOOLS.md) | The surplus: every design tool wired into this environment and when to reach for it. |
| [tokens/moshi.css](tokens/moshi.css) | Canonical palette + type. Exact values are a constraint. |
| [HOUSE_STYLE.md](HOUSE_STYLE.md) | **The register: Y2K console crunch (v2.2).** Dithered faceted world + plate-pass chrome (skewed lime plates, plastic gloss, chamfers) + the whole-page PS2 signal chain ([tokens/ps2-pass.css](tokens/ps2-pass.css)) — and the decade test that keeps it 2000s, not 80s. |
| [inspiration/INDEX.md](inspiration/INDEX.md) | ~150 reference links, identified and tagged by theme. |
| [playground/](playground/) | Vite app. **THE one main view** (index.html) — self-contained HTML. |
| [concepts/](concepts/) | One-pager per named design direction: thesis, how it meets the constraints, what to steal. |
| [avalonia/NOTES.md](avalonia/NOTES.md) | The native-surface translation path (web prototype → Avalonia/SkiaSharp). |

## Run THE VIEW

```sh
cd design-lab/playground
npm install   # first time only (vite is the only dep)
npm run dev   # → http://localhost:5180 — the one main view
```

## ONE MAIN VIEW (consolidated 2026-06-10)

The experiment pages (007–011) are retired — **everything lives in
[playground/index.html](playground/index.html)** now:

- **THE SYMBIOTE** — Moshi IS the artifact: everyone starts with the same agent
  (provably seed-invariant); your music grows and inscribes him. Face = agent
  channel (REC ember, grin, gaze), body = work channel (growth, waves, skin,
  veins, fringe — Blob Mixer two-layer grammar, credited).
- **The DAW skeleton** — ghost lanes, cartridge clips, latching M/S switches +
  LED ladders that feed him, the needle playhead, BUILD demo.
- **THE LISTENER** — ♪ LoserFace chip or drop any audio file: real 3-band
  analysis drives everything; ruler seeks; honest time readout.
- **No rectangles** — the rack orbits him, the chain hangs in its lane, the
  topbar is a scrim; THE ROOM (his ground + contact glow + hue aura).
- **THE SCENE rail** — crew orbs (deed ticks, REC embers) + rival fog orbs;
  tap a rival to PEEK their Moshi in fog. See it, never hear it.
- The whole page through the PS2 signal chain (CRT bloom + posterize), Nanum
  Square Round display voice.

Retired pages live in git history; the concepts/ one-pagers remain as the
design record (009-the-pit.md carries the full v1→v15 changelog).

## Parked (next waves)

- ~~Real audio features~~ **DONE (2026-06-10):** run Mosh with `MOSH_LAB_FEED=1` and 009
  links to the companion server (port 47873) — real transport position drives the bars,
  master meters drive energy/slams (`enable_all_meters` is sent automatically). Token:
  `MOSH_LAB_TOKEN` (default `mosh-lab`), or `?token=` on the page URL. Other experiments
  adopt the same client as they're revisited.
- **Rive / diffusion-baked Moshi sprites** — prior research says bake offline, SDF for
  continuous motion. Experiment 002 informs whether/when to invest.
- **Avalonia code** — notes only until the native-surface decision is firm.
