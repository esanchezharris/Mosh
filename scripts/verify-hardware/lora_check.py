"""LoRA-rack real-path check (optional; needs the wired SA3 service + a real adapter).

Proves the whole rack loop against the REAL MLX engine with a REAL trained adapter:
  1. a fixed-seed base render vs the same seed with the adapter @100 → audible change
     (diff-RMS above threshold)
  2. an identical re-render is a native cache HIT
  3. emptying the rack renders ≈ the base again (restore-to-base proof; SA3 is
     seed-deterministic so the empty-rack render matches the base render closely)
  4. the rack render's manifest carries loras / triggers_injected / lora_merge_ms
     (the layer's job dir reuses ONE manifest file, so the script renders the rack
     LAST — the manifest on disk at the end is the rack render's)

Stages a copy of a lab adapter (default `~/mosh-loras/artifacts/bro-sa3-v2.safetensors`,
override MOSH_LORA_CHECK_ADAPTER) + a trigger sidecar into an isolated MOSH_LORA_DIR
under ART. Lazily imported by verify.py (--lora) so offline checks never depend on
the model. Everything runs in ONE --run-script process (run-script sessions start
with a fresh edit — state does not span invocations).
"""
import glob
import json
import os
import shutil
import sys
from pathlib import Path

SESSION = "verify-lora"
ADAPTER = os.path.expanduser(os.environ.get(
    "MOSH_LORA_CHECK_ADAPTER", "~/mosh-loras/artifacts/bro-sa3-v2.safetensors"))
TRIGGER = "brozr"


def _mosh_base():
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Mosh"
    if sys.platform.startswith("win"):
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / "Mosh"
    return Path.home() / ".local" / "share" / "Mosh"


def check_lora_rack(ctx, ART, run_script, stats, diff_rms, failed_commands):
    if not os.path.isfile(ADAPTER):
        return {"check": "LoRA rack (real merge)", "pass": False,
                "detail": {"error": f"adapter not found: {ADAPTER} (set MOSH_LORA_CHECK_ADAPTER)"}}

    # Isolated library: the adapter under its lab name + a sidecar with the trigger.
    lib = ART / "lora-lib"
    shutil.rmtree(lib, ignore_errors=True)
    lib.mkdir(parents=True)
    name = Path(ADAPTER).stem
    shutil.copyfile(ADAPTER, lib / f"{name}.safetensors")
    (lib / f"{name}.json").write_text(json.dumps(
        {"displayName": "Verify Adapter", "trigger": TRIGGER, "notes": "lora_check"}))

    shutil.rmtree(_mosh_base() / SESSION, ignore_errors=True)

    out_base = ART / "07_lora_base.wav"
    out_rack = ART / "07_lora_rack.wav"
    out_restored = ART / "07_lora_restored.wav"
    rack = [{"name": name, "value": 100}]
    cmds = [
        {"command": "create_track", "args": {"name": "LoraV"}, "capture": {"T": "trackId"}},
        {"command": "add_test_tone_clip", "args": {"trackId": "${T}", "seconds": 3.0, "freq": 220.0}, "capture": {"C": "clipId"}},
        {"command": "create_render_layer", "args": {"clipId": "${C}", "adapter": "stable_audio3"}},
        {"command": "set_render_param", "args": {"clipId": "${C}", "seed": 7, "mode": "reimagine", "nl": 0.35}},
        # 1) base render (no rack)
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "export_audio", "args": {"file": str(out_base)}},
        # 2) the rack @100 — same seed; the model must sound different
        {"command": "set_render_param", "args": {"clipId": "${C}", "loras": rack}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "export_audio", "args": {"file": str(out_rack)}},
        # 3) identical re-render → native cache HIT (no job → manifest untouched)
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        # 4) emptied rack → restore-to-base render
        {"command": "set_render_param", "args": {"clipId": "${C}", "loras": []}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
        {"command": "export_audio", "args": {"file": str(out_restored)}},
        # 5) rack again, LAST — leaves the rack render's manifest on disk for (4/manifest)
        {"command": "set_render_param", "args": {"clipId": "${C}", "loras": rack}},
        {"command": "render_layer", "args": {"clipId": "${C}", "wait": True}},
    ]
    results, proc = run_script(
        ctx.bin, cmds, SESSION, sa3=True, timeout=900,
        extra_env={
            "MOSH_RENDER_WAIT_TIMEOUT_MS": "480000",
            "MOSH_SERVICE_PORT": "8794",
            "MOSH_LORA_DIR": str(lib),
            "MOSH_ENABLE_LORAS": "1",
        },
    )
    fails = failed_commands(results)
    renders = [r for r in results if r.get("command") == "render_layer"]
    caches = [r.get("data", {}).get("cache") for r in renders]

    detail = {"failed_commands": fails, "caches": caches, "adapter": name}
    if fails or len(renders) < 5:
        detail["stderr"] = proc.stderr[-700:]
        return {"check": "LoRA rack (real merge)", "pass": False, "detail": detail}

    # The manifest on disk is the FINAL (rack) render's: loras + trigger + merge timing.
    rack_man = None
    for m in sorted(glob.glob(str(_mosh_base() / SESSION / "renders" / "*" / "output_manifest.json"))):
        try:
            rack_man = json.loads(Path(m).read_text())
        except json.JSONDecodeError:
            pass
    triggers = (rack_man or {}).get("triggers_injected") or []
    merge_ms = (rack_man or {}).get("lora_merge_ms")

    base_s = stats(str(out_base)) if out_base.exists() else None
    rack_s = stats(str(out_rack)) if out_rack.exists() else None
    d_change = diff_rms(str(out_base), str(out_rack)) if base_s and rack_s else None
    d_restore = diff_rms(str(out_base), str(out_restored)) if out_restored.exists() else None

    ok = (base_s and base_s["rms"] > 0.001
          and rack_s and rack_s["rms"] > 0.001
          and d_change is not None and d_change > 0.01           # the adapter audibly changed the render
          and caches[:5] == ["miss", "miss", "hit", "miss", "miss"]
          and rack_man is not None and (rack_man.get("loras_applied") is True)
          and TRIGGER in triggers                                # auto-injection happened
          and merge_ms is not None and merge_ms >= 0
          and d_restore is not None and d_restore < 0.01)        # empty rack == base again (restore proof)
    detail.update({
        "base_stats": base_s, "rack_stats": rack_s,
        "diff_rms_base_vs_rack": d_change,
        "diff_rms_base_vs_restored": d_restore,
        "triggers_injected": triggers, "lora_merge_ms": merge_ms,
        "loras_applied": (rack_man or {}).get("loras_applied"),
    })
    return {"check": "LoRA rack (real merge)", "pass": bool(ok), "detail": detail}
