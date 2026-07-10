from __future__ import annotations

import json
from pathlib import Path

from asserted_proof_plan import build_manifest
from asserted_proof_provenance import receipt_is_current


def regenerate_manifest(base_files: dict[str, Path], clip_dir: Path) -> dict:
    candidates = dict(base_files)
    candidates.update(
        {
            "renderPlan": clip_dir / "asserted-render-plan.json",
            "targetScore": clip_dir / "soulx-score.json",
            "rawSlice": clip_dir / "raw.wav",
        }
    )
    lanes = (
        (
            clip_dir / "guide-receipt.json",
            {"guide": clip_dir / "guide.wav", "guideF0": clip_dir / "guide-1-f0.json", "metrics": clip_dir / "metrics.json"},
            frozenset({"renderPlan", "targetScore", "promptAudio", "promptMetadata", "output", "renderedF0", "metrics"}),
        ),
        (
            clip_dir / "guide-articulation-relaxed-receipt.json",
            {
                "relaxedGuide": clip_dir / "guide-articulation-relaxed.wav",
                "relaxedGuideF0": clip_dir / "guide-2-f0.json",
                "relaxedMetrics": clip_dir / "metrics-articulation-relaxed.json",
            },
            frozenset({"renderPlan", "targetScore", "promptAudio", "promptMetadata", "output", "renderedF0", "metrics"}),
        ),
        (
            clip_dir / "guide-word-repair-receipt.json",
            {
                "repairPlan": clip_dir / "asserted-render-plan-word-repair.json",
                "repairTargetScore": clip_dir / "soulx-score-word-repair.json",
                "repairGuide": clip_dir / "guide-word-repair.wav",
                "repairGuideF0": clip_dir / "guide-3-f0.json",
                "repairMetrics": clip_dir / "metrics-word-repair.json",
            },
            frozenset({"renderPlan", "targetScore", "promptAudio", "promptMetadata", "output", "renderedF0", "metrics"}),
        ),
        (
            clip_dir / "guide-word-repair-local-receipt.json",
            {
                "localRepairGuide": clip_dir / "guide-word-repair-local.wav",
                "localRepairGuideF0": clip_dir / "guide-word-repair-local-f0.json",
                "localRepairMetadata": clip_dir / "guide-word-repair-local.json",
                "localRepairMetrics": clip_dir / "metrics-word-repair-local.json",
            },
            frozenset({"baseline", "replacement", "renderPlan", "metadata", "output", "renderedF0", "metrics"}),
        ),
        (
            clip_dir / "lexical-guide-receipt.json",
            {
                "lexicalGuide": clip_dir / "lexical-guide.wav",
                "lexicalGuideUnpitched": clip_dir / "lexical-guide-unpitched.wav",
                "lexicalGuideUnpitchedF0": clip_dir / "lexical-guide-unpitched-f0.json",
                "lexicalGuideMetadata": clip_dir / "lexical-guide.json",
                "lexicalGuideF0": clip_dir / "lexical-guide-f0.json",
                "lexicalGuideMetrics": clip_dir / "metrics-lexical-guide.json",
                "lexicalGuideAsr": clip_dir / "lexical-guide-asr.json",
            },
            frozenset({"renderPlan", "unpitched", "unpitchedF0", "metadata", "output", "renderedF0", "metrics", "asr"}),
        ),
        (
            clip_dir / "lexical-svc-receipt.json",
            {
                "lexicalSvc": clip_dir / "lexical-svc.wav",
                "lexicalSvcF0": clip_dir / "lexical-svc-f0.json",
                "lexicalSvcMetrics": clip_dir / "metrics-lexical-svc.json",
                "lexicalSvcAsr": clip_dir / "lexical-svc-asr.json",
            },
            frozenset({"guide", "promptAudio", "output", "renderedF0", "metrics", "asr"}),
        ),
        (
            clip_dir / "voicebox-lexical-guide-receipt.json",
            {
                "voiceboxLexicalGuide": clip_dir / "voicebox-lexical-guide.wav",
                "voiceboxLexicalGuideUnpitched": clip_dir / "voicebox-lexical-guide-unpitched.wav",
                "voiceboxLexicalGuideUnpitchedF0": clip_dir / "voicebox-lexical-guide-unpitched-f0.json",
                "voiceboxLexicalGuideMetadata": clip_dir / "voicebox-lexical-guide.json",
                "voiceboxLexicalGuideF0": clip_dir / "voicebox-lexical-guide-f0.json",
                "voiceboxLexicalGuideMetrics": clip_dir / "metrics-voicebox-lexical-guide.json",
                "voiceboxLexicalGuideAsr": clip_dir / "voicebox-lexical-guide-asr.json",
            },
            frozenset({"renderPlan", "promptAudio", "metadata", "unpitched", "unpitchedF0", "output", "renderedF0", "metrics", "asr"}),
        ),
        (
            clip_dir / "svc-receipt.json",
            {"svc": clip_dir / "svc.wav", "svcF0": clip_dir / "svc-f0.json", "svcMetrics": clip_dir / "metrics-svc.json"},
            frozenset({"renderPlan", "guide", "promptAudio", "output", "renderedF0", "metrics"}),
        ),
    )
    if clip_dir.name == "opening":
        review_receipts = {"lexical-guide-receipt.json", "voicebox-lexical-guide-receipt.json"}
        lanes = tuple(lane for lane in lanes if lane[0].name in review_receipts)
    for receipt, files, required_labels in lanes:
        if receipt_is_current(receipt, required_labels):
            candidates.update(files)
    manifest = build_manifest({label: path for label, path in candidates.items() if path.is_file()}, path_root=clip_dir.parent.parent)
    manifest["status"] = "current"
    target = clip_dir / "manifest.json"
    target.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest
