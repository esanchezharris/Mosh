# TOOLS — the surplus

Everything wired into this environment that the lab can reach for. Organized by what
you're trying to do. (MCP servers are session-connected for Claude Code; external
sites/tools are listed with how to use them.)

## Review & artifact flow

| tool | reach for it when |
|---|---|
| **open-design** ([nexu-io/open-design](https://github.com/nexu-io/open-design)) | You want a persistent local gallery of design artifacts streamed from agent sessions — prototypes, decks, images, HyperFrames video — shaped by a `DESIGN.md` brand contract. Local-first, Apache-2.0. **INSTALLED** (2026-06-09): `Open Design.app` v0.9.0 in /Applications (sha256-verified DMG), MCP server registered user-scope in Claude Code (`open-design`, proxies to the app daemon at `127.0.0.1:7456`). Remaining manual step: complete first-run onboarding in the app (sign in to the Model Router, or pick local-CLI mode pointing at Claude Code). Next: distill `tokens/moshi.css` + BRIEF.md into an OD `DESIGN.md` so every artifact comes out on-brand. |
| **playground gallery** (`playground/`) | The zero-dependency default — every experiment is a live page. |
| **Claude Preview MCP** | Agent-side screenshot/verify loop on the dev server (`preview_start` → `preview_screenshot`). |
| **Claude in Chrome MCP** | Viewing auth-walled inspiration (X posts), or driving a live review session in the user's browser. |

## Making visuals & motion

| tool | reach for it when |
|---|---|
| **GLSL in the playground** | The default medium. Shader-first = portable to SKSL/Avalonia. |
| **p5.js** + [p5.steeve.website templates](https://p5.steeve.website/) | Sketch-speed generative studies; the template site does param-tweaking + MP4/PNG export in-browser. |
| **Cavalry MCP** | Proper motion-design work — keyframes, magic easing, renders to PNG. The strongest tool here for choreographed brand motion (logo stings, state transitions). |
| **three.js scene MCP** (`show_threejs_scene`) | Quick in-chat 3D looks (SDF blob lighting studies) without scaffolding a page. |
| **visualize widget** | Throwaway in-chat mockups/diagrams during discussion. |
| **tldraw MCP** | Spatial thinking: flows, storyboards, mode maps on a shared canvas. |
| **HeyGen HyperFrames MCP** | Programmable HTML→video renders (concept reels, animated walkthroughs). |
| **Figma MCP** | When a direction graduates to component-level design system work; round-trips code↔design. |
| **Canva MCP / Adobe Express MCP** | Brand collateral, quick image ops (halftone, glitch, grain effects on renders). |

## Skills (slash-commands in Claude Code)

| skill | reach for it when |
|---|---|
| `frontend-design` | Building any polished page — enforces anti-generic-AI aesthetics. |
| `algorithmic-art` | p5.js seeded generative studies (HEARTH variants). |
| `canvas-design` | Static poster/brand art (Moshi key art, mood frames). |
| `theme-factory` | Theming generated artifacts/decks. |
| `firecrawl-*` | Scraping/archiving inspiration pages; `firecrawl-search` for discovery. |
| `deep-research` | Multi-source verified research (e.g. "state of real-time NPR in 2026"). |
| `grab` | Downloading reference videos (yt-dlp, 1080p). |

## Research & discovery

| tool | reach for it when |
|---|---|
| [awesome-creative-coding](https://github.com/terkelg/awesome-creative-coding) | The index of the whole field — tools, books, communities. |
| [last30days-skill](https://github.com/mvanhorn/last30days-skill) | "What happened in X in the last 30 days" across Reddit/X/YouTube/HN. |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach) | Agent-side search of X/Reddit/YouTube/etc. without API fees — useful for X inspiration the fetchers can't reach. |
| [pm-skills](https://github.com/phuryn/pm-skills) | Product-side skills (positioning, launch) when a direction needs a narrative. |
| **Hugging Face MCP** | Model/paper lookup (diffusion mascot pipeline, NPR papers). |

## Image generation (external, browser)

| tool | note |
|---|---|
| **Grok Imagine** | The user has an agent session going (see inspiration index) — moodboard generation. |
| **Ideogram** | Strong for typographic/lockup explorations (the wordmark). |
| **Adobe Firefly MCP** | In-session generation + the full image-ops toolbox (halftone, glitch, grain). |

## Music-side reference

| tool | note |
|---|---|
| **Producer Pal MCP** | Drives Ableton Live — useful to study/screen-record how a conventional DAW handles a flow before Moshi-fying it. |
| **Mosh itself** (`/ui`, `Mosh --demo*`) | The current production UI — the baseline being replaced. |

## The native target (parked)

| tool | note |
|---|---|
| **Avalonia** | The intended native surface. See [avalonia/NOTES.md](avalonia/NOTES.md) for what ports. |
| [awesome-avalonia](https://github.com/AvaloniaCommunity/awesome-avalonia) | Thin on animation/shader libs — the real path is SkiaSharp + SKSL custom drawing. |
