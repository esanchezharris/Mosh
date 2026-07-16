"""Contract test for service/adapters/stable_audio3_cuda.py — FIT-013, torch-free.

Pins the CUDA adapter's MLX-parity surface without loading torch or a model:
NL guard (raise below NL_MIN, clamp at NL_MAX_RECOGNIZABLE), the SA3_SECONDS
window pin, and loras_key construction identical to the MLX adapter's.

Run:  python3 service/scripts/sa3_cuda_contract_test.py
"""
from __future__ import annotations

import importlib
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

CHECKS = 0


def check(cond, msg):
    global CHECKS
    CHECKS += 1
    if not cond:
        print(f"FAIL: {msg}")
        sys.exit(1)


def main():
    from adapters import stable_audio3_adapter as canon
    from adapters import stable_audio3_cuda as cuda

    # 1) NL guard parity: below NL_MIN raises (MLX refuses degenerate renders —
    #    the old CUDA path silently clamped up, which hid a caller bug)
    try:
        cuda._validated_nl(canon.NL_MIN / 2.0, canon.NL_MIN, canon.NL_MAX_RECOGNIZABLE)
        check(False, "nl below NL_MIN did not raise")
    except ValueError:
        check(True, "")
    check(cuda._validated_nl(0.3, canon.NL_MIN, canon.NL_MAX_RECOGNIZABLE) == 0.3,
          "in-range nl altered")
    check(cuda._validated_nl(0.9, canon.NL_MIN, canon.NL_MAX_RECOGNIZABLE)
          == canon.NL_MAX_RECOGNIZABLE, "nl above max not clamped")

    # 2) window pin follows SA3_SECONDS (and stays under MAX_DURATION)
    check(cuda.WINDOW_SECONDS == min(cuda.MAX_DURATION,
                                     float(os.environ.get("SA3_SECONDS", "8.0"))),
          f"WINDOW_SECONDS wrong: {cuda.WINDOW_SECONDS}")
    old = os.environ.get("SA3_SECONDS")
    try:
        os.environ["SA3_SECONDS"] = "6.5"
        importlib.reload(cuda)
        check(cuda.WINDOW_SECONDS == 6.5, "WINDOW_SECONDS ignores SA3_SECONDS")
        os.environ["SA3_SECONDS"] = "999"
        importlib.reload(cuda)
        check(cuda.WINDOW_SECONDS == cuda.MAX_DURATION,
              "WINDOW_SECONDS not capped at MAX_DURATION")
    finally:
        if old is None:
            os.environ.pop("SA3_SECONDS", None)
        else:
            os.environ["SA3_SECONDS"] = old
        importlib.reload(cuda)

    # 3) loras_key identical to the MLX adapter's inline construction
    sel = [("warm", "/x/warm.safetensors", 0.6), ("gritty", "/x/g.safetensors", 0.25)]
    check(cuda._loras_key(sel) == "|".join(f"{n}@{s}" for n, _f, s in sel),
          "loras_key drifted from the MLX adapter's format")
    check(cuda._loras_key([]) == "", "empty selection key must be '' (stock)")

    # 4) fresh-module LoRA state is inert
    check(cuda._LORA_APPLIED_KEY is None and not cuda._LORA_TOUCHED,
          "LoRA state not fresh after import")

    print(f"sa3_cuda_contract_test OK ({CHECKS} checks)")


if __name__ == "__main__":
    main()
