#!/usr/bin/env python3
from __future__ import annotations

import dataclasses
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping

HERE = Path(__file__).resolve().parent
SERVICE = HERE.parent
sys.path.insert(0, str(SERVICE))

from teardown.catalog import TutorialCatalog
from teardown.frame_verify import FrameVerifier
from teardown.scout import ScoutPolicy, TutorialProbe, TutorialTemplate, rank_tutorials
from teardown.youtube import YouTubeDataClient


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        raise AssertionError(name)


class FakeTransport:
    def __init__(self) -> None:
        self.calls: list[tuple[str, Mapping[str, Any]]] = []

    def __call__(self, endpoint: str, params: Mapping[str, Any]) -> dict[str, Any]:
        self.calls.append((endpoint, dict(params)))
        if endpoint == "search":
            query = str(params.get("q", "")).lower()
            if "serum" in query:
                return {
                    "items": [
                        {
                            "id": {"videoId": "ideal-serum"},
                            "snippet": {
                                "title": "Serum from scratch tutorial full plugin chain",
                                "description": "00:00 intro\n00:30 piano roll\n01:00 Serum preset filter envelope",
                                "channelTitle": "Tutor A",
                            },
                        },
                        {
                            "id": {"videoId": "weak-pack"},
                            "snippet": {
                                "title": "Serum preset pack download",
                                "description": "sample pack giveaway shorts",
                                "channelTitle": "Pack Seller",
                            },
                        },
                    ]
                }
            return {
                "items": [
                    {
                        "id": {"videoId": "usable-vital"},
                        "snippet": {
                            "title": "Vital beat breakdown tutorial plugin chain",
                            "description": "00:00 intro\n00:40 Vital patch\n01:20 mixer chain",
                            "channelTitle": "Tutor B",
                        },
                    }
                ]
            }
        if endpoint == "videos":
            ids = str(params.get("id", "")).split(",")
            items = []
            for video_id in ids:
                if video_id == "ideal-serum":
                    items.append(_video(video_id, "Serum from scratch tutorial full plugin chain", "00:00 intro\n00:30 piano roll\n01:00 Serum preset filter envelope", ["serum", "tutorial", "plugin chain"], "PT12M", "true", "creativeCommon"))
                elif video_id == "usable-vital":
                    items.append(_video(video_id, "Vital beat breakdown tutorial plugin chain", "00:00 intro\n00:40 Vital patch\n01:20 mixer chain", ["vital", "tutorial"], "PT8M30S", "true", "youtube"))
                elif video_id == "weak-pack":
                    items.append(_video(video_id, "Serum preset pack download", "sample pack giveaway shorts", ["preset pack"], "PT1M", "false", "youtube"))
            return {"items": items}
        return {"items": []}


class FakeVerifier:
    def verify(self, video_id: str, url: str, cache_dir: str, duration_s: int | None = None, title: str = "", description: str = "", tags=()) -> TutorialProbe:
        if video_id == "ideal-serum":
            return TutorialProbe(
                daw_visible=True,
                piano_roll_visible=True,
                synth_gui_visible=True,
                plugin_chain_visible=True,
                serum_visible=True,
                readable_preset=True,
                readable_knobs=True,
                visible_plugin_names=("Serum", "EQ"),
                evidence=({"type": "frame", "ref": "mock-frame.jpg"},),
            )
        if video_id == "usable-vital":
            return TutorialProbe(
                daw_visible=True,
                piano_roll_visible=False,
                synth_gui_visible=True,
                plugin_chain_visible=True,
                vital_visible=True,
                readable_preset=True,
                visible_plugin_names=("Vital",),
                evidence=({"type": "frame", "ref": "mock-vital.jpg"},),
            )
        return TutorialProbe(extra_synths=("Omnisphere",), visible_plugin_names=("Omnisphere",))


def _video(video_id: str, title: str, description: str, tags: list[str], duration: str, caption: str, license_name: str) -> dict[str, Any]:
    return {
        "id": video_id,
        "snippet": {
            "title": title,
            "description": description,
            "channelTitle": "Mock Channel",
            "tags": tags,
        },
        "contentDetails": {
            "duration": duration,
            "caption": caption,
        },
        "status": {
            "license": license_name,
        },
    }


def main() -> int:
    transport = FakeTransport()
    client = YouTubeDataClient(transport=transport)
    templates = (
        TutorialTemplate(id="serum-test", query="Serum tutorial plugin chain", include=("serum",), weight=1.0),
        TutorialTemplate(id="vital-test", query="Vital tutorial plugin chain", include=("vital",), weight=1.0),
    )
    candidates = []
    verifier = FakeVerifier()
    with tempfile.TemporaryDirectory() as tmp:
        for template in templates:
            for hit in client.discover(template, max_results=2):
                candidate = hit.to_candidate(template.id)
                probe = verifier.verify(candidate.video_id, candidate.url, tmp, candidate.duration_s, candidate.title, candidate.description, candidate.tags)
                candidates.append(dataclasses.replace(candidate, probe=probe))

        check("mock search calls made", sum(1 for endpoint, _ in transport.calls if endpoint == "search") == 2, str(transport.calls))
        check("mock video enrichment calls made", any(endpoint == "videos" for endpoint, _ in transport.calls), str(transport.calls))
        check("fields requested", all("fields" in params for _, params in transport.calls), str(transport.calls))
        ideal = next(candidate for candidate in candidates if candidate.video_id == "ideal-serum")
        check("duration parsed", ideal.duration_s == 720, str(ideal.duration_s))
        check("tags enriched", "serum" in ideal.tags, str(ideal.tags))
        check("captions enriched", ideal.has_captions is True)
        check("license enriched", ideal.license == "creativeCommon", ideal.license)

        scored = rank_tutorials(candidates, policy=ScoutPolicy())
        check("ideal ranks first", scored[0].candidate.video_id == "ideal-serum", scored[0].candidate.video_id)
        check("weak ranks last", scored[-1].candidate.video_id == "weak-pack", scored[-1].candidate.video_id)

        catalog = TutorialCatalog(Path(tmp) / "catalog.sqlite")
        for item in scored:
            catalog.upsert(item)
        rows = catalog.list(limit=3)
        check("catalog row order follows ranking", rows[0]["video_id"] == "ideal-serum", json.dumps(rows, sort_keys=True))
        check("catalog persisted all candidates", len(rows) == 3, str(len(rows)))

    print("ALL PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
