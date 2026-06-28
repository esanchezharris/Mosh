"""§9 Render agent — compile a Recipe into an ordered MoshOps command sequence.

`compile_recipe` (compile.py) is the data half: pure, JUCE-clean, golden-testable —
it turns a §0 Recipe into a list of `{command, args[, capture]}` dicts (the shape
`Mosh --run-script` / MoshOps.execute consume, with `${VAR}` capture for
engine-assigned ids). It emits the unambiguous mappings (tempo/key/sig, tracks,
sample placement, MIDI clips) and records `unresolved` for the parts that genuinely
need the engine at execute time (plugin-id + param-index resolution, MIDI-note
parsing, the Tier-B render-layer fallback). execute.py (the only seam-crosser) + qa.py
land later — they need the built binary.
"""
from .compile import CompileResult, compile_recipe  # noqa: F401
