"""Audiobox production-quality (PQ) worker — runs under the JUDGES venv
(`~/AI/judges_venv`, torch + audiobox_aesthetics), invoked as a subprocess by
`qa.py`. Prints `{path: pq_float}` JSON. Kept tiny + isolated so a heavy/slow judge
can't wedge the model worker (05 §7). Mirrors `judges.AudioboxJudge.pq`.
"""
import json
import sys

from audiobox_aesthetics.infer import initialize_predictor


def main():
    paths = sys.argv[1:]
    if not paths:
        print("{}")
        return
    pred = initialize_predictor()
    out = pred.forward([{"path": p} for p in paths])
    print(json.dumps({p: float(o["PQ"]) for p, o in zip(paths, out)}))


if __name__ == "__main__":
    main()
