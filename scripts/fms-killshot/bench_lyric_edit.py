#!/usr/bin/env python3
"""Lyric-correction tool — listen to the take, fix the ASR draft line by line.

The bench can only sing words it has VERIFIED lyrics for (ASR-guessed words would make
the word gate circular), which caps every round at the first ~15 s of each song. This
serves a small local page: the finished vocal with a real transport (play/pause/scrub,
per-line playback) beside an editable row per ASR line. Corrections autosave to
`<dataset>/asr-draft/<song>.corrected.json` + a plain `.corrected.txt`; the alignment
step then turns them into true word timings.

Pure cores (golden-tested): `build_lines`, `validate_correction`, `save_correction`.
Everything else is transport (a stdlib http server, POST-capable — python -m http.server
cannot accept the save).

Run:  bench_lyric_edit.py [--port 8199] [--dataset DIR] [--out DIR]
"""
import argparse
import html
import json
import os
import shutil
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_DATASET = os.path.expanduser("~/mosh-fms-ksb/bench/datasets/own-pairs")
SONGS = ("LookinBack", "stage9orsum", "stage10")
MAX_LINE_CHARS = 400
MAX_LINES = 400


# ── pure cores ──────────────────────────────────────────────────────────────────────────

def build_lines(segments, dur, verified_until=0.0, verified_words=None):
    """ASR segments -> editable rows. Each row's play span runs to the NEXT row's start
    (a click plays the whole line, not a fragment); the last runs to the take end.

    A row inside the verified span shows the TRUE words (bucketed from `verified_words`
    by onset), never the transcriber's guess of them — showing an ASR guess under a
    "verified" label would invite the owner to 'correct' data that is already correct.
    A verified span holding no words falls back to the ASR text rather than blanking."""
    out = []
    for i, s in enumerate(segments):
        t0 = float(s["start"])
        nxt = float(segments[i + 1]["start"]) if i + 1 < len(segments) else float(dur)
        text = str(s.get("text", "")).strip()
        verified = t0 < float(verified_until)
        if verified and verified_words:
            true = " ".join(str(w["word"]) for w in verified_words
                            if t0 <= float(w["start"]) < nxt)
            text = true or text
        out.append({"id": f"L{i:03d}", "t": round(t0, 2),
                    "playEnd": round(max(t0, nxt), 2), "text": text, "verified": verified})
    return out


def parse_range(header, size):
    """Parse a byte-range header -> (start, end) inclusive, None (serve whole), or
    "invalid" (416). Audio SEEKING depends on this: a server that answers 200-with-the-
    whole-file makes every timestamp click play from zero (measured, not theorised)."""
    if not header or not str(header).startswith("bytes="):
        return None
    spec = str(header)[len("bytes="):].split(",")[0].strip()
    try:
        if spec.startswith("-"):
            n = int(spec[1:])
            if n <= 0:
                return "invalid"
            return (max(0, size - n), size - 1)
        lo, _, hi = spec.partition("-")
        start = int(lo)
        end = int(hi) if hi else size - 1
    except ValueError:
        return None
    if start >= size or start < 0:
        return "invalid"
    return (start, min(end, size - 1))


def validate_correction(payload, allowed_songs):
    """Guard anything a browser may write to disk. Returns (ok, error)."""
    if not isinstance(payload, dict):
        return False, "payload must be an object"
    song = payload.get("song")
    if not isinstance(song, str) or song not in allowed_songs:
        return False, "unknown song"
    lines = payload.get("lines")
    if not isinstance(lines, list):
        return False, "lines must be a list"
    if len(lines) > MAX_LINES:
        return False, "too many lines"
    for ln in lines:
        if not isinstance(ln, dict):
            return False, "line must be an object"
        t, text = ln.get("t"), ln.get("text")
        if not isinstance(t, (int, float)) or t < 0 or t > 36000:
            return False, "bad time"
        if not isinstance(text, str) or len(text) > MAX_LINE_CHARS:
            return False, "bad text"
    return True, ""


def save_correction(payload, out_dir):
    """Atomically write `<song>.corrected.json` (+ a plain-text sidecar of the non-blank
    lines, in time order). Returns {"json": path, "txt": path}."""
    os.makedirs(out_dir, exist_ok=True)
    song = payload["song"]
    lines = sorted(({"t": round(float(ln["t"]), 2), "text": str(ln["text"]).strip()}
                    for ln in payload["lines"]), key=lambda ln: ln["t"])
    doc = {"song": song, "lines": lines,
           "nonBlank": sum(1 for ln in lines if ln["text"])}
    paths = {"json": os.path.join(out_dir, f"{song}.corrected.json"),
             "txt": os.path.join(out_dir, f"{song}.corrected.txt")}
    for key, body in (("json", json.dumps(doc, indent=1)),
                      ("txt", "\n".join(ln["text"] for ln in lines if ln["text"]) + "\n")):
        tmp = paths[key] + ".tmp"
        with open(tmp, "w") as f:
            f.write(body)
        os.replace(tmp, paths[key])
    return paths


# ── page assembly (impure: reads the dataset, copies audio into the serve dir) ──────────

def _wav_dur(path):
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def build_site(dataset, out_dir, songs=SONGS):
    draft = os.path.join(dataset, "asr-draft")
    media = os.path.join(out_dir, "audio")
    os.makedirs(media, exist_ok=True)
    data = {}
    for song in songs:
        seg_path = os.path.join(draft, f"{song}.segments.json")
        wav = os.path.join(dataset, f"{song}.finished.wav")
        if not (os.path.isfile(seg_path) and os.path.isfile(wav)):
            continue
        shutil.copyfile(wav, os.path.join(media, f"{song}.wav"))
        words = json.load(open(os.path.join(dataset, f"{song}.words.json")))
        words = words if isinstance(words, list) else words.get("words", words)
        vend = max(float(w["end"]) for w in words) if words else 0.0
        dur = _wav_dur(wav)
        saved = os.path.join(draft, f"{song}.corrected.json")
        lines = build_lines(json.load(open(seg_path)), dur, verified_until=vend,
                            verified_words=words)
        if os.path.isfile(saved):                       # resume an in-progress correction
            prev = {round(float(ln["t"]), 2): ln["text"] for ln in json.load(open(saved))["lines"]}
            for ln in lines:
                if ln["t"] in prev:
                    ln["text"] = prev[ln["t"]]
        data[song] = {"dur": round(dur, 2), "verifiedUntil": round(vend, 2), "lines": lines}
    open(os.path.join(out_dir, "index.html"), "w").write(_page(data))
    return data


def _page(data):
    tabs = "".join(f'<button class="tab" data-song="{html.escape(s)}">{html.escape(s)}</button>'
                   for s in data)
    return """<!doctype html><meta charset=utf-8>
<title>FMS — fix the lyrics</title>
<style>
 :root{--bg:#fff;--fg:#1a1a1a;--dim:#666;--rule:#e5e5e5;--card:#f7f7f5;--accent:#0b5cad;
       --ok:#127a37;--warn:#b26b00}
 @media (prefers-color-scheme:dark){:root{--bg:#151515;--fg:#ededed;--dim:#a8a8a8;
       --rule:#333;--card:#202020;--accent:#6fb4ff;--ok:#4ec97a;--warn:#e0a33a}}
 *{box-sizing:border-box}
 html,body{background:var(--bg);color:var(--fg);margin:0}
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;padding:0 0 80px}
 header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--rule);
        padding:12px 20px 10px;z-index:5}
 h1{font-size:17px;margin:0 0 8px}
 .tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
 .tab{font:inherit;padding:5px 12px;border:1px solid var(--rule);border-radius:20px;
      background:var(--card);color:var(--fg);cursor:pointer}
 .tab.on{background:var(--accent);color:#fff;border-color:var(--accent)}
 audio{width:100%;height:38px}
 .bar{display:flex;align-items:center;gap:12px;margin-top:6px;color:var(--dim);font-size:13px}
 .status{margin-left:auto}
 main{max-width:900px;margin:0 auto;padding:16px 20px}
 .row{display:flex;align-items:center;gap:10px;padding:3px 0}
 .t{font:12px ui-monospace,Menlo,monospace;min-width:62px;padding:5px 6px;border-radius:6px;
    border:1px solid var(--rule);background:var(--card);color:var(--accent);cursor:pointer}
 .t:hover{border-color:var(--accent)}
 .row.playing .t{background:var(--accent);color:#fff}
 input.line{flex:1;font:inherit;padding:7px 10px;border:1px solid var(--rule);border-radius:6px;
       background:var(--bg);color:var(--fg)}
 input.line:focus{outline:2px solid var(--accent);outline-offset:-1px}
 .row.verified input.line{background:var(--card);color:var(--dim)}
 .del{border:0;background:none;color:var(--dim);cursor:pointer;font-size:16px;padding:0 4px}
 .del:hover{color:#c0392b}
 .add{border:0;background:none;color:var(--dim);cursor:pointer;font-size:14px;padding:0 4px}
 .add:hover{color:var(--accent)}
 .hint{color:var(--dim);font-size:13px;margin:10px 0 16px}
 .sec{color:var(--warn);font-size:12px;letter-spacing:.04em;text-transform:uppercase;
      margin:18px 0 6px;border-top:1px solid var(--rule);padding-top:10px}
 kbd{background:var(--card);border:1px solid var(--rule);border-radius:4px;padding:1px 5px;
     font:12px ui-monospace,monospace}
</style>
<header>
  <h1>Fix the lyrics — listen, correct, it saves itself</h1>
  <div class="tabs">__TABS__</div>
  <audio id="au" controls preload="metadata"></audio>
  <div class="bar">
    <label><input type="checkbox" id="loopline"> loop the clicked line</label>
    <span><kbd>Tab</kbd> next line · <kbd>⌥Enter</kbd> replay line · <kbd>⌥Space</kbd> play/pause</span>
    <span class="status" id="status">ready</span>
  </div>
</header>
<main>
  <p class="hint">Click a timestamp to hear that line. Greyed rows are already verified —
   fix them only if they're wrong. Blank a line to drop it; <b>+</b> inserts one the
   transcriber missed.</p>
  <div id="rows"></div>
</main>
<script>
const DATA = __DATA__;
const au = document.getElementById('au'), rowsEl = document.getElementById('rows');
const statusEl = document.getElementById('status'), loopEl = document.getElementById('loopline');
let song = Object.keys(DATA)[0], stopAt = null, timer = null, curRow = null;

function setStatus(t, cls){ statusEl.textContent = t; statusEl.style.color =
  cls === 'ok' ? 'var(--ok)' : cls === 'err' ? '#c0392b' : 'var(--dim)'; }

function save(){
  const lines = [...rowsEl.querySelectorAll('.row')].map(r => ({
    t: parseFloat(r.dataset.t), text: r.querySelector('input.line').value }));
  setStatus('saving…');
  fetch('api/lyrics/' + song, {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({song, lines})})
    .then(r => r.ok ? r.json() : Promise.reject(r.status))
    .then(j => setStatus('saved ' + j.nonBlank + ' lines ✓', 'ok'))
    .catch(e => setStatus('SAVE FAILED (' + e + ')', 'err'));
}
let saveTimer = null;
const queueSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); };

function playRow(row){
  const t = parseFloat(row.dataset.t), end = parseFloat(row.dataset.end);
  if (curRow) curRow.classList.remove('playing');
  curRow = row; row.classList.add('playing');
  au.currentTime = t; au.play();
  stopAt = end;
  clearInterval(timer);
  timer = setInterval(() => {
    if (stopAt !== null && au.currentTime >= stopAt){
      if (loopEl.checked){ au.currentTime = t; }
      else { au.pause(); clearInterval(timer); row.classList.remove('playing'); }
    }
  }, 40);
}

function mkRow(ln){
  const row = document.createElement('div');
  row.className = 'row' + (ln.verified ? ' verified' : '');
  row.dataset.t = ln.t; row.dataset.end = ln.playEnd;
  const b = document.createElement('button');
  b.className = 't'; b.textContent = ln.t.toFixed(2);
  b.onclick = () => playRow(row);
  const inp = document.createElement('input');
  inp.className = 'line'; inp.value = ln.text; inp.spellcheck = false;
  inp.oninput = queueSave;
  inp.onfocus = () => { if (curRow) curRow.classList.remove('playing'); curRow = row; };
  inp.onkeydown = e => {
    if (e.altKey && e.key === 'Enter'){ e.preventDefault(); playRow(row); }
    if (e.altKey && e.code === 'Space'){ e.preventDefault(); au.paused ? au.play() : au.pause(); }
  };
  const add = document.createElement('button');
  add.className = 'add'; add.textContent = '+'; add.title = 'insert a line below';
  add.onclick = () => {
    const t2 = (parseFloat(row.dataset.t) + parseFloat(row.dataset.end)) / 2;
    const nr = mkRow({t: Math.round(t2*100)/100, playEnd: parseFloat(row.dataset.end),
                      text: '', verified: false});
    row.after(nr); nr.querySelector('input.line').focus(); queueSave();
  };
  const del = document.createElement('button');
  del.className = 'del'; del.textContent = '×'; del.title = 'clear this line';
  del.onclick = () => { inp.value = ''; queueSave(); };
  row.append(b, inp, add, del);
  return row;
}

function load(s){
  song = s; stopAt = null; clearInterval(timer);
  document.querySelectorAll('.tab').forEach(t =>
    t.classList.toggle('on', t.dataset.song === s));
  au.src = 'audio/' + s + '.wav?v=1';
  rowsEl.innerHTML = '';
  const d = DATA[s];
  let inDraft = false;
  d.lines.forEach(ln => {
    if (!ln.verified && !inDraft){
      inDraft = true;
      const h = document.createElement('div');
      h.className = 'sec';
      h.textContent = 'ASR draft from ' + d.verifiedUntil.toFixed(1) + 's — correct these';
      rowsEl.append(h);
    }
    rowsEl.append(mkRow(ln));
  });
  setStatus('ready');
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => load(t.dataset.song));
window.addEventListener('beforeunload', () => { clearTimeout(saveTimer); save(); });
load(song);
</script>
""".replace("__TABS__", tabs).replace("__DATA__", json.dumps(data))


# ── server ──────────────────────────────────────────────────────────────────────────────

def serve(root, dataset, port):
    draft_out = os.path.join(dataset, "asr-draft")
    songs = set(SONGS)

    class H(BaseHTTPRequestHandler):
        def _send(self, code, body=b"", ctype="application/json"):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if body:
                self.wfile.write(body)

        def do_GET(self):
            path = self.path.split("?")[0].lstrip("/") or "index.html"
            if ".." in path:
                return self._send(400, b'{"error":"bad path"}')
            full = os.path.join(root, path)
            if not os.path.isfile(full):
                return self._send(404, b'{"error":"not found"}')
            ctype = ("text/html" if full.endswith(".html")
                     else "audio/wav" if full.endswith(".wav") else "application/octet-stream")
            size = os.path.getsize(full)
            rng = parse_range(self.headers.get("Range"), size)
            if rng == "invalid":
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if rng is None:
                with open(full, "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return self.wfile.write(body)
            start, end = rng                      # 206: what makes audio SEEKING work
            with open(full, "rb") as f:
                f.seek(start)
                body = f.read(end - start + 1)
            self.send_response(206)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            if not self.path.startswith("/api/lyrics/"):
                return self._send(404, b'{"error":"not found"}')
            try:
                n = int(self.headers.get("Content-Length") or 0)
                payload = json.loads(self.rfile.read(n) or b"{}")
            except Exception:  # noqa: BLE001
                return self._send(400, b'{"error":"bad json"}')
            ok, err = validate_correction(payload, songs)
            if not ok:
                return self._send(400, json.dumps({"error": err}).encode())
            save_correction(payload, draft_out)
            n_ok = sum(1 for ln in payload["lines"] if str(ln["text"]).strip())
            self._send(200, json.dumps({"ok": True, "nonBlank": n_ok}).encode())

        def log_message(self, *a):
            pass

    print(f"serving {root} on http://localhost:{port}  (saves -> {draft_out})")
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", default=DEFAULT_DATASET)
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-fms-ksb/bench/lyric-edit"))
    ap.add_argument("--port", type=int, default=8199)
    ap.add_argument("--build-only", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    data = build_site(a.dataset, a.out)
    print(f"built {a.out}/index.html — {len(data)} songs, "
          f"{sum(len(d['lines']) for d in data.values())} lines")
    if not a.build_only:
        serve(a.out, a.dataset, a.port)


if __name__ == "__main__":
    main()
