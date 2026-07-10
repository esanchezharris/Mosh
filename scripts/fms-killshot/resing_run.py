#!/usr/bin/env python3
"""Re-sing driver (FMS re-sing, stages ③④⑤) — one voice, whole section, owner-gated.

Replaces the splice/keep-raw/SVC hybrid. Three phases, mirroring the review gates:

  --phase sheet    decode the take → skeleton + coherence gate → sheet.json.
                   (Delegates to hybrid_sing.phase_sheet — the decode is identical.)
  --phase author   sheet.json → section_lyric.author_section: ONE whole-song pass that fills
                   every mumbled line as part of one coherent lyric (his kept words are anchors).
                   Writes sheet-final.json and PRINTS it — the owner nudges the words here.
  --phase render   sheet-final.json + the take → resing_score (clamp every note to the take's
                   MEASURED voicing → author ONE SoulX score, rests where he rested) → render
                   score-mode in his voice (the KS-A-validated `--control score`) → resing.wav.
                   Then energy_compare vs the take (must show 0 render-in-take-silence windows).

The decode + MPS render are owner-gated (Basic Pitch / Whisper / skeleton venvs + the
SoulX-Singer-MLX bridge). The pure cores (section_lyric, resing_score) are golden-tested.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(REPO, "service"))
sys.path.insert(0, HERE)

MAC = os.path.expanduser(os.environ.get("SOULX_MAC_DIR", "~/AI/soulx-mac"))
BRIDGE = os.path.join(MAC, "SoulX-Singer-MLX")
VENV_PY = os.path.join(MAC, "venv/bin/python")
MODEL = os.path.join(BRIDGE, "models/SoulX-Singer-bf16")
PHONESET = os.path.join(BRIDGE, "soulxsinger/utils/phoneme/phone_set.json")


# ── phase: author (whole-section coherent lyric; owner nudge gate) ──────────────────────

def phase_author(args) -> int:
    import section_lyric
    import hybrid_sing
    sheet = json.load(open(os.path.join(args.out, "sheet.json")))
    print("1) author the WHOLE section as one coherent lyric (kept words are anchors) …", flush=True)
    res = section_lyric.author_section(sheet, backend=args.backend or None)
    with open(os.path.join(args.out, "sheet-final.json"), "w") as f:
        json.dump(res["sheet"], f, indent=1)
    print(f"   wrote {res['written']} lines (backend={res['backend']})")
    hybrid_sing.print_sheet(res["sheet"], "final lyric (KEEP = his words, WRITE/MIX = new, coherent)")
    print(f"\nsheet-final -> {args.out}/sheet-final.json")
    print("STOP: owner reads the WHOLE lyric, nudges any line, then --phase render.")
    return 0


# ── phase: render (clamp → one score → his voice → QA) ─────────────────────────────────

def phase_render(args) -> int:
    import resing_score
    import energy_compare
    from skeleton import core as skcore
    import diagnose

    sheet = json.load(open(os.path.join(args.out, "sheet-final.json")))
    with tempfile.TemporaryDirectory() as td:
        take_wav = diagnose._to_wav(os.path.abspath(args.take), td)
        pcm = skcore.read_pcm_mono(take_wav)
        if not pcm:
            print("FATAL: could not read the take audio", file=sys.stderr)
            return 1
        env = skcore.energy_envelope(pcm[0], pcm[1])

        print("1) author ONE re-sing score (clamp every note to his voicing) …", flush=True)
        res = resing_score.author_resing_score(sheet, env=env, hop_s=0.01, name="resing")
        if not res.get("ok"):
            print(f"FATAL author: {res.get('error')}", file=sys.stderr)
            return 1
        print(f"   {res['events']} events, {res['words']} words, {res['rests']} rests, "
              f"{res.get('slotsDropped', 0)} notes dropped as silence; clip {res['score'][0]['time']}")
        target = os.path.join(args.out, "target_score.json")
        json.dump(res["score"], open(target, "w"))

        print("2) render score-mode in his voice (clean prompt, KS-A `--control score`) …", flush=True)
        mel_dir = os.path.join(args.out, "render")
        os.makedirs(mel_dir, exist_ok=True)
        envx = dict(os.environ, PYTHONPATH=BRIDGE, PYTORCH_ENABLE_MPS_FALLBACK="1")
        r = subprocess.run([VENV_PY, os.path.join(BRIDGE, "scripts/inference_mlx_bridge.py"),
                            "--model", MODEL, "--component", "svs", "--control", "score", "--device", "mps",
                            "--prompt_wav_path", args.ref, "--prompt_metadata_path", args.ref_meta,
                            "--target_metadata_path", target, "--phoneset_path", PHONESET,
                            "--n_steps", str(args.n_steps), "--cfg", str(args.cfg), "--pitch_shift", "0",
                            "--save_dir", mel_dir], cwd=BRIDGE, env=envx)
        if r.returncode != 0:
            print("FATAL: render failed", file=sys.stderr)
            return 1
        render_wav = os.path.join(mel_dir, "generated.wav")
        final = os.path.join(args.out, "resing.wav")
        import shutil
        shutil.copyfile(render_wav, final)

        print("3) QA: per-second energy — the re-sing must be silent where he was silent", flush=True)
        te = energy_compare.envelope(*energy_compare.read_pcm_mono(take_wav))
        re_ = energy_compare.envelope(*energy_compare.read_pcm_mono(final))
        qa = energy_compare.compare(te, re_)
        json.dump(qa, open(os.path.join(args.out, "qa.json"), "w"))
    print(f"done -> {final}")
    print(f"   render_in_take_silence={qa['render_in_take_silence']} (want 0)  "
          f"envelope_corr={qa['envelope_corr']}  flagged={qa['flagged_pct']}%")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--phase", required=True, choices=("sheet", "author", "render"))
    ap.add_argument("--out", required=True)
    # sheet
    ap.add_argument("--input")
    ap.add_argument("--bpm", type=float, default=120.0)
    ap.add_argument("--grid", default="1/16")
    ap.add_argument("--topic", default="")
    ap.add_argument("--mood", default="")
    ap.add_argument("--whisper-model", default="small")
    ap.add_argument("--no-llm", action="store_true")
    # author
    ap.add_argument("--backend", default="", help="lyric backend: fake|llm (default auto)")
    # render
    ap.add_argument("--take", help="the raw take wav/m4a (its timeline == the sheet's)")
    ap.add_argument("--ref", help="clean SVS prompt wav (author_prompt.py)")
    ap.add_argument("--ref-meta", help="clean SVS prompt metadata (.json)")
    ap.add_argument("--n-steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=3.0)
    args = ap.parse_args()

    if args.phase == "sheet":
        import hybrid_sing
        if not args.input:
            print("--input required for --phase sheet", file=sys.stderr)
            return 2
        return hybrid_sing.phase_sheet(args)
    if args.phase == "author":
        return phase_author(args)
    for req in ("take", "ref", "ref_meta"):
        if not getattr(args, req):
            print(f"--{req.replace('_', '-')} required for --phase render", file=sys.stderr)
            return 2
    return phase_render(args)


if __name__ == "__main__":
    sys.exit(main())
