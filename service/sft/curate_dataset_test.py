#!/usr/bin/env python3
"""Golden test for curate_dataset.py — classify, leakage filter, caps, dedupe.

Run: python3 service/sft/curate_dataset_test.py  (stdlib only, deterministic)
"""

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))


def row(user, assistant):
    return {"messages": [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]}


def write_jsonl(path, rows):
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def main():
    from curate_dataset import classify

    # ── classify ────────────────────────────────────────────────────────────────
    assert classify('{"intent":"ACK_GOT_IT","commands":[{"command":"set_tempo","args":{}}]}') == "set_tempo"
    assert classify('{"intent":"ACK_GOT_IT","commands":[{"command":"add_note"},{"command":"add_note"}]}') == "populate"
    assert classify('{"intent":"HUH","say":"?"}') == "defer"
    assert classify('{"intent":"A","commands":[{"command":"a"},{"command":"b"}]}') == "multi"
    assert classify("not json") == "unparseable"

    # ── end-to-end: leakage + caps + dedupe ─────────────────────────────────────
    with tempfile.TemporaryDirectory() as td:
        d1 = os.path.join(td, "in1")
        os.makedirs(d1)
        tempo = '{"intent":"ACK_GOT_IT","commands":[{"command":"set_tempo","args":{"bpm":120}}]}'
        vol = '{"intent":"ACK_GOT_IT","commands":[{"command":"set_track_volume","args":{"db":-6}}]}'
        rows = [row("set tempo A", tempo), row("set tempo B", tempo), row("set tempo B", tempo),  # dupe
                row("leaky", vol), row("vol ok", vol)]
        metas = [{"id": f"x#{i}", "sourceId": s} for i, s in
                 enumerate(["src-a.mid@1", "src-a.mid@1", "src-a.mid@1", "LEAK.als@9", "src-b.als@2"])]
        write_jsonl(os.path.join(d1, "train.jsonl"), rows)
        write_jsonl(os.path.join(d1, "train.meta.jsonl"), metas)
        write_jsonl(os.path.join(d1, "valid.jsonl"), [])
        excl = os.path.join(td, "frozen.eval.jsonl")
        write_jsonl(excl, [{"id": "LEAK.als@9#4", "utterance": "u"}])
        out = os.path.join(td, "out")
        subprocess.run([sys.executable, os.path.join(HERE, "curate_dataset.py"),
                        "--in", d1, "--exclude-eval", excl,
                        "--cap", "set_tempo=1", "--out", out],
                       check=True, capture_output=True)
        m = json.load(open(os.path.join(out, "manifest.json")))
        train = [json.loads(l) for l in open(os.path.join(out, "train.jsonl"))]
        assert m["stats"]["leak_dropped"] == 1, m["stats"]          # LEAK.als row dropped
        assert m["stats"]["dupe_dropped"] == 1, m["stats"]          # duplicate tempo B
        assert m["stats"]["cap_dropped"] == 1, m["stats"]           # 2nd unique tempo over cap=1
        assert m["composition"] == {"set_tempo": 1, "set_track_volume": 1}, m["composition"]
        assert len(train) == 2

    print("curate_dataset_test: ALL PASS")


if __name__ == "__main__":
    sys.path.insert(0, HERE)
    main()
