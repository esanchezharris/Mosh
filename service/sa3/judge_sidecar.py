"""Persistent judge sidecar (05 §7) — loads the Audiobox aesthetics model ONCE,
then answers production-quality (PQ) requests over stdin/stdout so QA costs ~1–2s
per render instead of ~25s (a fresh process reloaded the model every time).

Runs under the JUDGES venv (`~/AI/judges_venv`, torch + audiobox_aesthetics),
spawned + kept alive by `qa.py` (which runs in the server/MLX-venv process). The
single server worker calls it serially, so no concurrency.

Protocol (line-delimited JSON, prefixed so model/library stdout noise can't corrupt
it): the sidecar prints `@@MOSH@@{...}` lines to stdout; everything else (incl. the
model's own prints) is redirected to stderr.
  • on load:    @@MOSH@@{"ready": true}
  • request  →  {"paths": ["/a.wav", "/b.wav"]}   (one JSON object per line, on stdin)
  • response ←  @@MOSH@@{"/a.wav": {"PQ": 5.7, "CE": 6.1, "CU": 5.9, "PC": 4.2}, ...}

The per-path value carries ALL of Audiobox's aesthetic axes (production quality PQ,
content enjoyment CE, content usefulness CU, production complexity PC) so the caller can
both keep the bare `pq` number AND build a human-readable judge reasoning (AL-006).
"""
import json
import sys

MARK = "@@MOSH@@"


def _emit(obj, out):
    out.write(MARK + json.dumps(obj) + "\n")
    out.flush()


def main():
    real_out = sys.stdout
    sys.stdout = sys.stderr                     # keep the protocol channel clean

    from audiobox_aesthetics.infer import initialize_predictor
    pred = initialize_predictor()
    _emit({"ready": True}, real_out)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            paths = req.get("paths", [])
            out = pred.forward([{"path": p} for p in paths])
            # Carry every aesthetic axis the model reports (PQ/CE/CU/PC), coerced to float.
            payload = {}
            for p, o in zip(paths, out):
                payload[p] = {k: float(v) for k, v in o.items()
                              if k in ("PQ", "CE", "CU", "PC") and v is not None}
            _emit(payload, real_out)
        except Exception as e:  # noqa: BLE001
            _emit({"error": str(e)}, real_out)


if __name__ == "__main__":
    main()
