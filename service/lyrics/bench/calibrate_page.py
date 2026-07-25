"""The blind rating page + its persistence (FMS lyrics-bench I2). Pure stdlib.

One local dark page, keyboard-first (a / b / t, ← to go back), autosaving each
verdict to JSONL over a loopback POST. The page is rendered from `pairs` ONLY —
the blind key never reaches the browser, so there is nothing in the DOM that
could tell the rater which line is the human's.

Ratings APPEND. A changed mind stays visible in the file, and
`calibrate.owner_labels` resolves a contradictory repeat to None rather than
silently taking the last click.
"""
from __future__ import annotations

import datetime as _dt
import html as _html
import json
import os
from typing import Dict, List, Sequence

_CSS = """
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d0f12;color:#e8e6e3;font:16px/1.55 ui-sans-serif,
 -apple-system,"SF Pro Text",Inter,system-ui,sans-serif;padding:28px 20px 80px}
main{max-width:820px;margin:0 auto}
h1{font-size:15px;font-weight:600;letter-spacing:.02em;color:#8b949e;margin:0 0 22px}
.bar{position:fixed;left:0;right:0;top:0;height:3px;background:#1c2128}
.bar>span{display:block;height:100%;background:#4c8dff;transition:width .18s ease}
.ctx{color:#6e7681;font-size:14px;white-space:pre-wrap;margin:0 0 6px}
.ctx.after{margin:6px 0 0}
.choices{display:grid;gap:12px;margin:18px 0 10px}
button.choice{all:unset;cursor:pointer;display:block;padding:16px 18px;border-radius:12px;
 background:#161b22;border:1px solid #262c36;font-size:18px;line-height:1.45}
button.choice:hover,button.choice:focus-visible{border-color:#4c8dff;background:#1b222c}
button.choice .k{display:inline-block;min-width:20px;color:#6e7681;font-size:13px;
 margin-right:10px;font-variant-numeric:tabular-nums}
.row{display:flex;gap:10px;align-items:center;margin-top:14px}
button.tie{all:unset;cursor:pointer;padding:9px 14px;border-radius:10px;
 background:#12161c;border:1px solid #262c36;color:#8b949e;font-size:14px}
button.tie:hover{border-color:#4c8dff;color:#e8e6e3}
.meta{color:#4d5460;font-size:13px;margin-left:auto;font-variant-numeric:tabular-nums}
.done{text-align:center;padding:70px 0;color:#8b949e}
.done b{color:#e8e6e3;display:block;font-size:20px;margin-bottom:8px}
"""

_JS = """
const PAIRS = __PAIRS__;
let i = 0, rated = 0;
const $ = id => document.getElementById(id);
function paint(){
  if(i >= PAIRS.length){
    $('card').innerHTML = '<div class="done"><b>Done — thank you.</b>' +
      'All ' + PAIRS.length + ' judged. You can close this tab; ' +
      'run <code>calibrate report</code> next.</div>';
    $('progress').style.width = '100%';
    return;
  }
  const p = PAIRS[i];
  const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
  const ctxBefore = p.before.length ? '<p class="ctx">' + esc(p.before.join('\\n')) + '</p>' : '';
  const ctxAfter  = p.after.length  ? '<p class="ctx after">' + esc(p.after.join('\\n')) + '</p>' : '';
  $('card').innerHTML = ctxBefore +
    '<div class="choices">' +
      '<button class="choice" data-c="left"><span class="k">A</span>' + esc(p.left) + '</button>' +
      '<button class="choice" data-c="right"><span class="k">B</span>' + esc(p.right) + '</button>' +
    '</div>' + ctxAfter +
    '<div class="row"><button class="tie" data-c="tie">T — too close to call</button>' +
    '<span class="meta">' + (i+1) + ' / ' + PAIRS.length + '</span></div>';
  $('progress').style.width = (100 * i / PAIRS.length) + '%';
  document.querySelectorAll('[data-c]').forEach(b =>
    b.onclick = () => pick(b.getAttribute('data-c')));
}
function pick(choice){
  const p = PAIRS[i];
  fetch('/rate', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({pairId: p.pairId, choice: choice})}).catch(()=>{});
  rated++; i++; paint();
}
document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  if(k === 'a') pick('left');
  else if(k === 'b') pick('right');
  else if(k === 't') pick('tie');
  else if(k === 'arrowleft' && i > 0){ i--; paint(); }
});
paint();
"""


def render(pairs: Sequence[dict], *, title: str = "blind calibration") -> str:
    """The whole page, self-contained. Only pairId/left/right/context reach the
    browser — never the arm, never the blind key."""
    safe = [{"pairId": p["pairId"], "left": p["left"], "right": p["right"],
             "before": list(p.get("before") or []),
             "after": list(p.get("after") or [])} for p in pairs]
    payload = json.dumps(safe, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_html.escape(title)}</title><style>{_CSS}</style></head>
<body><div class="bar"><span id="progress"></span></div>
<main><h1>{_html.escape(title)} — pick the better bar &nbsp;·&nbsp; A / B / T</h1>
<div id="card"></div></main>
<script>{_JS.replace("__PAIRS__", payload)}</script>
</body></html>
"""


def append_rating(path: str, rating: dict) -> bool:
    """Append one verdict. Returns False (without writing) for a malformed row —
    a bad POST must never corrupt the label file."""
    pid = rating.get("pairId")
    choice = str(rating.get("choice", "")).lower()
    if not pid or choice not in ("left", "right", "tie"):
        return False
    row = {"pairId": pid, "choice": choice,
           "ts": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")}
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(row, sort_keys=True) + "\n")
    return True


def load_ratings(path: str) -> List[dict]:
    if not os.path.exists(path):
        return []
    out = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:  # noqa: BLE001 — a torn line never kills a sitting
                continue
    return out


def progress(pairs: Sequence[dict], ratings: Sequence[dict]) -> Dict[str, int]:
    return {"rated": len(ratings), "total": len(pairs)}


def serve(pairs: Sequence[dict], ratings_path: str, *, port: int = 8765,
          title: str = "blind calibration") -> None:
    """Serve the page on loopback until interrupted (the owner's sitting)."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    page = render(pairs, title=title).encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # keep the sitting quiet
            pass

        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            ok = False
            try:
                ok = append_rating(ratings_path, json.loads(body))
            except Exception:  # noqa: BLE001
                ok = False
            self.send_response(200 if ok else 400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": ok}).encode("utf-8"))

    srv = HTTPServer(("127.0.0.1", port), Handler)
    print(f"calibration page: http://127.0.0.1:{port}/  "
          f"({len(pairs)} pairs → {ratings_path})\nCtrl-C when done.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")
