from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import recipe_source_intake as intake


FIXTURES = HERE / "fixtures" / "recipe_source_cards"


def read_card(name: str) -> intake.CandidateCard:
    path = FIXTURES / name
    return intake.load_candidate_card(path)


def check(label: str, ok: bool, failures: list[str]) -> None:
    print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    if not ok:
        failures.append(label)


def main() -> int:
    failures: list[str] = []

    valid = read_card("valid_tutorial_card.md")
    valid_errors = intake.validate_candidate_card(valid)
    check("valid fixture passes", valid_errors == [], failures)
    summary = valid.safe_summary()
    check("safe summary redacts evidence path", summary.get("local_evidence") == "outside-repo", failures)
    check("safe summary keeps score and decision", summary["total_score"] == 17 and summary["decision"] == "candidate", failures)
    check("safe index line is concise", "outside-repo" not in valid.safe_index_line(), failures)

    media = read_card("invalid_embedded_media_card.md")
    media_errors = intake.validate_candidate_card(media)
    check("embedded media is rejected", any("unsafe payload" in err for err in media_errors), failures)
    check("repo-local evidence is rejected", any("local_evidence_path must stay outside the repo" in err for err in media_errors), failures)

    transcript = read_card("invalid_transcript_card.md")
    transcript_errors = intake.validate_candidate_card(transcript)
    check("transcript-like payload is rejected", any("unsafe payload" in err for err in transcript_errors), failures)

    index_payload = json.loads(json.dumps([valid.safe_summary()]))
    check("index payload omits raw evidence paths", "local_evidence_path" not in index_payload[0], failures)
    check("index payload preserves rubric scores", index_payload[0]["score"]["rights and handling"] == 3, failures)

    print(f"\n{'OK' if not failures else 'FAILED'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
