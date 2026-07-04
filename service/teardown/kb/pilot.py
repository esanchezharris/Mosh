#!/usr/bin/env python3
"""FX knowledge-base scrape PILOT — YouTube mixing tutorials → knowledge CARDS
(natural language ↔ plugin/chain/settings), the owner's 'encyclopedic' direction.

HONEST FRAMING (the referee is the pre-registered go/no-go, not enthusiasm): the
2026-07 training audit KILLED OCR-based video teardown for recipe mining ("synth-param
recall ≈0 after the never-mislabel gate; zero recipes ever mined from any video").
This pilot is a DIFFERENT bet on two axes: (a) a real VLM reads the plugin UI, not
tesseract; (b) the target artifact is a knowledge card (what producers SAY a move
does, tied to observed settings), not an executable recipe. If the audit's verdict
holds anyway, the go/no-go kills it again and the pilot docs say so.

Rights posture (the Bar-IQ vocabulary reframe): parameter values, chain orderings,
and technique descriptions are unprotectable FACTS; transcript excerpts are short and
attributed; no audio is retained; the YouTube license field is recorded per card;
frames are cached locally only, never redistributed.

Go/no-go (pre-registered): ≥12 cards from ≥3 videos; audit of 10 random cards ≥70%
correct (plugin identified + ≥1 param matching the frame + a recognizable NL
description); total spend ≤ $10 (hard abort via ~/mosh-kb/spend.jsonl).

    python3 service/teardown/kb/pilot.py [--videos N] [--budget 10.0]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

KB = Path(os.path.expanduser("~/mosh-kb"))
SPEND = KB / "spend.jsonl"
CARDS = KB / "cards.jsonl"
FRAMES = KB / "frames"

# search-driven selection: 2 mixing topics that directly calibrate the fx presets +
# 1 sound-design topic for continuity with the old scout catalog
QUERIES = ["OTT compressor drums trap mixing tutorial",
           "808 mixing saturation tutorial FL Studio",
           "Serum bass sound design tutorial",
           "how to mix trap drums punchy compression tutorial",
           "808 EQ low end mixing tutorial",
           "Vital synth bass patch tutorial"]
KEYWORDS = ("ott", "compressor", "compression", "saturat", "eq", "808", "sidechain",
            "serum", "limiter", "distortion", "reverb", "stereo", "wide")
PRICE_IN, PRICE_OUT = 0.15 / 1e6, 0.60 / 1e6   # gpt-4o-mini per token
MIN_CONF = 0.6                                  # never-mislabel: below → dropped


def _env_key() -> tuple:
    envf = Path(__file__).resolve().parents[3] / "ui" / ".env.local"
    key, model = os.environ.get("OPENAI_API_KEY", ""), "gpt-4o-mini"
    if envf.is_file():
        for line in envf.read_text().splitlines():
            if line.startswith("OPENAI_API_KEY=") and not key:
                key = line.split("=", 1)[1].strip()
    return key, model


def spend_total() -> float:
    if not SPEND.is_file():
        return 0.0
    return sum(json.loads(l).get("usd", 0.0) for l in SPEND.read_text().splitlines() if l.strip())


def record_spend(usd: float, what: str, budget: float):
    SPEND.parent.mkdir(parents=True, exist_ok=True)
    with open(SPEND, "a") as f:
        f.write(json.dumps({"usd": round(usd, 6), "what": what}) + "\n")
    if spend_total() > budget:
        print(f"BUDGET EXCEEDED (${spend_total():.2f} > ${budget}) — hard abort", file=sys.stderr)
        raise SystemExit(2)


def openai_json(key: str, model: str, messages: list, budget: float, what: str) -> dict:
    body = json.dumps({"model": model, "messages": messages, "max_tokens": 700,
                       "response_format": {"type": "json_object"}}).encode()
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", data=body,
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        out = json.loads(resp.read())
    u = out.get("usage", {})
    record_spend(u.get("prompt_tokens", 0) * PRICE_IN + u.get("completion_tokens", 0) * PRICE_OUT,
                 what, budget)
    try:
        return json.loads(out["choices"][0]["message"]["content"])
    except Exception:
        return {}


def fetch_video(query: str, workdir: Path) -> dict:
    """Resolve a search query to one video: metadata + auto-subs (no video download)."""
    meta_raw = subprocess.run(
        ["yt-dlp", f"ytsearch1:{query}", "--skip-download", "--write-auto-subs",
         "--sub-format", "json3", "--sub-langs", "en", "-J", "--no-warnings",
         "-o", str(workdir / "%(id)s")],
        capture_output=True, text=True, timeout=180)
    try:
        doc = json.loads(meta_raw.stdout)
        entry = (doc.get("entries") or [doc])[0]
    except Exception:
        return {}
    return {"id": entry.get("id"), "title": entry.get("title"),
            "channel": entry.get("channel"), "license": entry.get("license") or "youtube-standard",
            "url": entry.get("webpage_url"), "duration": entry.get("duration")}


def fetch_subs(video_id: str, url: str, workdir: Path) -> list:
    """[(t_seconds, text)] from auto-subs."""
    subprocess.run(["yt-dlp", url, "--skip-download", "--write-auto-subs",
                    "--sub-format", "json3", "--sub-langs", "en", "--no-warnings",
                    "-o", str(workdir / video_id)],
                   capture_output=True, text=True, timeout=180)
    subfile = next(iter(workdir.glob(f"{video_id}*.json3")), None)
    if not subfile:
        return []
    doc = json.loads(subfile.read_text())
    out = []
    for ev in doc.get("events", []) or []:
        txt = "".join(s.get("utf8", "") for s in ev.get("segs", []) or []).strip()
        if txt:
            out.append((ev.get("tStartMs", 0) / 1000.0, txt))
    return out


def keyword_moments(subs: list, max_moments: int = 8) -> list:
    """Timestamps where the producer is TALKING about an fx move (≥45 s apart)."""
    hits = [(t, txt) for t, txt in subs if any(k in txt.lower() for k in KEYWORDS)]
    picked = []
    for t, txt in hits:
        if all(abs(t - p) >= 45 for p, _ in picked):
            picked.append((t, txt))
        if len(picked) >= max_moments:
            break
    return picked


def grab_frame(url: str, t: float, dest: Path) -> bool:
    """One frame at t via the stream URL (frame_verify's pattern — no full download)."""
    g = subprocess.run(["yt-dlp", "-g", "-f", "best[height<=720]", url],
                       capture_output=True, text=True, timeout=120)
    stream = g.stdout.strip().splitlines()[0] if g.stdout.strip() else ""
    if not stream:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["ffmpeg", "-y", "-ss", str(t), "-i", stream, "-frames:v", "1",
                        "-q:v", "3", str(dest)], capture_output=True, timeout=120)
    return r.returncode == 0 and dest.is_file()


VLM_PROMPT = (
    "You are reading a frame from a music-production tutorial. If an audio plugin UI is "
    "clearly visible, report it; otherwise say so. NEVER guess: omit any parameter you "
    "cannot actually read, and give per-param confidence 0-1. Reply JSON: "
    '{"plugin_visible": bool, "plugin_name": str, "vendor_guess": str, '
    '"params": [{"name": str, "value": str, "unit": str, "confidence": float}]}')


def transcript_window(subs: list, t: float, width: float = 20.0) -> str:
    return " ".join(txt for ts, txt in subs if abs(ts - t) <= width)[:900]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--videos", type=int, default=3)
    ap.add_argument("--budget", type=float, default=10.0)
    args = ap.parse_args(argv)
    key, model = _env_key()
    if not key:
        print("no OPENAI_API_KEY reachable — abort")
        return 1
    KB.mkdir(parents=True, exist_ok=True)
    workdir = KB / "work"
    workdir.mkdir(exist_ok=True)

    n_cards = 0
    videos_used = 0
    for query in QUERIES[: args.videos]:
        meta = fetch_video(query, workdir)
        if not meta.get("id"):
            print(f"  (no video for {query!r})", file=sys.stderr)
            continue
        print(f"video: {meta['title']!r} ({meta['id']}, license {meta['license']})")
        subs = fetch_subs(meta["id"], meta["url"], workdir)
        moments = keyword_moments(subs)
        print(f"  {len(subs)} caption events, {len(moments)} keyword moments")
        made = 0
        for t, hit_txt in moments:
            frame = FRAMES / meta["id"] / f"t{int(t):05d}.jpg"
            if not frame.is_file() and not grab_frame(meta["url"], t, frame):
                continue
            b64 = base64.b64encode(frame.read_bytes()).decode()
            seen = openai_json(key, model, [
                {"role": "user", "content": [
                    {"type": "text", "text": VLM_PROMPT},
                    {"type": "image_url",
                     "image_url": {"url": f"data:image/jpeg;base64,{b64}", "detail": "high"}}]}],
                args.budget, f"vlm:{meta['id']}:{int(t)}")
            if not seen.get("plugin_visible"):
                continue
            params = [p for p in seen.get("params", [])
                      if float(p.get("confidence", 0)) >= MIN_CONF]
            ctx = transcript_window(subs, t)
            card_meta = openai_json(key, model, [
                {"role": "user", "content":
                    "From this tutorial transcript excerpt and the observed plugin state, "
                    "write a knowledge card. Reply JSON: {\"nl_description\": one sentence of "
                    "what the producer says this move DOES (their words/intent, not yours), "
                    "\"chain_context\": [strings], \"style_tags\": [strings]}.\n\n"
                    f"Transcript (±20s): {ctx}\n\nPlugin: {seen.get('plugin_name')} "
                    f"params: {json.dumps(params)}"}],
                args.budget, f"card:{meta['id']}:{int(t)}")
            card = {"id": f"{meta['id']}_{int(t)}",
                    "source": {"video_id": meta["id"], "url": meta["url"],
                               "channel": meta.get("channel"), "t": t,
                               "license": meta["license"]},
                    "plugin": {"name": seen.get("plugin_name"),
                               "vendor_guess": seen.get("vendor_guess")},
                    "observed_params": params,
                    "transcript_quote": hit_txt[:200],
                    "nl_description": card_meta.get("nl_description", ""),
                    "chain_context": card_meta.get("chain_context", []),
                    "style_tags": card_meta.get("style_tags", []),
                    "extraction": {"model": model, "frame": str(frame)}}
            with open(CARDS, "a") as f:
                f.write(json.dumps(card) + "\n")
            made += 1
            n_cards += 1
            print(f"  card @{int(t)}s: {seen.get('plugin_name')} "
                  f"({len(params)} params ≥{MIN_CONF}) — {card_meta.get('nl_description', '')[:70]}")
        if made:
            videos_used += 1

    print(f"\npilot: {n_cards} cards from {videos_used} videos, "
          f"spend ${spend_total():.2f} → {CARDS}")
    print("go/no-go bar: ≥12 cards from ≥3 videos + 10-card audit ≥70% correct")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
