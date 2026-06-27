"""§9 execute — the ONE seam-crosser: compile a Recipe (render/compile.py, pure) then run
it through MoshOps to build a real Edit, render it, and write back `yield.actual` +
`reconstruction_class` (honest measured yield, per the spec).

At execute time we resolve what the pure compiler deferred:
  * MIDI notes — parse each element's `midi_ref` SMF → inline `notes` on its add_midi_clip
    (render/midi_read.py); the clip is no longer empty.
  * (synth plugin load + param-name→index mapping still needs an engine describe-params
    command — left in `unresolved`, flagged, NOT silently dropped.)

The binary call mirrors the §6 oracle: write JSONL, `Mosh --run-script` (exit code =
command-failure count), read the per-command results + the exported WAV. Pure helpers
(`inline_midi`, `yield_actual`, `reconstruction_class_for`) are split out so they're
testable without the engine.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import numpy as np

from .compile import DRUM_ROLES, compile_recipe
from .midi_read import read_midi

DEFAULT_BIN = "/Applications/Mosh.app/Contents/MacOS/Mosh"
_TVAR = re.compile(r"^\$\{T(\d+)\}$")


def _bin(bin_path: Optional[str]) -> str:
    return bin_path or os.environ.get("MOSH_BIN", "").strip() or DEFAULT_BIN


@dataclass
class ExecuteResult:
    commands: list = field(default_factory=list)
    results: list = field(default_factory=list)
    unresolved: list = field(default_factory=list)
    out_wav: Optional[str] = None
    audio_rms: float = 0.0
    nonsilent: bool = False
    notes_resolved: int = 0
    synths_loaded: int = 0
    synth_params_set: int = 0
    yield_actual: dict = field(default_factory=dict)
    ran: bool = False
    error: Optional[str] = None


def _resolve_ref(midi_ref: str, asset_root: Optional[str]) -> Optional[str]:
    if not midi_ref:
        return None
    if os.path.isabs(midi_ref) and os.path.isfile(midi_ref):
        return midi_ref
    if asset_root:
        cand = os.path.join(asset_root, midi_ref)
        if os.path.isfile(cand):
            return cand
    return midi_ref if os.path.isfile(midi_ref) else None


def inline_midi(commands: list, recipe, asset_root: Optional[str] = None) -> tuple[list, int]:
    """Fill each add_midi_clip's `notes` from its element's midi_ref SMF. Pure: maps a
    clip's `${Ti}` trackId back to recipe.elements[i]. Returns (commands, n_resolved)."""
    out = []
    resolved_ids: list = []
    for c in commands:
        c = dict(c)
        if c.get("command") == "add_midi_clip":
            tref = (c.get("args") or {}).get("trackId", "")
            m = _TVAR.match(str(tref))
            if m:
                i = int(m.group(1))
                if 0 <= i < len(recipe.elements):
                    ref = _resolve_ref(recipe.elements[i].midi.midi_ref, asset_root)
                    if ref:
                        try:
                            notes = read_midi(ref)
                        except Exception:
                            notes = []
                        if notes:
                            c["args"] = dict(c["args"], notes=notes)
                            resolved_ids.append(recipe.elements[i].element_id)
        out.append(c)
    return out, resolved_ids


def _run_capture(binp: str, cmds: list, session_dir: Optional[str], timeout_s: int) -> list:
    """Run a read-only probe rollout and return the per-command results (no export)."""
    work = Path(tempfile.mkdtemp(prefix="td-probe-"))
    script = work / "s.jsonl"
    results = work / "r.jsonl"
    script.write_text("\n".join(json.dumps(c) for c in cmds) + "\n")
    env = dict(os.environ, MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(results),
               MOSH_SESSION_DIR=str(session_dir or work))
    subprocess.run([binp, "--run-script"], env=env, capture_output=True, text=True,
                   timeout=timeout_s, check=False)
    if not results.exists():
        return []
    return [json.loads(ln) for ln in results.read_text().splitlines() if ln.strip()]


def _list_instruments(binp: str, session_dir: Optional[str], timeout_s: int) -> dict:
    """name (lowercased) → VST3 instrument pluginId, for resolving a recipe's synth by name."""
    out: dict = {}
    for r in _run_capture(binp, [{"command": "list_plugins", "args": {}}], session_dir, timeout_s):
        if r.get("command") == "list_plugins":
            for p in (r.get("data") or {}).get("plugins", []):
                if p.get("isInstrument") and p.get("format") == "VST3":
                    out.setdefault(p["name"].lower(), p["id"])
    return out


def _resolve_plugin_id(name: str, name2id: dict) -> Optional[str]:
    """Exact then forward-prefix match only (recipe 'Serum' → catalog 'Serum 2'). The reverse
    direction (catalog name a prefix of the recipe name) is dropped — it mismatches short
    catalog names against longer recipe names. Deterministic (sorted)."""
    n = name.lower()
    if n in name2id:
        return name2id[n]
    for k in sorted(name2id):
        if k.startswith(n):
            return name2id[k]
    return None


def _describe_params(binp: str, plugin_ids: set, session_dir: Optional[str], timeout_s: int) -> dict:
    """{pluginId: {param_name_lower: index}} by loading each synth once + describe_plugin.

    Association is POSITIONAL (describe_plugin doesn't echo the pluginId), so we keep EVERY
    describe_plugin result — including ok:false (a failed load → no-plugin describe) — to
    preserve the 1:1 order with `ids`. Filtering to ok-only would shift the zip and bind a
    param map to the wrong plugin. ids is sorted for determinism."""
    out: dict = {}
    ids = sorted(plugin_ids)
    cmds = []
    for k, pid in enumerate(ids):
        cmds += [
            {"command": "create_track", "args": {"name": f"probe{k}", "type": "audio"},
             "capture": {f"P{k}": "trackId"}},
            {"command": "load_plugin", "args": {"trackId": f"${{P{k}}}", "pluginId": pid, "index": 0}},
            {"command": "describe_plugin", "args": {"trackId": f"${{P{k}}}", "index": 0, "limit": 1024}},
        ]
    results = _run_capture(binp, cmds, session_dir, timeout_s)
    desc = [r for r in results if r.get("command") == "describe_plugin"]
    if len(desc) != len(ids):
        # one describe result per probe is expected even on failure; if the count is off the
        # positional mapping is unsafe → degrade to empty maps (params land in unresolved).
        return {pid: {} for pid in ids}
    for pid, r in zip(ids, desc):
        out[pid] = ({p["name"].lower(): p["index"] for p in (r.get("data") or {}).get("params", [])}
                    if r.get("ok") else {})
    return out


def resolve_synths(commands: list, recipe, binp: str, session_dir: Optional[str],
                   timeout_s: int) -> tuple[list, int, int, list, list]:
    """Inject load_plugin (resolve id by name) + set_plugin_param (map patch param NAMES→
    indices via describe_plugin) after each synth element's create_track. Returns
    (commands, synths_loaded, params_set, unresolved_params, loaded_element_ids). Needs
    describe_plugin."""
    synth_idx = {i for i, e in enumerate(recipe.elements)
                 if e.synth_patch.plugin.name and e.synth_patch.status in
                 ("params_visible", "matched", "substituted")}
    if not synth_idx:
        return commands, 0, 0, [], []

    name2id = _list_instruments(binp, session_dir, timeout_s)
    resolved = {}
    for i in synth_idx:
        pid = _resolve_plugin_id(recipe.elements[i].synth_patch.plugin.name, name2id)
        if pid:
            resolved[i] = pid
    pmaps = _describe_params(binp, set(resolved.values()), session_dir, timeout_s) if resolved else {}

    out: list = []
    n_load = n_set = 0
    unresolved: list = []
    for c in commands:
        out.append(c)
        if c.get("command") == "create_track" and c.get("capture"):
            tvar = next(iter(c["capture"]))
            m = re.match(r"^T(\d+)$", tvar)
            if not m:
                continue
            i = int(m.group(1))
            if i not in resolved:
                continue
            pid = resolved[i]
            tref = f"${{{tvar}}}"
            out.append({"command": "load_plugin",
                        "args": {"trackId": tref, "pluginId": pid, "index": 0}})
            n_load += 1
            pmap = pmaps.get(pid, {})
            for pname, pval in (recipe.elements[i].synth_patch.params or {}).items():
                idx = pmap.get(str(pname).lower())
                # set_plugin_param treats value as NORMALIZED 0..1 and clamps. A §5b read may
                # carry a denormalized real (e.g. cutoff in Hz) → silently clamped-to-1 = wrong.
                # Only apply values already in [0,1]; out-of-range / unmapped → unresolved.
                if idx is None:
                    unresolved.append({"element_id": recipe.elements[i].element_id,
                                       "param": pname, "reason": "param name not on plugin"})
                elif not (isinstance(pval, (int, float)) and 0.0 <= float(pval) <= 1.0):
                    unresolved.append({"element_id": recipe.elements[i].element_id,
                                       "param": pname, "reason": f"value {pval!r} not normalized [0,1]"})
                else:
                    out.append({"command": "set_plugin_param",
                                "args": {"trackId": tref, "index": 0, "paramIndex": idx,
                                         "value": float(pval)}})
                    n_set += 1
    loaded_ids = [recipe.elements[i].element_id for i in resolved]
    return out, n_load, n_set, unresolved, loaded_ids


def _ok_by_command(results: list) -> dict:
    """command name → count of successful results."""
    counts: dict = {}
    for r in results:
        if r.get("ok"):
            counts[r.get("command")] = counts.get(r.get("command"), 0) + 1
    return counts


def yield_actual(recipe, results: list, notes_resolved: int, nonsilent: bool) -> dict:
    """Measured per-category yield ∈ [0,1] from what actually landed. Honest: gated by a
    non-silent render so a clean-applying-but-silent edit doesn't score high."""
    els = recipe.elements
    drum_els = [e for e in els if e.role.value in DRUM_ROLES]
    midi_els = [e for e in els if e.midi.status in ("extracted", "partial") and e.midi.midi_ref]
    synth_els = [e for e in els if e.synth_patch.plugin.name]

    ok = _ok_by_command(results)
    tracks_made = ok.get("create_track", 0)
    samples_placed = ok.get("import_clip", 0)
    midi_clips = ok.get("add_midi_clip", 0)

    def frac(a, b):
        return float(min(1.0, a / b)) if b else 0.0

    g = 1.0 if nonsilent else 0.0
    # drums: a drum element lands when its matched sample imports (drum samples are placed
    # as audio clips). Fall back to the global sample-placement count over drum elements.
    drums = frac(samples_placed, max(1, len(drum_els))) * g if drum_els else 0.0
    midi = frac(notes_resolved, len(midi_els)) * g if midi_els else 0.0
    # synth param mapping is deferred → a loaded-but-unparameterized synth is partial credit
    synth = (frac(ok.get("load_plugin", 0), len(synth_els)) * 0.5 * g) if synth_els else 0.0
    arrangement = frac(tracks_made, len(els)) * g if els else 0.0

    present = [v for v, has in ((drums, drum_els), (midi, midi_els),
                                (synth, synth_els), (arrangement, els)) if has]
    overall = float(round(sum(present) / len(present), 4)) if present else 0.0
    return {"drums": round(drums, 4), "midi": round(midi, 4), "synth": round(synth, 4),
            "arrangement": round(arrangement, 4), "overall": overall}


def reconstruction_class_for(recipe, ya: dict, unresolved: list) -> str:
    """deterministic (high screen-read yield, nothing deferred) / inferred (leaned on
    extraction/refine) / partial (holes). Mirrors §0's definition."""
    from teardown.recipe import ReconstructionClass
    if ya.get("overall", 0) >= 0.85 and not unresolved:
        return ReconstructionClass.deterministic
    if ya.get("overall", 0) >= 0.4:
        return ReconstructionClass.inferred
    return ReconstructionClass.partial


def _measure(out: Path) -> tuple[float, bool]:
    if not out.exists() or out.stat().st_size == 0:
        return 0.0, False
    import soundfile as sf
    data, _sr = sf.read(str(out), dtype="float32", always_2d=True)
    y = data.mean(axis=1)
    rms = float(np.sqrt(np.mean(y.astype(np.float64) ** 2))) if y.size else 0.0
    return rms, rms > 1e-4


def execute_recipe(recipe, bin_path: Optional[str] = None, out_wav: Optional[str] = None,
                   asset_root: Optional[str] = None, session_dir: Optional[str] = None,
                   timeout_s: int = 300, write_back: bool = True,
                   resolve_synth_patches: bool = True) -> ExecuteResult:
    """Compile → resolve MIDI → (resolve synths via describe_plugin) → run through MoshOps →
    render → measure yield. Writes recipe.yield.actual + reconstruction_class (write_back).
    Needs the built binary."""
    binp = _bin(bin_path)
    cr = compile_recipe(recipe)
    cmds, midi_resolved_ids = inline_midi(list(cr.commands), recipe, asset_root)
    notes_resolved = len(midi_resolved_ids)

    work = Path(session_dir) if session_dir else Path(tempfile.mkdtemp(prefix="td-execute-"))
    work.mkdir(parents=True, exist_ok=True)
    out = Path(out_wav) if out_wav else work / "render.wav"

    res = ExecuteResult(unresolved=list(cr.unresolved), out_wav=str(out),
                        notes_resolved=notes_resolved)
    if not os.path.isfile(binp):
        res.commands = cmds + [{"command": "export_audio", "args": {"file": str(out)}}]
        res.error = f"Mosh binary not found at {binp!r} (set MOSH_BIN)"
        return res

    # resolve synths (needs the binary: list_plugins + describe_plugin probes)
    synth_unres: list = []
    synth_loaded_ids: list = []
    if resolve_synth_patches:
        cmds, res.synths_loaded, res.synth_params_set, synth_unres, synth_loaded_ids = resolve_synths(
            cmds, recipe, binp, str(work), timeout_s)

    # RESIDUAL unresolved = compile deferrals execute did NOT handle + synth param misses.
    # (compile.py always defers MIDI notes + synth load; execute resolves them here, so the
    # stale compile list must not be what gates reconstruction_class — else `deterministic`
    # is unreachable for any MIDI/synth recipe.)
    handled = set(midi_resolved_ids) | set(synth_loaded_ids)
    residual = [u for u in cr.unresolved if u.get("element_id") not in handled] + synth_unres
    res.unresolved = residual

    cmds = cmds + [{"command": "export_audio", "args": {"file": str(out)}}]
    res.commands = cmds

    script = work / "rollout.jsonl"
    results_path = work / "results.jsonl"
    script.write_text("\n".join(json.dumps(c) for c in cmds) + "\n")
    env = dict(os.environ, MOSH_RUN_SCRIPT=str(script), MOSH_RUN_SCRIPT_OUT=str(results_path),
               MOSH_SESSION_DIR=str(work))
    proc = subprocess.run([binp, "--run-script"], env=env, capture_output=True, text=True,
                          timeout=timeout_s, check=False)
    res.ran = True
    if results_path.exists():
        res.results = [json.loads(ln) for ln in results_path.read_text().splitlines() if ln.strip()]
    if proc.returncode != 0:
        res.error = f"render had {proc.returncode} failed command(s): {(proc.stderr or '')[-300:]!r}"

    res.audio_rms, res.nonsilent = _measure(out)
    res.yield_actual = yield_actual(recipe, res.results, notes_resolved, res.nonsilent)

    if write_back:
        from teardown.recipe import YieldScores
        recipe.yield_.actual = YieldScores(**res.yield_actual)
        recipe.reconstruction_class = reconstruction_class_for(recipe, res.yield_actual, residual)
    return res
