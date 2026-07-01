#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(SERVICE))

from teardown.catalog import TutorialCatalog
from teardown.jobs import build_teardown_jobs, write_jobs
from teardown.scout import (
    ScoutPolicy,
    TutorialCandidate,
    TutorialProbe,
    build_scout_system_prompt,
    load_template_bank,
    rank_tutorials,
)
from teardown.cli import _read_api_key_file, main as scout_cli_main


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise AssertionError(name)


def main() -> int:
    bank = load_template_bank()
    check("template bank loaded", len(tuple(bank)) >= 10, str([template.id for template in bank]))
    check("template bank includes serum", bank.by_id("serum-from-scratch") is not None)
    check("template bank includes vital sound design", bank.by_id("vital-sound-design") is not None)
    bad_text = "Serum tutorial sample pack preset pack shorts stream reaction"
    check("false-positive exclusions reject bad serum text", len(bank.search_templates(bad_text)) == 0, str([t.id for t in bank.search_templates(bad_text)]))

    prompt = build_scout_system_prompt(ScoutPolicy())
    check("prompt mentions serum/vital", "Serum" in prompt and "Vital" in prompt, prompt)
    check("prompt mentions plugin chain", "plugin chain" in prompt.lower(), prompt)

    candidates = [
        TutorialCandidate(
            video_id="ideal-1",
            url="https://www.youtube.com/watch?v=ideal-1",
            title="Serum tutorial from scratch with full plugin chain",
            channel="Tutor One",
            description="00:00 intro\n00:42 serum part\n01:10 plugin chain",
            duration_s=900,
            tags=("serum", "from scratch", "tutorial"),
            license="creativeCommon",
            template_id="serum-from-scratch",
            chapters=("00:00 intro", "00:42 serum part", "01:10 plugin chain"),
            has_captions=True,
            probe=TutorialProbe(
                daw_visible=True,
                piano_roll_visible=True,
                synth_gui_visible=True,
                plugin_chain_visible=True,
                serum_visible=True,
                readable_preset=True,
                readable_knobs=True,
                visible_plugin_names=("Serum", "FabFilter Pro-Q 3"),
                extra_synths=(),
                evidence=({"type": "frame", "note": "clear synth GUI"},),
            ),
        ),
        TutorialCandidate(
            video_id="usable-1",
            url="https://www.youtube.com/watch?v=usable-1",
            title="Vital beat breakdown tutorial",
            channel="Tutor Two",
            description="0:00 intro\n0:35 chords\n1:05 chain overview",
            duration_s=780,
            tags=("vital", "tutorial", "breakdown"),
            license="youtube",
            template_id="vital-from-scratch",
            chapters=("0:00 intro", "0:35 chords", "1:05 chain overview"),
            has_captions=True,
            probe=TutorialProbe(
                daw_visible=True,
                piano_roll_visible=False,
                synth_gui_visible=True,
                plugin_chain_visible=True,
                vital_visible=True,
                readable_preset=True,
                readable_knobs=False,
                visible_plugin_names=("Vital", "EQ"),
                extra_synths=("EQ",),
                evidence=({"type": "frame", "note": "good chain"},),
            ),
        ),
        TutorialCandidate(
            video_id="synth-focus-1",
            url="https://www.youtube.com/watch?v=synth-focus-1",
            title="Serum 2 for Absolute Beginners Guide",
            channel="Tutor Synth",
            description="Serum preset wavetable filter envelope guide",
            duration_s=1133,
            tags=("serum", "guide", "preset"),
            license="youtube",
            template_id="serum-preset-recreation",
            chapters=(),
            has_captions=False,
            probe=TutorialProbe(
                daw_visible=True,
                piano_roll_visible=False,
                synth_gui_visible=True,
                plugin_chain_visible=False,
                serum_visible=True,
                readable_preset=True,
                readable_knobs=False,
                visible_plugin_names=("Serum",),
                extra_synths=(),
                evidence=({"type": "frame", "note": "serum preset visible"},),
            ),
        ),
        TutorialCandidate(
            video_id="midi-only-1",
            url="https://www.youtube.com/watch?v=midi-only-1",
            title="Dark trap melody tutorial piano roll from scratch",
            channel="Tutor MIDI",
            description="0:00 intro\n0:45 melody piano roll\n1:15 pattern",
            duration_s=600,
            tags=("trap", "melody", "tutorial", "piano roll"),
            license="youtube",
            template_id="trap-piano-roll-808",
            chapters=("0:00 intro", "0:45 melody piano roll", "1:15 pattern"),
            has_captions=True,
            probe=TutorialProbe(
                daw_visible=True,
                piano_roll_visible=True,
                synth_gui_visible=False,
                plugin_chain_visible=False,
                serum_visible=False,
                vital_visible=False,
                readable_preset=False,
                readable_knobs=False,
                visible_plugin_names=(),
                extra_synths=(),
                evidence=({"type": "frame", "note": "maximized piano roll"},),
            ),
        ),
        TutorialCandidate(
            video_id="reject-1",
            url="https://www.youtube.com/watch?v=reject-1",
            title="Type beat cookup with Omnisphere",
            channel="Tutor Three",
            description="talking head sample pack links",
            duration_s=420,
            tags=("type beat", "sample pack"),
            license="unknown",
            template_id="from-scratch-beatmaking",
            chapters=(),
            has_captions=False,
            probe=TutorialProbe(
                daw_visible=False,
                piano_roll_visible=False,
                synth_gui_visible=False,
                plugin_chain_visible=False,
                serum_visible=False,
                vital_visible=False,
                readable_preset=False,
                readable_knobs=False,
                extra_synths=("Omnisphere",),
                visible_plugin_names=("Omnisphere",),
                evidence=(),
            ),
        ),
    ]

    scored = rank_tutorials(candidates, policy=ScoutPolicy(synth_policy="hybrid"))
    check("top candidate is ideal", scored[0].candidate.video_id == "ideal-1", scored[0].candidate.video_id)
    check("ideal candidate gets ideal label", scored[0].decision == "ideal", scored[0].decision)
    usable_decisions = {item.candidate.video_id: item.decision for item in scored}
    check("chain-backed candidate stays usable or ideal", usable_decisions["usable-1"] in {"ideal", "usable"}, usable_decisions["usable-1"])
    check("MIDI-only piano-roll candidate is accepted as an ingredient", usable_decisions["midi-only-1"] in {"usable", "weak"}, usable_decisions["midi-only-1"])
    midi_item = next(item for item in scored if item.candidate.video_id == "midi-only-1")
    check("MIDI-only candidate does not require Serum/Vital",
          "serum-or-vital:no" in midi_item.evidence_bundle and midi_item.yield_prediction.midi >= midi_item.yield_prediction.synth,
          str((midi_item.evidence_bundle, midi_item.yield_prediction.as_dict())))
    check("synth-focused candidate is usable without chain", usable_decisions["synth-focus-1"] == "usable", usable_decisions["synth-focus-1"])
    check("reject candidate is rejected or weak", scored[-1].decision in {"weak", "reject"}, scored[-1].decision)
    check("serum/vital candidate outranks reject", scored[0].score > scored[-1].score, f"{scored[0].score} > {scored[-1].score}")

    with tempfile.TemporaryDirectory() as tmp:
        catalog_path = Path(tmp) / "tutorial-catalog.sqlite"
        key_path = Path(tmp) / "yt api.rtf"
        fake_key = "AIza" + "A" * 32
        key_path.write_text(r"{\rtf1\ansi " + fake_key + "}", encoding="utf-8")
        parsed_key = _read_api_key_file(str(key_path))
        check("rtf api key parser finds key", parsed_key == fake_key)
        check("scored payload does not contain key", fake_key not in json.dumps([item.as_record() for item in scored], sort_keys=True))
        catalog = TutorialCatalog(catalog_path)
        for item in scored:
            catalog.upsert(item, discovered_at="2026-06-30T00:00:00Z", screened_at="2026-06-30T00:01:00Z")
        rows = catalog.list(limit=10)
        check("catalog persisted rows", len(rows) == 5, str(rows))
        check("catalog top row matches score order", rows[0]["video_id"] == "ideal-1", rows[0]["video_id"])
        jobs = build_teardown_jobs(rows, checkpoint_root=Path(tmp) / "checkpoints")
        check("job export keeps ideal and usable rows", len(jobs) == 4, json.dumps(jobs, sort_keys=True))
        check("job export avoids recrawl", all(job["resume"]["requires_recrawl"] is False for job in jobs), json.dumps(jobs, sort_keys=True))
        jobs_path = Path(tmp) / "jobs.jsonl"
        check("job jsonl written", write_jobs(jobs_path, jobs) == 4 and jobs_path.exists(), str(jobs_path))
        summary = catalog.summary()
        check("catalog summary counts", summary["total"] == 5 and summary["by_status"].get("ideal", 0) == 1 and summary["by_status"].get("usable", 0) >= 3, json.dumps(summary, sort_keys=True))
        rescored_path = Path(tmp) / "rescored.sqlite"
        check("rescore-catalog exits 0",
              scout_cli_main(["rescore-catalog", "--catalog", str(catalog_path), "--out-catalog", str(rescored_path)]) == 0)
        rescored_summary = TutorialCatalog(rescored_path).summary()
        check("rescore-catalog preserves row count", rescored_summary["total"] == 5, json.dumps(rescored_summary, sort_keys=True))
        check("rescore-catalog rewrites out-catalog on rerun",
              scout_cli_main(["rescore-catalog", "--catalog", str(catalog_path),
                              "--out-catalog", str(rescored_path), "--limit", "1"]) == 0
              and TutorialCatalog(rescored_path).summary()["total"] == 1)
        catalog.update_status("ideal-1", "reject")
        reprioritized = catalog.list(limit=4)
        first_reject = next(index for index, row in enumerate(reprioritized) if row["status"] == "reject")
        usable_indexes = [index for index, row in enumerate(reprioritized) if row["status"] == "usable"]
        check("catalog prioritizes queued statuses before rejects", usable_indexes and max(usable_indexes) < first_reject, json.dumps(reprioritized, sort_keys=True))

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
