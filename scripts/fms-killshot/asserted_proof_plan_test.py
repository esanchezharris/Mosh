from __future__ import annotations

import hashlib
import json
import re
import sys
import wave
from array import array
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from asserted_proof_plan import (  # noqa: E402
    PlanError,
    apply_articulation_heuristics,
    articulation_relaxed_plan,
    author_soulx_score,
    build_manifest,
    build_render_plan,
    flatten_corrected_words,
    repair_word_articulation_plan,
)
from asserted_proof_clip import contained_pairs  # noqa: E402
from asserted_proof_provenance import receipt_is_current, write_receipt  # noqa: E402
from asserted_proof_manifest import regenerate_manifest  # noqa: E402
from asserted_proof_page import _owner_passes_current_manifest  # noqa: E402
from asserted_proof_lexical import assemble_pcm16_mono, build_lexical_targets  # noqa: E402
from asserted_proof_voicebox import (  # noqa: E402
    VoiceboxClient,
    articulation_fit_duration,
    group_opening_targets,
    match_asserted_phrase,
    parse_generation_events,
    public_phrase_metadata,
    public_profile_metadata,
)
from asserted_proof_splice import splice_pcm16_mono  # noqa: E402
from asserted_proof_verdict import save_review_verdict, validate_owner_verdict, validate_review_verdict  # noqa: E402
from preview_server import load_current_verdict  # noqa: E402


def test_flatten_corrected_words_preserves_every_owner_mapping() -> None:
    corrected = {
        "words": [
            {"word": "Yeah,", "sourceIndex": 0, "deleted": False},
            {"word": "I need more of", "sourceIndex": 19, "deleted": False},
            {"word": "ignored", "sourceIndex": 20, "deleted": True},
            {"word": "Truman.", "sourceIndex": 124, "deleted": False},
        ]
    }

    tokens = flatten_corrected_words(corrected, split_word_idx=124)

    assert [row["text"] for row in tokens] == ["Yeah", "I", "need", "more", "of", "Truman"]
    assert [row["ownerId"] for row in tokens] == ["src-0-0", "src-19-0", "src-19-1", "src-19-2", "src-19-3", "src-124-0"]
    assert len({row["ownerId"] for row in tokens}) == len(tokens)


def test_render_plan_uses_measured_or_phrase_interpolated_pitch() -> None:
    tokens = [
        {"text": "Yeah", "normalized": "yeah", "ownerId": "src-0-0", "sourceIndex": 0},
        {"text": "Truman", "normalized": "truman", "ownerId": "src-124-0", "sourceIndex": 124},
    ]
    aligned = [
        {"word": "Yeah", "start": 0.3947, "end": 0.5602, "score": 0.8},
        {"word": "Truman", "start": 55.1126, "end": 55.34, "score": 0.7},
    ]
    pronunciations = {
        "yeah": ["Y", "AE1"],
        "truman": ["T", "R", "UW1", "M", "AH0", "N"],
    }
    f0 = [
        {"t": 0.42, "hz": 146.83},
        {"t": 55.14, "hz": 164.81},
        {"t": 55.27, "hz": 0.0},
    ]

    plan = build_render_plan(
        clip_id="first-half-continuous",
        clip_start=0.0,
        clip_end=55.6,
        tokens=tokens,
        aligned=aligned,
        pronunciations=pronunciations,
        f0=f0,
        envelope=[0.2] * 5600,
        envelope_hop_s=0.01,
    )

    assert plan["summary"]["lexicalTokens"] == 2
    assert plan["words"][-1]["start"] == pytest.approx(55.1126)
    assert plan["words"][-1]["end"] == pytest.approx(55.34)
    syllables = [syl for word in plan["words"] for syl in word["syllables"]]
    assert len({syl["id"] for syl in syllables}) == len(syllables)
    assert {syl["pitchProvenance"] for syl in syllables} <= {"measured", "interpolated"}
    assert all(syl["midiPitch"] != 69 for syl in syllables)


def test_score_author_refuses_placeholder_or_missing_phone_groups() -> None:
    plan = {
        "clip": {"id": "opening", "start": 0.35, "end": 1.0},
        "words": [
            {
                "text": "Yeah",
                "syllables": [
                    {
                        "id": "src-0-0-syl-0",
                        "start": 0.3947,
                        "end": 0.5602,
                        "phones": ["AH1"],
                        "midiPitch": 53,
                        "pitchProvenance": "measured",
                    }
                ],
            }
        ],
    }

    with pytest.raises(PlanError, match="placeholder phoneme"):
        author_soulx_score(plan, name="opening")


def test_octave_unwrap_tie_keeps_measured_register() -> None:
    tokens = [
        {"text": "one", "normalized": "one", "ownerId": "src-1-0", "sourceIndex": 1},
        {"text": "two", "normalized": "two", "ownerId": "src-2-0", "sourceIndex": 2},
    ]
    aligned = [
        {"word": "one", "start": 1.0, "end": 1.2, "score": 1.0},
        {"word": "two", "start": 1.2, "end": 1.4, "score": 1.0},
    ]
    plan = build_render_plan(
        clip_id="tie",
        clip_start=1.0,
        clip_end=1.4,
        tokens=tokens,
        aligned=aligned,
        pronunciations={"one": ["W", "AH1", "N"], "two": ["T", "UW1"]},
        f0=[{"t": 1.1, "hz": 130.8128}, {"t": 1.3, "hz": 195.9977}],
        envelope=[0.2] * 200,
        envelope_hop_s=0.01,
    )

    assert [word["syllables"][0]["midiPitch"] for word in plan["words"]] == [48, 55]


def test_manifest_hashes_exact_file_bytes(tmp_path: Path) -> None:
    source = tmp_path / "source.json"
    source.write_text(json.dumps({"ok": True}), encoding="utf-8")

    manifest = build_manifest({"correctedTranscript": source})

    expected = hashlib.sha256(source.read_bytes()).hexdigest()
    assert manifest["files"]["correctedTranscript"]["sha256"] == expected
    assert manifest["files"]["correctedTranscript"]["bytes"] == source.stat().st_size


def test_served_manifest_uses_artifact_relative_paths(tmp_path: Path) -> None:
    source = tmp_path / "inputs" / "source.json"
    source.parent.mkdir()
    source.write_text('{"ok":true}', encoding="utf-8")

    manifest = build_manifest({"correctedTranscript": source}, path_root=tmp_path)

    assert manifest["files"]["correctedTranscript"]["path"] == "inputs/source.json"
    assert str(tmp_path) not in json.dumps(manifest)


def test_articulation_relaxation_preserves_word_attack_and_pitch() -> None:
    plan = {
        "words": [
            {
                "start": 1.0,
                "end": 1.4,
                "syllables": [
                    {"start": 1.0, "end": 1.08, "phones": ["T", "R", "UW1"], "midiPitch": 52},
                    {"start": 1.08, "end": 1.4, "phones": ["M", "AH0", "N"], "midiPitch": 50},
                ],
            }
        ]
    }

    relaxed = articulation_relaxed_plan(plan, consonant_min_s=0.12)

    syllables = relaxed["words"][0]["syllables"]
    assert syllables[0]["start"] == 1.0
    assert syllables[-1]["end"] == 1.4
    assert syllables[0]["end"] - syllables[0]["start"] >= 0.12
    assert [syl["midiPitch"] for syl in syllables] == [52, 50]


def test_word_articulation_repair_borrows_only_following_silence() -> None:
    plan = {
        "clip": {"start": 0.0, "end": 1.0},
        "words": [
            {
                "text": "the",
                "ownerId": "src-9-0",
                "start": 0.20,
                "end": 0.243,
                "syllables": [
                    {
                        "id": "src-9-0-syl-0",
                        "start": 0.20,
                        "end": 0.243,
                        "phones": ["DH", "AH0"],
                        "midiPitch": 55,
                        "pitchProvenance": "measured",
                    }
                ],
            },
            {
                "text": "night",
                "ownerId": "src-10-0",
                "start": 0.41,
                "end": 0.75,
                "syllables": [
                    {
                        "id": "src-10-0-syl-0",
                        "start": 0.41,
                        "end": 0.75,
                        "phones": ["N", "AY1", "T"],
                        "midiPitch": 58,
                        "pitchProvenance": "measured",
                    }
                ],
            },
        ],
    }

    repaired = repair_word_articulation_plan(plan, owner_id="src-9-0", minimum_duration_s=0.14, trailing_guard_s=0.06)

    target, following = repaired["words"]
    assert target["start"] == 0.20
    assert target["end"] == pytest.approx(0.34)
    assert target["syllables"][0]["end"] == pytest.approx(0.34)
    assert target["syllables"][0]["midiPitch"] == 55
    assert following["start"] == 0.41
    assert repaired["articulationRepair"]["borrowedTrailingSilenceS"] == pytest.approx(0.097)

    score = author_soulx_score(repaired, name="word-repair")[0]
    texts = score["text"].split()
    durations = [float(value) for value in score["duration"].split()]
    assert durations[texts.index("the")] == pytest.approx(0.14)


def test_word_articulation_repair_refuses_to_move_the_next_attack() -> None:
    plan = {
        "clip": {"start": 0.0, "end": 1.0},
        "words": [
            {"text": "the", "ownerId": "src-9-0", "start": 0.20, "end": 0.243, "syllables": [{"start": 0.20, "end": 0.243}]},
            {"text": "night", "ownerId": "src-10-0", "start": 0.32, "end": 0.75, "syllables": [{"start": 0.32, "end": 0.75}]},
        ],
    }

    with pytest.raises(PlanError, match="following attack"):
        repair_word_articulation_plan(plan, owner_id="src-9-0", minimum_duration_s=0.14, trailing_guard_s=0.06)


def test_dh_schwa_heuristic_weights_vowel_and_preserves_neighbor_attack() -> None:
    plan = {
        "clip": {"start": 0.0, "end": 1.0},
        "words": [
            {
                "text": "the",
                "normalized": "the",
                "ownerId": "src-9-0",
                "start": 0.20,
                "end": 0.243,
                "phones": ["DH", "AH0"],
                "syllables": [
                    {
                        "id": "src-9-0-syl-0",
                        "start": 0.20,
                        "end": 0.243,
                        "phones": ["DH", "AH0"],
                        "midiPitch": 55,
                        "pitchProvenance": "measured",
                    }
                ],
            },
            {
                "text": "night",
                "ownerId": "src-10-0",
                "start": 0.41,
                "end": 0.75,
                "syllables": [
                    {
                        "id": "src-10-0-syl-0",
                        "start": 0.41,
                        "end": 0.75,
                        "phones": ["N", "AY1", "T"],
                        "midiPitch": 58,
                        "pitchProvenance": "measured",
                    }
                ],
            },
        ],
    }

    repaired = apply_articulation_heuristics(plan)

    target, following = repaired["words"]
    assert target["start"] == 0.20
    assert target["end"] == pytest.approx(0.34)
    assert target["syllables"][0]["scorePhones"] == ["DH", "AH0", "AH0"]
    assert following["start"] == 0.41
    assert repaired["articulationHeuristics"][0]["rule"] == "dh-schwa-vowel-weight"
    score = author_soulx_score(repaired, name="heuristic")[0]
    assert "en_DH-AH0-AH0" in score["phoneme"].split()


def test_local_used2_regression_replaces_stale_110_token_sheet() -> None:
    root = Path("~/mosh-fms-ksb/used2").expanduser()
    required = [root / "nofx-whisper-corrected.json", root / "nofx-aligned-corrected.json", root / "used2-split.json", root / "full-song/sheet.json"]
    if not all(path.is_file() for path in required):
        pytest.skip("local Used2 proof artifacts are not installed")
    corrected = json.loads(required[0].read_text(encoding="utf-8"))
    aligned = json.loads(required[1].read_text(encoding="utf-8"))
    split = json.loads(required[2].read_text(encoding="utf-8"))
    stale_sheet = json.loads(required[3].read_text(encoding="utf-8"))
    stale_text = " ".join(str(line.get("text") or line.get("seedText") or "") for line in stale_sheet["lines"])

    tokens = flatten_corrected_words(corrected, int(split["split_word_idx"]))

    assert len(re.findall(r"[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?", stale_text)) == 110
    assert len(tokens) == 127
    assert aligned[-1]["word"] == "Truman."
    assert aligned[-1]["start"] == pytest.approx(55.1126, abs=0.0001)
    assert aligned[-1]["end"] == pytest.approx(55.34, abs=0.0001)


def test_owner_pass_is_bound_to_the_exact_reviewed_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"version":1}', encoding="utf-8")
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()

    validate_owner_verdict({"clip": "opening", "verdict": "pass", "createdAt": "2026-07-09T23:00:00Z", "manifestSha256": digest}, manifest)

    with pytest.raises(RuntimeError, match="different artifact manifest"):
        validate_owner_verdict({"clip": "opening", "verdict": "pass", "createdAt": "2026-07-09T23:00:00Z", "manifestSha256": "stale"}, manifest)


def test_review_verdict_is_validated_and_saved_atomically(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"version":1}', encoding="utf-8")
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    destination = tmp_path / "owner-verdict.json"
    payload = {
        "clip": "opening",
        "verdict": "close but revise",
        "classification": "words",
        "notes": "The lower register is right, but one phrase is still blurred.",
        "createdAt": "2026-07-09T23:00:00Z",
        "manifestSha256": digest,
    }

    saved = save_review_verdict(payload, manifest, destination)

    assert saved == payload
    assert json.loads(destination.read_text(encoding="utf-8")) == payload
    assert not destination.with_suffix(".json.tmp").exists()

    with pytest.raises(RuntimeError, match="classification"):
        save_review_verdict({**payload, "classification": "other"}, manifest, destination)
    with pytest.raises(RuntimeError, match="different artifact manifest"):
        save_review_verdict({**payload, "manifestSha256": "stale"}, manifest, destination)


def test_preview_server_marks_an_old_manifest_verdict_stale(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"version":2}', encoding="utf-8")
    verdict = tmp_path / "owner-verdict.json"
    verdict.write_text('{"verdict":"close but revise","manifestSha256":"old"}', encoding="utf-8")

    status, payload = load_current_verdict(verdict, manifest)

    assert status == 409
    assert payload == {"ok": False, "stale": True, "verdict": None}


def test_expansion_review_requires_a_pass_for_the_current_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"version":2}', encoding="utf-8")
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    verdict = tmp_path / "owner-verdict.json"
    verdict.write_text(json.dumps({"verdict": "pass", "manifestSha256": "old"}), encoding="utf-8")
    assert not _owner_passes_current_manifest(tmp_path)

    verdict.write_text(json.dumps({"verdict": "pass", "manifestSha256": digest}), encoding="utf-8")
    assert _owner_passes_current_manifest(tmp_path)


def test_render_receipt_invalidates_when_a_dependency_changes(tmp_path: Path) -> None:
    plan, guide, receipt = tmp_path / "plan.json", tmp_path / "guide.wav", tmp_path / "receipt.json"
    plan.write_text("plan-v1", encoding="utf-8")
    guide.write_bytes(b"guide-v1")
    write_receipt(receipt, {"renderPlan": plan, "guide": guide})

    assert receipt_is_current(receipt)
    assert not Path(json.loads(receipt.read_text())["files"]["renderPlan"]["path"]).is_absolute()

    plan.write_text("plan-v2", encoding="utf-8")
    assert not receipt_is_current(receipt)


def test_empty_render_receipt_is_never_current(tmp_path: Path) -> None:
    receipt = tmp_path / "receipt.json"
    receipt.write_text('{"version":1,"files":{}}', encoding="utf-8")

    assert not receipt_is_current(receipt)


def test_clip_selection_excludes_partial_boundary_words() -> None:
    tokens = [{"text": "inside"}, {"text": "stuck"}]
    aligned = [
        {"start": 28.9, "end": 29.3},
        {"start": 29.4506, "end": 29.8908},
    ]

    selected = contained_pairs(tokens, aligned, clip_start=17.6, clip_end=29.6)

    assert [token["text"] for token, _span in selected] == ["inside"]


def test_manifest_does_not_rebless_audio_from_an_older_plan(tmp_path: Path) -> None:
    clip = tmp_path / "opening"
    clip.mkdir()
    plan, score, raw = clip / "asserted-render-plan.json", clip / "soulx-score.json", clip / "raw.wav"
    guide, metadata = clip / "lexical-guide.wav", clip / "lexical-guide.json"
    unpitched, unpitched_f0 = clip / "lexical-guide-unpitched.wav", clip / "lexical-guide-unpitched-f0.json"
    rendered_f0, metrics, asr = clip / "lexical-guide-f0.json", clip / "metrics-lexical-guide.json", clip / "lexical-guide-asr.json"
    plan.write_text("plan-v1", encoding="utf-8")
    score.write_text("score", encoding="utf-8")
    raw.write_bytes(b"raw")
    guide.write_bytes(b"guide")
    metadata.write_text("{}", encoding="utf-8")
    unpitched.write_bytes(b"unpitched")
    unpitched_f0.write_text("[]", encoding="utf-8")
    rendered_f0.write_text("[]", encoding="utf-8")
    metrics.write_text("{}", encoding="utf-8")
    asr.write_text('{"exactSequence":true}', encoding="utf-8")
    write_receipt(
        clip / "lexical-guide-receipt.json",
        {
            "renderPlan": plan,
            "unpitched": unpitched,
            "unpitchedF0": unpitched_f0,
            "metadata": metadata,
            "output": guide,
            "renderedF0": rendered_f0,
            "metrics": metrics,
            "asr": asr,
        },
    )

    current = regenerate_manifest({}, clip)
    assert "lexicalGuide" in current["files"]

    plan.write_text("plan-v2", encoding="utf-8")

    manifest = regenerate_manifest({}, clip)

    assert "lexicalGuide" not in manifest["files"]
    assert "lexicalGuideMetrics" not in manifest["files"]


def test_close_diagnostic_verdict_must_match_current_manifest(tmp_path: Path) -> None:
    manifest = tmp_path / "manifest.json"
    manifest.write_text('{"files":{}}', encoding="utf-8")
    digest = hashlib.sha256(manifest.read_bytes()).hexdigest()
    current = {
        "clip": "opening",
        "verdict": "close but revise",
        "createdAt": "2026-07-09T23:00:00Z",
        "manifestSha256": digest,
    }

    validate_review_verdict(current, manifest)
    with pytest.raises(RuntimeError, match="different artifact manifest"):
        validate_review_verdict({**current, "manifestSha256": "stale"}, manifest)


def test_local_splice_preserves_every_sample_outside_patch(tmp_path: Path) -> None:
    sample_rate = 1000
    baseline_samples = array("h", [1000] * sample_rate)
    replacement_samples = array("h", [-1000] * sample_rate)

    def write(path: Path, samples: array) -> None:
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(samples.tobytes())

    baseline = tmp_path / "baseline.wav"
    replacement = tmp_path / "replacement.wav"
    output = tmp_path / "localized.wav"
    write(baseline, baseline_samples)
    write(replacement, replacement_samples)

    metadata = splice_pcm16_mono(
        baseline,
        replacement,
        output,
        patch_start_s=0.20,
        patch_end_s=0.80,
        crossfade_s=0.10,
    )

    with wave.open(str(output), "rb") as handle:
        rendered = array("h")
        rendered.frombytes(handle.readframes(handle.getnframes()))
    assert rendered[:200] == baseline_samples[:200]
    assert rendered[800:] == baseline_samples[800:]
    assert rendered[300:700] == replacement_samples[300:700]
    assert metadata["outsidePatchChangedSamples"] == 0
    assert metadata["patchStartS"] == pytest.approx(0.20)
    assert metadata["patchEndS"] == pytest.approx(0.80)


def test_lexical_targets_borrow_only_real_trailing_gap() -> None:
    plan = {
        "clip": {"start": 0.0, "end": 1.0},
        "words": [
            {"text": "the", "ownerId": "src-9-0", "start": 0.20, "end": 0.243, "phones": ["DH", "AH0"], "syllables": [{"midiPitch": 55}]},
            {"text": "night", "ownerId": "src-10-0", "start": 0.41, "end": 0.75, "phones": ["N", "AY1", "T"], "syllables": [{"midiPitch": 58}]},
        ],
    }

    targets = build_lexical_targets(plan)

    assert targets[0]["start"] == 0.20
    assert targets[0]["end"] == pytest.approx(0.34)
    assert targets[0]["duration"] == pytest.approx(0.14)
    assert targets[0]["targetMidi"] == 55
    assert targets[1]["start"] == 0.41


def test_lexical_target_uses_explicit_tts_spelling_for_in() -> None:
    plan = {
        "clip": {"start": 0.0, "end": 0.5},
        "words": [
            {"text": "in", "ownerId": "src-8-0", "start": 0.1, "end": 0.2, "phones": ["IH0", "N"], "syllables": [{"midiPitch": 61}]},
        ],
    }

    assert build_lexical_targets(plan)[0]["ttsText"] == "inn"


def test_lexical_assembler_places_words_without_filling_rests(tmp_path: Path) -> None:
    sample_rate = 1000

    def write(path: Path, value: int, frames: int) -> None:
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(sample_rate)
            handle.writeframes(array("h", [value] * frames).tobytes())

    first, second = tmp_path / "first.wav", tmp_path / "second.wav"
    write(first, 1000, 100)
    write(second, -1000, 100)
    output = tmp_path / "guide.wav"

    metadata = assemble_pcm16_mono(
        [
            {"path": first, "start": 0.10, "end": 0.20, "ownerId": "a"},
            {"path": second, "start": 0.40, "end": 0.50, "ownerId": "b"},
        ],
        output,
        duration_s=0.60,
        sample_rate=sample_rate,
        fade_s=0.0,
    )

    with wave.open(str(output), "rb") as handle:
        rendered = array("h")
        rendered.frombytes(handle.readframes(handle.getnframes()))
    assert rendered[:100] == array("h", [0] * 100)
    assert rendered[100:200] == array("h", [1000] * 100)
    assert rendered[200:400] == array("h", [0] * 200)
    assert rendered[400:500] == array("h", [-1000] * 100)
    assert rendered[500:] == array("h", [0] * 100)
    assert metadata["placedWords"] == 2
    assert metadata["nonSilentOutsideWordSpans"] == 0


def test_voicebox_opening_groups_are_short_and_cover_every_asserted_word() -> None:
    words = "yeah we used to fight like invincible but in the night we got hella close yeah".split()
    targets = [{"text": word, "ownerId": f"word-{index}"} for index, word in enumerate(words)]

    groups = group_opening_targets(targets)

    assert [[target["text"] for target in group] for group in groups] == [
        ["yeah", "we", "used", "to", "fight"],
        ["like", "invincible"],
        ["but", "in", "the", "night"],
        ["we", "got", "hella", "close", "yeah"],
    ]
    assert [target["ownerId"] for group in groups for target in group] == [f"word-{index}" for index in range(16)]


def test_voicebox_phrase_match_discards_prompt_echo_and_uses_last_exact_sequence() -> None:
    asr_words = [
        {"word": "I", "start": 0.2, "end": 0.4},
        {"word": "need", "start": 0.4, "end": 0.6},
        {"word": "more", "start": 0.6, "end": 0.8},
        {"word": "in", "start": 1.0, "end": 1.2},
        {"word": "the", "start": 1.2, "end": 1.3},
        {"word": "night.", "start": 1.3, "end": 1.7},
        {"word": "in", "start": 2.0, "end": 2.2},
        {"word": "the", "start": 2.2, "end": 2.3},
        {"word": "night", "start": 2.3, "end": 2.7},
    ]

    match = match_asserted_phrase(asr_words, ["in", "the", "night"])

    assert [word["word"] for word in match] == ["in", "the", "night"]
    assert match[0]["start"] == 2.0
    assert match[-1]["end"] == 2.7


def test_voicebox_generation_events_require_completed_terminal_event() -> None:
    events = '\n'.join(
        [
            'data: {"id":"g1","status":"generating","duration":0.0,"error":null}',
            '',
            'data: {"id":"g1","status":"completed","duration":2.4,"error":null}',
        ]
    )

    terminal = parse_generation_events(events)

    assert terminal["id"] == "g1"
    assert terminal["status"] == "completed"


def test_voicebox_client_rejects_non_loopback_or_unsafe_profile_paths() -> None:
    assert VoiceboxClient("http://127.0.0.1:17494", "safe-profile").base_url == "http://127.0.0.1:17494"
    assert VoiceboxClient("http://localhost:17494/", "safe_profile").base_url == "http://localhost:17494"

    with pytest.raises(RuntimeError, match="loopback"):
        VoiceboxClient("https://voice.example.com", "safe-profile")
    with pytest.raises(RuntimeError, match="profile id"):
        VoiceboxClient("http://127.0.0.1:17494", "../samples")


def test_voicebox_public_metadata_omits_names_paths_and_reference_text() -> None:
    profile = {"id": "profile-1", "name": "Private Name", "voice_type": "cloned", "default_engine": "qwen"}
    samples = [{"audio_path": "/private/prompt.wav", "reference_text": "private prompt transcript"}]

    public = public_profile_metadata(profile, samples)

    assert public["voiceType"] == "cloned"
    assert public["sampleCount"] == 1
    assert "profile-1" not in json.dumps(public)
    assert "Private Name" not in json.dumps(public)
    assert "prompt" not in json.dumps(public)


def test_voicebox_public_phrase_metadata_omits_prompt_echo_and_generation_id() -> None:
    expected = ["in", "the", "night"]
    matched = [
        {"word": "in", "start": 2.0, "end": 2.2},
        {"word": "the", "start": 2.2, "end": 2.3},
        {"word": "night", "start": 2.3, "end": 2.7},
    ]

    public = public_phrase_metadata(
        expected,
        {"generationId": "private-id", "status": "completed", "durationS": 2.7, "seed": 0, "modelSize": "0.6B"},
        matched,
        trim_start_s=1.94,
        trim_end_s=2.76,
    )

    serialized = json.dumps(public)
    assert public["exactSequence"] is True
    assert [word["word"] for word in public["matchedWords"]] == expected
    assert "private-id" not in serialized
    assert '"asr"' not in serialized
    assert "need" not in serialized


def test_voicebox_long_multisyllabic_word_preserves_articulation_then_leaves_the_hold_empty() -> None:
    target = {"duration": 0.94034, "phones": ["IH2", "N", "V", "IH1", "N", "S", "AH0", "B", "AH0", "L"]}

    fitted = articulation_fit_duration(target, source_duration_s=0.351)

    assert fitted == pytest.approx(0.6)
    assert articulation_fit_duration({"duration": 0.3, "phones": ["N", "AY1", "T"]}, source_duration_s=0.25) == 0.3

