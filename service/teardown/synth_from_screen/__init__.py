"""§5b Synth-GUI patch reader — the PRIMARY, cheap patch route (read the picture). Reads a
synth GUI into `synth_patch.params`: knob indicator angles → values, menus/labels → OCR,
toggles → state. Output is APPROXIMATE (knob angles have error bars) — exactly what §8 refines
and the §6 audio check verifies. Generic CV core + per-synth profiles (control map). The
knob-angle core is hermetically tested; per-synth profile calibration needs real frames (gated).
"""
from .controls import read_knob, read_menu, read_toggle  # noqa: F401
from .export import read_patch  # noqa: F401
from .fx_rack import detect_fx_chain  # noqa: F401
from .matrix import read_matrix  # noqa: F401
