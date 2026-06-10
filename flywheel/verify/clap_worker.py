#!/usr/bin/env python3
"""CLAP embedding worker — runs under the JUDGES venv (laion_clap + torch),
NOT the repo's python. Spawned by flywheel/verify/l3.py.

  $MOSH_JUDGES_PY flywheel/verify/clap_worker.py cos pairs.json

pairs.json = [["a.wav", "b.wav"], ...] → one @@MOSH@@-marked JSON line:
{"ok": true, "cosines": [0.83, ...]}  (model loads once per invocation —
batch every pair you have).
"""
from __future__ import annotations

import json
import os
import sys

MARKER = "@@MOSH@@"
CKPT = os.environ.get(
    "MOSH_CLAP_CKPT",
    os.path.expanduser("~/AI/clap_ckpt/630k-audioset-best.pt"))


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] != "cos":
        print(MARKER + json.dumps({"ok": False, "error": "usage: cos pairs.json"}))
        return 2
    pairs = json.loads(open(sys.argv[2]).read())

    try:
        import numpy as np
        import laion_clap
        model = laion_clap.CLAP_Module(enable_fusion=False)
        model.load_ckpt(CKPT)
    except Exception as e:  # noqa: BLE001
        print(MARKER + json.dumps({"ok": False, "error": f"clap load: {e}"}))
        return 1

    files = sorted({p for pair in pairs for p in pair})
    try:
        embs = model.get_audio_embedding_from_filelist(x=files, use_tensor=False)
    except Exception as e:  # noqa: BLE001
        print(MARKER + json.dumps({"ok": False, "error": f"embed: {e}"}))
        return 1
    by_file = {f: embs[i] for i, f in enumerate(files)}

    def cos(a, b):
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        return float(np.dot(a, b) / (na * nb)) if na > 0 and nb > 0 else 0.0

    cosines = [round(cos(by_file[a], by_file[b]), 4) for a, b in pairs]
    print(MARKER + json.dumps({"ok": True, "cosines": cosines}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
