#!/usr/bin/env python3
"""build-package.py — assemble the produce-lane overnight package.

Reads a `<produce-ab-dir>/runs/<runId>/run.json` tree written by
ui/scripts/produceLiveRun.mts (+ optional `<runId>/swap/` from
produceReplay.mts --swap and `fixture-replay/` from --fixture), and produces:

  - A/B WAV symlinks at the package root: A-release-<slug>.wav,
    B-mosh-<runId>.wav, B-labkit-<runId>.wav (when a swap render exists),
    B-reference-notes-moshsounds.wav (when the fixture replay exists). A
    missing A-flywheel.wav is noted, never fabricated (W3.3: the corrected
    reference beat cannot be exported overnight — Live is off-limits).
  - audition.html — a self-contained page pairing each B-mosh-<runId>
    candidate against the release reference: play buttons, N/K keybindings
    (matching the palette-v2 audition.html pattern this reuses), a rating
    select + notes textarea per candidate, Space swaps A/B playback for the
    row in focus, and "Copy verdict" serializes every row into the SAME shape
    as verdict.json below.
  - verdict.json — an ARRAY template, one skeleton entry per B candidate,
    `{v:1, date, candidate, reference, rating, user_verdict, notes:[]}`
    (rating/user_verdict null, notes empty) — the owner fills this in (or
    pastes audition.html's "Copy verdict" output over it) and it becomes the
    produce lane's first docs/produce-corrections/<id>.meta.json input (W2.8,
    scripts/produce/capture-correction.py — not this script's job).
  - MORNING-REPORT-produce.md — the run-by-run + totals summary the owner
    reads first: outcomes, tokens/cost, silentRender flags, disk usage, the
    batch's stop reason, and the manual owner-acceptance checklist.

Runs entirely on the filesystem tree — no companion server, no Mosh binary,
no network. Safe (and intended) to run against a synthetic runs/ directory
for testing: see the --produce-ab-dir flag.

Usage:
  build-package.py --produce-ab-dir <dir>
    [--reference-release <path>] [--reference-flywheel-note <text>]
    [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from html import escape
from pathlib import Path
from typing import Any, Optional

# Round 2 (produce-r1-2026-09-02.meta.json): the provisional A was a symlink
# to a file OUTSIDE the package folder (~/Documents) — browsers refuse
# file:// parent traversal from audition.html, so it silently never played.
# The owner has since exported the real corrected beat to
# ~/Desktop/A-flywheel.wav (4-bar A section, 6.5s, float32) and, for this
# round, straight into the package folder itself. resolve_a_reference below
# either COPIES an explicit --a-file in (never symlinks — that's exactly how
# round 1's A silently failed to play) or uses an A-flywheel.wav already
# sitting in the folder; audition.html uses it as the ONLY A — no more
# A-release-<slug>.wav symlink pointing outside the folder.
DEFAULT_FLYWHEEL_NOTE = (
    "A-flywheel.wav is not in this package and no --a-file was given (or the "
    "path didn't exist): the corrected reference beat exists ONLY as the Live "
    "set (cATHARDIC_trap_r0_gen001.als) and Live is off-limits overnight. "
    "Export it by hand (bounce the .als to a wav) and re-run this script with "
    "--a-file <path> — it will be COPIED in, never symlinked, so it plays from "
    "audition.html's file:// origin."
)


def eprint(*a: Any) -> None:
    print(*a, file=sys.stderr)


@dataclass
class RunInfo:
    run_id: str
    dir: Path
    run_json: dict[str, Any] = field(default_factory=dict)
    mix_wav: Optional[Path] = None
    swap_wav: Optional[Path] = None
    swap_status: Optional[str] = None  # "ok" | "unavailable" | "failed" | None
    # R3 (kit-matched round): swap/replay-result.json's own "stems" field
    # (produceReplay.mts now runs export_stems for the swap leg too, same as
    # the live driver) — the owner's round-2 note "labkit twins: no stems are
    # available?" named exactly this gap.
    swap_stems: list[dict[str, Any]] = field(default_factory=list)


def load_json(path: Path) -> dict[str, Any]:
    try:
        with path.open() as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001 — a malformed run.json shouldn't kill the whole package
        eprint(f"[build-package] WARNING: could not read {path}: {e}")
        return {}


def discover_runs(runs_dir: Path) -> list[RunInfo]:
    runs: list[RunInfo] = []
    if not runs_dir.is_dir():
        return runs
    for run_json_path in sorted(runs_dir.glob("*/run.json")):
        run_dir = run_json_path.parent
        run_id = run_dir.name
        info = RunInfo(run_id=run_id, dir=run_dir, run_json=load_json(run_json_path))
        mix = run_dir / "mix.wav"
        if mix.is_file():
            info.mix_wav = mix
        swap_mix = run_dir / "swap" / "mix.wav"
        swap_result = run_dir / "swap" / "replay-result.json"
        if swap_mix.is_file():
            info.swap_wav = swap_mix
            info.swap_status = "ok"
        elif swap_result.is_file():
            info.swap_status = "failed"  # a replay-result.json with no usable wav
        if swap_result.is_file():
            stems = load_json(swap_result).get("stems")
            if isinstance(stems, list):
                info.swap_stems = stems
        runs.append(info)
    return runs


def discover_fixture(runs_dir: Path) -> Optional[Path]:
    mix = runs_dir / "fixture-replay" / "mix.wav"
    return mix if mix.is_file() else None


def discover_fixture_stems(runs_dir: Path) -> list[dict[str, Any]]:
    """R3 — the fixture-replay leg's own replay-result.json "stems" field
    (produceReplay.mts's --fixture branch runs export_stems the same as
    --swap and the live driver)."""
    result_path = runs_dir / "fixture-replay" / "replay-result.json"
    if not result_path.is_file():
        return []
    stems = load_json(result_path).get("stems")
    return stems if isinstance(stems, list) else []


def relink(dest: Path, target: Path, dry_run: bool) -> str:
    """(Re)create dest as a relative symlink to target. Idempotent. Returns a
    short status string for the report."""
    rel = os.path.relpath(target, start=dest.parent)
    if dry_run:
        return f"would link {dest.name} -> {rel}"
    if dest.is_symlink() or dest.exists():
        dest.unlink()
    dest.symlink_to(rel)
    return f"linked {dest.name} -> {rel}"


def resolve_a_reference(package_dir: Path, a_file_arg: Optional[Path], dry_run: bool) -> tuple[Optional[Path], list[str]]:
    """Resolve the package's ONE A reference: A-flywheel.wav inside
    package_dir. `a_file_arg` (--a-file), when given, is COPIED in (never
    symlinked — browsers refuse file:// parent traversal, which is exactly
    how round 1's provisional A silently failed to play) and OVERWRITES
    whatever was already there. Absent --a-file, a real A-flywheel.wav
    already sitting in the folder (the common case — the owner drops it in
    by hand) is used as-is. Returns (path-or-None, report notes)."""
    dest = package_dir / "A-flywheel.wav"
    notes: list[str] = []
    if a_file_arg is not None:
        src = a_file_arg.expanduser().resolve()
        if not src.is_file():
            notes.append(f"--a-file {src} not found — A-flywheel.wav NOT updated from it")
        elif dry_run:
            notes.append(f"would copy --a-file {src} -> {dest.name}")
        else:
            shutil.copyfile(src, dest)
            notes.append(f"copied --a-file {src} -> {dest.name}")
    if dest.is_file():
        notes.append(f"using {dest.name} as the A reference")
        return dest, notes
    notes.append(DEFAULT_FLYWHEEL_NOTE)
    return None, notes


def build_links(package_dir: Path, runs: list[RunInfo], fixture_wav: Optional[Path], dry_run: bool) -> list[str]:
    notes: list[str] = []
    for r in runs:
        if r.mix_wav:
            notes.append(relink(package_dir / f"B-mosh-{r.run_id}.wav", r.mix_wav, dry_run))
        else:
            notes.append(f"run {r.run_id}: no mix.wav — no B-mosh-{r.run_id}.wav symlink made")
        if r.swap_wav:
            notes.append(relink(package_dir / f"B-labkit-{r.run_id}.wav", r.swap_wav, dry_run))

    if fixture_wav:
        notes.append(relink(package_dir / "B-reference-notes-moshsounds.wav", fixture_wav, dry_run))
    else:
        notes.append("fixture replay (reference notes on Mosh sounds) not available — no B-reference-notes-moshsounds.wav")
    return notes


AUDITION_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><title>produce-lane audition — {date}</title>
<style>
body{{font:14px -apple-system,sans-serif;margin:0;background:#111;color:#eee;padding:16px 16px 160px}}
h1{{font-size:18px}} h2{{margin:22px 0 6px;color:#7fd4ff;text-transform:uppercase;font-size:13px}}
.pair{{border-radius:8px;padding:10px 12px;margin:8px 0;background:#191919}}
.pair.focused{{outline:2px solid #2b6cb0}}
.row{{display:flex;align-items:center;gap:10px;padding:3px 0;flex-wrap:wrap}}
button.play{{min-width:70px;height:28px;border:0;border-radius:5px;background:#333;color:#fff;cursor:pointer}}
button.play.playing{{background:#2b6cb0}}
button.play:hover{{background:#555}}
.name{{color:#ccc;font-family:ui-monospace,monospace;font-size:12px}}
.meta{{color:#888;font-size:11px}}
details.stems{{margin-top:8px}}
details.stems summary{{cursor:pointer;color:#7fd4ff;font-size:11px;text-transform:uppercase}}
details.stems button.play{{min-width:0;height:22px;padding:0 10px;font-size:11px}}
details.stems .row{{padding:3px 0 3px 14px}}
select{{background:#181818;color:#eee;border:1px solid #333;border-radius:4px;padding:3px 6px}}
textarea.notes{{width:100%;min-height:44px;background:#181818;color:#eee;border:1px solid #333;border-radius:4px;font:12px ui-monospace,monospace;padding:6px;margin-top:6px}}
#bar{{position:fixed;left:0;right:0;bottom:0;background:#000d;border-top:1px solid #333;padding:10px 16px;display:flex;gap:12px;align-items:center;backdrop-filter:blur(6px)}}
#count{{color:#9f9;min-width:110px;font-size:12px}}
#copy{{border:0;border-radius:6px;background:#2b6cb0;color:#fff;padding:8px 14px;cursor:pointer}}
#help{{color:#888;font-size:11px;flex:1}}
.missing{{color:#a55;font-size:11px}}
</style></head><body>
<h1>produce-lane overnight audition &mdash; {date}</h1>
<p class="meta">ask: {ask}</p>
{pairs}
<div id="bar"><span id="help">N next pair &middot; Space swap A/B in the focused pair &middot; K keep (rating=pass) &middot; click a play button directly any time</span><span id="count">0 rated</span><button id="copy">Copy verdict</button></div>
<script>
const audio = new Audio();
const pairs = [...document.querySelectorAll('.pair')];
let focusIdx = -1;
let lastPlayed = null; // {{pairIdx, side}}

function setFocus(i) {{
  focusIdx = ((i % pairs.length) + pairs.length) % pairs.length;
  pairs.forEach((p, idx) => p.classList.toggle('focused', idx === focusIdx));
  pairs[focusIdx].scrollIntoView({{block: 'center', behavior: 'smooth'}});
}}
function play(pairIdx, side) {{
  const btn = pairs[pairIdx].querySelector(`button[data-side="${{side}}"]`);
  if (!btn || !btn.dataset.src) return;
  document.querySelectorAll('button.play').forEach(b => b.classList.remove('playing'));
  btn.classList.add('playing');
  audio.src = btn.dataset.src;
  audio.play();
  lastPlayed = {{pairIdx, side}};
  setFocus(pairIdx);
}}
pairs.forEach((p, idx) => {{
  p.querySelectorAll('button.play').forEach(b => {{
    b.onclick = () => play(idx, b.dataset.side);
  }});
}});
document.addEventListener('keydown', e => {{
  if (e.target && (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
  if (e.key === 'n' || e.key === 'N') {{ e.preventDefault(); setFocus(focusIdx + 1); }}
  if (e.key === ' ') {{
    e.preventDefault();
    const side = lastPlayed && lastPlayed.pairIdx === focusIdx && lastPlayed.side === 'a' ? 'b' : 'a';
    play(focusIdx, side);
  }}
  if (e.key === 'k' || e.key === 'K') {{
    e.preventDefault();
    const sel = pairs[focusIdx >= 0 ? focusIdx : 0].querySelector('select.rating');
    if (sel) {{ sel.value = 'pass'; sel.dispatchEvent(new Event('change')); }}
  }}
}});
const STORE_KEY = 'produce-lane-verdicts-{date}';
function load() {{ try {{ return JSON.parse(localStorage.getItem(STORE_KEY) || '{{}}'); }} catch {{ return {{}}; }} }}
function save(state) {{ try {{ localStorage.setItem(STORE_KEY, JSON.stringify(state)); }} catch {{}} }}
let state = load();
function sync() {{
  let rated = 0;
  pairs.forEach(p => {{
    const cand = p.dataset.candidate;
    const sel = p.querySelector('select.rating');
    const notes = p.querySelector('textarea.notes');
    if (state[cand]) {{
      if (sel && state[cand].rating) sel.value = state[cand].rating;
      if (notes && state[cand].notes) notes.value = state[cand].notes;
    }}
    if (sel && sel.value) rated++;
  }});
  document.getElementById('count').textContent = rated + ' rated';
}}
pairs.forEach(p => {{
  const cand = p.dataset.candidate;
  const sel = p.querySelector('select.rating');
  const notes = p.querySelector('textarea.notes');
  const persist = () => {{
    state[cand] = {{rating: sel ? sel.value : '', notes: notes ? notes.value : ''}};
    save(state); sync();
  }};
  if (sel) sel.onchange = persist;
  if (notes) notes.oninput = persist;
}});
sync();
document.getElementById('copy').onclick = () => {{
  const out = pairs.map(p => {{
    const cand = p.dataset.candidate;
    const s = state[cand] || {{}};
    return {{
      v: 1, date: '{date}', candidate: p.dataset.candidateFile,
      reference: p.dataset.referenceFile,
      rating: s.rating || null, user_verdict: s.rating || null,
      notes: s.notes ? [s.notes] : [],
    }};
  }});
  navigator.clipboard.writeText(JSON.stringify(out, null, 2));
}};
if (pairs.length) setFocus(0);
</script>
</body></html>
"""

PAIR_TEMPLATE = """<div class="pair" data-candidate="{candidate_id}" data-candidate-file="{candidate_file}" data-reference-file="{reference_file}">
<h2>{title}</h2>
<div class="row">
<button class="play" data-side="a" data-src="{a_src}">&#9654; A</button>
<span class="name">{a_label}</span>
</div>
<div class="row">
<button class="play" data-side="b" data-src="{b_src}">&#9654; B</button>
<span class="name">{b_label}</span>
<span class="meta">{meta}</span>
</div>
{stems_block}
<div class="row">
<label>rating <select class="rating"><option value="">-- pick --</option><option value="pass">pass</option><option value="pass_with_notes">pass_with_notes</option><option value="fail">fail</option></select></label>
</div>
<textarea class="notes" placeholder="notes for this candidate..."></textarea>
</div>
"""


def stem_rows_html(package_dir: Path, stems: list[dict[str, Any]]) -> str:
    """R2.8 — one play row per stem file (run.json.stems, written by
    produceLiveRun.mts's export_stems call), folded under its candidate's B
    row so the owner can name WHICH track is wrong next round instead of just
    the whole mix. Empty string (no <details>) when the run has no stems —
    an older run, or a run whose export_stems call failed."""
    rows: list[str] = []
    for i, s in enumerate(stems):
        f = s.get("file")
        if not isinstance(f, str):
            continue
        try:
            rel = os.path.relpath(Path(f), start=package_dir)
        except Exception:  # noqa: BLE001 — a bad path just drops that one stem row
            continue
        name = s.get("name") or Path(f).name
        rows.append(
            f'<div class="row"><button class="play" data-side="stem-{i}" data-src="{escape(rel, quote=True)}">&#9654;</button>'
            f'<span class="name">{escape(str(name))}</span></div>'
        )
    if not rows:
        return ""
    return f'<details class="stems"><summary>stems ({len(rows)})</summary>\n' + "\n".join(rows) + "\n</details>"


def render_audition_html(package_dir: Path, date_str: str, ask: str, runs: list[RunInfo],
                          a_reference: Optional[Path]) -> str:
    a_rel = os.path.relpath(a_reference, start=package_dir) if a_reference else ""
    a_label = a_reference.name if a_reference else "(no A-flywheel.wav in this package — see the report)"
    a_reference_file = escape("A-flywheel.wav" if a_reference else "", quote=True)
    pairs_html: list[str] = []
    for r in runs:
        if not r.mix_wav:
            continue
        b_src = f"runs/{r.run_id}/mix.wav"
        rj = r.run_json
        meta = f"model={rj.get('model','?')} outcome={rj.get('outcome','?')} tracks={rj.get('tracks','?')} silent={rj.get('render',{}).get('silentRender','?')}"
        stems = rj.get("stems") or []
        pairs_html.append(PAIR_TEMPLATE.format(
            candidate_id=escape(f"B-mosh-{r.run_id}", quote=True),
            candidate_file=escape(f"B-mosh-{r.run_id}.wav", quote=True),
            reference_file=a_reference_file,
            title=escape(f"run {r.run_id}"),
            a_src=escape(a_rel),
            a_label=escape(a_label),
            b_src=escape(b_src),
            b_label=escape(f"B-mosh-{r.run_id}.wav"),
            meta=escape(meta),
            stems_block=stem_rows_html(package_dir, stems if isinstance(stems, list) else []),
        ))
        if r.swap_wav:
            pairs_html.append(PAIR_TEMPLATE.format(
                candidate_id=escape(f"B-labkit-{r.run_id}", quote=True),
                candidate_file=escape(f"B-labkit-{r.run_id}.wav", quote=True),
                reference_file=a_reference_file,
                title=escape(f"run {r.run_id} — sound-matched (labkit)"),
                a_src=escape(a_rel),
                a_label=escape(a_label),
                b_src=escape(f"runs/{r.run_id}/swap/mix.wav"),
                b_label=escape(f"B-labkit-{r.run_id}.wav"),
                meta="sound-matched replay: original run's notes, owner's lab kit",
                stems_block=stem_rows_html(package_dir, r.swap_stems),
            ))
    fixture_mix = package_dir / "runs" / "fixture-replay" / "mix.wav"
    if fixture_mix.is_file():
        pairs_html.append(PAIR_TEMPLATE.format(
            candidate_id="B-reference-notes-moshsounds",
            candidate_file="B-reference-notes-moshsounds.wav",
            reference_file=a_reference_file,
            title="reference notes, Mosh sounds (fixture replay)",
            a_src=escape(a_rel),
            a_label=escape(a_label),
            b_src="runs/fixture-replay/mix.wav",
            b_label="B-reference-notes-moshsounds.wav",
            meta="the corrected reference beat's own notes, played back with Mosh's own sounds",
            stems_block=stem_rows_html(package_dir, discover_fixture_stems(package_dir / "runs")),
        ))
    return AUDITION_TEMPLATE.format(
        date=escape(date_str), ask=escape(ask or "(no ask recorded)"),
        pairs="\n".join(pairs_html) if pairs_html else "<p class=\"missing\">No completed runs with a mix.wav were found — nothing to audition yet.</p>",
    )


def build_verdict_template(date_str: str, runs: list[RunInfo], a_reference: Optional[Path]) -> list[dict[str, Any]]:
    reference = "A-flywheel.wav" if a_reference else None
    out: list[dict[str, Any]] = []
    for r in runs:
        if r.mix_wav:
            out.append({"v": 1, "date": date_str, "candidate": f"B-mosh-{r.run_id}.wav", "reference": reference,
                        "rating": None, "user_verdict": None, "notes": []})
        if r.swap_wav:
            out.append({"v": 1, "date": date_str, "candidate": f"B-labkit-{r.run_id}.wav", "reference": reference,
                        "rating": None, "user_verdict": None, "notes": []})
    return out


def dir_size_mb(path: Path) -> Optional[float]:
    try:
        out = subprocess.run(["du", "-sk", str(path)], capture_output=True, text=True, timeout=30, check=True)
        kb = int(out.stdout.split()[0])
        return round(kb / 1024, 1)
    except Exception:  # noqa: BLE001
        return None


def read_ledger_batch_end(ledger_path: Path) -> Optional[dict[str, Any]]:
    if not ledger_path.is_file():
        return None
    last: Optional[dict[str, Any]] = None
    with ledger_path.open() as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:  # noqa: BLE001
                continue
            if rec.get("kind") == "batch-end":
                last = rec
    return last


def build_morning_report(package_dir: Path, date_str: str, ask: str, runs: list[RunInfo],
                          fixture_wav: Optional[Path], a_reference: Optional[Path],
                          link_notes: list[str]) -> str:
    lines: list[str] = []
    lines.append(f"# Produce-lane overnight report — {date_str}")
    lines.append("")
    lines.append(f"**Ask:** {ask or '(none recorded)'}")
    lines.append("")
    total_cost = 0.0
    total_tokens_in = 0
    total_tokens_out = 0
    silent_count = 0
    outcome_counts: dict[str, int] = {}
    lines.append("## Runs")
    lines.append("")
    lines.append("| run | model | outcome | tracks | clips | tokens in/out | cost | render | swap | notes |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in runs:
        rj = r.run_json
        outcome = str(rj.get("outcome", "?"))
        outcome_counts[outcome] = outcome_counts.get(outcome, 0) + 1
        cost = float(rj.get("costUsd", 0) or 0)
        total_cost += cost
        tin = int(rj.get("tokensIn", 0) or 0)
        tout = int(rj.get("tokensOut", 0) or 0)
        total_tokens_in += tin
        total_tokens_out += tout
        render = rj.get("render", {}) or {}
        silent = bool(render.get("silentRender"))
        if silent:
            silent_count += 1
        render_cell = f"{'SILENT ' if silent else ''}{render.get('bytes', '?')}B rms={render.get('rmsDbfs', '?')}dBFS"
        swap_cell = r.swap_status or ("ok" if r.swap_wav else "-")
        notes_cell = ""
        errs = rj.get("brainErrors") or []
        if errs:
            notes_cell = "; ".join(str(e) for e in errs)[:120]
        lines.append(
            f"| {r.run_id} | {rj.get('model','?')} | {outcome} | {rj.get('tracks','?')} | {rj.get('clips','?')} "
            f"| {tin}/{tout} | ${cost:.4f} | {render_cell} | {swap_cell} | {notes_cell} |"
        )
    lines.append("")
    lines.append("## Totals")
    lines.append("")
    lines.append(f"- Completed runs: {len(runs)}")
    lines.append(f"- Outcomes: {', '.join(f'{k}={v}' for k, v in sorted(outcome_counts.items())) or 'none'}")
    lines.append(f"- Tokens in/out: {total_tokens_in}/{total_tokens_out}")
    lines.append(f"- Estimated OpenRouter cost: ${total_cost:.4f}")
    lines.append(f"- Silent renders (RMS < -60 dBFS): {silent_count} of {len(runs)}")
    size_mb = dir_size_mb(package_dir)
    lines.append(f"- Package disk usage: {size_mb if size_mb is not None else 'unknown'} MB")
    batch_end = read_ledger_batch_end(package_dir / "ledger.jsonl")
    if batch_end:
        lines.append(f"- Batch stop reason: {batch_end.get('reason', '?')}")
    lines.append("")
    lines.append("## A/B references")
    lines.append("")
    for note in link_notes:
        lines.append(f"- {note}")
    lines.append("")
    lines.append("## Owner morning checklist (cannot be automated)")
    lines.append("")
    lines.append("- [ ] Export the corrected Live set (`cATHARDIC_trap_r0_gen001.als`) to `A-flywheel.wav` in this folder.")
    lines.append("- [ ] Open `audition.html`, listen through each pair, rate + note.")
    lines.append("- [ ] Click \"Copy verdict\" and paste over `verdict.json` (or fill it in by hand).")
    lines.append("- [ ] Run `scripts/produce/capture-correction.py` (once it exists, W2.8) to turn `verdict.json` into the first `docs/produce-corrections/<id>.meta.json`.")
    lines.append("- [ ] Note which Vital presets earned a veto (audition.html's per-candidate notes, or `runs/<runId>/template.json`'s `synths[].preset`).")
    lines.append("- [ ] Decide whether to merge this branch's produce-lane commits.")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--produce-ab-dir", required=True, type=Path)
    p.add_argument("--a-file", type=Path, default=None,
                    help="path to the corrected reference beat's wav — COPIED into the package "
                         "folder as A-flywheel.wav (never symlinked). Omit to use an "
                         "A-flywheel.wav already sitting in the package folder.")
    p.add_argument("--ask", default=None, help="override the ask shown in the report (defaults to the first run's ask)")
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    package_dir: Path = args.produce_ab_dir.expanduser().resolve()
    runs_dir = package_dir / "runs"
    if not package_dir.is_dir():
        eprint(f"[build-package] --produce-ab-dir does not exist: {package_dir}")
        return 2

    runs = discover_runs(runs_dir)
    fixture_wav = discover_fixture(runs_dir)
    date_str = package_dir.name if package_dir.name[:4].isdigit() else datetime.now(timezone.utc).strftime("%Y-%m-%d")
    ask = args.ask or next((str(r.run_json.get("ask")) for r in runs if r.run_json.get("ask")), "")

    print(f"[build-package] {len(runs)} run(s) found under {runs_dir}")
    if not runs:
        eprint("[build-package] WARNING: no runs found — the package will still be built (empty audition page, a report noting zero runs).")

    a_reference, a_notes = resolve_a_reference(package_dir, args.a_file, args.dry_run)
    for n in a_notes:
        print(f"[build-package] {n}")

    link_notes = a_notes + build_links(package_dir, runs, fixture_wav, args.dry_run)
    for n in link_notes[len(a_notes):]:
        print(f"[build-package] {n}")

    audition_html = render_audition_html(package_dir, date_str, ask, runs, a_reference)
    verdict_template = build_verdict_template(date_str, runs, a_reference)
    report_md = build_morning_report(package_dir, date_str, ask, runs, fixture_wav, a_reference, link_notes)

    if args.dry_run:
        print("[build-package] --dry-run: not writing audition.html / verdict.json / MORNING-REPORT-produce.md")
        return 0

    (package_dir / "audition.html").write_text(audition_html, encoding="utf-8")
    (package_dir / "verdict.json").write_text(json.dumps(verdict_template, indent=2) + "\n", encoding="utf-8")
    (package_dir / "MORNING-REPORT-produce.md").write_text(report_md, encoding="utf-8")
    print(f"[build-package] wrote {package_dir / 'audition.html'}")
    print(f"[build-package] wrote {package_dir / 'verdict.json'} ({len(verdict_template)} candidate(s))")
    print(f"[build-package] wrote {package_dir / 'MORNING-REPORT-produce.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
