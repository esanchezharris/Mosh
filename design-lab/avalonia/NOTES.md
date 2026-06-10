# Avalonia translation notes

Avalonia is the intended native surface for the next-gen interface. The lab prototypes
on the web (iteration speed, open-design streaming, agent leverage) — these notes keep
the prototypes **portable by construction** so the winning direction doesn't die in
translation. No Avalonia code until the surface decision is firm.

## What survives the port

| web technique | Avalonia path | fidelity |
|---|---|---|
| **GLSL fragment shaders** (HEARTH, SPECIMEN, PERIPHERY edge-field) | **SKSL** via SkiaSharp `SKRuntimeEffect`, hosted in a custom `ICustomDrawOperation` / composition custom visual | ~1:1 — SKSL is a GLSL dialect; mostly s/`gl_FragCoord`/`fragcoord`-uniform/, type renames, no derivatives in some targets |
| Canvas-2D drawing (GULLET) | SkiaSharp `SKCanvas` (same drawing model, near-identical API) | 1:1 |
| requestAnimationFrame loops | `TopLevel.RequestAnimationFrame` / composition animations / `DispatcherTimer` at 60 Hz | 1:1 |
| Tabular-mono / heavy-grotesque type | Bundled font + `FontFeatures` (tnum) | 1:1 |
| Audio-feature uniforms (RMS/onset/centroid) | Push from the engine on the UI thread (same decimated-feed discipline as the current 30 Hz transport events) | better than web (no bridge hop) |
| GIF/sprite playback (baked Moshi states) | AvaloniaGif, or sprite atlas on SkiaSharp | 1:1 |

## What does NOT survive (avoid leaning on these in prototypes)

- **CSS filters/blend-modes/backdrop-filter** — no direct equivalent; re-do in-shader.
- **DOM layout tricks** (absolutely-positioned div clouds, CSS keyframe choreography) —
  must be rebuilt as Avalonia controls/animations. Fine for *direction* studies
  (SPORE LEDGER is deliberately DOM-heavy), but the shipped version would be Skia.
- **SVG-as-DOM with CSS animation** — Avalonia has SVG rendering but not the CSS
  animation layer; bake to code-driven drawing.
- **`<input>`/form chrome** — restyle natively (trivial, just don't design *around*
  browser chrome).

## Ecosystem reality (researched 2026-06)

[awesome-avalonia](https://github.com/AvaloniaCommunity/awesome-avalonia) lists no
Lottie/Rive/shader/audio-viz libraries — only AvaloniaGif (animation) and Beutl
(compositing app). Plan on **SkiaSharp + SKSL custom drawing as the rendering spine**,
not third-party animation packages. If Rive becomes load-bearing for Moshi states,
budget for hosting its C++ runtime behind a custom control (it exists but is not a
drop-in Avalonia package).

## Porting checklist (when the time comes)

1. Lift each winning shader verbatim → SKSL; diff golden frames against web renders.
2. One custom `MoshiSurface` control owning the render loop + uniform feed.
3. Engine-side feature extractor (RMS/onset/centroid/band energies) → decimated to
   30–60 Hz on the UI dispatcher, same pattern as the existing transport feed.
4. Type: license/bundle the display face chosen by then; tnum mono for timecodes.
5. Keep the two non-negotiables testable: REC state and song position must be
   readable from the rendered surface alone (screenshot test).
