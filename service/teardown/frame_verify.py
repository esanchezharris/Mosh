from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping

from .scout import TutorialProbe


_DAW_HINTS = ("fl studio", "ableton", "logic", "daw", "mixer", "playlist", "arrangement", "channel rack", "browser")
_PIANO_HINTS = ("piano roll", "midi", "melody", "chords", "bassline", "notes")
_CHAIN_HINTS = ("plugin chain", "vocal chain", "effect chain", "mixer chain", "chain overview", "insert", "rack", "device chain", "channel strip")
_SERUM_HINTS = ("serum", "xfer serum", "serum 2")
_VITAL_HINTS = ("vital", "vital audio")
_PRESET_HINTS = ("preset", "patch", "wavetable", "init preset")
_KNOB_HINTS = ("knob", "oscillator", "filter", "envelope", "env", "lfo", "osc", "unison", "detune")
_KNOWN_OTHER_SYNTHS = (
    "omnisphere",
    "nexus",
    "sylenth",
    "massive",
    "phase plant",
    "kontakt",
    "pigments",
    "spire",
    "diva",
)


@dataclass(frozen=True)
class FrameVerifier:
    yt_dlp: str | None = None
    ffmpeg: str | None = None
    tesseract: str | None = None
    timeout_s: int = 45

    def verify(
        self,
        video_id: str,
        url: str,
        cache_dir: str | os.PathLike[str],
        duration_s: int | None = None,
        title: str = "",
        description: str = "",
        tags: Iterable[str] = (),
    ) -> TutorialProbe:
        root = Path(cache_dir) / video_id
        root.mkdir(parents=True, exist_ok=True)
        metadata_text = _joined_text(title, description, tags)
        frames, frame_error = self._sample_frames(url, root, duration_s)
        frame_texts: list[str] = []
        frame_hits: list[Mapping[str, bool]] = []
        cv_hits: list[Mapping[str, bool]] = []
        evidence: list[Mapping[str, Any]] = []
        for frame in frames:
            ocr_text, ocr_error = self._ocr_frame(frame)
            frame_texts.append(ocr_text)
            text_hits = _text_hits(ocr_text.lower())
            visual_hits = _cv_hits(frame)
            frame_hits.append(text_hits)
            cv_hits.append(visual_hits)
            hits = _merge_hits(text_hits, visual_hits)
            hits["piano_roll"] = bool(visual_hits.get("piano_roll"))
            entry: dict[str, Any] = {
                "type": "frame",
                "ref": str(frame),
                "detector": "ocr_cv",
                "hits": sorted(k for k, v in hits.items() if v),
            }
            if ocr_text.strip():
                entry["ocr_preview"] = _preview_text(ocr_text)
            if ocr_error:
                entry["ocr_status"] = "unavailable"
                entry["ocr_reason"] = ocr_error
            evidence.append({
                **entry,
                "cv": dict(visual_hits),
            })
        if frame_error:
            evidence.append({"type": "frame_probe", "status": "unavailable", "reason": frame_error})

        combined_text = _joined_text(metadata_text, " ".join(frame_texts), ())
        hits = _merge_hits(_text_hits(metadata_text), _text_hits(combined_text), *frame_hits, *cv_hits)
        hits["piano_roll"] = any(bool(item.get("piano_roll")) for item in cv_hits)
        visible_plugins = []
        if hits["serum"]:
            visible_plugins.append("Serum")
        if hits["vital"]:
            visible_plugins.append("Vital")
        visible_plugins.extend(_other_synths(combined_text))

        return TutorialProbe(
            daw_visible=hits["daw"] or (bool(frames) and any(item.get("dense_ui") for item in cv_hits)),
            piano_roll_visible=hits["piano_roll"],
            synth_gui_visible=hits["synth_gui"] or hits["serum"] or hits["vital"] or bool(_other_synths(combined_text)),
            plugin_chain_visible=hits["chain"],
            serum_visible=hits["serum"],
            vital_visible=hits["vital"],
            readable_preset=hits["preset"],
            readable_knobs=hits["knobs"],
            extra_synths=tuple(_other_synths(combined_text)),
            visible_plugin_names=tuple(dict.fromkeys(visible_plugins)),
            evidence=tuple(evidence),
        )

    def _ocr_frame(self, frame: Path) -> tuple[str, str]:
        tesseract = self.tesseract or shutil.which("tesseract")
        if not tesseract:
            return "", "tesseract missing"
        prepared = _prepare_ocr_image(frame)
        image_path = (prepared or frame).resolve()
        cmd = [tesseract, str(image_path), "stdout", "--psm", "6"]
        try:
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=self.timeout_s)
        except Exception as exc:
            return "", str(exc)
        if result.returncode != 0:
            return "", result.stderr.strip() or "tesseract failed"
        return result.stdout, ""

    def _sample_frames(self, url: str, root: Path, duration_s: int | None) -> tuple[list[Path], str]:
        ytdlp = self.yt_dlp or shutil.which("yt-dlp")
        ffmpeg = self.ffmpeg or shutil.which("ffmpeg")
        if not ytdlp or not ffmpeg:
            return [], "yt-dlp or ffmpeg missing"
        stream = self._stream_url(ytdlp, url)
        if not stream:
            return [], "yt-dlp did not return a stream URL"
        frames = []
        for index, timestamp in enumerate(_sample_times(duration_s), start=1):
            target = root / f"frame-{index:02d}-{int(timestamp):04d}s.jpg"
            if target.exists() and target.stat().st_size > 0:
                frames.append(target)
                continue
            cmd = [
                ffmpeg,
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                str(timestamp),
                "-i",
                stream,
                "-frames:v",
                "1",
                str(target),
            ]
            try:
                result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=self.timeout_s)
            except Exception as exc:
                return frames, str(exc)
            if result.returncode == 0 and target.exists() and target.stat().st_size > 0:
                frames.append(target)
        if frames:
            return frames, ""
        return [], "ffmpeg did not extract frames"

    def _stream_url(self, ytdlp: str, url: str) -> str:
        cmd = [
            ytdlp,
            "-f",
            "bestvideo[height<=720]/best[height<=720]/best",
            "--get-url",
            "--no-playlist",
            url,
        ]
        try:
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=self.timeout_s)
        except Exception:
            return ""
        if result.returncode != 0:
            return ""
        for line in result.stdout.splitlines():
            line = line.strip()
            if line.startswith("http"):
                return line
        return ""


def _joined_text(title: str, description: str, tags: Iterable[str]) -> str:
    return " ".join([title, description, " ".join(tags)]).lower()


def _has_any(text: str, words: Iterable[str]) -> bool:
    return any(word in text for word in words)


def _text_hits(text: str) -> Mapping[str, bool]:
    other_synths = bool(_other_synths(text))
    return {
        "daw": _has_any(text, _DAW_HINTS),
        "piano_roll": _has_any(text, _PIANO_HINTS),
        "chain": _has_any(text, _CHAIN_HINTS),
        "serum": _has_any(text, _SERUM_HINTS),
        "vital": _has_any(text, _VITAL_HINTS),
        "preset": _has_any(text, _PRESET_HINTS),
        "knobs": _has_any(text, _KNOB_HINTS),
        "synth_gui": _has_any(text, _SERUM_HINTS) or _has_any(text, _VITAL_HINTS) or other_synths or _has_any(text, _KNOB_HINTS),
        "dense_ui": False,
    }


def _merge_hits(*items: Mapping[str, bool]) -> dict[str, bool]:
    keys = ("daw", "piano_roll", "chain", "serum", "vital", "preset", "knobs", "synth_gui", "dense_ui")
    return {key: any(bool(item.get(key, False)) for item in items) for key in keys}


def _cv_hits(frame: Path) -> Mapping[str, bool]:
    metrics = _image_metrics(frame)
    if not metrics:
        return {
            "daw": False,
            "piano_roll": False,
            "chain": False,
            "serum": False,
            "vital": False,
            "preset": False,
            "knobs": False,
            "synth_gui": False,
            "dense_ui": False,
        }
    dense_ui = metrics["edge_density"] >= 0.075
    side_panel = metrics["right_edge_density"] >= 0.085
    bottom_panel = metrics["bottom_edge_density"] >= 0.095
    center_panel = metrics["center_edge_density"] >= 0.070
    return {
        "daw": dense_ui and (side_panel or bottom_panel),
        "piano_roll": _recoverable_piano_roll(frame),
        "chain": dense_ui and (side_panel or bottom_panel),
        "serum": False,
        "vital": False,
        "preset": False,
        "knobs": center_panel,
        "synth_gui": dense_ui and center_panel,
        "dense_ui": dense_ui,
    }


def _recoverable_piano_roll(frame: Path) -> bool:
    try:
        import cv2

        from teardown.midi_from_screen import detect_notes
        from teardown.midi_from_screen.axes import detect_axes
        from teardown.render.from_screen import _is_fine_grid
        from teardown.vision.pianoroll import piano_roll_present
    except Exception:
        return False
    img = cv2.imread(str(frame))
    if img is None or getattr(img, "ndim", 0) != 3:
        return False
    pr = piano_roll_present(img)
    bbox = pr.get("bbox")
    if not (pr.get("present") and bbox):
        return False
    x, y, w, h = [int(v) for v in bbox]
    crop = img[max(0, y): max(0, y + h), max(0, x): max(0, x + w)]
    if crop.size == 0 or not _is_fine_grid(crop):
        return False
    axes = detect_axes(crop)
    try:
        notes = [
            note for note in detect_notes(crop, axes)
            if 12 <= int(note.get("pitch", -1)) <= 120
            and float(note.get("end", 0.0)) > float(note.get("start", 0.0))
        ]
        return 3 <= len(notes) <= 256
    except Exception:
        return False


def _image_metrics(frame: Path) -> dict[str, float]:
    try:
        from PIL import Image
    except Exception:
        return {}
    try:
        image = Image.open(frame).convert("L").resize((160, 90))
    except Exception:
        return {}
    pixels = list(image.getdata())
    width, height = image.size
    edge_total = 0
    edge_count = 0
    horizontal_count = 0
    horizontal_total = 0
    for y in range(height):
        for x in range(width):
            value = pixels[y * width + x]
            if x + 1 < width:
                diff = abs(value - pixels[y * width + x + 1])
                edge_count += 1
                edge_total += 1 if diff > 18 else 0
            if y + 1 < height:
                diff = abs(value - pixels[(y + 1) * width + x])
                edge_count += 1
                edge_total += 1 if diff > 18 else 0
                horizontal_count += 1
                horizontal_total += 1 if diff > 18 else 0
    return {
        "edge_density": edge_total / max(edge_count, 1),
        "right_edge_density": _region_edge_density(pixels, width, height, int(width * 0.70), 0, width, height),
        "bottom_edge_density": _region_edge_density(pixels, width, height, 0, int(height * 0.68), width, height),
        "center_edge_density": _region_edge_density(pixels, width, height, int(width * 0.18), int(height * 0.16), int(width * 0.82), int(height * 0.84)),
        "horizontal_bias": horizontal_total / max(horizontal_count, 1),
    }


def _region_edge_density(pixels: list[int], width: int, height: int, x0: int, y0: int, x1: int, y1: int) -> float:
    total = 0
    count = 0
    for y in range(max(0, y0), min(height, y1)):
        for x in range(max(0, x0), min(width - 1, x1 - 1)):
            diff = abs(pixels[y * width + x] - pixels[y * width + x + 1])
            count += 1
            total += 1 if diff > 18 else 0
    return total / max(count, 1)


def _prepare_ocr_image(frame: Path) -> Path | None:
    try:
        from PIL import Image, ImageOps
    except Exception:
        return None
    target = frame.with_suffix(".ocr.png")
    try:
        image = Image.open(frame).convert("L")
        image = ImageOps.autocontrast(image)
        width, height = image.size
        image = image.resize((max(width * 2, width), max(height * 2, height)))
        image.save(target)
        return target
    except Exception:
        return None


def _preview_text(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:240]


def _other_synths(text: str) -> list[str]:
    found = []
    for synth in _KNOWN_OTHER_SYNTHS:
        if re.search(rf"\b{re.escape(synth)}\b", text):
            found.append(synth.title())
    return found


def _sample_times(duration_s: int | None) -> tuple[int, int, int]:
    if duration_s and duration_s >= 180:
        return (
            max(10, int(duration_s * 0.15)),
            max(20, int(duration_s * 0.45)),
            max(30, int(duration_s * 0.75)),
        )
    return (15, 60, 120)
