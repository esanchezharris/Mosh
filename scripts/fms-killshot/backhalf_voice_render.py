#!/usr/bin/env python3
"""Voice render — the B verse sung in the OWNER'S VOICE over the mumble section. No more sine.

The beeps proved the words sit on the flow; this renders them for real. Source carrier = the
FX vocal (`all.wav`, the config that "sounds exactly like my voice"), section 8.5–22.5s of
the back half. Two arms, both B major @ 138, seed 4099, torch DiT, HF-offline worker:

  flow-edit n0.0–0.7 — ACE's keep-the-audio-replace-the-lyrics mechanism (the round-3
      standout: genuinely re-sung + melody-locked). Source lyrics = the mumble's ASR words,
      target = the approved B verse.
  cover str0.7       — the full-song sonic winner. Words conditioned but loose (may echo the
      mumble's own words back — that's the known trade).

Serves raw mumble + both vocals on the one clean page. Words land by diffusion, not by
contract — ASR ranks, the owner's ear declares.
"""
from __future__ import annotations

import html
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from asserted_proof_ace_cover import ACE_PY, ACE_ROOT, ACE_WORKER, build_worker_request  # noqa: E402
from asserted_proof_ace_flowedit import build_flow_edit_request  # noqa: E402

ROOT = Path("~/mosh-fms-ksb/used2").expanduser()
ACE_DIR = ROOT / "asserted-proof/opening/ace-step-cover"
BH = ROOT / "asserted-proof/back-half"
SERVE = ROOT / "asserted-proof"
VOICE = BH / "voice"
PAGE = SERVE / "index.html"
OUT_JSON = BH / "voice-render.json"

SPLIT_S = 55.06                      # back half starts here in all.wav
SECT0, SECT1 = 8.5, 22.5             # the bench section (back-half clock)
SEED = 4099
KEYSCALE, BPM = "B major", 138


def b_words() -> list:
    data = json.loads((BH / "flowfit-ab.json").read_text())
    return [w["text"] for w in data["words"] if w.get("text")]


def section_asr() -> str:
    """The mumble's own words inside the section window (absolute clock) — flow-edit's V_src."""
    d = json.loads((ROOT / "nofx-whisper-corrected.json").read_text())
    lo, hi = SPLIT_S + SECT0, SPLIT_S + SECT1
    return " ".join(w["word"] for w in d["words"]
                    if not w.get("deleted") and lo <= float(w["start"]) < hi)


def run_worker(request: dict, tag: str) -> Path:
    save_dir = VOICE / f"worker-{tag}"
    save_dir.mkdir(parents=True, exist_ok=True)
    wr = VOICE / f"request-{tag}.json"
    wr.write_text(json.dumps(build_worker_request(request, root=ROOT, seeds=[SEED], save_dir=save_dir), indent=2))
    res = VOICE / f"result-{tag}.json"
    t0 = time.perf_counter()
    subprocess.run([str(ACE_PY), str(ACE_WORKER), "--request", str(wr), "--output", str(res)],
                   cwd=ACE_ROOT, timeout=1800, check=False)
    wall = round(time.perf_counter() - t0, 1)
    result = json.loads(res.read_text())
    entry = next((r for r in result.get("results", []) if r.get("ok")), None)
    if not entry:
        raise SystemExit(f"[{tag}] render FAILED: "
                         f"{result.get('error') or [r.get('error') for r in result.get('results', [])]}")
    print(f"  [{tag}] OK in {wall}s", flush=True)
    return Path(entry["audioPath"])


def build() -> dict:
    VOICE.mkdir(parents=True, exist_ok=True)
    words = b_words()
    target = "[Verse]\n" + "\n".join(words)
    source = section_asr()
    print(f"target ({len(words)} lines): {' / '.join(words)}", flush=True)
    print(f"source ASR: {source}", flush=True)

    # section slice of the FX vocal, 48k stereo pcm16 (the worker's source spec)
    src = VOICE / "source-section-48k.wav"
    subprocess.run(["ffmpeg", "-y", "-ss", str(SPLIT_S + SECT0), "-to", str(SPLIT_S + SECT1),
                    "-i", str(ROOT / "all.wav"), "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
                    str(src)], check=True, capture_output=True)
    src_rel = str(src.relative_to(ROOT))

    main_request = json.loads((ACE_DIR / "request.json").read_text())

    # ── arm 1: flow-edit n0.0–0.7 (re-sung + melody-locked; the lyric-replacement lane) ──
    fe = build_flow_edit_request(main_request, source_lyrics=source, target_lyrics=target,
                                 keyscale=KEYSCALE, bpm=BPM, n_min=0.0, n_max=0.7,
                                 seed=SEED, src_audio_rel=src_rel, src_tag="bhvoice")
    fe_wav = run_worker(fe, "flowedit")

    # ── arm 2: plain cover str0.7 (the full-song sonic winner; loose word landing) ──────
    cov = json.loads(json.dumps(main_request))
    for volatile in ("requestSha256", "createdAt", "updatedAt"):
        cov.pop(volatile, None)
    p = cov["params"]
    p["keyscale"], p["bpm"] = KEYSCALE, BPM
    p["cover_noise_strength"] = 0.7
    p["lyrics"] = target
    p["src_audio"] = src_rel
    cov["useMlxDit"] = False
    cov_wav = run_worker(cov, "cover07")

    # serve-root copies (mono mumble reference + the two vocals)
    subprocess.run(["ffmpeg", "-y", "-i", str(src), "-ac", "1", "-ar", "44100",
                    str(SERVE / "mumble-section.wav")], check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(fe_wav), str(SERVE / "voice-flowedit.wav")],
                   check=True, capture_output=True)
    subprocess.run(["ffmpeg", "-y", "-i", str(cov_wav), str(SERVE / "voice-cover07.wav")],
                   check=True, capture_output=True)

    out = {"section": [SECT0, SECT1], "seed": SEED, "keyscale": KEYSCALE, "bpm": BPM,
           "words": words, "sourceAsr": source,
           "arms": [{"key": "flowedit", "name": "Flow-edit (melody-locked re-sing)", "wav": "voice-flowedit.wav",
                     "blurb": "ACE's keep-the-audio-replace-the-lyrics lane (window 0.0–0.7) — re-sung, melody locked to your take."},
                    {"key": "cover07", "name": "Cover, strength 0.7", "wav": "voice-cover07.wav",
                     "blurb": "The full-song sonic winner. Voice is closest here, but words land loosely — it may echo your mumble's own words."}]}
    OUT_JSON.write_text(json.dumps(out, indent=2))
    return out


def render_page(data: dict) -> None:
    words_rows = "".join(f"<tr><td class='idx'>L{i}</td><td class='txt'>{html.escape(w)}</td></tr>"
                         for i, w in enumerate(data["words"]))
    arm_cards = "".join(f"""
      <div class="card">
        <div class="chead"><h2>{html.escape(a['name'])}</h2></div>
        <p class="blurb">{html.escape(a['blurb'])}</p>
        <audio controls preload="metadata" src="{a['wav']}"></audio>
      </div>""" for a in data["arms"])
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Used2 — the verse in YOUR voice</title>
<style>
  body{{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}}
  .wrap{{max-width:820px;margin:0 auto;padding:26px 20px 80px}}
  h1{{font-size:22px;margin:0 0 4px}} .sub{{color:#8b949e;margin:0 0 22px}}
  .card{{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px 18px;margin:0 0 16px}}
  .chead h2{{font-size:16px;margin:0}} .blurb{{color:#8b949e;font-size:13px;margin:8px 0 10px}}
  audio{{width:100%}}
  .ref h2{{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px}}
  table{{width:100%;border-collapse:collapse;font-size:13px}} td{{padding:5px 8px;border-top:1px solid #21262d}}
  .idx{{color:#6e7681;width:34px}} .txt{{font-weight:600}}
  .meta{{color:#6e7681;font-size:12px;margin-top:8px}}
</style></head><body><div class="wrap">
  <h1>Used2 — the verse, sung in your voice</h1>
  <p class="sub">Same ~14s section. Your B-verse words rendered through the voice model — no more beeps.</p>
  <div class="card ref"><h2>Your raw mumble (reference)</h2>
    <audio controls preload="metadata" src="mumble-section.wav"></audio></div>
  {arm_cards}
  <div class="card"><h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e;margin:0 0 8px">The words it was told to sing</h2>
    <table><tbody>{words_rows}</tbody></table>
    <p class="meta">{html.escape(data['keyscale'])} @ {data['bpm']} · seed {data['seed']} · torch DiT · source: your FX vocal</p></div>
</div></body></html>"""
    PAGE.write_text(page)
    print(f"page -> {PAGE}", flush=True)


if __name__ == "__main__":
    render_page(json.loads(OUT_JSON.read_text()) if "--page-only" in sys.argv else build())
