from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol


_DEFAULT_TEMPLATE_PATH = Path(__file__).with_name("template_bank.json")
_ALLOWED_SYNTHS = {"serum", "vital"}

_FROM_SCRATCH_HINTS = (
    "from scratch",
    "start from scratch",
    "make from scratch",
    "build from scratch",
    "start to finish",
    "making a beat",
    "how to make",
    "tutorial",
    "breakdown",
)

_NEGATIVE_HINTS = (
    "sample pack",
    "preset pack",
    "loop kit",
    "project file",
    "full project",
    "reaction",
    "remake",
    "cookup",
    "talking head",
    "listen along",
    "patreon",
)

_TUTORIAL_HINTS = (
    "tutorial",
    "walkthrough",
    "breakdown",
    "from scratch",
    "how to make",
    "deconstruct",
)

_CHAIN_HINTS = (
    "plugin chain",
    "chain",
    "insert",
    "rack",
    "signal chain",
    "effects chain",
)

_SERUM_HINTS = ("serum", "xfer serum", "serum 2")
_VITAL_HINTS = ("vital", "vital audio")
_SYNTH_FOCUS_HINTS = (
    "absolute beginners",
    "beginner",
    "guide",
    "synth",
    "sound design",
    "preset recreation",
    "preset",
    "patch",
    "wavetable",
    "synth tutorial",
)
_BEAT_FOCUS_HINTS = (
    "beat",
    "track",
    "song",
    "arrangement",
    "mix",
    "mixer",
    "full production",
    "start to finish",
    "type beat",
)
_MIDI_INGREDIENT_HINTS = (
    "808",
    "808s",
    "arp",
    "bass",
    "bassline",
    "chord",
    "chords",
    "clap",
    "claps",
    "drum",
    "drums",
    "hat",
    "hats",
    "hi hat",
    "hi-hat",
    "lead",
    "leads",
    "melody",
    "melodies",
    "pad",
    "pads",
    "pattern",
    "patterns",
    "piano roll",
    "pluck",
    "progression",
    "snare",
    "snares",
)


def _clamp01(value: float) -> float:
    if value < 0.0:
        return 0.0
    if value > 1.0:
        return 1.0
    return round(value, 4)


def _lower_text(parts: Iterable[str]) -> str:
    return " ".join(str(part) for part in parts if part).lower()


def _contains_any(text: str, phrases: Iterable[str]) -> bool:
    return any(phrase in text for phrase in phrases)


def _count_any(text: str, phrases: Iterable[str]) -> int:
    return sum(1 for phrase in phrases if phrase in text)


def _contains_wordish_phrase(text: str, phrases: Iterable[str]) -> bool:
    for phrase in phrases:
        if re.search(rf"(?<![a-z0-9]){re.escape(phrase)}(?![a-z0-9])", text):
            return True
    return False


def _extract_chapters(description: str) -> tuple[str, ...]:
    chapters: list[str] = []
    for raw_line in description.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if re.match(r"^\d{1,2}:\d{2}(?::\d{2})?\b", line):
            chapters.append(line)
            continue
        if re.match(r"^\[\d{1,2}:\d{2}(?::\d{2})?\]\s*", line):
            chapters.append(line)
    return tuple(chapters)


def _hash_payload(payload: Mapping[str, Any]) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


@dataclass(frozen=True)
class TutorialTemplate:
    id: str
    query: str
    include: tuple[str, ...] = ()
    exclude: tuple[str, ...] = ()
    weight: float = 1.0
    notes: str = ""

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "TutorialTemplate":
        return cls(
            id=str(data.get("id", "")).strip(),
            query=str(data.get("query", "")).strip(),
            include=tuple(str(v).strip() for v in data.get("include", []) if str(v).strip()),
            exclude=tuple(str(v).strip() for v in data.get("exclude", []) if str(v).strip()),
            weight=float(data.get("weight", 1.0)),
            notes=str(data.get("notes", "")).strip(),
        )

    def matches(self, text: str) -> bool:
        lowered = text.lower()
        if self.include and not all(token.lower() in lowered for token in self.include):
            return False
        if self.exclude and any(token.lower() in lowered for token in self.exclude):
            return False
        return True


@dataclass(frozen=True)
class TutorialProbe:
    daw_visible: bool = False
    piano_roll_visible: bool = False
    synth_gui_visible: bool = False
    plugin_chain_visible: bool = False
    serum_visible: bool = False
    vital_visible: bool = False
    readable_preset: bool = False
    readable_knobs: bool = False
    extra_synths: tuple[str, ...] = ()
    visible_plugin_names: tuple[str, ...] = ()
    evidence: tuple[Mapping[str, Any], ...] = ()

    @property
    def synth_names(self) -> tuple[str, ...]:
        names = []
        for raw in self.visible_plugin_names:
            name = str(raw).strip()
            if name:
                names.append(name)
        return tuple(names)

    def synth_score(self) -> float:
        score = 0.0
        if self.synth_gui_visible:
            score += 0.22
        if self.serum_visible or self.vital_visible:
            score += 0.28
        if self.readable_preset:
            score += 0.16
        if self.readable_knobs:
            score += 0.12
        if self.plugin_chain_visible:
            score += 0.10
        return _clamp01(score)

    def chain_score(self) -> float:
        score = 0.0
        if self.daw_visible:
            score += 0.18
        if self.plugin_chain_visible:
            score += 0.42
        if self.piano_roll_visible:
            score += 0.10
        if self.evidence:
            score += min(0.10, len(self.evidence) * 0.02)
        return _clamp01(score)


@dataclass(frozen=True)
class TutorialCandidate:
    video_id: str
    url: str
    title: str
    channel: str = ""
    description: str = ""
    duration_s: int | None = None
    tags: tuple[str, ...] = ()
    license: str = "unknown"
    template_id: str = ""
    chapters: tuple[str, ...] = ()
    has_captions: bool = False
    probe: TutorialProbe = field(default_factory=TutorialProbe)
    metadata: Mapping[str, Any] = field(default_factory=dict)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "TutorialCandidate":
        chapters = data.get("chapters")
        if chapters is None:
            chapters = _extract_chapters(str(data.get("description", "")))
        probe_payload = data.get("probe") if isinstance(data.get("probe"), Mapping) else {}
        probe = TutorialProbe(
            daw_visible=bool(probe_payload.get("daw_visible", False)),
            piano_roll_visible=bool(probe_payload.get("piano_roll_visible", False)),
            synth_gui_visible=bool(probe_payload.get("synth_gui_visible", False)),
            plugin_chain_visible=bool(probe_payload.get("plugin_chain_visible", False)),
            serum_visible=bool(probe_payload.get("serum_visible", False)),
            vital_visible=bool(probe_payload.get("vital_visible", False)),
            readable_preset=bool(probe_payload.get("readable_preset", False)),
            readable_knobs=bool(probe_payload.get("readable_knobs", False)),
            extra_synths=tuple(str(v).strip() for v in probe_payload.get("extra_synths", []) if str(v).strip()),
            visible_plugin_names=tuple(str(v).strip() for v in probe_payload.get("visible_plugin_names", []) if str(v).strip()),
            evidence=tuple(
                dict(item) if isinstance(item, Mapping) else {"value": item}
                for item in probe_payload.get("evidence", [])
                if item is not None
            ),
        )
        return cls(
            video_id=str(data.get("video_id", "")).strip(),
            url=str(data.get("url", "")).strip(),
            title=str(data.get("title", "")).strip(),
            channel=str(data.get("channel", "")).strip(),
            description=str(data.get("description", "")).strip(),
            duration_s=(int(data["duration_s"]) if data.get("duration_s") not in (None, "") else None),
            tags=tuple(str(v).strip() for v in data.get("tags", []) if str(v).strip()),
            license=str(data.get("license", "unknown")).strip() or "unknown",
            template_id=str(data.get("template_id", "")).strip(),
            chapters=tuple(str(v).strip() for v in chapters if str(v).strip()),
            has_captions=bool(data.get("has_captions", False)),
            probe=probe,
            metadata=data.get("metadata", {}) if isinstance(data.get("metadata"), Mapping) else {},
        )

    def search_text(self) -> str:
        return _lower_text((self.title, self.description, " ".join(self.tags), " ".join(self.chapters), self.channel))

    def source_payload(self) -> dict[str, Any]:
        return {
            "video_id": self.video_id,
            "url": self.url,
            "title": self.title,
            "channel": self.channel,
            "description": self.description,
            "duration_s": self.duration_s,
            "tags": list(self.tags),
            "license": self.license,
            "template_id": self.template_id,
            "chapters": list(self.chapters),
            "has_captions": self.has_captions,
            "metadata": dict(self.metadata),
        }


@dataclass(frozen=True)
class TutorialYield:
    drums: float
    midi: float
    synth: float
    arrangement: float
    overall: float
    signals: Mapping[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "drums": self.drums,
            "midi": self.midi,
            "synth": self.synth,
            "arrangement": self.arrangement,
            "overall": self.overall,
            "signals": dict(self.signals),
        }


@dataclass(frozen=True)
class ScoutPolicy:
    synth_policy: str = "hybrid"
    min_overall_to_queue: float = 0.72
    min_visual_to_queue: float = 0.55
    min_usability: float = 0.45


@dataclass(frozen=True)
class ScoredTutorial:
    candidate: TutorialCandidate
    yield_prediction: TutorialYield
    confidence: float
    decision: str
    score: float
    evidence_bundle: tuple[str, ...] = ()
    content_hash: str = ""

    def as_record(self) -> dict[str, Any]:
        return {
            "video_id": self.candidate.video_id,
            "url": self.candidate.url,
            "title": self.candidate.title,
            "channel": self.candidate.channel,
            "duration_s": self.candidate.duration_s,
            "license": self.candidate.license,
            "template_id": self.candidate.template_id,
            "status": self.decision,
            "confidence": self.confidence,
            "score": self.score,
            "yield_json": self.yield_prediction.as_dict(),
            "evidence_bundle": list(self.evidence_bundle),
            "probe": dataclasses.asdict(self.candidate.probe),
            "metadata": dict(self.candidate.metadata),
            "content_hash": self.content_hash or _hash_payload({
                "candidate": self.candidate.source_payload(),
                "probe": dataclasses.asdict(self.candidate.probe),
                "yield": self.yield_prediction.as_dict(),
                "decision": self.decision,
            }),
        }


class TutorialBank:
    def __init__(self, templates: Iterable[TutorialTemplate]):
        self.templates = tuple(templates)

    def __iter__(self):
        return iter(self.templates)

    def by_id(self, template_id: str) -> TutorialTemplate | None:
        for template in self.templates:
            if template.id == template_id:
                return template
        return None

    def search_templates(self, candidate_text: str) -> tuple[TutorialTemplate, ...]:
        scored: list[tuple[float, TutorialTemplate]] = []
        lowered = candidate_text.lower()
        for template in self.templates:
            if not template.matches(lowered):
                continue
            hits = sum(1 for token in template.include if token.lower() in lowered)
            misses = sum(1 for token in template.exclude if token.lower() in lowered)
            score = template.weight + hits * 0.15 - misses * 0.25
            scored.append((score, template))
        scored.sort(key=lambda item: (-item[0], item[1].id))
        return tuple(template for _, template in scored)


def load_template_bank(path: str | os.PathLike[str] | None = None) -> TutorialBank:
    template_path = Path(path) if path is not None else _DEFAULT_TEMPLATE_PATH
    data = json.loads(template_path.read_text(encoding="utf-8"))
    templates = data.get("templates", []) if isinstance(data, Mapping) else []
    return TutorialBank(TutorialTemplate.from_mapping(entry) for entry in templates if isinstance(entry, Mapping))


def build_scout_system_prompt(policy: ScoutPolicy | None = None) -> str:
    policy = policy or ScoutPolicy()
    synth_clause = (
        "Treat non-Serum/Vital synths as a meaningful downgrade, not an automatic reject."
        if policy.synth_policy == "hybrid"
        else "Reject candidates that clearly depend on synths outside Serum or Vital."
    )
    return "\n".join([
        "You are a tutorial scouting agent for DAW teardown.",
        "Goal: find tutorials and MIDI-visible ingredients whose notes can become real per-element recipes.",
        "Discover tutorials via the YouTube Data API and rank them before any expensive teardown work.",
        "Prefer from-scratch tutorials with chapters, captions, and clear metadata.",
        "Prefer visible piano-roll/MIDI evidence for beat-production tutorials; plugin chain evidence is helpful but not required for MIDI-only ingredients.",
        "For v1, rank MIDI-visible single-element ingredients ahead of synth-parameter detail.",
        "For synth-focused Serum/Vital tutorials, rank by visible synth GUI, readable preset names, and parameter detail.",
        "Treat visible Serum/Vital screens, readable preset names, and readable knobs as positive signals, not universal acceptance gates.",
        synth_clause,
        "Do not over-rank talking-head, sample-pack, preset-pack, remix, or ambiguous uploads.",
        "Keep discovery local-only and transient-cache based.",
        "Output structured JSON with: candidate metadata, evidence bundle, yield.predicted, confidence, decision, and reasons.",
        "Use labels: ideal, usable, weak, reject.",
    ])


class TutorialScorer:
    def __init__(self, policy: ScoutPolicy | None = None):
        self.policy = policy or ScoutPolicy()

    def _metadata_signals(self, candidate: TutorialCandidate) -> dict[str, float]:
        text = candidate.search_text()
        tutorial_hits = _count_any(text, _TUTORIAL_HINTS)
        scratch_hits = _count_any(text, _FROM_SCRATCH_HINTS)
        negative_hits = _count_any(text, _NEGATIVE_HINTS)
        chain_hits = _count_any(text, _CHAIN_HINTS)
        serum_hits = _count_any(text, _SERUM_HINTS)
        vital_hits = _count_any(text, _VITAL_HINTS)
        duration_bonus = 0.0
        if candidate.duration_s is not None:
            if 240 <= candidate.duration_s <= 1800:
                duration_bonus = 0.10
            elif 181 <= candidate.duration_s < 240 or 1800 < candidate.duration_s <= 3600:
                duration_bonus = 0.05
        captions_bonus = 0.10 if candidate.has_captions else 0.0
        chapters_bonus = 0.12 if candidate.chapters else 0.0
        tutorial_bonus = min(0.18, tutorial_hits * 0.06)
        scratch_bonus = min(0.16, scratch_hits * 0.08)
        chain_bonus = min(0.12, chain_hits * 0.04)
        synth_bonus = min(0.12, (serum_hits + vital_hits) * 0.06)
        penalty = min(0.40, negative_hits * 0.12)
        score = _clamp01(0.18 + tutorial_bonus + scratch_bonus + duration_bonus + captions_bonus + chapters_bonus + chain_bonus + synth_bonus - penalty)
        return {
            "metadata_score": score,
            "tutorial_hits": float(tutorial_hits),
            "scratch_hits": float(scratch_hits),
            "negative_hits": float(negative_hits),
            "chain_hits": float(chain_hits),
            "serum_hits": float(serum_hits),
            "vital_hits": float(vital_hits),
            "captions_bonus": captions_bonus,
            "chapters_bonus": chapters_bonus,
            "duration_bonus": duration_bonus,
            "penalty": penalty,
        }

    def _visual_signals(self, candidate: TutorialCandidate) -> dict[str, float]:
        probe = candidate.probe
        synth_names = {name.lower() for name in probe.synth_names}
        extra_synths = tuple(name for name in probe.extra_synths if name.lower() not in _ALLOWED_SYNTHS)
        serum_visible = probe.serum_visible or any(
            any(hint in synth_name for hint in _SERUM_HINTS) for synth_name in synth_names
        )
        vital_visible = probe.vital_visible or any(
            any(hint in synth_name for hint in _VITAL_HINTS) for synth_name in synth_names
        )

        chain_score = probe.chain_score()
        synth_score = probe.synth_score()

        if extra_synths:
            if serum_visible or vital_visible:
                synth_score = _clamp01(synth_score - min(0.15, 0.05 * len(extra_synths)))
            else:
                synth_score = _clamp01(synth_score - min(0.30, 0.10 * len(extra_synths)))

        if self.policy.synth_policy == "strict" and extra_synths and not (serum_visible or vital_visible):
            synth_score = 0.0
            chain_score = min(chain_score, 0.30)

        return {
            "chain_score": chain_score,
            "synth_score": synth_score,
            "serum_visible": 1.0 if serum_visible else 0.0,
            "vital_visible": 1.0 if vital_visible else 0.0,
            "piano_roll_visible": 1.0 if probe.piano_roll_visible else 0.0,
            "plugin_chain_visible": 1.0 if probe.plugin_chain_visible else 0.0,
            "daw_visible": 1.0 if probe.daw_visible else 0.0,
            "readable_preset": 1.0 if probe.readable_preset else 0.0,
            "readable_knobs": 1.0 if probe.readable_knobs else 0.0,
            "extra_synth_count": float(len(extra_synths)),
        }

    def score(self, candidate: TutorialCandidate) -> ScoredTutorial:
        meta = self._metadata_signals(candidate)
        visual = self._visual_signals(candidate)
        probe = candidate.probe

        text = candidate.search_text()
        from_scratch = _contains_any(text, _FROM_SCRATCH_HINTS)
        single_element_hint = _contains_wordish_phrase(text, _MIDI_INGREDIENT_HINTS)
        chain_visible = bool(probe.plugin_chain_visible)
        serum_or_vital = bool(probe.serum_visible or probe.vital_visible or meta["serum_hits"] or meta["vital_hits"])
        extra_synth_count = int(visual["extra_synth_count"])
        synth_focused = _is_synth_focused(text, serum_or_vital)
        synth_focus_duration_ok = candidate.duration_s is None or candidate.duration_s >= 120
        midi_context = bool(
            (not synth_focused and (from_scratch or candidate.has_captions or candidate.chapters or meta["tutorial_hits"]))
            or single_element_hint
        )
        midi_ingredient = bool(
            probe.piano_roll_visible
            and midi_context
        )

        drums = _clamp01(
            0.10
            + (0.12 if "drum" in candidate.search_text() or "beat" in candidate.search_text() else 0.0)
            + (0.08 if chain_visible else 0.0)
            + (0.06 if candidate.chapters else 0.0)
        )
        midi = _clamp01(
            0.10
            + (0.45 if probe.piano_roll_visible else 0.0)
            + (0.10 if candidate.has_captions else 0.0)
            + (0.05 if candidate.chapters else 0.0)
            + (0.08 if midi_ingredient else 0.0)
        )
        synth = _clamp01(
            0.08
            + (0.18 if probe.synth_gui_visible else 0.0)
            + (0.22 if serum_or_vital else 0.0)
            + (0.14 if probe.readable_preset else 0.0)
            + (0.10 if probe.readable_knobs else 0.0)
            + (0.08 if chain_visible else 0.0)
            - (0.08 * extra_synth_count if serum_or_vital else 0.15 * extra_synth_count)
        )
        arrangement = _clamp01(
            0.08
            + (0.24 if candidate.chapters else 0.0)
            + (0.16 if candidate.has_captions else 0.0)
            + (0.14 if from_scratch else 0.0)
            + (0.06 if "arrangement" in candidate.search_text() or "breakdown" in candidate.search_text() else 0.0)
        )

        overall = _clamp01(
            0.14 * drums
            + 0.42 * midi
            + 0.18 * synth
            + 0.14 * arrangement
            + 0.04 * meta["metadata_score"]
            + 0.04 * visual["chain_score"]
            + (0.14 if midi_ingredient else 0.0)
        )
        confidence = _clamp01(
            0.18
            + 0.14 * meta["metadata_score"]
            + 0.24 * visual["chain_score"]
            + 0.16 * visual["synth_score"]
            + 0.12 * (1.0 if probe.readable_preset else 0.0)
            + 0.10 * (1.0 if probe.readable_knobs else 0.0)
            + 0.10 * (1.0 if candidate.has_captions else 0.0)
            + 0.06 * (1.0 if candidate.chapters else 0.0)
            - (0.08 if extra_synth_count and not serum_or_vital else 0.0)
        )

        evidence_bundle = [
            f"focus:{'synth' if synth_focused else 'beat'}",
            f"midi-ingredient:{'yes' if midi_ingredient else 'no'}",
            f"piano-roll:{'visible' if probe.piano_roll_visible else 'missing'}",
            f"plugin-chain:{'visible' if chain_visible else 'missing'}",
            f"serum-or-vital:{'yes' if serum_or_vital else 'no'}",
            f"captions:{'yes' if candidate.has_captions else 'no'}",
            f"chapters:{len(candidate.chapters)}",
        ]
        if probe.readable_preset:
            evidence_bundle.append("preset:readable")
        if probe.readable_knobs:
            evidence_bundle.append("knobs:readable")
        if extra_synth_count:
            evidence_bundle.append(f"extra-synths:{extra_synth_count}")

        if self.policy.synth_policy == "strict":
            if not serum_or_vital and extra_synth_count:
                overall = min(overall, 0.30)
                confidence = min(confidence, 0.40)
            if extra_synth_count:
                synth = min(synth, 0.50)

        if midi_ingredient and midi >= 0.68 and confidence >= 0.45:
            decision = "ideal"
        elif midi_ingredient and midi >= 0.65 and confidence >= 0.45:
            decision = "usable"
        elif (
            overall >= 0.62
            and chain_visible
            and serum_or_vital
            and probe.readable_preset
            and probe.readable_knobs
        ):
            decision = "usable"
        elif chain_visible and serum_or_vital and (overall >= 0.50 or (synth >= 0.55 and confidence >= 0.45)):
            decision = "usable"
        elif (
            synth_focused
            and synth_focus_duration_ok
            and serum_or_vital
            and probe.synth_gui_visible
            and (probe.readable_preset or probe.readable_knobs)
            and synth >= 0.55
            and confidence >= 0.45
        ):
            decision = "usable"
        elif overall >= self.policy.min_usability:
            decision = "weak"
        elif midi_ingredient and midi >= 0.55 and confidence >= 0.35:
            decision = "weak"
        else:
            decision = "reject"

        if self.policy.synth_policy == "strict" and not serum_or_vital and extra_synth_count:
            decision = "reject"

        return ScoredTutorial(
            candidate=candidate,
            yield_prediction=TutorialYield(
                drums=drums,
                midi=midi,
                synth=synth,
                arrangement=arrangement,
                overall=overall,
                signals={
                    **meta,
                    **visual,
                },
            ),
            confidence=confidence,
            decision=decision,
            score=overall,
            evidence_bundle=tuple(evidence_bundle),
            content_hash=_hash_payload({
                "video_id": candidate.video_id,
                "template_id": candidate.template_id,
                "candidate": candidate.source_payload(),
                "probe": dataclasses.asdict(candidate.probe),
                "yield": {
                    "drums": drums,
                    "midi": midi,
                    "synth": synth,
                    "arrangement": arrangement,
                    "overall": overall,
                },
                "decision": decision,
            }),
        )


def rank_tutorials(candidates: Iterable[TutorialCandidate], policy: ScoutPolicy | None = None) -> list[ScoredTutorial]:
    scorer = TutorialScorer(policy=policy)
    scored = [scorer.score(candidate) for candidate in candidates]
    scored.sort(
        key=lambda item: (
            -item.score,
            -item.confidence,
            -item.yield_prediction.midi,
            -item.yield_prediction.synth,
            item.candidate.video_id,
        )
    )
    return scored


def _is_synth_focused(text: str, serum_or_vital: bool) -> bool:
    if not serum_or_vital:
        return False
    synth_hits = _count_any(text, _SYNTH_FOCUS_HINTS)
    beat_hits = _count_any(text, _BEAT_FOCUS_HINTS)
    if synth_hits == 0:
        return False
    if beat_hits and "plugin chain" in text:
        return False
    return synth_hits >= beat_hits
