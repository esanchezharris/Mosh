"""Guard: SA3 availability requires the MLX runtime, not just the model directory.

Why this exists. `engine_available()` gates /health's adapter list, /capabilities, the
service's SA3_ENABLED flag and — through /colors' `sa3` field — the generative drawer's
green "SA3" vs amber "preview" badge. It used to check ONLY that SA3_MLX_DIR existed on
disk. MLX is Apple-Silicon/Metal only (no x86_64 macOS wheels), so on an Intel Mac an
SA3_MLX_DIR arriving by any route — guest zip, Time Machine restore, synced folder — made
the whole stack claim the real Stable Audio 3 model was running, right up until
`import mlx.core` threw at the first render.

The load-bearing case below is (model dir present, MLX absent) → False. Delete the
`and mlx_importable()` from engine_available() and that assertion fails.

Hermetic + stdlib-only: engine.py's module top imports no mlx (that's lazy in _Engine),
so this imports without a GPU, weights, or the MLX venv. Run via gate.sh run_py_tests.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # service/
from sa3 import engine


def _with(dir_present, mlx_ok):
    """Run engine_available() against injected seams, always restoring the real ones."""
    real_dir, real_mlx = engine.model_dir_present, engine.mlx_importable
    try:
        engine.model_dir_present = lambda: dir_present
        engine.mlx_importable = lambda: mlx_ok
        return engine.engine_available()
    finally:
        engine.model_dir_present, engine.mlx_importable = real_dir, real_mlx


def main():
    # THE REGRESSION. An Intel Mac (or any host without MLX) that happens to have the
    # model dir must report UNAVAILABLE, so the UI shows "preview" instead of lying.
    assert _with(dir_present=True, mlx_ok=False) is False, \
        "model dir present but MLX unimportable must NOT advertise SA3"

    # Both present → available (the real Apple Silicon path stays unchanged).
    assert _with(dir_present=True, mlx_ok=True) is True, "dir + MLX → available"

    # MLX alone is not enough — an Apple Silicon Mac with no weights installed.
    assert _with(dir_present=False, mlx_ok=True) is False, "MLX without the model dir → unavailable"
    assert _with(dir_present=False, mlx_ok=False) is False, "neither → unavailable"

    # The seams must be real functions returning real bools, not accidentally-truthy
    # objects — a lambda-shaped stub would make the assertions above vacuous.
    assert isinstance(engine.model_dir_present(), bool), "model_dir_present returns bool"
    assert isinstance(engine.mlx_importable(), bool), "mlx_importable returns bool"

    # mlx_importable must agree with what `import mlx` would actually do here, in both
    # directions — this is the check that would catch a stub that always returns True.
    try:
        import mlx  # noqa: F401
        really_importable = True
    except Exception:
        really_importable = False
    assert engine.mlx_importable() == really_importable, \
        f"mlx_importable()={engine.mlx_importable()} disagrees with a real import ({really_importable})"

    # And the restore in _with() actually restored (guards against a test that leaves the
    # module monkeypatched for every later test in the same interpreter).
    assert engine.model_dir_present.__name__ == "model_dir_present", "seam restored"
    assert engine.mlx_importable.__name__ == "mlx_importable", "seam restored"

    print(f"engine_available_test: OK (mlx_importable={engine.mlx_importable()}, "
          f"model_dir_present={engine.model_dir_present()})")


if __name__ == "__main__":
    main()
