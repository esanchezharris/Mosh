# Schema And UI Comparison

Date: 2026-06-08

## Contract Result

The old `mosh_v1_final_build_pack` schemas were preserved, but they should not be imported as live contract truth.

ClaudeMosh current command/result seam is:

```json
{ "command": "create_track", "args": { "name": "Drums" } }
{ "ok": true, "command": "create_track", "data": { "trackId": "1023" } }
{ "ok": false, "command": "create_track", "error": "insert failed" }
```

The current JSONL command log uses:

```json
{ "ts": 1780934602502, "seq": 1, "command": "create_track", "args": { "name": "Drums" }, "ok": true, "undoable": true }
```

The old schemas expect revisioned/global envelopes with fields such as `revision`, `changed_entities`, `message`, `base_revision`, `source`, top-level `clips`, top-level `plugins`, `jobs`, `devices`, `ui`, and a telemetry frame shape. ClaudeMosh currently keeps UI-local state local and uses snapshot invalidation plus decimated transport events instead of the old global revision model.

## Render Layer Numeric Fields

Current ClaudeMosh runtime types require numeric render-layer fields:

- `renderLayer.seed: number`
- `renderLayer.nl: number`
- `renderLayer.colors[].value: number`

The current backend snapshot conversion in `src/moshops/MoshOps.cpp` explicitly casts these values before exposing them to the UI. This preserves the WebView fix from commit `5216ba9`, where stringy ValueTree/XML values could crash `GenPanel`.

## Old Schemas Preserved For Reference

Preserved schema paths:

- `_preserved_artifacts/2026-06-08-consolidation/jampilot/mosh_v1_final_build_pack/schemas/command-result.schema.json`
- `_preserved_artifacts/2026-06-08-consolidation/jampilot/mosh_v1_final_build_pack/schemas/event-envelope.schema.json`
- `_preserved_artifacts/2026-06-08-consolidation/jampilot/mosh_v1_final_build_pack/schemas/render-layer-manifest.schema.json`
- `_preserved_artifacts/2026-06-08-consolidation/jampilot/mosh_v1_final_build_pack/schemas/session-snapshot.schema.json`
- `_preserved_artifacts/2026-06-08-consolidation/jampilot/mosh_v1_final_build_pack/schemas/telemetry-frame.schema.json`

If formal schemas are added later, generate them from the live ClaudeMosh MoshOps contract instead of copying these files verbatim.

## Color Rack UI Comparison

Legacy Color Rack references were preserved for product/UI comparison, not source import:

- `ColorRackPanel.tsx`
- `ColorSwatch.tsx`
- `swatchGeometry.ts`
- `colorRackClient.ts`

Useful ideas:

- Palette/deck organization and swatch visual language.
- Keeping prompt/control text visible.
- Artist-facing color names rather than research jargon.

Do not import:

- Old browser `DawAction`/store mutation flow.
- Old native sidecar assumptions.
- Any UI mutation path outside `execute_command(...)` plus snapshot/events.

## WebView Build Invariant

The current ClaudeMosh UI must keep the single-file Vite build path:

- `vite-plugin-singlefile` stays enabled in `ui/vite.config.ts`.
- `cmake/BuildUI.cmake` tracks UI source files so UI changes rebuild the staged WebView bundle.
- External module-script loading under JUCE's resource-provider scheme is not reliable for this app.
