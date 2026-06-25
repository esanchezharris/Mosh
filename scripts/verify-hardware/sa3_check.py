"""SA3 generative-transform check (optional; needs the wired SA3 service).

Renders a real Stable Audio 3 "re-imagine" of a test tone via the render-layer
flow (render_layer wait:true blocks until the job finishes), then proves the
model produced real, non-silent audio that differs from its input — and surfaces
the quality readout (pq) from the job manifest. Lazily imported by verify.py so
the offline checks never depend on the model being installed.
"""
import glob
import json
import os
import sys
from pathlib import Path

SESSION = "verify-sa3"


def check_sa3_transform(ctx, ART, run_script, stats, diff_rms, failed_commands):
    out = ART / "04_sa3.wav"
    cmds = [
        {"command": "create_track", "args": {"name": "SA3"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 3.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "stable_audio3"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "seed": 1, "mode": "reimagine",
                                                 "colors": [{"name": "grit", "value": 50}]}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},   # blocks until rendered
        {"command": "accept_render", "args": {"clipId": "${C}"}},
        {"command": "export_audio", "args": {"file": str(out)}},
    ]
    results, proc = run_script(
        ctx.bin, cmds, SESSION, sa3=True, timeout=360,
        extra_env={"MOSH_RENDER_WAIT_TIMEOUT_MS": "240000", "MOSH_SERVICE_PORT": "8793"},
    )
    fails = failed_commands(results)
    render_result = next((r for r in results if r.get("command") == "render_layer"), None)

    # The adapter stages input.wav and writes output.wav + manifest in the job dir.
    # Mosh's session base is OS-specific (JUCE userApplicationDataDirectory):
    #   macOS  ~/Library/Mosh   ·   Windows  %APPDATA%\Mosh   ·   Linux  ~/.local/share/Mosh
    if sys.platform == "darwin":
        mosh_base = Path.home() / "Library" / "Mosh"
    elif sys.platform.startswith("win"):
        mosh_base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Mosh"
    else:
        mosh_base = Path.home() / ".local" / "share" / "Mosh"
    renders_dir = mosh_base / SESSION / "renders"
    outputs = sorted(glob.glob(str(renders_dir / "*" / "output.wav")))
    inputs = sorted(glob.glob(str(renders_dir / "*" / "output_manifest.json")))

    detail = {"failed_commands": fails, "render_result": render_result}
    if fails or not outputs:
        detail["stderr"] = proc.stderr[-700:]
        return {"check": "SA3 generative transform", "pass": False, "detail": detail}

    sa3_out = outputs[0]
    job_dir = Path(sa3_out).parent
    sa3_in = job_dir / "input.wav"
    so = stats(sa3_out)
    transformed = diff_rms(str(sa3_in), sa3_out) if sa3_in.exists() else None

    pq = adapter = reasoning = None
    manifest = job_dir / "output_manifest.json"
    if manifest.exists():
        try:
            m = json.loads(manifest.read_text())
            pq = m.get("pq", m.get("quality", {}).get("pq") if isinstance(m.get("quality"), dict) else None)
            adapter = m.get("adapter")
            reasoning = m.get("reasoning")   # AL-006: judge's human-readable readout
        except json.JSONDecodeError:
            pass

    final = stats(out) if out.exists() else None
    ok = (so["rms"] > 0.001) and (transformed is None or transformed > 0.001) and (final and final["rms"] > 0.001)
    detail.update({
        "adapter": adapter, "pq": pq, "reasoning": reasoning,
        "sa3_output": so, "diff_from_input_rms": transformed,
        "final_export": str(out), "final_export_stats": final,
    })
    return {"check": "SA3 generative transform", "pass": bool(ok), "detail": detail}
