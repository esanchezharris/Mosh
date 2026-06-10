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
| [inspiration/INDEX.md](inspiration/INDEX.md) | ~150 reference links, identified and tagged by theme. |
| [playground/](playground/) | Vite app. Gallery of live experiments — each one self-contained HTML. |
| [concepts/](concepts/) | One-pager per named design direction: thesis, how it meets the constraints, what to steal. |
| [avalonia/NOTES.md](avalonia/NOTES.md) | The native-surface translation path (web prototype → Avalonia/SkiaSharp). |

## Run the gallery

```sh
cd design-lab/playground
npm install   # first time only (vite is the only dep)
npm run dev   # → http://localhost:5180
```

Every experiment is **one self-contained `index.html`** (inline JS/GLSL/CSS, no module
imports, no network deps) so it also opens directly as a file and can be streamed as a
single artifact into [open-design](https://github.com/nexu-io/open-design) for review.

## Review surfaces

- **Browser / gallery** — the default. `npm run dev`, click around.
- **open-design** (desktop app) — artifacts from agent sessions stream into its
  gallery. Installed in /Applications with its MCP server registered in Claude Code
  (see [TOOLS.md](TOOLS.md) for state + remaining onboarding step).
- **In-chat** — agents can render concepts inline (visualize widget, three.js viewer).

## House rules

1. **Lore-derived, not layout-specified.** Every concept must be defensible as "what
   the world looks like with Moshi fused to your perception" — not a dashboard reskin.
2. **The two non-negotiables** (am-I-recording, where-am-I-in-the-song) must be solved
   in every direction — through the creature/world where possible.
3. **Palette exact** ([tokens/moshi.css](tokens/moshi.css)). Dark world, lime glows.
4. **Anti-slop.** Not corporate SaaS, not a generic dark dashboard, not cluttered.
5. **Portable by construction.** Prefer shader/canvas techniques over DOM-only tricks —
   GLSL ports to SKSL nearly 1:1 ([avalonia/NOTES.md](avalonia/NOTES.md)); CSS filters
   and DOM layout do not. A DOM-heavy study is fine for *direction* work, but flag it.
6. **Every experiment leaves an artifact**: a live page in the gallery + (for interface
   directions) a one-pager in `concepts/`.

## Wave 1 (shipped with the lab)

| # | experiment | role |
|---|---|---|
| 001 | **HEARTH** — the stage centerpiece | The fire/screensaver: an ambient generative organism for not-passthrough mode |
| 002 | **SPECIMEN** — Moshi morphology | The creature itself: calm→feral spectrum; REC + song-position carried by the body |
| 003 | **PERIPHERY** — the vision filter | Interface lives at the edges of sight; center stays empty for your world |
| 004 | **THE GULLET** — creature-as-timeline | The song is something Moshi is digesting, left to right |
| 005 | **SPORE LEDGER** — visible metabolism | Every agent action is a living cell you can pop to undo |
| 006 | **BROADCAST** — the familiar on stream | Moshi as the watchable star; OBS-friendly |

## Wave 2 (grounded)

| # | experiment | role |
|---|---|---|
| 007 | **TERRARIUM** — the specimen, kept quietly | Synthesis: SPECIMEN × SPORE LEDGER, HEARTH dimmed to atmosphere |
| 008 | **POSSESSION** — the current UI, possessed | The shipping skeleton ([current-ui/AUDIT.md](current-ui/AUDIT.md)) re-materialized per the [field notes](inspiration/FIELD_NOTES.md) — the migration path |
| 009 | **THE PIT** — the song as matter | 008's DAW + a raymarched, dithered, on-twos 3D mass in the stage; the Rack sculpts it. Rough on purpose. |

Wave 2 inputs: [current-ui/AUDIT.md](current-ui/AUDIT.md) (what the product looks like
today and the gap to the brief) and [inspiration/FIELD_NOTES.md](inspiration/FIELD_NOTES.md)
(the linked inspiration actually viewed — 100/101 posts fetched as imagery — distilled
into eight motifs with steal-this mappings).

## Parked (next waves)

- **Real audio features** into experiments — needs a WebSocket tap on the engine's
  30 Hz transport/level feed (the experiments already expose `energy/onset/brightness`
  params with mouse + mic fallbacks, so wiring is mechanical).
- **Rive / diffusion-baked Moshi sprites** — prior research says bake offline, SDF for
  continuous motion. Experiment 002 informs whether/when to invest.
- **Avalonia code** — notes only until the native-surface decision is firm.
