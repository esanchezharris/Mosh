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
import math
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
# Owner-named style vocabulary (styles.json) drives the grid; each style maps to a
# retrieval mood + tempo. Cards show the style so the owner's chips catch mismatch.
STYLES_TEMPO = {"club-swag": ("chill", 132), "disrespectful": ("aggressive", 152),
                "melodic-heartfelt": ("emotional", 148), "dark-menacing": ("dark", 140)}
KEYS = ["F minor", "G minor", "A minor", "C# minor", "D minor", "E minor"]
SEEDS = [1, 2, 3]
JUDGES_PY = os.path.expanduser("~/AI/judges_venv/bin/python")


def requests_grid(smoke: bool = False):
    reqs = [({"style": s, "mood": m, "tempo": t, "key": k}, seed)
            for s, (m, t) in STYLES_TEMPO.items() for k in KEYS for seed in SEEDS]
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


def tail_energy_db(wav: str, tempo: float) -> float:
    """Last-bar RMS relative to whole-mix RMS (dB). Logged FEATURE for the 'ends-weird'
    chip (r3 note: 'composition kind of trails off towards the end') — not a gate until
    a pack of chip evidence confirms the threshold."""
    import numpy as np
    import soundfile as sf
    x, sr = sf.read(wav)
    if getattr(x, "ndim", 1) > 1:
        x = x.mean(axis=1)
    if len(x) == 0:
        return 0.0
    bar = int(sr * 4.0 * 60.0 / max(tempo, 1.0))
    tail = x[-bar:] if len(x) > bar else x
    rms = float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))
    trms = float(np.sqrt(np.mean(np.asarray(tail, dtype=np.float64) ** 2)))
    return round(20.0 * (math.log10(max(trms, 1e-9)) - math.log10(max(rms, 1e-9))), 2)


def section_metrics(wav: str, sections) -> list:
    """Per-section band metrics (formed beats): slice the WAV at the arrangement's
    section boundaries — advisory rows for the ledger, never a gate this pack."""
    import tempfile

    import soundfile as sf
    from teardown.render.balance import band_metrics
    out = []
    try:
        x, sr = sf.read(wav)
    except Exception:
        return out
    for s in sections:
        a, b = int(float(s.start_s) * sr), int(float(s.end_s) * sr)
        seg = x[a:min(b, len(x))]
        if len(seg) < sr // 10:
            continue
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            sf.write(tf.name, seg, sr)
            m = band_metrics(tf.name)
        os.unlink(tf.name)
        out.append({"name": s.name, **{k: m[k] for k in ("rmsDb", "subRatio")}})
    return out


def audiobox_axes(paths: list) -> dict:
    """path → {PQ,CE,CU,PC} via the judges venv sidecar; {} when the venv is absent
    (owner-gated install) — the factory never blocks on it.

    The sidecar protocol emits TWO @@MOSH@@ lines: {"ready": true} on model load,
    THEN the path-keyed payload. Pack-001's axes were silently lost by taking the
    first line (the handshake) — skip it, merge every payload, and report loudly."""
    if not paths:
        return {}
    if not os.path.isfile(JUDGES_PY):
        print(f"  (audiobox axes skipped: judges venv absent at {JUDGES_PY})", file=sys.stderr)
        return {}
    sidecar = os.path.join(SERVICE, "sa3", "judge_sidecar.py")
    if not os.path.isfile(sidecar):
        print(f"  (audiobox axes skipped: sidecar missing at {sidecar})", file=sys.stderr)
        return {}
    axes: dict = {}
    try:
        proc = subprocess.run([JUDGES_PY, sidecar], input=json.dumps({"paths": paths}),
                              capture_output=True, text=True, timeout=120 + 10 * len(paths))
        for line in proc.stdout.splitlines():
            if not line.startswith("@@MOSH@@"):
                continue
            payload = json.loads(line[len("@@MOSH@@"):])
            if payload.get("ready"):
                continue                        # the load handshake, not a result
            if "error" in payload and len(payload) == 1:
                print(f"  (audiobox axes error: {payload['error']})", file=sys.stderr)
                continue
            axes.update({k: v for k, v in payload.items() if isinstance(v, dict)})
    except Exception as e:  # noqa: BLE001 — advisory metadata only, never fatal
        print(f"  (audiobox axes skipped: {e})", file=sys.stderr)
    print(f"  audiobox axes attached: {len(axes)}/{len(paths)}", file=sys.stderr)
    return axes


def select_pack(passed: list, pack_size: int) -> list:
    """Deterministic diverse selection: best-gated first, capped per (drums, backbone)
    pairing, per mood, AND per individual sample (≤2 pack beats may share any one
    sample hash — pack-001 shipped one pad sample in 7/14 beats and the owner's note
    was 'getting tired of this sound effect'). When caps leave the pack short, they
    relax in a DECLARED order (mood → combo → sample LAST) and each relaxation is
    logged loudly — the old backfill silently ignored every cap."""
    ranked = sorted(passed, key=lambda c: (c["gate"]["keyRank"], -c["gate"]["subRatio"], c["id"]))
    per_mood_cap = max(2, (pack_size + len(MOODS_TEMPO) - 1) // len(MOODS_TEMPO))
    picks: list = []
    combo_seen: dict = {}
    mood_seen: dict = {}
    sample_seen: dict = {}

    def try_add(c, caps: set) -> bool:
        combo = (c["sources"].get("drums"), c["backbone"])
        mood = c["request"]["mood"]
        samples = set((c.get("samples") or {}).values())
        if "mood" in caps and mood_seen.get(mood, 0) >= per_mood_cap:
            return False
        if "combo" in caps and combo_seen.get(combo, 0) >= 2:
            return False
        if "sample" in caps and any(sample_seen.get(s, 0) >= 2 for s in samples):
            return False
        picks.append(c)
        combo_seen[combo] = combo_seen.get(combo, 0) + 1
        mood_seen[mood] = mood_seen.get(mood, 0) + 1
        for s in samples:
            sample_seen[s] = sample_seen.get(s, 0) + 1
        return True

    all_caps = {"mood", "combo", "sample"}
    for caps in (all_caps, {"combo", "sample"}, {"sample"}, set()):
        for c in ranked:
            if len(picks) >= pack_size:
                break
            if any(p is c for p in picks):
                continue
            if try_add(c, caps) and caps != all_caps:
                print(f"  select_pack: relaxed {sorted(all_caps - caps)} to seat {c['id']}",
                      file=sys.stderr)
        if len(picks) >= pack_size:
            break
    return picks


def build_pack_page(out_dir: str, picks: list) -> str:
    cards = []
    for i, c in enumerate(picks):
        r = c["request"]
        srcs = " · ".join(f"<b>{k}</b> {str(v)[:38]}" for k, v in c["sources"].items())
        rep = c.get("reprise") or {}
        rep_badge = (f'<span class="badge b-rep">REPRISE of {rep["of"]}</span>' if rep else "")
        if (c.get("fx") or {}).get("applied"):
            rep_badge += '<span class="badge b-rep">FX</span>'
        if c.get("form"):
            rep_badge += f'<span class="badge b-rep">FORM {c["form"].get("plan", "")}</span>'
        if c.get("moreLike"):
            rep_badge += '<span class="badge b-rep">MORE LIKE YOUR TOP PICK</span>'
        if c.get("soundsLike"):
            rep_badge += (f'<span class="badge b-ok">sounds like: '
                          f'{", ".join(c["soundsLike"])}</span>')
        if c.get("predictedKeep") is not None:
            rep_badge += (f'<span class="badge b-ok">ranker {int(c["predictedKeep"] * 100)}%'
                          f' (advisory)</span>')
        if (c.get("filters") or {}).get("styleGrooveRelaxed"):
            rep_badge += '<span class="badge b-rep">no-backbeat</span>'
        rep_block = ""
        if rep:
            rep_block = (f'<div class="src" style="margin-top:6px">{rep.get("note", "same composition, new mix")} — '
                         f'<b>{rep["of"]} original for comparison:</b></div>'
                         f'<audio controls preload="metadata" src="{rep["old_file"]}"></audio>'
                         f'<div class="src">did the new mix move it? rate the NEW render above.</div>')
        cards.append(f"""
  <div class="beat" data-f="{c['pack_file']}">
    <div class="row1"><span class="name">{i+1:02d} · {r.get('style') or r['mood']} · {int(r['tempo'])} bpm · {r['key']}
      <span class="badge b-ok">key rank {c['gate']['keyRank']}</span>
      <span class="badge b-ok">sub {c['gate']['subRatio']:.2f}</span>{rep_badge}</span></div>
    <audio controls preload="metadata" src="{c['pack_file']}"></audio>
    <div class="src">{srcs}</div>{rep_block}
    <div class="rate">
      <span class="kk"><button data-k="keep">KEEP</button><button data-k="kill">KILL</button>
        <button class="top" data-k="top">★ TOP PICK</button></span>
      <span class="chips">{''.join(f'<button data-c="{ch}">{ch}</button>' for ch in
                            ('808', 'drums', 'mix', 'key', 'boring', 'messy', 'ends-weird', 'style'))}</span>
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
  .b-rep { background:rgba(255,210,63,.14); color:var(--accent); border:1px solid rgba(255,210,63,.4); }
  audio { width:100%; margin:10px 0 8px; height:36px; }
  .src { color:var(--dim); font-size:11.5px; line-height:1.65; } .src b { color:var(--ink); }
  .rate { display:flex; gap:10px; align-items:center; margin-top:10px; flex-wrap:wrap; }
  .kk button, .chips button { background:#101018; color:var(--dim); border:1px solid var(--edge);
    border-radius:6px; padding:6px 10px; font-size:12px; font-weight:600; cursor:pointer; margin-right:4px; }
  .kk button[data-k=keep].on { background:rgba(111,224,168,.16); color:var(--ok); border-color:rgba(111,224,168,.5); }
  .kk button[data-k=kill].on { background:rgba(255,107,107,.14); color:var(--bad); border-color:rgba(255,107,107,.5); }
  .kk button.top.on { background:rgba(255,210,63,.22); color:var(--accent); border-color:var(--accent); }
  .chips button.on { background:rgba(255,210,63,.15); color:var(--accent); border-color:rgba(255,210,63,.5); }
  .rate input[type=text] { flex:1; min-width:140px; background:#101018; color:var(--ink);
    border:1px solid var(--edge); border-radius:6px; padding:6px 10px; font-size:13px; }
  .actions { margin-top:20px; display:flex; gap:10px; } #saved { color:var(--ok); font-size:12.5px; align-self:center; }
  .actions button { background:var(--accent); color:#14140f; border:none; border-radius:8px;
    padding:9px 16px; font-weight:700; font-size:13px; cursor:pointer; }
  .actions button.ghost { background:transparent; color:var(--dim); border:1px solid var(--edge); }
</style></head><body>
<h1>Taste Pack — @N@ beats, ~10 minutes</h1>
<div class="sub">Every clip already passed the machine gates (key · clipping · sub register · balance) — you're rating <b>taste</b>, not defects.
KEEP or KILL each one (required); tap defect chips on kills (optional but gold); and pick exactly <b>ONE ★ TOP PICK</b>:
which beat would you actually open in the DAW and finish? The CSV won't export until every card has a verdict and a top pick is set.</div>
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
let paintAll = [];
document.querySelectorAll(".beat").forEach(card => {
  const f = card.dataset.f, kk = [...card.querySelectorAll(".kk button")],
        chips = [...card.querySelectorAll(".chips button")],
        notes = card.querySelector("input[type=text]");
  const paint = () => { const st = state[f] || {};
    kk.forEach(b => b.classList.toggle("on",
      b.dataset.k === "top" ? state.__top === f : st.verdict === b.dataset.k));
    chips.forEach(b => b.classList.toggle("on", (st.chips || []).includes(b.dataset.c))); };
  paintAll.push(paint);
  kk.forEach(b => b.onclick = () => {
    if (b.dataset.k === "top") {                 // exactly ONE top pick, globally
      state.__top = state.__top === f ? null : f;
      save(); paintAll.forEach(p => p()); return;
    }
    state[f] = state[f] || {}; state[f].verdict = b.dataset.k; save(); paint(); });
  chips.forEach(b => b.onclick = () => { state[f] = state[f] || {}; const c = new Set(state[f].chips || []);
    c.has(b.dataset.c) ? c.delete(b.dataset.c) : c.add(b.dataset.c); state[f].chips = [...c]; save(); paint(); });
  notes.value = (state[f] || {}).notes || "";
  notes.onchange = () => { state[f] = state[f] || {}; state[f].notes = notes.value; save(); };
  paint();
});
document.getElementById("clearBtn").onclick = () => { for (const k in state) delete state[k]; save(); location.reload(); };
document.getElementById("csvBtn").onclick = () => {
  const files = [...document.querySelectorAll(".beat")].map(c => c.dataset.f);
  const missing = files.filter(f => !(state[f] || {}).verdict);
  if (missing.length) { alert("KEEP or KILL every beat first — missing: " + missing.join(", ")); return; }
  if (!state.__top || !files.includes(state.__top)) {
    alert("Pick exactly ONE ★ TOP PICK — which beat would you open in the DAW and finish?"); return; }
  const rows = [["file","verdict","chips","top","notes"]];
  files.forEach(f => { const st = state[f] || {};
    rows.push([f, st.verdict ?? "", (st.chips || []).join("+"),
               state.__top === f ? "1" : "", (st.notes ?? "").replace(/"/g, "'")]); });
  const csv = rows.map(r => r.map(x => `"${x}"`).join(",")).join("\\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], {type: "text/csv"}));
  a.download = "TASTE-PACK-RATINGS.csv"; a.click();
};
</script></body></html>"""


def process_candidate(rec, prov, req: dict, seed: int, cid: str, wav: str,
                      work_dir: str, binp: str) -> dict:
    """Render → balance → RAW clip measure → normalize → gain-invariant gates →
    audibility. One shared path so factory candidates and pack reprises are gated
    identically. Returns the full feature row (with verdict)."""
    from teardown.render.balance import (BASS_AUDIBILITY_MAX_GAP_DB as BASS_GAP_DB,
                                         MIX_RMS_FLOOR_DB, balance_render, normalize_wav)
    from render_audition import render_gate_standalone, sub_gate

    bal = balance_render(rec, binp, wav, work_dir, timeout_s=180)
    res = bal["res"]
    row = {"id": cid, "file": wav, "request": req, "seed": seed,
           "backbone": prov.backbone, "sources": prov.sources, "transpose": prov.transpose,
           "samples": {k: os.path.basename(v) for k, v in prov.samples.items()},
           "density": density_features(rec), "rmsDb": bal["metrics"].get("rmsDb"),
           "balance": {"iters": bal["iters"], "offsets": {str(k): v for k, v in bal["offsets"].items()},
                       "soloSub": bal["soloSub"], "soloRmsDb": bal.get("soloRmsDb"),
                       "soloRmsAdjDb": bal.get("soloRmsAdjDb")},
           # calibration features from generation (filters fired, fills, variety);
           # drumRoles is a FEATURE, never a gate — pack-001 keeps 01 ("no drums")
           # and 11 ("no hi-hats") are the standing counterexamples. getattr: reprises
           # regenerate with the OLD generator whose Provenance predates these fields.
           "filters": getattr(prov, "filters", {}), "drumRoles": getattr(prov, "drum_roles", []),
           "distinct": getattr(prov, "distinct", {}), "subOverlap": getattr(prov, "sub_overlap", {}),
           "priors": getattr(prov, "priors", {}), "form": getattr(prov, "form", {})}
    if not (res.nonsilent and res.error is None):
        row["verdict"] = "reject:render"
        return row
    # ORDER IS LOAD-BEARING: clipFrac comes from the RAW render (bal metrics);
    # after normalize_wav, |x| ≥ 0.999 is unreachable and the clip gate would go
    # permanently blind. All post-normalize gates are gain-invariant (ratio/argmax).
    raw_rms = bal["metrics"].get("rmsDb")
    clip = bal["metrics"].get("clipFrac", 0.0)
    row["normGainDb"] = normalize_wav(wav)
    # Style key policy: when conform_to_key was deliberately SKIPPED ('disrespectful' =
    # weird key on purpose), the tripwire must gate against the recipe's MEASURED key —
    # heard==written smear-catching is preserved; only the reference key changes
    # (otherwise every disrespectful candidate dies reject:key by design).
    from recipes import generate as G
    want_key = req["key"]
    style_spec = G.load_styles().get((req.get("style") or "").lower()) or {}
    if not (style_spec.get("key") or {}).get("conform", True):
        mk = G.measured_key_of(rec)
        row["measuredKey"] = mk or "(ambiguous)"
        if mk:
            want_key = mk
    rank, _ = render_gate_standalone(wav, want_key)
    sub_ok, sub_m = sub_gate(wav)
    row["gate"] = {"keyRank": rank, "clip": round(clip, 5), **sub_m, "rawRmsDb": raw_rms}
    row["tailEnergyDb"] = tail_energy_db(wav, req["tempo"])
    secs = getattr(getattr(rec, "arrangement", None), "sections", None) or []
    if len(secs) > 1:
        row["sections"] = section_metrics(wav, secs)  # ADVISORY only (never a gate)
        # per-role onsets in the FINAL BAR of each section (MIDI-space, cheap) — the
        # S1 "ends-weird" adjudication feature: next pack's chips grade the fix.
        form = getattr(prov, "form", {}) or {}
        lb = form.get("loopBeats")
        if lb:
            tails = {}
            for el in rec.elements:
                if el.role.value in ("kick", "snare", "clap", "hat", "perc"):
                    per = []
                    for si in range(len(form.get("sections") or [])):
                        hi, lo = (si + 1) * lb, (si + 1) * lb - 4.0
                        per.append(sum(1 for n in el.midi.notes
                                       if lo <= float(n.start_beats) < hi))
                    tails[el.role.value] = per
            row["sectionTailOnsets"] = tails
    # 808-audibility ADVISORY (log this pack, promote next on calibration): the
    # solo stem is gain-corrected to the shipped offset (stem_rms_adjusted).
    gap = (round(raw_rms - bal["soloRmsAdjDb"], 2)
           if raw_rms is not None and bal.get("soloRmsAdjDb") is not None else None)
    row["audibility808"] = {"gapDb": gap,
                            "advisory": bool(gap is not None and gap > BASS_GAP_DB)}
    # Key/mode is enforced in MIDI space by construction (conform_to_key +
    # measured sampler roots ⇒ heard == written). Chroma tonal-center ranking is
    # ambiguous on drum-heavy loops (calibration: scale-mass and rank both fail to
    # separate known-good from known-bad), so the render-side key check is only a
    # SMEAR TRIPWIRE for regressions (stale-binary/root-drift class ranks 9–23);
    # exact rank ships as a feature and the pack's "key" chip lets the owner rule.
    # The RMS floor is a hard gate calibrated on pack-001: beat 01 ("808
    # inaudible", −23.5 dB) fails; every other pack beat (≥ −15.4) passes.
    quiet = raw_rms is not None and raw_rms < MIX_RMS_FLOOR_DB
    if rank <= 8 and clip < 0.005 and sub_ok and not quiet:
        row["verdict"] = "pass"
        _apply_fx_stage(rec, row, req, wav, work_dir, binp, want_key)
    else:
        row["verdict"] = ("reject:key" if rank > 8 else
                          "reject:clip" if clip >= 0.005 else
                          "reject:sub" if not sub_ok else "reject:quiet")
    return row


def _apply_fx_stage(rec, row: dict, req: dict, wav: str, work_dir: str, binp: str,
                    want_key: str):
    """Mix-polish v0: render the PASSING candidate once more with the native FX chains
    (drum OTT + 808 density comp) and ship the fx version ONLY when (a) the change is
    audible (gain-aligned residual > −40 dB — the pack-002 'sounds identical?' lesson)
    and (b) every gate re-passes on the fx render. Anything else ships dry with a loud
    reason. All params were round-trip-probed (fx_probe.py) before any pack render."""
    from teardown.render.balance import (MIX_RMS_FLOOR_DB, _volume_cmds, band_metrics,
                                         gain_aligned_residual_db, normalize_wav)
    from teardown.render.execute import execute_recipe
    from teardown.render.fx import fx_chain_commands
    from render_audition import render_gate_standalone, sub_gate

    roles = [e.role.value for e in rec.elements]
    fx_cmds, applied, params = fx_chain_commands(roles)
    if not applied:
        row["fx"] = {"applied": False, "reason": "no-applicable-chain"}
        return
    offsets = {int(k): v for k, v in (row.get("balance", {}).get("offsets") or {}).items()}
    fx_wav = wav.replace(".wav", ".fx.wav")
    res = execute_recipe(rec, bin_path=binp, out_wav=fx_wav, session_dir=work_dir + ".fx",
                         timeout_s=180, write_back=False, resolve_synth_patches=False,
                         pre_export_commands=_volume_cmds(offsets) + fx_cmds)
    if not (res.nonsilent and res.error is None and os.path.isfile(fx_wav)):
        row["fx"] = {"applied": False, "reason": f"fx-render-failed:{res.error}"}
        print(f"  fx: render failed for {row['id']} — shipping dry", file=sys.stderr)
        return
    fx_metrics = band_metrics(fx_wav)                 # RAW first (clip gate blindness)
    residual = gain_aligned_residual_db(wav, fx_wav)  # gain-invariant: dry is normalized
    fx_gain = normalize_wav(fx_wav)
    fx_rank, _ = render_gate_standalone(fx_wav, want_key)
    fx_sub_ok, _ = sub_gate(fx_wav)
    gates_ok = (fx_rank <= 8 and fx_metrics.get("clipFrac", 0.0) < 0.005 and fx_sub_ok
                and fx_metrics.get("rmsDb", 0.0) >= MIX_RMS_FLOOR_DB)
    if residual <= -40.0:
        row["fx"] = {"applied": False, "chain": applied, "residualDb": residual,
                     "reason": "residual-noop"}
        os.remove(fx_wav)
        return
    if not gates_ok:
        row["fx"] = {"applied": False, "chain": applied, "residualDb": residual,
                     "reason": f"gates-failed:rank{fx_rank}:clip{fx_metrics.get('clipFrac')}"
                               f":sub{fx_sub_ok}"}
        print(f"  fx: gates failed on fx render for {row['id']} — shipping dry",
              file=sys.stderr)
        os.remove(fx_wav)
        return
    os.replace(fx_wav, wav)      # the fx render IS the candidate now
    row["fx"] = {"applied": True, "chain": applied, "residualDb": residual,
                 "params": params, "normGainDb": fx_gain}


def main() -> int:
    from recipes import generate as G

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

    # owner keep/kill priors: loaded ONCE + snapshotted into the run dir, so a mid-run
    # merge_labels regeneration can never change a live run's retrieval (hermeticity)
    priors = G.load_priors()
    priors_hash = ""
    if priors and os.path.isfile(G.PRIORS_PATH):
        import hashlib
        priors_hash = hashlib.sha1(open(G.PRIORS_PATH, "rb").read()).hexdigest()[:12]
        shutil.copy2(G.PRIORS_PATH, os.path.join(out_dir, "source_priors.snapshot.json"))
    print(f"priors: {len(priors)} sources (hash {priors_hash or 'none'})")

    grid = requests_grid(args.smoke)
    print(f"factory: {len(grid)} candidates → {out_dir}")
    rows = []
    for n, (req, seed) in enumerate(grid):
        cid = (f"{(req.get('style') or req['mood'])[:4]}_{int(req['tempo'])}_"
               f"{req['key'].replace(' ', '').replace('#', 's')}_s{seed}")
        wav = os.path.join(cand_dir, cid + ".wav")
        # pack-004: alternate loop/form by grid index — per-beat attribution (the
        # 'form' feature + card badge) beats a separate formed pack for speed of signal
        form = G.FORM_AABA32 if n % 2 == 0 else None
        rec, prov = G.generate(req, seed=seed, palette=palette, library=library,
                               priors=priors, form=form)
        row = process_candidate(rec, prov, req, seed, cid, wav,
                                os.path.join(cand_dir, ".w" + cid), binp)
        row["priorsHash"] = priors_hash
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

    # latent lanes (ALL advisory-safe): persist embeddings for passing candidates, then
    # attach predictedKeep (ranker is ADVISORY until LOPO ≥ 0.65 — current: 0.52 MuQ),
    # similarity to the owner's top pick, and sounds-like tags from HIS exemplars.
    try:
        import latent_lanes as LL
        passing_r = [r for r in rendered if r["verdict"] == "pass"]
        LL.embed_candidates([r["file"] for r in passing_r])
        LL.annotate_rows(passing_r)
        print(f"  latent lanes: {sum(1 for r in passing_r if 'predictedKeep' in r)}"
              f"/{len(passing_r)} scored (mode: "
              f"{passing_r[0].get('rankerMode', '?') if passing_r else '?'})")
    except Exception as e:  # noqa: BLE001 — advisory, never fatal
        print(f"  (latent lanes skipped: {e})", file=sys.stderr)

    with open(ledger, "a") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    passed = [r for r in rows if r["verdict"] == "pass"]
    print(f"\ngate: {len(passed)}/{len(rows)} PASS")
    if not passed:
        return 1
    # more-like-top-pick lane (owner-chosen: 3-4 slots chase pack-004 #14 "I love it")
    by_sim = sorted([r for r in passed if r.get("simTopPick") is not None],
                    key=lambda r: -r["simTopPick"])[:4]
    for r in by_sim:
        r["moreLike"] = True
    if by_sim:
        print(f"  more-like-top-pick: {[(r['id'], r['simTopPick']) for r in by_sim]}")
    # half formed / half loops among the REST, each independently diversity-capped
    rest = [r for r in passed if not r.get("moreLike")]
    formed = [r for r in rest if r.get("form")]
    loops = [r for r in rest if not r.get("form")]
    remaining = args.pack_size - len(by_sim)
    half = remaining // 2
    picks = by_sim + select_pack(formed, half) + select_pack(loops, remaining - half)
    if len(picks) < args.pack_size:   # one side ran short — backfill from the other
        pool = [r for r in passed if not any(p is r for p in picks)]
        picks += select_pack(pool, args.pack_size - len(picks))
    print(f"pack split: {sum(1 for p in picks if p.get('form'))} formed / "
          f"{sum(1 for p in picks if not p.get('form'))} loops")
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
