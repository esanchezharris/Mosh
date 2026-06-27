#!/usr/bin/env python3
"""Generate docs/FEATURE_AUDIT.md — the present-tense DAW-parity scoreboard.

Reads scripts/daw-conformance/report.json (produced by conformance.py against the current
binary) and renders a trustworthy dashboard that SUPERSEDES the stale 2026-06-09 baseline
audit. Re-runnable: `python3 scripts/daw-conformance/conformance.py && python3 scripts/daw-conformance/scoreboard.py`.

The curated parity backlog (G1–G14) below is the single source for both this scoreboard and
the auto-loop backlog seed — each gap maps to a reality-pack invariant + an eval-suite area.
"""
import json
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
REPORT = REPO / "scripts" / "daw-conformance" / "report.json"
OUT = REPO / "docs" / "FEATURE_AUDIT.md"

# Curated conventional-parity backlog (conventional scope; superset of the conformance gaps
# plus the "stranded backend" surface gaps found in the current-code audit). tier: must/should/nice.
# klass: cheap (ui-only) | native (MoshOps/engine). status reflects current main.
BACKLOG = [
    ("G5",  "Sends / returns / bus UI + agent catalog", "should", "cheap",
     "Backend real (create_bus/add_send/set_send_level in MoshOps); no UI, absent from agent catalog.", "inv 59"),
    ("G6",  "Tempo / time-sig / metronome GUI controls", "should", "cheap",
     "set_tempo/set_time_signature/set_metronome exist + in agent catalog; Topbar shows them read-only.", "inv 6,7"),
    ("G8",  "Per-track output / multi-out routing UI", "should", "cheap",
     "set_track_output/list_track_outputs real; loadRouting() orphaned in store; no picker.", "inv 19"),
    ("G9",  "Audio warp / time-stretch GUI", "should", "cheap",
     "set_clip_warp + autoTempo/stretchMode serialized; no control to engage it.", "inv 24(matrix)"),
    ("G3",  "Audio device + per-track input picker UI", "must", "cheap",
     "set_audio_device/set_track_input/list_wave_inputs exist; Settings exposes only buffer/threads.", "inv 16,41"),
    ("G1",  "Export range/section + delay-tail policy", "must", "native",
     "export_audio hardcodes {0,getLength()} over all tracks; no range arg, no tail policy.", "inv 78,81"),
    ("G7",  "Stem export (per-track, common zero point)", "should", "native",
     "All tracks render to one file; no per-track stem path.", "inv 84"),
    ("G4",  "Clip inspector (gain/mute/rename) + clip fades", "must", "native",
     "set_clip_gain/mute/rename agent-only; NO fade command exists; Inspector is track-only.", "inv 27,29,30"),
    ("G2",  "Recording count-in / pre-roll + mic-permission UX", "must", "native",
     "No count-in token anywhere; record degrades to a silent no-op with no permission surface.", "inv 5,41,45,49"),
    ("G14", "set_track_volume / pan undo restores prior value", "must", "native",
     "DISCOVERED: vp->setVolumeDb() bypasses the UndoManager → empty txn; undo does not revert (logs undoable:true).", "inv 97"),
    ("G11", "MIDI-input picker + live-monitor surface", "nice", "cheap",
     "list_midi_inputs unreferenced in UI.", "inv 47"),
    ("G13", "Missing-media on-load banner", "nice", "cheap",
     "clipToVar.sourceMissing emitted + relink exists; verify a clear load-time banner.", "inv 71,117"),
    ("G10", "Automation depth (write/touch/latch modes)", "nice", "native",
     "Point-draw only; no record-knob / mode / multi-target conflict policy.", "inv 63,64"),
    ("G12", "Comping promote-to-main UX", "nice", "native",
     "Take swap only; no visual comping / promote.", "inv (comping)"),
]

STATUS_LABEL = {"pass": "✅ pass", "fail": "❌ FAIL", "gap": "🟡 gap",
                "hardware": "🔌 hardware", "out-of-scope": "— out-of-scope"}


def main():
    rep = json.loads(REPORT.read_text())
    s = rep["summary"]["by_status"]
    total = rep["eval_total"]
    in_scope = total - s.get("out-of-scope", 0)

    L = []
    L.append("# Mosh — DAW Parity Scoreboard")
    L.append("")
    L.append(f"_Generated from a live conformance run against `{Path(rep['binary']).name}` "
             f"by `scripts/daw-conformance/conformance.py` + `scoreboard.py`._")
    L.append("")
    L.append("> **This supersedes the 2026-06-09 baseline audit.** That audit's JSON "
             "(`167 missing / 24 shipped`) was a point-in-time snapshot; ~20 feature waves and "
             "subsequent work landed on top of it, so it cannot be read as current. This page is "
             "regenerated from the gathered reality-pack eval suite replayed through the **real "
             "command surface** — it reflects what the code does *now*. The archived baseline "
             "lives in `docs/archive/feature-audit-2026-06-09/`.")
    L.append("")
    L.append("## Headline")
    L.append("")
    L.append(f"- **{s.get('pass',0)} / {in_scope} in-scope eval rows pass** "
             f"(~{round(100*s.get('pass',0)/in_scope)}%), proven headless (state / audio / undo asserted).")
    L.append(f"- **{s.get('gap',0)} gap** rows — real conventional-DAW gaps, tracked in the backlog below.")
    L.append(f"- **{s.get('hardware',0)} hardware** row — needs a live device (Phase-1 hardware pass).")
    L.append(f"- **{s.get('out-of-scope',0)} out-of-scope** rows — Monster / Arena / Collaboration "
             "(outside the conventional-parity pass).")
    L.append(f"- Scope: {rep['scope']}.")
    L.append("")

    L.append("## Parity by area (eval suite)")
    L.append("")
    L.append("| Area | pass | gap | hardware | out-of-scope |")
    L.append("|---|---|---|---|---|")
    for area, counts in rep["summary"]["by_area"].items():
        L.append(f"| {area} | {counts.get('pass',0)} | {counts.get('gap',0)} | "
                 f"{counts.get('hardware',0)} | {counts.get('out-of-scope',0)} |")
    L.append("")

    L.append("## Scenario verdicts")
    L.append("")
    L.append("| Area | Scenario | Status | Invariants | Notes |")
    L.append("|---|---|---|---|---|")
    for f in rep["families"]:
        det = f["detail"]
        note = det.get("note") or det.get("gap") or det.get("reason") or ""
        if "gap" in det and det.get("gap"):
            note = f"**{det['gap']}** — {det.get('note','')}"
        inv = ",".join(str(i) for i in f["invariants"]) or "—"
        L.append(f"| {f['area']} | {f['action']} | {STATUS_LABEL.get(f['status'], f['status'])} "
                 f"| {inv} | {note} |")
    L.append("")

    L.append("## Conventional-parity backlog (drives the auto-loop)")
    L.append("")
    L.append("Each item maps to a reality-pack invariant + eval-suite area. `cheap` = UI/agent "
             "wiring (auto-mergeable); `native` = MoshOps/engine. Items touching "
             "`src/engine/MoshEngine.*` or `src/state/**` land as `needs-human` PRs.")
    L.append("")
    L.append("| id | tier | class | Gap | Evidence | Invariants |")
    L.append("|---|---|---|---|---|---|")
    order = {"must": 0, "should": 1, "nice": 2}
    for gid, title, tier, klass, ev, inv in sorted(BACKLOG, key=lambda r: (order[r[2]], r[0])):
        L.append(f"| {gid} | {tier} | {klass} | {title} | {ev} | {inv} |")
    L.append("")

    L.append("## How this stays honest")
    L.append("")
    L.append("- `conformance.py` is wired into the native gate (`scripts/auto-loop/gate.sh`), so "
             "every merged native PR keeps the proven rows green; a parity fix flips its gap → pass.")
    L.append("- Audio/undo claims are asserted against real rendered WAVs and the real `snapshot()` "
             "(via the `__snapshot` run-script directive) — not against command return codes.")
    L.append("- Hardware-only behavior (mic capture, live meters, MIDI input, multi-out, loop "
             "playback) is confirmed in the Phase-1 hardware pass — see `docs/VERIFICATION.md`.")
    L.append("")

    OUT.write_text("\n".join(L) + "\n")
    print(f"wrote {OUT}  ({len(L)} lines)")


if __name__ == "__main__":
    main()
