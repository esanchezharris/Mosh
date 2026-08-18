from __future__ import annotations

import json
import os
import sys
import tempfile
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

    # --- Task 2: SourceCardV1 projection ---

    projected = intake.project_skill_source(valid)
    check("schema", projected["schemaVersion"] == 1, failures)
    check("claim ceiling", len(projected["claims"]) <= 10, failures)
    check("legacy summary", valid.safe_summary()["total_score"] == 17, failures)
    check("projected source card id", projected["sourceCardId"] == "yt-dark-trap-808-walkthrough-001", failures)
    check("projected rights", projected["rights"] == "official_public_documentation", failures)
    check("projected acquisition", projected["acquisition"] == "official_https_page", failures)
    check("projected claim count matches fixture", len(projected["claims"]) == 3, failures)
    check("snapshot hash is 64 lowercase hex", intake.HEX64_PATTERN.fullmatch(projected["sourceSnapshotSha256"]) is not None, failures)

    # snapshot hash excludes reviewer/timestamps/dependencies/state: changing them must not
    # change the hash, so unchanged evidence can extend freshness via a later reviewer sign-off.
    reprojected_same_snapshot = intake.project_skill_source(
        intake.CandidateCard(
            path=valid.path,
            fields={**valid.fields, "reviewer": "someone-else", "reviewed_at": "2030-01-01T00:00:00Z"},
            scores=valid.scores,
            total_score=valid.total_score,
            raw_text=valid.raw_text,
            claims=valid.claims,
        )
    )
    check(
        "snapshot hash excludes reviewer/timestamps",
        reprojected_same_snapshot["sourceSnapshotSha256"] == projected["sourceSnapshotSha256"],
        failures,
    )

    # unknown/unresolved rights and unofficial/scraped acquisition fail closed rather than
    # being silently coerced or projected.
    bad_rights_card = intake.CandidateCard(
        path=None,
        fields={**valid.fields, "rights": "scraped-unofficial"},
        scores=valid.scores,
        total_score=valid.total_score,
        raw_text=valid.raw_text,
        claims=valid.claims,
    )
    try:
        intake.project_skill_source(bad_rights_card)
        check("unresolved rights is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("unresolved rights is rejected", any("rights" in e for e in exc.errors), failures)

    bad_acquisition_card = intake.CandidateCard(
        path=None,
        fields={**valid.fields, "acquisition": "unofficial_scrape"},
        scores=valid.scores,
        total_score=valid.total_score,
        raw_text=valid.raw_text,
        claims=valid.claims,
    )
    try:
        intake.project_skill_source(bad_acquisition_card)
        check("unofficial acquisition is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("unofficial acquisition is rejected", any("acquisition" in e for e in exc.errors), failures)

    # duplicate claim IDs fail closed.
    dup_claim = intake.ClaimRow(claim_id="c1", origin="source_text", workflow_moment="x", paraphrase="y", boundary="z")
    dup_card = intake.CandidateCard(
        path=None,
        fields=valid.fields,
        scores=valid.scores,
        total_score=valid.total_score,
        raw_text=valid.raw_text,
        claims=[dup_claim, dup_claim],
    )
    try:
        intake.project_skill_source(dup_card)
        check("duplicate claim id is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("duplicate claim id is rejected", any("duplicate claim id" in e for e in exc.errors), failures)

    # eleven claims exceed the ten-claim ceiling.
    eleven_claims = [
        intake.ClaimRow(claim_id=f"c{i}", origin="source_text", workflow_moment="m", paraphrase="p", boundary="b")
        for i in range(11)
    ]
    eleven_card = intake.CandidateCard(
        path=None,
        fields=valid.fields,
        scores=valid.scores,
        total_score=valid.total_score,
        raw_text=valid.raw_text,
        claims=eleven_claims,
    )
    try:
        intake.project_skill_source(eleven_card)
        check("eleven claims is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("eleven claims is rejected", any("claim ceiling exceeded" in e for e in exc.errors), failures)

    # zero claims also fails closed (below the one-claim floor).
    zero_card = intake.CandidateCard(
        path=None, fields=valid.fields, scores=valid.scores, total_score=valid.total_score, raw_text=valid.raw_text, claims=[]
    )
    try:
        intake.project_skill_source(zero_card)
        check("zero claims is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("zero claims is rejected", any("at least one claim" in e for e in exc.errors), failures)

    # embedded media and hidden-transcript fixtures reject at the NEW skill-source layer too
    # (via their Claims table), independent of the legacy rubric checks above.
    media_projection_errors: list[str] = []
    try:
        intake.project_skill_source(media)
        check("embedded media rejected by skill-source projection", False, failures)
    except intake.SkillSourceProjectionError as exc:
        media_projection_errors = exc.errors
        check("embedded media rejected by skill-source projection", any("unsafe payload" in e for e in exc.errors), failures)

    try:
        intake.project_skill_source(transcript)
        check("hidden transcript rejected by skill-source projection", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("hidden transcript rejected by skill-source projection", any("unsafe payload" in e for e in exc.errors), failures)

    # unsafe source-id characters (path-traversal defence: this ID becomes a path component
    # downstream in the TypeScript CLI) fail closed before any claim is even inspected.
    unsafe_id_card = intake.CandidateCard(
        path=None,
        fields={**valid.fields, "source_id": "../etc/passwd"},
        scores=valid.scores,
        total_score=valid.total_score,
        raw_text=valid.raw_text,
        claims=valid.claims,
    )
    try:
        intake.project_skill_source(unsafe_id_card)
        check("unsafe source id is rejected", False, failures)
    except intake.SkillSourceProjectionError as exc:
        check("unsafe source id is rejected", any("invalid source card id" in e for e in exc.errors), failures)

    # --- file-level admission: symlink / FIFO / oversized / round-trip via project-skill-source ---

    with tempfile.TemporaryDirectory() as tmp_name:
        tmp_dir = Path(tmp_name)

        real_card_path = tmp_dir / "real_card.md"
        real_card_path.write_text(valid.raw_text, encoding="utf-8")

        # NOTE: the temp filename deliberately avoids the substring "symlink" — an earlier
        # version named it "symlink_card.md" and the loose `"symlink" in e` check kept
        # passing even with the dedicated symlink guard deleted, because the rejection
        # message embeds the (rejected) file's own path. Asserting the exact guard phrase
        # against a neutrally-named path is what actually proves the guard fired.
        link_path = tmp_dir / "sl_card.md"
        link_path.symlink_to(real_card_path)
        try:
            intake.project_skill_source_from_path(link_path)
            check("symlink source card is rejected", False, failures)
        except intake.SkillSourceProjectionError as exc:
            check(
                "symlink source card is rejected",
                any("must not be a symlink" in e for e in exc.errors),
                failures,
            )

        fifo_path = tmp_dir / "fifo_card.md"
        os.mkfifo(fifo_path)
        try:
            intake.project_skill_source_from_path(fifo_path)
            check("FIFO source card is rejected", False, failures)
        except intake.SkillSourceProjectionError as exc:
            check("FIFO source card is rejected", any("regular file" in e for e in exc.errors), failures)

        oversized_path = tmp_dir / "oversized_card.md"
        oversized_path.write_bytes(b"#" + b"x" * (intake.MAX_SKILL_SOURCE_CARD_BYTES))
        try:
            intake.project_skill_source_from_path(oversized_path)
            check("1 MiB + 1 source card is rejected", False, failures)
        except intake.SkillSourceProjectionError as exc:
            check("1 MiB + 1 source card is rejected", any("exceeds" in e for e in exc.errors), failures)

        exact_cap_path = tmp_dir / "exact_cap_card.md"
        padding = intake.MAX_SKILL_SOURCE_CARD_BYTES - len(valid.raw_text.encode("utf-8"))
        exact_cap_path.write_text(valid.raw_text + ("\n" * max(padding, 0))[: max(padding, 0)], encoding="utf-8")
        check(
            "exactly-at-cap source card is admitted",
            len(exact_cap_path.read_bytes()) <= intake.MAX_SKILL_SOURCE_CARD_BYTES,
            failures,
        )

        # --out round-trip through the atomic writer
        out_path = tmp_dir / "out" / "source.json"
        out_path.parent.mkdir(parents=True)
        written = intake.project_skill_source_from_path(real_card_path)
        intake.write_json_atomic(out_path, written)
        round_tripped = json.loads(out_path.read_text(encoding="utf-8"))
        check("write_json_atomic round-trips the projection", round_tripped == written, failures)
        check(
            "write_json_atomic leaves no temp file behind",
            not any(p.name.startswith(".") for p in out_path.parent.iterdir() if p != out_path),
            failures,
        )

    print(f"\n{'OK' if not failures else 'FAILED'}: {len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
