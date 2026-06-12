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

## Wave 1 — retired (2026-06-10)

Experiments 001–006 (HEARTH, SPECIMEN, PERIPHERY, GULLET, SPORE LEDGER, BROADCAST)
were direction studies; the 008+ lineage absorbed what worked (presence-in-fog →
THE SCENE's fog orbs; spore ledger → the deeds rail; SPECIMEN → MoshiBlob). Deleted
from the working tree — **git history keeps every one** if a direction gets revisited.

## Wave 2 (grounded)

| # | experiment | role |
|---|---|---|
| 007 | **TERRARIUM** — the specimen, kept quietly | The one Wave-1 survivor (synthesis of 002×005×001), brightened 2026-06-10 — it was too dark to read |
| 008 | **POSSESSION** — the current UI, possessed | The shipping skeleton ([current-ui/AUDIT.md](current-ui/AUDIT.md)) re-materialized per the [field notes](inspiration/FIELD_NOTES.md) — the migration path |
| 009 | **THE PIT** — the song as matter | 008's DAW + a raymarched, dithered, on-twos 3D mass in the stage; the Rack sculpts it. Now faceted, wobbly, draggable, pokeable. |
| 010 | **MOSHI** — the agent as a 3D component | Portable `MoshiBlob`: faceted raymarched blob, cursor-tracking eyes, beat squash, poke-to-squish. Embedded in 008/009. Face fused to the body (squash/tremble/lime-on-REC). |
| 011 | **THE SCENE** — presence at a glance | v2 of the battle seed: crew as detailed orbs on one side of the topbar, rivals as fog orbs (size only) on the other; tap to PEEK their artifact — see it, never hear it. The hourglass died. |

Wave 2 inputs: [current-ui/AUDIT.md](current-ui/AUDIT.md) (what the product looks like
today and the gap to the brief) and [inspiration/FIELD_NOTES.md](inspiration/FIELD_NOTES.md)
(the linked inspiration actually viewed — 100/101 posts fetched as imagery — distilled
into eight motifs with steal-this mappings).

## Parked (next waves)

- ~~Real audio features~~ **DONE (2026-06-10):** run Mosh with `MOSH_LAB_FEED=1` and 009
  links to the companion server (port 47873) — real transport position drives the bars,
  master meters drive energy/slams (`enable_all_meters` is sent automatically). Token:
  `MOSH_LAB_TOKEN` (default `mosh-lab`), or `?token=` on the page URL. Other experiments
  adopt the same client as they're revisited.
- **Rive / diffusion-baked Moshi sprites** — prior research says bake offline, SDF for
  continuous motion. Experiment 002 informs whether/when to invest.
- **Avalonia code** — notes only until the native-surface decision is firm.
