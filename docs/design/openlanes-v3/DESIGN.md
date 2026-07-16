# Open Lanes v3 design contract

## 1. Direction

Open Lanes is a quiet obsidian instrument, not a conventional DAW chrome stack. The signature moment is the lane itself becoming the editor while the lime navigator window keeps the whole arrangement legible.

Canonical source:

- `shell-rail-sequencer.html` is the desktop interaction and material reference — the FINAL
  judged mockup (post-R19: chrome-off lanes, fill-all layout, slim navigator, reactive ambient,
  drag-reorder). It is the only surviving copy; treat it as canonical.
- `companion-pro-monument-v3.html` is the later companion reference.
- `reference/01-rest.png` is the 1440 × 900 desktop composition target.
- The remaining reference images lock focused drum/MIDI, zoom, fader, panel, navigator, Moshi,
  and companion states.
- **Provenance:** every `reference/*.png` is from the arena verify runner's R19-verified capture
  set (`arena/.verify/seq-graphite/` + `pro-monument-v3/`, 2026-07-13) — rendered from the final
  mockup above. Do NOT re-capture from older arena outputs: pre-R14 captures show per-lane color
  dots, left spine bars, and pinned track names, all of which were explicitly REMOVED by the owner
  in judging rounds R14–R19. If a capture shows a colored dot next to a track name, it is the
  wrong era.

## 2. Color and material

- Room: `#0b0d12` to `#080a0c`, with a cool gray-violet breathing aura and a black floor vignette.
- Slab: translucent `#14161c` graphite with a hairline rim and restrained inset highlight.
- Lane: translucent `#181a21`; expanded lanes lift one tonal step rather than becoming a card.
- Text: `#e8ebf1`; secondary and microcopy use alpha, never an unrelated gray.
- Sacred accent: `#ccff36`, reserved for selection, play, playhead, viewport, focus, and commit.
- Track identity: desaturated amber, lavender, rose, and mint from `trackHue()`; **color lives
  ONLY in the musical content** (steps, notes, waveform) and in the revealed name text. There is
  NO color dot, NO left spine bar, NO chrome identifier of any kind — the content IS the identity
  (owner doctrine, locked in judging round R14).
- Depth strategy: mixed tonal shift, hairline seams, and one soft long shadow. No stacked card shadows or glass blur.

## 3. Typography

- Display/brand: the existing Mosh display face, 14px, heavy, wide tracking.
- Instrument UI: the existing mono stack, tabular numerals, 8–12px.
- Track names: 9.5px/700, uppercase, `0.16em` tracking.
- Section and ruler labels: 6.5–8.5px uppercase micro-caps.
- No new font dependency. Production remains offline and bundle-local.

## 4. Spacing and layout

- Base unit: 4px.
- Desktop reference viewport: 1440 × 900.
- Top bar: 52px visual band; arrangement navigator begins below it and shares the lane slab width.
- Main slab: centered, approximately 1040px at the reference viewport, with calm outer gutters for dock tabs.
- Lane gap: 8px. Compact lane: 60px. Minimum editor: 116px. Maximum even editor: 190px.
- Fill-all when every lane fits at the minimum editor height; otherwise one focused editor consumes the remainder and all other lanes stay compact.
- Composer: centered near the lower edge, narrow enough to leave the stage breathing.

## 5. Primitives and states

### Arrangement navigator

- Structure: section field, one overview row per track, viewport, playhead, collaborator beads.
- States: rest, hover, keyboard focus, dragging, seeking, full-span.
- Accessibility: slider semantics, keyboard pan, Shift+keyboard seek, visible inset focus ring.

### Open lane

- Structure: progressive header, type-specific surface, cached compositor playhead.
- **Chrome-off at rest (non-negotiable):** a resting lane shows PURE content — no name, no dot,
  no spine, no mute/solo, no grip. On hover or focus, a top gradient scrim fades in and reveals
  the name (in the track hue), the grip, and the M/S controls (200ms ease-out reveal). Muted
  state reads via content opacity (0.4), never via chrome.
- Variants: drum, MIDI, audio; compact and expanded.
- States: rest, hover, selected, focused/expanded, muted.
- Motion: transform/opacity only; layout height changes use the existing 340ms instrument easing.

### Prompt-bar Moshi

- Structure: real AgentComposer input plus the real baked Moshi mount as talk target.
- States: idle, hover, listening, busy, disabled, focus-visible.
- Accessibility: Moshi talk target exposes the same label, pressed state, and disabled behavior as the default mic.

### Ambient stage

- Structure: one half-resolution canvas behind the shell plus static CSS aura/floor fallbacks.
- States: playing, paused slow-motion, reduced-motion static.
- Motion: maximum 30fps; never reads layout per frame.

## 6. Interaction and motion

- Micro actions: 100–150ms ease-out.
- Progressive disclosure: 200ms cubic-bezier(0.23, 1, 0.32, 1).
- Lane layout transition: 340ms cubic-bezier(0.22, 0.61, 0.36, 1).
- Only `transform` and `opacity` animate continuously.
- Reduced motion removes non-essential transitions and freezes the ambient canvas after one frame.

## 7. Responsive behavior

- Desktop is canonical; 1280px retains the same hierarchy with narrower outer gutters.
- Below 768px, project metadata and nonessential collaboration labels collapse before transport or musical content.
- At 375px, the shell remains horizontally contained; navigator section names may hide, but viewport, playhead, and lane identity remain visible.
- Container size, not global viewport width, decides navigator label density and lane fill-all versus accordion mode.

## 8. Accessibility constraints and accepted debt

- Target WCAG 2.2 AA for controls and text that communicates state.
- Every interactive element remains keyboard reachable with a visible focus ring.
- Color is reinforced by text, shape, or position for mute/solo, selection, and collaborator state.
- Deferred by owner plan: editing gestures, faders, reorder, panels, material variants, and companion implementation. Deferred controls do not appear as dead chrome.
