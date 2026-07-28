#!/usr/bin/env python3
"""The owner-sitting surface (FMS WS1): one loopback page for the two tasks only
a human can do, in the order that keeps them honest.

  1. **Norming** — write the missing word on the blind packet. The server never
     opens the withheld answer file; the packet is blind by construction and
     `serve()` REFUSES to start if an answer file is found inside the packet
     directory (the one mistake that would void the sitting).
  2. **Accept pass** — judge the machine's wrong-but-maybe-keepable fills from
     the best arm's run. Writes the same append-only log as `accept mark`.

Sequencing rule, enforced not suggested: an item that appears in BOTH the
accept queue and the norming packet is withheld from the accept panel until its
norming answer is written. The accept panel shows the machine's candidate in
the real bar; seeing that before writing your own guess would contaminate the
ceiling measurement.

Loopback only — packet text is third-party lyric, it never leaves the machine.
"""
from __future__ import annotations

import json
import os
from typing import Dict, List, Optional

from lyrics.bench import accept_set, metrics, norming, paths

SIT_VERSION = "v1"
DEFAULT_PORT = 8767


# ── data assembly ────────────────────────────────────────────────────────────────

def load_packet(packet_dir: str) -> List[dict]:
    with open(os.path.join(packet_dir, "packet.json"), encoding="utf-8") as f:
        return json.load(f)["items"]


def assert_blind(packet_dir: str) -> None:
    """Refuse to serve a packet directory that contains an answer file."""
    for name in os.listdir(packet_dir):
        if name.startswith("answers") and name.endswith(".json"):
            raise RuntimeError(
                f"answer file {name!r} found INSIDE the packet dir — a sitting "
                f"served from it would measure nothing. Move it out first.")


def sheet_path(out_dir: str, rater: str = "owner") -> str:
    return os.path.join(out_dir, f"sheet-{rater}.txt")


def norming_closed(out_dir: str) -> bool:
    """True once the owner has DECLARED the norming sitting complete (a `CLOSED`
    marker beside the packet). The accept-pass lock exists to keep answers that
    are still going to be written blind; once the sitting is closed there are no
    such answers left to protect, and holding the queue would just strand it.
    Explicit marker, never inferred — a low answer count is a paused sitting,
    not a finished one."""
    return os.path.exists(os.path.join(out_dir, "CLOSED"))


def read_sheet(path: str) -> Dict[int, List[str]]:
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return norming.parse_sheet(f.read())


def write_sheet_entry(path: str, no: int, guesses: List[str]) -> Dict[int, List[str]]:
    """Merge one answer into the sheet and rewrite it whole.

    Parse → merge → render keeps the file hand-editable and RESUMABLE: existing
    lines survive, a re-answer overwrites only its own number, and the scorer
    (`norming.parse_sheet`) reads the result unchanged.
    """
    sheet = read_sheet(path)
    guesses = [g.strip() for g in guesses if g and g.strip()][:5]
    if guesses:
        sheet[int(no)] = guesses
    else:
        sheet.pop(int(no), None)          # an emptied answer un-answers the item
    lines = ["# One line per item: NUMBER = your guess(es), best first, "
             "comma-separated.", ""]
    lines += [f"{n} = {', '.join(sheet[n])}" for n in sorted(sheet)]
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
    return sheet


def accept_queue(rows: List[dict], items_by_id: Dict[str, dict],
                 sets: Dict[str, Dict[str, set]],
                 norming_ids: Optional[set] = None,
                 answered_ids: Optional[set] = None) -> Dict:
    """The CLI's todo filter, plus the sequencing rule.

    Same semantics as `accept mark`: only rows the arm got WRONG, whose top
    candidate carries no judgement yet. On top of that, an item still blind in
    the norming packet is EXCLUDED (returned in `excluded`, count visible in
    the UI) until its answer is on the sheet.
    """
    norming_ids = norming_ids or set()
    answered_ids = answered_ids or set()
    todo, excluded = [], 0
    for r in rows:
        if r.get("exact") != 0 or not (r.get("candidates") or []):
            continue
        fill = (r["candidates"] or [""])[0]
        judged = (sets.get(r["itemId"], {}).get("accept", set())
                  | sets.get(r["itemId"], {}).get("reject", set()))
        if metrics.normalize(fill) in judged:
            continue
        if r["itemId"] in norming_ids and r["itemId"] not in answered_ids:
            excluded += 1
            continue
        it = items_by_id.get(r["itemId"])
        if not it:
            continue
        todo.append({
            "itemId": r["itemId"],
            "before": (it["context"].get("before") or [])[-2:],
            "filled": metrics.apply_fill(it, fill),
            "after": (it["context"].get("after") or [])[:1],
            "fill": fill,
        })
    return {"todo": todo, "excluded": excluded}


def build_state(packet_dir: str, sheet: Dict[int, List[str]],
                run_rows: List[dict], items_by_id: Dict[str, dict],
                sets: Dict[str, Dict[str, set]], *, run_name: str = "",
                closed: bool = False) -> Dict:
    packet = load_packet(packet_dir)
    answered = {int(n) for n in sheet}
    no_to_id = {p["no"]: p["itemId"] for p in packet}
    # A closed sitting has no blind answers left to protect — the lock lifts.
    norming_ids = set() if closed else set(no_to_id.values())
    answered_ids = {no_to_id[n] for n in answered if n in no_to_id}
    aq = accept_queue(run_rows, items_by_id, sets,
                      norming_ids=norming_ids, answered_ids=answered_ids)
    judged = sum(len(v["accept"]) + len(v["reject"]) for v in sets.values())
    return {
        "version": SIT_VERSION,
        "norming": {
            "total": len(packet),
            "answered": len(answered),
            # Answers are NOT in packet.json; nothing here can leak them.
            "items": [{**p, "answered": p["no"] in answered,
                       "guesses": sheet.get(p["no"], [])} for p in packet],
        },
        "accept": {"run": run_name, "queue": aq["todo"],
                   "excludedUntilNormed": aq["excluded"], "judged": judged},
    }


# ── the page ─────────────────────────────────────────────────────────────────────

PAGE = r"""<!doctype html><html><head><meta charset="utf-8">
<title>Mosh — your sitting</title>
<style>
:root{--bg:#101014;--card:#18181f;--ink:#e8e6e1;--dim:#8a8894;--acc:#e8b04b;
--good:#69c987;--bad:#d96a6a;--line:#26262e}
*{box-sizing:border-box;margin:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,'Helvetica Neue',sans-serif;
padding:28px;max-width:760px;margin:0 auto}
h1{font-size:19px;font-weight:600;margin-bottom:4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
padding:18px 20px;margin-bottom:14px;cursor:pointer}
.card:hover{border-color:var(--acc)}
.card h2{font-size:15px;font-weight:600}
.card .meta{color:var(--dim);font-size:13px;margin-top:4px}
.card .done{color:var(--good)}
.bar{height:4px;background:var(--line);border-radius:2px;margin-top:10px}
.bar>i{display:block;height:4px;background:var(--acc);border-radius:2px}
#stage{display:none}
.ctx{color:var(--dim);white-space:pre-wrap}
.focus{color:var(--ink);font-weight:600;white-space:pre-wrap}
.blank{color:var(--acc);font-weight:700}
.hint{color:var(--dim);font-size:13px;margin:10px 0 14px}
input[type=text]{width:100%;background:#0c0c10;border:1px solid var(--line);
border-radius:8px;color:var(--ink);font:16px inherit;padding:10px 12px;outline:none}
input[type=text]:focus{border-color:var(--acc)}
.row{display:flex;gap:10px;margin-top:14px;align-items:center}
button{background:#22222b;border:1px solid var(--line);border-radius:8px;
color:var(--ink);font:14px inherit;padding:8px 16px;cursor:pointer}
button:hover{border-color:var(--acc)}
button.keep{border-color:var(--good);color:var(--good)}
button.rej{border-color:var(--bad);color:var(--bad)}
.prog{color:var(--dim);font-size:13px;margin-left:auto}
.kbd{color:var(--dim);font-size:12px;margin-top:16px}
kbd{background:#22222b;border:1px solid var(--line);border-radius:4px;
padding:1px 6px;font-size:11px}
.note{border-left:3px solid var(--acc);padding:2px 12px;color:var(--dim);
font-size:13px;margin-top:8px}
a{color:var(--acc)}
.fillword{color:var(--acc);font-weight:700}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
background:#22222b;border:1px solid var(--line);border-radius:8px;
padding:8px 18px;opacity:0;transition:opacity .2s}
</style></head><body>
<div id="home">
 <h1>Your sitting</h1>
 <div class="sub">The two things only you can do — in this order.</div>
 <div class="card" id="cN" onclick="startNorming()">
  <h2>1 · Norming — write the missing word</h2>
  <div class="meta" id="mN"></div><div class="bar"><i id="bN"></i></div>
 </div>
 <div class="card" id="cA" onclick="startAccept()">
  <h2>2 · Accept pass — judge the machine's misses</h2>
  <div class="meta" id="mA"></div><div class="bar"><i id="bA"></i></div>
 </div>
 <div class="card" style="cursor:default">
  <h2>3 · Decide the new bars</h2>
  <div class="meta">Every pre-registered bar was calibrated against the broken
  pool and is void. When the two sittings are done, answer in chat: routing bar
  proposal is <b>exact &ge; .45 AND rhyme_perfect &ge; .60 on
  prompt-rhyme-menu-fp</b> (coverage now supports it), kill-to-finetune stays
  retired. Nothing to click here — this one is a conversation.</div>
 </div>
</div>

<div id="stage">
 <div id="ctxTop" class="ctx"></div>
 <div id="focusLine" class="focus"></div>
 <div id="ctxBot" class="ctx"></div>
 <div class="hint" id="hint"></div>
 <div id="normIn" style="display:none">
  <input type="text" id="guess" placeholder="up to 5 guesses, best first, separated by commas"
   autocomplete="off">
  <div class="row">
   <button onclick="saveNorm(-1)">&larr; back</button>
   <button onclick="saveNorm(1)" style="border-color:var(--acc)">save &amp; next</button>
   <button onclick="saveNorm(1,true)">skip</button>
   <span class="prog" id="pN"></span>
  </div>
  <div class="kbd"><kbd>Enter</kbd> save &amp; next &nbsp; <kbd>&uarr;</kbd> back
   &nbsp; <kbd>&darr;</kbd> skip &nbsp; <kbd>Esc</kbd> home</div>
 </div>
 <div id="accIn" style="display:none">
  <div class="row">
   <button class="keep" onclick="judge('accept')">keep it &nbsp;<kbd>A</kbd></button>
   <button class="rej" onclick="judge('reject')">reject &nbsp;<kbd>R</kbd></button>
   <button onclick="nextAccept()">skip &nbsp;<kbd>S</kbd></button>
   <span class="prog" id="pA"></span>
  </div>
  <div class="kbd"><kbd>Esc</kbd> home</div>
 </div>
</div>
<div id="toast"></div>
<script>
let S=null, mode=null, ni=0, ai=0;
async function boot(){S=await (await fetch('/api/state')).json(); home();}
function pct(a,b){return b? Math.round(100*a/b)+'%':'0%';}
function home(){mode=null;
 document.getElementById('stage').style.display='none';
 document.getElementById('home').style.display='block';
 const n=S.norming, a=S.accept;
 const mN=document.getElementById('mN');
 mN.innerHTML = n.closed
   ? '<span class=done>closed — scored at '+n.answered+' answered (declared complete)</span>'
   : (n.answered>=n.total
      ? '<span class=done>done — '+n.total+' / '+n.total+'</span>'
      : n.answered+' of '+n.total+' answered · ~'+Math.ceil((n.total-n.answered)*11/60)+' min left');
 document.getElementById('bN').style.width=n.closed?'100%':pct(n.answered,n.total);
 const mA=document.getElementById('mA');
 const held = a.excludedUntilNormed
   ? '<div class=note>'+a.excludedUntilNormed+' item(s) held back until you '
     +'answer them in the norming packet above — seeing the machine\'s word '
     +'first would contaminate your ceiling. They unlock as you go.</div>' : '';
 mA.innerHTML = (a.queue.length===0 && !a.excludedUntilNormed)
   ? '<span class=done>queue empty — '+a.judged+' judgement(s) recorded</span>'
   : (a.queue.length+' fill(s) judgeable now · '+a.judged
      +' recorded · run '+a.run+held);
 document.getElementById('bA').style.width=
   (a.queue.length||a.excludedUntilNormed)?'0%':'100%';}
function esc(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML;}
function startNorming(){mode='norm';
 ni=S.norming.items.findIndex(p=>!p.answered); if(ni<0) ni=0; showNorm();}
function showNorm(){const p=S.norming.items[ni]; if(!p){boot();return;}
 document.getElementById('home').style.display='none';
 document.getElementById('stage').style.display='block';
 document.getElementById('accIn').style.display='none';
 document.getElementById('normIn').style.display='block';
 document.getElementById('ctxTop').textContent=(p.before||[]).join('\n');
 document.getElementById('focusLine').innerHTML=
   esc(p.maskedLine).replace(/_{2,}/,'<span class=blank>____</span>');
 document.getElementById('ctxBot').textContent=(p.after||[]).join('\n');
 let h=[]; if(p.syllables)h.push(p.syllables+' syllable(s)');
 if(p.rhymeWith)h.push('rhymes with “'+p.rhymeWith+'”');
 document.getElementById('hint').textContent=h.join(' · ');
 const g=document.getElementById('guess'); g.value=(p.guesses||[]).join(', ');
 g.focus();
 document.getElementById('pN').textContent=(ni+1)+' / '+S.norming.items.length;}
async function saveNorm(step, skip){const p=S.norming.items[ni];
 const raw=document.getElementById('guess').value;
 if(!skip){const guesses=raw.split(',').map(x=>x.trim()).filter(x=>x);
  const r=await (await fetch('/api/norming',{method:'POST',
    body:JSON.stringify({no:p.no,guesses:guesses})})).json();
  if(r.ok){p.answered=guesses.length>0;p.guesses=guesses;
   S.norming.answered=r.answered;}
  else{toast('not saved: '+(r.error||'?'));return;}}
 ni+=step;
 if(ni<0){ni=0;} if(ni>=S.norming.items.length){toast('packet complete');home();return;}
 showNorm();}
function startAccept(){mode='acc'; ai=0; showAccept();}
function showAccept(){const q=S.accept.queue;
 if(ai>=q.length){toast('queue done');boot();return;}
 const it=q[ai];
 document.getElementById('home').style.display='none';
 document.getElementById('stage').style.display='block';
 document.getElementById('normIn').style.display='none';
 document.getElementById('accIn').style.display='block';
 document.getElementById('ctxTop').textContent=(it.before||[]).join('\n');
 document.getElementById('focusLine').innerHTML=esc(it.filled)
   .replace(new RegExp('('+it.fill.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')','i'),
            '<span class=fillword>$1</span>');
 document.getElementById('ctxBot').textContent=(it.after||[]).join('\n');
 document.getElementById('hint').textContent='the machine wrote: “'+it.fill
   +'” — would you have kept it?';
 document.getElementById('pA').textContent=(ai+1)+' / '+q.length;}
async function judge(verdict){const it=S.accept.queue[ai];
 const r=await (await fetch('/api/accept',{method:'POST',
   body:JSON.stringify({itemId:it.itemId,word:it.fill,verdict:verdict})})).json();
 if(!r.ok){toast('not saved: '+(r.error||'?'));return;}
 S.accept.judged=r.judged; nextAccept();}
function nextAccept(){ai+=1; showAccept();}
function toast(t){const e=document.getElementById('toast');
 e.textContent=t;e.style.opacity=1;setTimeout(()=>e.style.opacity=0,1600);}
document.addEventListener('keydown',e=>{
 if(e.key==='Escape'){home();return;}
 if(mode==='norm'){
  if(e.key==='Enter'){e.preventDefault();saveNorm(1);}
  else if(e.key==='ArrowUp'){e.preventDefault();saveNorm(-1);}
  else if(e.key==='ArrowDown'){e.preventDefault();saveNorm(1,true);}}
 else if(mode==='acc' && document.activeElement.tagName!=='INPUT'){
  const k=e.key.toLowerCase();
  if(k==='a')judge('accept'); else if(k==='r')judge('reject');
  else if(k==='s')nextAccept();}});
boot();
</script></body></html>"""


# ── the server ───────────────────────────────────────────────────────────────────

def make_server(packet_dir: str, run_dir: str, *, slice_: str = "dev",
                rater: str = "owner", port: int = DEFAULT_PORT):
    """Build the HTTPServer without running it — `serve` loops it; tests bind
    port 0, drive it from a thread, and shut it down."""
    from http.server import BaseHTTPRequestHandler, HTTPServer

    assert_blind(packet_dir)
    spath = sheet_path(os.path.dirname(os.path.abspath(packet_dir)), rater)
    run_name = os.path.basename(os.path.normpath(run_dir))
    rows: List[dict] = []
    for name in os.listdir(run_dir):
        if name.startswith("results-") and name.endswith(".jsonl"):
            with open(os.path.join(run_dir, name), encoding="utf-8") as f:
                rows = [json.loads(ln) for ln in f if ln.strip()]
            break
    wanted = {r["itemId"] for r in rows}
    items_by_id: Dict[str, dict] = {}
    items_path = os.path.join(paths.data_root(), "eval", f"items-{slice_}.jsonl")
    with open(items_path, encoding="utf-8") as f:
        for ln in f:
            if not ln.strip():
                continue
            it = json.loads(ln)
            if it["itemId"] in wanted:
                items_by_id[it["itemId"]] = it
                if len(items_by_id) == len(wanted):
                    break

    def state() -> bytes:
        s = build_state(packet_dir, read_sheet(spath), rows, items_by_id,
                        accept_set.load(slice_), run_name=run_name,
                        closed=norming_closed(
                            os.path.dirname(os.path.abspath(packet_dir))))
        s["norming"]["closed"] = norming_closed(
            os.path.dirname(os.path.abspath(packet_dir)))
        return json.dumps(s, ensure_ascii=False).encode("utf-8")

    page = PAGE.encode("utf-8")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # keep the sitting quiet
            pass

        def _send(self, code: int, body: bytes, ctype: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):  # noqa: N802
            if self.path.startswith("/api/state"):
                self._send(200, state(), "application/json")
            else:
                self._send(200, page, "text/html; charset=utf-8")

        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else b"{}"
            try:
                req = json.loads(body)
                if self.path.startswith("/api/norming"):
                    sheet = write_sheet_entry(spath, int(req["no"]),
                                              list(req.get("guesses") or []))
                    out = {"ok": True, "answered": len(sheet)}
                elif self.path.startswith("/api/accept"):
                    accept_set.record(slice_, req["itemId"], req["word"],
                                      req["verdict"], source="web")
                    sets = accept_set.load(slice_)
                    out = {"ok": True,
                           "judged": sum(len(v["accept"]) + len(v["reject"])
                                         for v in sets.values())}
                else:
                    out = {"ok": False, "error": "unknown endpoint"}
            except Exception as e:  # noqa: BLE001
                out = {"ok": False, "error": str(e)}
            self._send(200 if out.get("ok") else 400,
                       json.dumps(out).encode("utf-8"), "application/json")

    srv = HTTPServer(("127.0.0.1", port), Handler)
    return srv, {"sheet": spath, "run": run_name,
                 "acceptLog": accept_set.log_path(slice_)}


def serve(packet_dir: str, run_dir: str, *, slice_: str = "dev",
          rater: str = "owner", port: int = DEFAULT_PORT) -> None:
    srv, info = make_server(packet_dir, run_dir, slice_=slice_, rater=rater,
                            port=port)
    print(f"sitting page: http://127.0.0.1:{srv.server_address[1]}/")
    print(f"  norming packet: {packet_dir}  → sheet {info['sheet']}")
    print(f"  accept run:     {info['run']}  → {info['acceptLog']}")
    print("Ctrl-C when done.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
