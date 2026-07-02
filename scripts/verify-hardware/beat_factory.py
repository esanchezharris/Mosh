#!/usr/bin/env python3
"""Beat factory: batch-generate candidates → gate hard → auto-balance → select a diverse
Taste Pack the owner can rate in ~10 minutes (keep/kill + defect chips).

    MOSH_BIN=/Applications/Mosh.app/Contents/MacOS/Mosh \
        service/teardown/.venv/bin/python scripts/verify-hardware/beat_factory.py \
        [--out ~/mosh-beats/pack-001] [--pack-size 14] [--smoke]

Every candidate (pass or reject) is appended to <out>/candidates.jsonl with its full
feature record — the accumulating training set for the taste ranker and the benchmark
for external evaluators (Audiobox axes are attached when the judges venv is present).
ONLY gate-PASS candidates can enter the pack: nothing the instruments can catch reaches
the owner's ears (2026-07 program rule: metrics are filters, never judges)."""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SERVICE = os.path.join(REPO, "service")
for p in (SERVICE, os.path.dirname(os.path.abspath(__file__))):
    if p not in sys.path:
        sys.path.insert(0, p)

DEFAULT_BIN = "/Applications/Mosh.app/Contents/MacOS/Mosh"
MOODS_TEMPO = {"dark": 140, "emotional": 148, "aggressive": 152, "chill": 132}
KEYS = ["F minor", "G minor", "A minor", "C# minor", "D minor", "E minor"]
SEEDS = [1, 2, 3]
JUDGES_PY = os.path.expanduser("~/AI/judges_venv/bin/python")


def requests_grid(smoke: bool = False):
    reqs = [({"mood": m, "tempo": t, "key": k}, s)
            for m, t in MOODS_TEMPO.items() for k in KEYS for s in SEEDS]
    return reqs[:6] if smoke else reqs


def density_features(rec) -> dict:
    out = {}
    for e in rec.elements:
        if not e.midi.notes:
            continue
        end = max(float(n.start_beats) + float(n.duration_beats) for n in e.midi.notes)
        bars = max(1.0, end / 4.0)
        out[e.role.value] = round(len(e.midi.notes) / bars, 2)
    return out


def audiobox_axes(paths: list) -> dict:
    """path → {PQ,CE,CU,PC} via the judges venv sidecar; {} when the venv is absent
    (owner-gated install) — the factory never blocks on it."""
    if not (paths and os.path.isfile(JUDGES_PY)):
        return {}
    sidecar = os.path.join(SERVICE, "sa3", "judge_sidecar.py")
    if not os.path.isfile(sidecar):
        return {}
    try:
        proc = subprocess.run([JUDGES_PY, sidecar], input=json.dumps({"paths": paths}),
                              capture_output=True, text=True, timeout=120 + 10 * len(paths))
        for line in proc.stdout.splitlines():
            if line.startswith("@@MOSH@@"):
                return json.loads(line[len("@@MOSH@@"):])
    except Exception as e:  # noqa: BLE001 — advisory metadata only, never fatal
        print(f"  (audiobox axes skipped: {e})", file=sys.stderr)
    return {}


def select_pack(passed: list, pack_size: int) -> list:
    """Deterministic diverse selection: best-gated first, capped per (drums, backbone)
    pairing and per mood so the pack spans the library instead of one groove."""
    ranked = sorted(passed, key=lambda c: (c["gate"]["keyRank"], -c["gate"]["subRatio"], c["id"]))
    per_mood_cap = max(2, (pack_size + len(MOODS_TEMPO) - 1) // len(MOODS_TEMPO))
    combo_seen: dict = {}
    mood_seen: dict = {}
    picks = []
    for c in ranked:
        combo = (c["sources"].get("drums"), c["backbone"])
        mood = c["request"]["mood"]
        if combo_seen.get(combo, 0) >= 2 or mood_seen.get(mood, 0) >= per_mood_cap:
            continue
        picks.append(c)
        combo_seen[combo] = combo_seen.get(combo, 0) + 1
        mood_seen[mood] = mood_seen.get(mood, 0) + 1
        if len(picks) >= pack_size:
            break
    # backfill if diversity caps left the pack short
    for c in ranked:
        if len(picks) >= pack_size:
            break
        if c not in picks:
            picks.append(c)
    return picks


def build_pack_page(out_dir: str, picks: list) -> str:
    cards = []
    for i, c in enumerate(picks):
        r = c["request"]
        srcs = " · ".join(f"<b>{k}</b> {str(v)[:38]}" for k, v in c["sources"].items())
        cards.append(f"""
  <div class="beat" data-f="{c['pack_file']}">
    <div class="row1"><span class="name">{i+1:02d} · {r['mood']} · {int(r['tempo'])} bpm · {r['key']}
      <span class="badge b-ok">key rank {c['gate']['keyRank']}</span>
      <span class="badge b-ok">sub {c['gate']['subRatio']:.2f}</span></span></div>
    <audio controls preload="metadata" src="{c['pack_file']}"></audio>
    <div class="src">{srcs}</div>
    <div class="rate">
      <span class="kk"><button data-k="keep">KEEP</button><button data-k="kill">KILL</button></span>
      <span class="chips">{''.join(f'<button data-c="{ch}">{ch}</button>' for ch in
                            ('808', 'drums', 'mix', 'key', 'boring', 'messy', 'ends-weird'))}</span>
      <span class="stars"><button>★</button><button>★</button><button>★</button><button>★</button><button>★</button></span>
      <input type="text" placeholder="notes (optional)">
    </div>
  </div>""")
    html = _PAGE_TMPL.replace("@CARDS@", "".join(cards)).replace("@N@", str(len(picks)))
    path = os.path.join(out_dir, "index.html")
    with open(path, "w") as f:
        f.write(html)
    return path


_PAGE_TMPL = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mosh Taste Pack</title>
<style>
  :root { --bg:#101014; --panel:#191921; --edge:#2a2a36; --ink:#e8e6df; --dim:#9a97a6;
          --accent:#ffd23f; --ok:#6fe0a8; --bad:#ff6b6b; }
  * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink);
    font:14px/1.5 -apple-system,"Helvetica Neue",sans-serif; padding:20px 16px 60px; }
  h1 { font-size:20px; margin:0 0 2px; } .sub { color:var(--dim); font-size:12.5px; margin-bottom:18px; max-width:860px; }
  .beat { background:var(--panel); border:1px solid var(--edge); border-radius:10px; padding:14px 16px; margin-bottom:14px; }
  .row1 { display:flex; justify-content:space-between; gap:10px; align-items:baseline; flex-wrap:wrap; }
  .name { font-weight:600; font-size:15px; }
  .badge { display:inline-block; font-size:11px; font-weight:600; padding:2px 8px; border-radius:20px; margin-left:6px; }
  .b-ok { background:rgba(111,224,168,.14); color:var(--ok); border:1px solid rgba(111,224,168,.4); }
  audio { width:100%; margin:10px 0 8px; height:36px; }
  .src { color:var(--dim); font-size:11.5px; line-height:1.65; } .src b { color:var(--ink); }
  .rate { display:flex; gap:10px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .kk button, .chips button { background:#101018; color:var(--dim); border:1px solid var(--edge);
    border-radius:6px; padding:6px 10px; font-size:12px; font-weight:600; cursor:pointer; margin-right:4px; }
  .kk button[data-k=keep].on { background:rgba(111,224,168,.16); color:var(--ok); border-color:rgba(111,224,168,.5); }
  .kk button[data-k=kill].on { background:rgba(255,107,107,.14); color:var(--bad); border-color:rgba(255,107,107,.5); }
  .chips button.on { background:rgba(255,210,63,.15); color:var(--accent); border-color:rgba(255,210,63,.5); }
  .stars button { background:none; border:none; font-size:18px; cursor:pointer; color:#4a4a58; padding:0 1px; }
  .stars button.on { color:var(--accent); }
  .rate input[type=text] { flex:1; min-width:140px; background:#101018; color:var(--ink);
    border:1px solid var(--edge); border-radius:6px; padding:6px 10px; font-size:13px; }
  .actions { margin-top:20px; display:flex; gap:10px; } #saved { color:var(--ok); font-size:12.5px; align-self:center; }
  .actions button { background:var(--accent); color:#14140f; border:none; border-radius:8px;
    padding:9px 16px; font-weight:700; font-size:13px; cursor:pointer; }
  .actions button.ghost { background:transparent; color:var(--dim); border:1px solid var(--edge); }
</style></head><body>
<h1>Taste Pack — @N@ beats, ~10 minutes</h1>
<div class="sub">Every clip already passed the machine gates (key · clipping · sub register · balance) — you're rating <b>taste</b>, not defects.
KEEP or KILL each one (required); tap defect chips on kills (optional but gold); stars/notes only if you feel like it. Download the CSV at the end.</div>
<div id="beats">@CARDS@</div>
<div class="actions">
  <button id="csvBtn">Download ratings CSV</button>
  <button class="ghost" id="clearBtn">Clear</button>
  <span id="saved"></span>
</div>
<script>
const store = (() => { try { localStorage.setItem("__t","1"); localStorage.removeItem("__t"); return localStorage; }
  catch { const m = {}; return { getItem: k => m[k] ?? null, setItem: (k,v) => { m[k]=v; } }; } })();
const state = JSON.parse(store.getItem("tastePack") || "{}");
function save(){ store.setItem("tastePack", JSON.stringify(state));
  document.getElementById("saved").textContent = "saved locally"; }
document.querySelectorAll(".beat").forEach(card => {
  const f = card.dataset.f, kk = [...card.querySelectorAll(".kk button")],
        chips = [...card.querySelectorAll(".chips button")],
        stars = [...card.querySelectorAll(".stars button")],
        notes = card.querySelector("input[type=text]");
  const paint = () => { const st = state[f] || {};
    kk.forEach(b => b.classList.toggle("on", st.verdict === b.dataset.k));
    chips.forEach(b => b.classList.toggle("on", (st.chips || []).includes(b.dataset.c)));
    stars.forEach((b,i) => b.classList.toggle("on", (st.stars || 0) >= i+1)); };
  kk.forEach(b => b.onclick = () => { state[f] = state[f] || {}; state[f].verdict = b.dataset.k; save(); paint(); });
  chips.forEach(b => b.onclick = () => { state[f] = state[f] || {}; const c = new Set(state[f].chips || []);
    c.has(b.dataset.c) ? c.delete(b.dataset.c) : c.add(b.dataset.c); state[f].chips = [...c]; save(); paint(); });
  stars.forEach((b,i) => b.onclick = () => { state[f] = state[f] || {}; state[f].stars = i+1; save(); paint(); });
  notes.value = (state[f] || {}).notes || "";
  notes.onchange = () => { state[f] = state[f] || {}; state[f].notes = notes.value; save(); };
  paint();
});
document.getElementById("clearBtn").onclick = () => { for (const k in state) delete state[k]; save(); location.reload(); };
document.getElementById("csvBtn").onclick = () => {
  const rows = [["file","verdict","chips","stars","notes"]];
  document.querySelectorAll(".beat").forEach(c => { const f = c.dataset.f, st = state[f] || {};
    rows.push([f, st.verdict ?? "", (st.chips || []).join("+"), st.stars ?? "", (st.notes ?? "").replace(/"/g, "'")]); });
  const csv = rows.map(r => r.map(x => `"${x}"`).join(",")).join("\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
  a.download = "TASTE-PACK-RATINGS.csv"; a.click();
};
</script></body></html>"""


def main() -> int:
    from recipes import generate as G
    from teardown.render.balance import balance_render
    from render_audition import render_gate_standalone, sub_gate

    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.expanduser("~/mosh-beats/pack-001"))
    ap.add_argument("--pack-size", type=int, default=14)
    ap.add_argument("--smoke", action="store_true")
    args = ap.parse_args()

    binp = os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN
    if not os.path.isfile(binp):
        print(f"no Mosh binary at {binp!r}")
        return 1
    palette = G.load_palette()
    if not palette:
        print("no palette — abort")
        return 1
    library = G.load_library()  # snapshot ONCE: hermetic to concurrent library writes
    print(f"library: {len(library)} recipes")

    out_dir = os.path.expanduser(args.out)
    cand_dir = os.path.join(out_dir, "candidates")
    os.makedirs(cand_dir, exist_ok=True)
    ledger = os.path.join(out_dir, "candidates.jsonl")

    grid = requests_grid(args.smoke)
    print(f"factory: {len(grid)} candidates → {out_dir}")
    rows = []
    for n, (req, seed) in enumerate(grid):
        cid = f"{req['mood'][:4]}_{int(req['tempo'])}_{req['key'].replace(' ', '').replace('#', 's')}_s{seed}"
        wav = os.path.join(cand_dir, cid + ".wav")
        rec, prov = G.generate(req, seed=seed, palette=palette, library=library)
        bal = balance_render(rec, binp, wav, os.path.join(cand_dir, ".w" + cid), timeout_s=180)
        res = bal["res"]
        row = {"id": cid, "file": wav, "request": req, "seed": seed,
               "backbone": prov.backbone, "sources": prov.sources, "transpose": prov.transpose,
               "samples": {k: os.path.basename(v) for k, v in prov.samples.items()},
               "density": density_features(rec), "rmsDb": bal["metrics"].get("rmsDb"),
               "balance": {"iters": bal["iters"], "offsets": {str(k): v for k, v in bal["offsets"].items()},
                           "soloSub": bal["soloSub"]}}
        if not (res.nonsilent and res.error is None):
            row["verdict"] = "reject:render"
        else:
            rank, clip = render_gate_standalone(wav, req["key"])
            sub_ok, sub_m = sub_gate(wav)
            row["gate"] = {"keyRank": rank, "clip": round(clip, 5), **sub_m}
            # Key/mode is enforced in MIDI space by construction (conform_to_key +
            # measured sampler roots ⇒ heard == written). Chroma tonal-center ranking is
            # ambiguous on drum-heavy loops (calibration: scale-mass and rank both fail to
            # separate known-good from known-bad), so the render-side key check is only a
            # SMEAR TRIPWIRE for regressions (stale-binary/root-drift class ranks 9–23);
            # exact rank ships as a feature and the pack's "key" chip lets the owner rule.
            if rank <= 8 and clip < 0.005 and sub_ok:
                row["verdict"] = "pass"
            else:
                row["verdict"] = ("reject:key" if rank > 8 else
                                  "reject:clip" if clip >= 0.005 else "reject:sub")
        rows.append(row)
        print(f"  [{n+1}/{len(grid)}] {cid}: {row['verdict']}"
              + (f" (sub {row['gate']['subRatio']})" if "gate" in row else ""))

    # advisory external axes on every rendered candidate (bench data for the evaluators)
    rendered = [r for r in rows if os.path.isfile(r["file"])]
    axes = audiobox_axes([r["file"] for r in rendered])
    for r in rendered:
        ax = axes.get(r["file"])
        if ax:
            r["axes"] = ax

    with open(ledger, "a") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    passed = [r for r in rows if r["verdict"] == "pass"]
    print(f"\ngate: {len(passed)}/{len(rows)} PASS")
    if not passed:
        return 1
    picks = select_pack(passed, args.pack_size)
    for i, c in enumerate(picks):
        r = c["request"]
        c["pack_file"] = (f"{i+1:02d}_{r['mood']}_{int(r['tempo'])}_"
                          f"{r['key'].replace(' ', '').replace('#', 's')}.wav")
        shutil.copy2(c["file"], os.path.join(out_dir, c["pack_file"]))
    with open(os.path.join(out_dir, "pack.json"), "w") as f:
        json.dump(picks, f, indent=1)
    page = build_pack_page(out_dir, picks)
    print(f"pack: {len(picks)} beats → {page}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
