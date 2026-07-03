#!/usr/bin/env python3
"""Tokenizer-true length filter for a chat-JSONL training mix (pre-registered in
docs/bench/PROGRAM_STAGE1_2026-07.md §P4 via the plan's NaN mitigation): drop
rows whose full chat-templated length exceeds --max-seq, or whose PROMPT alone
(system+user, generation prompt added) leaves no unmasked completion tokens —
the mask-prompt+overlength→NaN class, removed at the source.

Run under the sft venv (has transformers via mlx-lm):
  "$SFT_PY" service/sft/filter_by_length.py --model <MODEL_DIR> \
      --data service/sft/.sft-data/s2-mix --max-seq 4096
Filters train.jsonl and valid.jsonl IN PLACE (originals -> .prefilter.jsonl),
appends a `lengthFilter` block to manifest.json.
"""
import argparse, json, os, sys

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="HF model dir (tokenizer source)")
    ap.add_argument("--data", required=True, help="dataset dir with train/valid.jsonl")
    ap.add_argument("--max-seq", type=int, default=4096)
    a = ap.parse_args()

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model)

    report = {"model": a.model, "maxSeq": a.max_seq, "files": {}}
    for name in ("train.jsonl", "valid.jsonl"):
        path = os.path.join(a.data, name)
        if not os.path.exists(path):
            continue
        keep, dropped_long, dropped_nocompletion, total = [], 0, 0, 0
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                total += 1
                msgs = json.loads(line)["messages"]
                full = tok.apply_chat_template(msgs, tokenize=True)
                if len(full) > a.max_seq:
                    dropped_long += 1
                    continue
                prompt = tok.apply_chat_template(msgs[:-1], tokenize=True, add_generation_prompt=True)
                if len(prompt) >= a.max_seq - 1:  # no room for even one completion token
                    dropped_nocompletion += 1
                    continue
                keep.append(line)
        os.replace(path, path.replace(".jsonl", ".prefilter.jsonl"))
        with open(path, "w") as f:
            f.write("\n".join(keep) + "\n")
        report["files"][name] = {"total": total, "kept": len(keep),
                                 "droppedOverMax": dropped_long,
                                 "droppedNoCompletionRoom": dropped_nocompletion}
        print(f"{name}: {total} -> {len(keep)} (over-max {dropped_long}, no-completion-room {dropped_nocompletion})")

    man_path = os.path.join(a.data, "manifest.json")
    if os.path.exists(man_path):
        man = json.load(open(man_path))
        man["lengthFilter"] = report
        json.dump(man, open(man_path, "w"), indent=2)
    print("manifest updated" if os.path.exists(man_path) else "no manifest")

if __name__ == "__main__":
    sys.exit(main())
