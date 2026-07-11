#!/usr/bin/env python3
from __future__ import annotations

import argparse
import html
import json
import os
import shutil
from datetime import datetime, timezone

DEFAULT_ROOT = os.path.expanduser("~/mosh-fms-ksb/used2")
DEFAULT_RAW = "nofx-whisper.json"
DEFAULT_CORRECTED = "nofx-whisper-corrected.json"
DEFAULT_AUDIO = "nofx.wav"
DEFAULT_PAGE = os.path.join("listen", "edit-transcript.html")
DEFAULT_SPLIT_IDX = 124
DEFAULT_SPLIT_TIME = 55.06


def _load_json(path: str):
    with open(path) as f:
        return json.load(f)


def _seed_words(raw_words: list[dict], corrected: dict | None) -> list[dict]:
    seeded = []
    corrected_words = list((corrected or {}).get("words") or [])
    by_source = {}
    for i, item in enumerate(corrected_words):
        src = item.get("sourceIndex", i)
        by_source[int(src)] = item
    for i, raw in enumerate(raw_words):
        prev = by_source.get(i, {})
        seeded.append({
            "word": str(prev.get("word", raw.get("word", ""))),
            "start": float(prev.get("start", raw.get("start", 0.0))),
            "end": float(prev.get("end", raw.get("end", 0.0))),
            "confidence": float(prev.get("confidence", raw.get("confidence", 0.0) or 0.0)),
            "deleted": bool(prev.get("deleted", False)),
            "sourceIndex": i,
        })
    return seeded


def _page_html(*, title: str, audio_src: str, raw_words: list[dict], seeded_words: list[dict],
               corrected_rel: str, split_idx: int, split_time: float, generated_at: str) -> str:
    raw_json = json.dumps({"ok": True, "words": raw_words}, separators=(",", ":"))
    seeded_json = json.dumps(seeded_words, separators=(",", ":"))
    corrected_rel_js = json.dumps(corrected_rel)
    return f"""<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
 :root {{
   color-scheme: dark;
   --bg: #0e0f13;
   --panel: #16181f;
   --panel-2: #111318;
   --line: #252934;
   --line-soft: #1d2028;
   --text: #e8ebf3;
   --muted: #8f96a7;
   --accent: #7fd8a7;
   --accent-soft: rgba(127, 216, 167, 0.18);
   --warn: #f3d06a;
   --danger: #ff7b7b;
 }}
 body {{
   margin: 0;
   background: radial-gradient(circle at top, #171b26 0%, var(--bg) 35%);
   color: var(--text);
   font: 15px/1.45 -apple-system, BlinkMacSystemFont, sans-serif;
 }}
 .wrap {{ max-width: 1180px; margin: 0 auto; padding: 34px 20px 80px; }}
 h1 {{ font-size: 24px; margin: 0 0 6px; }}
 .sub {{ color: var(--muted); margin: 0 0 18px; font-size: 13px; }}
 .grid {{ display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 16px; align-items: start; }}
 .card {{
   background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0));
   border: 1px solid var(--line);
   border-radius: 16px;
   padding: 16px 18px;
   box-shadow: 0 20px 60px rgba(0,0,0,0.18);
 }}
 .meta-row {{ display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-top: 10px; }}
 .btns {{ display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }}
 button {{
   font: inherit;
   border: 1px solid var(--line);
   border-radius: 10px;
   background: #1f2330;
   color: var(--text);
   padding: 8px 14px;
   cursor: pointer;
 }}
 button.primary {{ background: #223329; border-color: #2e5a42; color: #d7f5e3; }}
 button:hover {{ filter: brightness(1.08); }}
 audio {{ width: 100%; margin-top: 10px; }}
 .summary {{ display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 14px; }}
 .metric {{ background: var(--panel-2); border: 1px solid var(--line-soft); border-radius: 12px; padding: 12px; }}
 .metric b {{ display: block; font-size: 24px; margin-bottom: 4px; }}
 .metric span {{ color: var(--muted); font-size: 12px; }}
 .list-head {{
   display: grid;
   grid-template-columns: 44px 72px 74px minmax(0, 1fr) 78px 88px;
   gap: 10px;
   color: var(--muted);
   font: 11px/1.2 ui-monospace, SFMono-Regular, monospace;
   text-transform: uppercase;
   letter-spacing: 0.06em;
   padding: 0 10px 8px;
 }}
 .rows {{
   max-height: 72vh;
   overflow: auto;
   padding-right: 4px;
 }}
 .word-row {{
   display: grid;
   grid-template-columns: 44px 72px 74px minmax(0, 1fr) 78px 88px;
   gap: 10px;
   align-items: center;
   padding: 10px;
   border-radius: 12px;
   border: 1px solid transparent;
   margin-bottom: 8px;
   background: rgba(255,255,255,0.01);
 }}
 .word-row:hover {{ border-color: var(--line); background: rgba(255,255,255,0.025); }}
 .word-row.split {{ border-color: rgba(243, 208, 106, 0.35); background: rgba(243, 208, 106, 0.08); }}
 .word-row.deleted {{ opacity: 0.55; background: rgba(255, 123, 123, 0.06); }}
 .idx, .ts, .conf {{ font: 12px/1.2 ui-monospace, SFMono-Regular, monospace; color: var(--muted); }}
 .conf.low {{ color: var(--warn); }}
 .conf.bad {{ color: var(--danger); }}
 input.word {{
   width: 100%;
   box-sizing: border-box;
   background: var(--panel-2);
   color: var(--text);
   border: 1px solid var(--line);
   border-radius: 8px;
   padding: 8px 10px;
   font: 14px/1.2 ui-monospace, SFMono-Regular, monospace;
 }}
 .seek, .toggle {{
   border: 1px solid var(--line);
   border-radius: 8px;
   background: #1b1f29;
   color: var(--text);
   padding: 8px 10px;
   text-align: center;
 }}
 .toggle[data-on="true"] {{
   background: rgba(255, 123, 123, 0.16);
   border-color: rgba(255, 123, 123, 0.4);
   color: #ffd6d6;
 }}
 .pill {{
   display: inline-flex;
   align-items: center;
   gap: 6px;
   padding: 4px 8px;
   border-radius: 999px;
   background: var(--accent-soft);
   color: #d8f5e5;
   font-size: 12px;
 }}
 .split-note {{
   margin-top: 10px;
   font-size: 12px;
   color: var(--warn);
 }}
 .path {{
   margin-top: 10px;
   color: var(--muted);
   font: 12px/1.4 ui-monospace, SFMono-Regular, monospace;
   word-break: break-all;
 }}
 .footer {{
   margin-top: 12px;
   color: var(--muted);
   font-size: 12px;
 }}
 textarea.hidden-copy {{ position: absolute; left: -9999px; top: -9999px; }}
 @media (max-width: 980px) {{
   .grid {{ grid-template-columns: 1fr; }}
   .rows {{ max-height: none; }}
 }}
</style></head>
<body><div class="wrap">
  <h1>{html.escape(title)}</h1>
  <p class="sub">Edit the Whisper words, soft-delete hallucinations, and save a corrected JSON for the alignment rerun. Split is locked to the owner-confirmed <code>Truman.</code> word at <code>{split_time:.2f}s</code>.</p>
  <div class="grid">
    <div class="card">
      <div class="pill">Generated {html.escape(generated_at)}</div>
      <audio id="audio" controls preload="auto" src="{html.escape(audio_src)}"></audio>
      <div class="meta-row">
        <span>raw cache stays untouched</span>
        <span>working array: <code>window.correctedWords</code></span>
      </div>
      <div class="summary">
        <div class="metric"><b id="m-total">0</b><span>raw words</span></div>
        <div class="metric"><b id="m-active">0</b><span>active words</span></div>
        <div class="metric"><b id="m-deleted">0</b><span>soft deleted</span></div>
        <div class="metric"><b id="m-low">0</b><span>sub-0.6 confidence</span></div>
      </div>
      <div class="split-note">Split marker = source index {split_idx}, time {split_time:.2f}s. Everything after that source word is mumble territory.</div>
      <div class="btns">
        <button class="primary" id="save-btn">Save corrected JSON</button>
        <button id="copy-btn">Copy JSON</button>
        <button id="reset-btn">Reset to raw</button>
      </div>
      <div class="path">target artifact: {html.escape(corrected_rel)}</div>
      <div class="footer" id="status">Ready.</div>
    </div>
    <div class="card">
      <div class="list-head">
        <span>#</span><span>start</span><span>conf</span><span>word</span><span>seek</span><span>delete</span>
      </div>
      <div class="rows" id="rows"></div>
    </div>
  </div>
  <textarea class="hidden-copy" id="copy-buffer" aria-hidden="true"></textarea>
</div>
<script>
const RAW = {raw_json};
const SEEDED = {seeded_json};
const SPLIT_SOURCE_INDEX = {split_idx};
const SPLIT_TIME_S = {split_time};
const TARGET_SAVE_NAME = {corrected_rel_js}.split('/').pop();
window.correctedWords = SEEDED.map(w => ({{...w}}));
const rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status');
const audioEl = document.getElementById('audio');

function exportPayload() {{
  const words = window.correctedWords.map((w, i) => ({{
    word: String(w.word ?? ""),
    start: +Number(w.start ?? 0).toFixed(4),
    end: +Number(w.end ?? 0).toFixed(4),
    confidence: +Number(w.confidence ?? 0).toFixed(6),
    deleted: !!w.deleted,
    sourceIndex: Number.isFinite(+w.sourceIndex) ? +w.sourceIndex : i
  }}));
  const active = words.filter(w => !w.deleted);
  const real = active.filter(w => w.sourceIndex <= SPLIT_SOURCE_INDEX);
  const mumble = active.filter(w => w.sourceIndex > SPLIT_SOURCE_INDEX);
  return {{
    ok: true,
    words,
    metadata: {{
      source: "edit-transcript.html",
      editedAt: new Date().toISOString(),
      splitWordIdx: SPLIT_SOURCE_INDEX,
      splitTimeS: SPLIT_TIME_S,
      rawWordCount: RAW.words.length,
      activeWordCount: active.length,
      realWordCount: real.length,
      mumbleWordCount: mumble.length
    }}
  }};
}}

function updateMetrics() {{
  const words = window.correctedWords;
  const active = words.filter(w => !w.deleted);
  const low = active.filter(w => Number(w.confidence || 0) < 0.6).length;
  document.getElementById('m-total').textContent = String(words.length);
  document.getElementById('m-active').textContent = String(active.length);
  document.getElementById('m-deleted').textContent = String(words.length - active.length);
  document.getElementById('m-low').textContent = String(low);
}}

function renderRows() {{
  rowsEl.innerHTML = "";
  window.correctedWords.forEach((word, idx) => {{
    const row = document.createElement('div');
    row.className = 'word-row' + (word.deleted ? ' deleted' : '') + ((word.sourceIndex ?? idx) === SPLIT_SOURCE_INDEX ? ' split' : '');
    row.dataset.index = String(idx);
    row.innerHTML = `
      <div class="idx">${{idx}}</div>
      <div class="ts">${{Number(word.start || 0).toFixed(2)}}s</div>
      <div class="conf ${{Number(word.confidence || 0) < 0.4 ? 'bad' : Number(word.confidence || 0) < 0.6 ? 'low' : ''}}">${{Number(word.confidence || 0).toFixed(3)}}</div>
      <input class="word" value="${{String(word.word ?? '').replace(/"/g, '&quot;')}}" aria-label="Word ${{idx}}">
      <button class="seek" type="button">Seek</button>
      <button class="toggle" type="button" data-on="${{word.deleted ? 'true' : 'false'}}">${{word.deleted ? 'Restore' : 'Delete'}}</button>
    `;
    if ((word.sourceIndex ?? idx) === SPLIT_SOURCE_INDEX) {{
      const badge = document.createElement('div');
      badge.className = 'split-note';
      badge.textContent = `Split marker: "${{word.word}}" @ ${{Number(word.start || 0).toFixed(2)}}s`;
      row.appendChild(badge);
    }}
    const input = row.querySelector('input.word');
    input.addEventListener('input', (e) => {{
      window.correctedWords[idx].word = e.target.value;
      statusEl.textContent = `Edited source word ${{word.sourceIndex ?? idx}}.`;
    }});
    row.querySelector('.seek').addEventListener('click', () => {{
      audioEl.currentTime = Number(window.correctedWords[idx].start || 0);
      void audioEl.play();
    }});
    row.querySelector('.toggle').addEventListener('click', (e) => {{
      window.correctedWords[idx].deleted = !window.correctedWords[idx].deleted;
      renderRows();
      updateMetrics();
      statusEl.textContent = window.correctedWords[idx].deleted
        ? `Deleted source word ${{word.sourceIndex ?? idx}} from corrected output.`
        : `Restored source word ${{word.sourceIndex ?? idx}}.`;
    }});
    rowsEl.appendChild(row);
  }});
  updateMetrics();
}}

async function writeWithPicker(text) {{
  if (!window.showSaveFilePicker) return false;
  const handle = await window.showSaveFilePicker({{
    suggestedName: TARGET_SAVE_NAME,
    types: [{{ description: 'JSON', accept: {{ 'application/json': ['.json'] }} }}]
  }});
  const writable = await handle.createWritable();
  await writable.write(text);
  await writable.close();
  return true;
}}

function downloadFallback(text) {{
  const blob = new Blob([text], {{ type: 'application/json' }});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = TARGET_SAVE_NAME;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}}

async function saveJson() {{
  const payload = exportPayload();
  const text = JSON.stringify(payload, null, 2);
  try {{
    const wrote = await writeWithPicker(text);
    if (wrote) {{
      statusEl.textContent = `Saved corrected JSON via file picker as ${{TARGET_SAVE_NAME}}.`;
      return;
    }}
  }} catch (err) {{
    statusEl.textContent = `File picker save failed: ${{err.message}}. Falling back to download.`;
  }}
  downloadFallback(text);
  statusEl.textContent = `Downloaded corrected JSON as ${{TARGET_SAVE_NAME}}. Move it to the used2 folder if your browser saved elsewhere.`;
}}

async function copyJson() {{
  const text = JSON.stringify(exportPayload(), null, 2);
  try {{
    await navigator.clipboard.writeText(text);
    statusEl.textContent = 'Copied corrected JSON to clipboard.';
  }} catch (_err) {{
    const ta = document.getElementById('copy-buffer');
    ta.value = text;
    ta.select();
    document.execCommand('copy');
    statusEl.textContent = 'Copied corrected JSON using the fallback copy path.';
  }}
}}

function resetToRaw() {{
  window.correctedWords = RAW.words.map((w, i) => ({{
    word: w.word,
    start: w.start,
    end: w.end,
    confidence: w.confidence,
    deleted: false,
    sourceIndex: i
  }}));
  renderRows();
  statusEl.textContent = 'Reset to the raw Whisper cache.';
}}

document.getElementById('save-btn').addEventListener('click', () => void saveJson());
document.getElementById('copy-btn').addEventListener('click', () => void copyJson());
document.getElementById('reset-btn').addEventListener('click', resetToRaw);
renderRows();
</script></body></html>"""


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--raw", default=DEFAULT_RAW)
    ap.add_argument("--corrected", default=DEFAULT_CORRECTED)
    ap.add_argument("--audio", default=DEFAULT_AUDIO)
    ap.add_argument("--out", default=DEFAULT_PAGE)
    ap.add_argument("--title", default="Used2 — editable Whisper transcript")
    ap.add_argument("--split-word-idx", type=int, default=DEFAULT_SPLIT_IDX)
    ap.add_argument("--split-time-s", type=float, default=DEFAULT_SPLIT_TIME)
    args = ap.parse_args()

    root = os.path.abspath(os.path.expanduser(args.root))
    raw_path = os.path.join(root, args.raw)
    corrected_path = os.path.join(root, args.corrected)
    out_path = os.path.join(root, args.out)
    out_dir = os.path.dirname(out_path)
    os.makedirs(out_dir, exist_ok=True)

    raw = _load_json(raw_path)
    corrected = _load_json(corrected_path) if os.path.isfile(corrected_path) else None
    seeded_words = _seed_words(raw.get("words") or [], corrected)

    audio_src = os.path.join(out_dir, os.path.basename(args.audio))
    audio_abs = os.path.join(root, args.audio)
    if os.path.abspath(audio_src) != os.path.abspath(audio_abs):
        shutil.copyfile(audio_abs, audio_src)
    else:
        audio_src = os.path.basename(args.audio)

    page = _page_html(
        title=args.title,
        audio_src=os.path.basename(audio_src),
        raw_words=raw.get("words") or [],
        seeded_words=seeded_words,
        corrected_rel=os.path.relpath(corrected_path, out_dir),
        split_idx=args.split_word_idx,
        split_time=args.split_time_s,
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    with open(out_path, "w") as f:
        f.write(page)
    print(out_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
