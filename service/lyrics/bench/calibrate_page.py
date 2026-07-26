"""The rating page + its persistence (FMS lyrics-bench I2c). Pure stdlib.

One local dark page, keyboard-first (1 / 2 / 3 per bar, H for heard, ← to go
back), autosaving every rating to JSONL over a loopback POST.

The instrument changed at I2c, for a reason the owner gave: real-vs-generated is
not a head-to-head. So each bar is rated on its OWN — keep / passable / no —
rather than one being picked over the other. The pairwise label the calibration
maths needs is derived from the two ratings (`mixpairs.owner_labels`), so nothing
downstream lost its footing.

What the page shows and what it withholds:
  * **The song is named** (artist, title, section, listen link) so the rater can
    play the track. Flow is not judgeable from a page — syllable counts are not
    cadence — and blinding was unenforceable anyway once he pressed play.
  * **Provenance is not.** Nothing in the DOM says which bar is the human's. He
    may work it out by ear on tracks he plays (recorded as `heard`), but the page
    must never contaminate the pairs he did not play.
  * **A control stratum stays fully hidden**, so the report can separate the
    effect of un-blinding from real disagreement.

Ratings APPEND. An unflagged contradictory repeat is the duplicate-pair probe
and resolves to None; a `revision` row (the rater arrowed back and changed an
answer on purpose) is taken as the latest word.
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
.song{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin:0 0 16px;
 padding:0 0 12px;border-bottom:1px solid #1c2128}
.song b{color:#e8e6e3;font-weight:600;font-size:15px}
.song span{color:#6e7681;font-size:14px}
.song a{color:#4c8dff;text-decoration:none;font-size:14px}
.song a:hover{text-decoration:underline}
.song.hidden b{color:#6e7681;font-weight:400;font-style:italic}
.fill{margin:16px 0;padding:14px 16px;border-radius:12px;background:#161b22;
 border:1px solid #262c36;opacity:.45;transition:opacity .12s,border-color .12s}
.fill.active{opacity:1;border-color:#30363d}
.fill.rated{opacity:.7}
.fill .txt{font-size:18px;line-height:1.45}
.fill .k{display:inline-block;min-width:20px;color:#6e7681;font-size:13px;
 margin-right:10px;font-variant-numeric:tabular-nums}
.scale{display:flex;gap:8px;margin-top:12px}
button.opt{all:unset;cursor:pointer;padding:8px 14px;border-radius:9px;
 background:#12161c;border:1px solid #262c36;color:#8b949e;font-size:14px}
button.opt:hover{border-color:#4c8dff;color:#e8e6e3}
button.opt.on{border-color:#4c8dff;color:#e8e6e3;background:#1b222c}
button.opt em{font-style:normal;color:#4d5460;margin-right:7px}
.row{display:flex;gap:10px;align-items:center;margin-top:18px}
button.tie{all:unset;cursor:pointer;padding:9px 14px;border-radius:10px;
 background:#12161c;border:1px solid #262c36;color:#8b949e;font-size:14px}
button.tie:hover{border-color:#4c8dff;color:#e8e6e3}
button.tie.on{border-color:#3fb950;color:#3fb950}
.meta{color:#4d5460;font-size:13px;margin-left:auto;font-variant-numeric:tabular-nums}
.done{text-align:center;padding:70px 0;color:#8b949e}
.done b{color:#e8e6e3;display:block;font-size:20px;margin-bottom:8px}
"""

_JS = """
const PAIRS = __PAIRS__;
const SCALE = [['keep','1','keep — I would keep this bar'],
               ['passable','2','passable — works, not my first choice'],
               ['no','3','no — breaks the flow, sense or register']];
let i = 0, step = 0;
const given = {};                       // pairId -> {left, right}
const heard = {};                       // pairId -> bool
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>]/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function songLine(p){
  if(p.identityHidden)
    return '<div class="song hidden"><b>song withheld — control pair</b>' +
           '<span>judge it on the bars alone</span></div>';
  const bits = ['<b>' + esc(p.artist) + ' — ' + esc(p.title) + '</b>'];
  const sub = [p.year, p.section].filter(Boolean).map(esc).join(' · ');
  if(sub) bits.push('<span>' + sub + '</span>');
  if(p.listenUrl) bits.push('<a href="' + esc(p.listenUrl) +
    '" target="_blank" rel="noopener noreferrer">listen &#9654;</a>');
  return '<div class="song">' + bits.join('') + '</div>';
}

function fillBlock(p, side, letter){
  const val = (given[p.pairId] || {})[side];
  const cls = 'fill' + (sideOf(step) === side ? ' active' : '') +
              (val ? ' rated' : '');
  const opts = SCALE.map(o =>
    '<button class="opt' + (val === o[0] ? ' on' : '') + '" data-side="' + side +
    '" data-rating="' + o[0] + '"><em>' + o[1] + '</em>' + o[0] + '</button>'
  ).join('');
  return '<div class="' + cls + '"><div class="txt"><span class="k">' + letter +
         '</span>' + esc(p[side]) + '</div><div class="scale">' + opts +
         '</div></div>';
}

const sideOf = s => (s === 0 ? 'left' : 'right');

function paint(){
  if(i >= PAIRS.length){
    $('card').innerHTML = '<div class="done"><b>Done — thank you.</b>' +
      'All ' + PAIRS.length + ' rated. You can close this tab; ' +
      'run <code>calibrate report</code> next.</div>';
    $('progress').style.width = '100%';
    return;
  }
  const p = PAIRS[i];
  const ctxBefore = p.before.length
    ? '<p class="ctx">' + esc(p.before.join('\\n')) + '</p>' : '';
  const ctxAfter = p.after.length
    ? '<p class="ctx after">' + esc(p.after.join('\\n')) + '</p>' : '';
  $('card').innerHTML = songLine(p) + ctxBefore +
    fillBlock(p, 'left', 'A') + fillBlock(p, 'right', 'B') + ctxAfter +
    '<div class="row"><button class="tie' + (heard[p.pairId] ? ' on' : '') +
    '" id="heard">H — ' + (heard[p.pairId] ? 'played the track \\u2713'
                                           : 'I played the track') + '</button>' +
    '<span class="meta">' + (i+1) + ' / ' + PAIRS.length + '</span></div>';
  $('progress').style.width = (100 * i / PAIRS.length) + '%';
  document.querySelectorAll('[data-rating]').forEach(b => b.onclick = () =>
    rate(b.getAttribute('data-side'), b.getAttribute('data-rating')));
  $('heard').onclick = toggleHeard;
}

function toggleHeard(){
  const p = PAIRS[i];
  heard[p.pairId] = !heard[p.pairId];
  paint();
}

function rate(side, rating){
  const p = PAIRS[i];
  const seen = given[p.pairId] || (given[p.pairId] = {});
  const revision = !!seen[side];        // an on-purpose correction, not a dupe
  seen[side] = rating;
  fetch('/rate', {method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({pairId: p.pairId, side: side, rating: rating,
                          heard: !!heard[p.pairId], revision: revision})
  }).catch(()=>{});
  if(seen.left && seen.right){ i++; step = 0; }
  else { step = seen.left ? 1 : 0; }
  paint();
}

document.addEventListener('keydown', e => {
  const k = e.key.toLowerCase();
  const hit = SCALE.find(o => o[1] === k);
  if(hit) rate(sideOf(step), hit[0]);
  else if(k === 'h') toggleHeard();
  else if(k === 'arrowleft'){
    if(step === 1) step = 0;
    else if(i > 0){ i--; step = 0; }
    paint();
  }
});
paint();
"""


_SAFE_IDENTITY = ("artist", "title", "year", "section", "listenUrl")


def render(pairs: Sequence[dict], *, title: str = "bar calibration") -> str:
    """The whole page, self-contained.

    The payload is built by WHITELIST, not by stripping: only the fields named
    here reach the browser, so a field added to a pair upstream cannot leak into
    the DOM by default. The arm and the blind key never appear; song identity
    appears only for pairs the mint did not mark `identityHidden`.
    """
    safe = []
    for p in pairs:
        row = {"pairId": p["pairId"], "left": p["left"], "right": p["right"],
               "before": list(p.get("before") or []),
               "after": list(p.get("after") or [])}
        if p.get("identityHidden") or not p.get("artist"):
            row["identityHidden"] = True
        else:
            row.update({k: p[k] for k in _SAFE_IDENTITY if p.get(k) is not None})
        safe.append(row)
    payload = json.dumps(safe, ensure_ascii=False)
    return f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{_html.escape(title)}</title><style>{_CSS}</style></head>
<body><div class="bar"><span id="progress"></span></div>
<main><h1>{_html.escape(title)} — rate each bar on its own &nbsp;·&nbsp;
1 keep / 2 passable / 3 no &nbsp;·&nbsp; H if you played the track</h1>
<div id="card"></div></main>
<script>{_JS.replace("__PAIRS__", payload)}</script>
</body></html>
"""


RATINGS_VERSION = 2
_SCALE = ("keep", "passable", "no")


def append_rating(path: str, rating: dict) -> bool:
    """Append one rating. Returns False (without writing) for a malformed row —
    a bad POST must never corrupt the label file.

    Accepts the I2c per-fill row `{pairId, side, rating}` and, so the archived
    sitting files still load and resolve, the older `{pairId, choice}`. The two
    are never reconciled: a version stamp rides along and the report refuses to
    mix them.
    """
    pid = rating.get("pairId")
    if not pid:
        return False
    side = str(rating.get("side", "")).lower()
    value = str(rating.get("rating", "")).lower()
    stamp = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
    if side or value:
        if side not in ("left", "right") or value not in _SCALE:
            return False
        row = {"pairId": pid, "side": side, "rating": value,
               "heard": bool(rating.get("heard")),
               "revision": bool(rating.get("revision")),
               "ratingsVersion": RATINGS_VERSION, "ts": stamp}
    else:
        choice = str(rating.get("choice", "")).lower()
        if choice not in ("left", "right", "tie"):
            return False
        row = {"pairId": pid, "choice": choice, "ts": stamp}
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
