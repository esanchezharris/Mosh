# Asserted Proof Review Design

## 1. Direction

An audio-lab proof sheet, not a product dashboard. The page uses charcoal recording-room surfaces, warm signal amber, and waveform-like rules. The memorable moment is the linear evidence chain from raw take to asserted mapping to generated guide to clone.

## 2. Tokens

- Canvas: `#11110f`
- Raised surface: `#1b1a17`
- Inset surface: `#151411`
- Text: `#f4f0e8`
- Muted text: `#aaa399`
- Rule: `#36322c`
- Accent: `#f2a93b`
- Pass: `#8bbf76`
- Fail: `#e06b55`
- Spacing unit: `4px`; page rhythm uses 8, 12, 16, 24, 32, and 48px.
- Radius: cards 12px, controls 8px, status pills fully rounded.
- Type: `Avenir Next` for display/body and `IBM Plex Mono`, `Menlo` fallback for evidence.

## 3. Layout

- Desktop: 1180px maximum, asymmetrical header, then one full-width evidence rail.
- Tablet: same hierarchy with two-column metadata collapsing to one.
- Mobile: one column, 16px gutters, controls remain at least 44px tall.

## 4. States

- Current: accent rule and playable audio.
- Missing: muted inset with no audio control.
- Quarantined: red rule, explicit hash mismatch, and no audio control.
- Awaiting ear: amber status; metrics never imply owner approval.
- Owner verdict: pass, close, and fail are mutually exclusive controls; classification remains optional; save state is explicit and restored after reload.

## 5. Primitives

- `EvidenceCard`: numbered stage, title, provenance status, audio or missing/quarantined state.
- `RepairCard`: an evidence card whose copy names the single bounded timing change and the invariant boundaries it preserves.
- `ExpansionCard`: a known-lyrics clip with raw and generated players, asserted text, heuristic count, and diagnostic metrics; diagnostic status never implies owner approval.
- `MetricStrip`: compact mono key/value cells with threshold context.
- `MappingTable`: asserted word, absolute span, syllable phones, pitch, and provenance.
- `VerdictPanel`: verdict controls, failure classification, notes, durable local save status, and JSON download fallback.
- `CandidateCard` (Local Model Spike): rank + effective status + provenance kicker, seed title, playable-or-quarantined audio (hash-checked against the spike's own manifest, never the opening manifest), heard transcript with per-word lexical chips (hit/near-miss/substitution/miss), a metric strip whose failing shortlist gates render in the fail token, and a per-candidate VerdictPanel bound to the spike manifest hash. Only the three highest-ranked current candidates get cards; invalid candidates never render. Metrics never imply owner approval; a lane stop renders as a fail-ruled banner.

## 6. Motion And Accessibility

- One staggered load reveal communicates evidence order; disabled under `prefers-reduced-motion`.
- Visible focus rings use the accent token.
- Semantic headings, table headers, labels, and buttons; no color-only status.
- Audio elements always include a nearby text label naming the exact artifact.
