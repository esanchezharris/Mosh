#!/usr/bin/env python3
"""Extract measurable mix/arrangement facts from an Ableton .als, as JSON.

    python3 service/references/extract_als.py <project.als> [more.als ...] [--out DIR]

Read-only. Prints a summary; writes one <name>.stats.json per project when --out is given.

WHY THIS EXISTS, and what it deliberately does NOT do
-----------------------------------------------------
The produce lane's mix numbers (per-role gains, a 180 Hz highpass on every melodic
track, a master soft clipper) were guessed from the owner's verbal notes. This reads
the same quantities out of real projects so they can be compared against measurement.

Its output is NEVER read at produce time. The only legitimate consumer is a profile a
human signed off on after LISTENING. Wiring this into the preflight automatically would
build a proxy metric that gates a musical decision, which docs/POSTMORTEM-2026-09.md
forbids outright.

THE GAIN-STAGING TRAP (this is the whole reason the file is not ten lines)
-------------------------------------------------------------------------
`Mixer.Volume` is one of SEVERAL places a track's level is set. Measured across the four
reference projects on disk, 26% of tracks stage gain somewhere else:

  * both Adriatique projects trim EVERY drum track ~-12 dB inside Simpler — a uniform
    offset, so it cancels out of relative measures but moves absolutes by 12 dB;
  * STMPD's group tracks sit at -2.6/-5.4/-6.4/+0.8 dB, which does NOT cancel.

So this sums the stages. And the units differ per stage — mixing them up is exactly how
an early probe reported a -120 dB kick in a working mix:

  | stage                | XML                                          | units   | unity |
  |----------------------|----------------------------------------------|---------|-------|
  | mixer / group volume | Mixer.Volume.Manual                          | linear  | 1.0   |
  | Utility              | StereoGain.Gain.Manual                       | linear  | 1.0   |
  | Simpler              | OriginalSimpler.VolumeAndPan.Volume.Manual   | **dB**  | 0.0   |
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import re
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from roles import name_is_uninformative, role_from_name, role_from_notes  # noqa: E402

# ── XML helpers (regex over the raw text: the tree is deep, version-specific, and we
#    want a handful of leaves out of a 29MB document — a DOM parse costs far more) ────
_TRACK_RE = re.compile(r"<(AudioTrack|MidiTrack)\b.*?</\1>", re.S)
_GROUP_RE = re.compile(r"<GroupTrack\b[^>]*Id=\"(\d+)\".*?</GroupTrack>", re.S)
_EQ8_RE = re.compile(r"<Eq8\b.*?</Eq8>", re.S)
_BAND_RE = re.compile(r"<Bands\.(\d+)>(.*?)</Bands\.\1>", re.S)


def _manual(blob: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}>\s*(?:<LomId[^>]*/>\s*)?<Manual Value=\"([^\"]+)\"", blob, re.S)
    return m.group(1) if m else None


def _lin_to_db(v) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return 0.0
    return 20 * math.log10(f) if f > 1e-6 else -120.0


def _name(blob: str) -> str:
    m = re.search(r"<EffectiveName Value=\"([^\"]*)\"", blob)
    return m.group(1) if m else ""


# Above this, a low-cut is shaping the part; below it, it is subsonic cleanup or an
# untouched default. NOT a filter — every active band is still recorded. The split is
# reported as its own summary field so the judgement is visible rather than hidden in a
# threshold. Measured basis: the Adriatique remake's cuts are 75/119/243/346/864 Hz, all
# deliberate; the STMPD project has 30 Hz EIGHT times (EQ Eight's default, left enabled)
# plus one at 10 Hz, the device minimum. Counting those as "this producer highpasses"
# would have been simply false.
SHAPING_LOW_CUT_HZ = 60.0


def low_cut_hz(track_blob: str) -> float | None:
    """Highest ACTIVE low-cut frequency across the track's EQ Eight devices.

    Ableton's Eq8 Mode 0/1 are the low-cut shapes. Every enabled low-cut band counts —
    including a 30 Hz one — because deciding which are "real" is the reader's job, not
    the extractor's. See SHAPING_LOW_CUT_HZ for how the summary splits them.
    """
    best = None
    for dev in _EQ8_RE.findall(track_blob):
        for _idx, band in _BAND_RE.findall(dev):
            on = re.search(r"<IsOn>.*?<Manual Value=\"(\w+)\"", band, re.S)
            mode = re.search(r"<Mode>.*?<Manual Value=\"(\d+)\"", band, re.S)
            freq = re.search(r"<Freq>.*?<Manual Value=\"([\d.]+)\"", band, re.S)
            if on and on.group(1) == "true" and mode and mode.group(1) in ("0", "1") and freq:
                f = float(freq.group(1))
                best = f if best is None else max(best, f)
    return best


def note_features(track_blob: str) -> dict:
    """Per-track note statistics — tier B's only input. Ableton groups notes by pitch."""
    pitches: list[int] = []
    starts: list[float] = []
    lengths: list[float] = []
    for kt in re.findall(r"<KeyTrack\b.*?</KeyTrack>", track_blob, re.S):
        mk = re.search(r"<MidiKey Value=\"(\d+)\"", kt)
        if not mk:
            continue
        pitch = int(mk.group(1))
        for ev in re.findall(r"<MidiNoteEvent\b[^>]*/?>", kt):
            t = re.search(r'Time="([-\d.]+)"', ev)
            d = re.search(r'Duration="([\d.]+)"', ev)
            if not (t and d):
                continue
            pitches.append(pitch)
            starts.append(float(t.group(1)))
            lengths.append(float(d.group(1)))
    n = len(pitches)
    if n == 0:
        return {"noteCount": 0}
    span = max(max(s + l for s, l in zip(starts, lengths)) - min(starts), 1e-6)
    # Mean polyphony: notes sounding at each note's onset.
    poly = statistics.mean(
        sum(1 for s2, l2 in zip(starts, lengths) if s2 <= s < s2 + l2) for s in starts
    ) if n <= 4000 else 1.0
    return {
        "noteCount": n,
        "medianPitch": int(statistics.median(pitches)),
        "minPitch": min(pitches),
        "maxPitch": max(pitches),
        "meanPolyphony": round(poly, 2),
        "notesPerBar": round(n / max(span / 4.0, 1e-6), 2),
        "medianLengthBeats": round(statistics.median(lengths), 3),
        "dutyCycle": round(min(sum(lengths) / span, 1.0), 3),
    }


def extract(path: Path) -> dict:
    xml = gzip.open(path).read().decode("utf-8", errors="replace")

    tempo = None
    m = re.search(r"<Tempo>.*?<Manual Value=\"([\d.]+)\"", xml, re.S)
    if m:
        tempo = round(float(m.group(1)), 3)

    # Group-track levels, keyed by id, so member tracks can add their bus offset.
    groups: dict[str, float] = {}
    for gm in re.finditer(_GROUP_RE, xml):
        gid, blob = gm.group(1), gm.group(0)
        vol = re.search(r"<Mixer>.*?<Volume>.*?<Manual Value=\"([\d.eE+-]+)\"", blob, re.S)
        groups[gid] = round(_lin_to_db(vol.group(1)), 2) if vol else 0.0

    master = []
    mt = re.search(r"<MasterTrack>.*?</MasterTrack>", xml, re.S)
    if mt:
        master = re.findall(
            r"<(Eq8|Compressor2|GlueCompressor|Limiter|Saturator|StereoGain|"
            r"MultibandDynamics|PluginDevice|AutoFilter)\b", mt.group(0))

    tracks = []
    for tm in re.finditer(_TRACK_RE, xml):
        blob = tm.group(0)
        name = _name(blob)

        fader = re.search(r"<Mixer>.*?<Volume>.*?<Manual Value=\"([\d.eE+-]+)\"", blob, re.S)
        fader_db = round(_lin_to_db(fader.group(1)), 2) if fader else 0.0

        utility_db = 0.0
        for dev in re.findall(r"<StereoGain\b.*?</StereoGain>", blob, re.S):
            g = _manual(dev, "Gain")          # LINEAR, unity 1.0
            if g is not None and abs(float(g) - 1.0) > 0.02:
                utility_db += round(_lin_to_db(g), 2)

        sampler_db = 0.0
        for dev in re.findall(r"<OriginalSimpler\b.*?</OriginalSimpler>", blob, re.S):
            vp = re.search(r"<VolumeAndPan>.*?<Volume>.*?<Manual Value=\"([-\d.eE+]+)\"",
                           dev, re.S)
            if vp:                            # ALREADY dB, unity 0.0 — do NOT convert
                sampler_db += round(float(vp.group(1)), 2)

        gid = re.search(r"<TrackGroupId Value=\"(-?\d+)\"", blob)
        group_db = groups.get(gid.group(1), 0.0) if gid and gid.group(1) != "-1" else 0.0

        pan = re.search(r"<Mixer>.*?<Pan>.*?<Manual Value=\"([-\d.eE+]+)\"", blob, re.S)
        feat = note_features(blob)
        devices = re.findall(
            r"<(Eq8|Compressor2|GlueCompressor|Limiter|Saturator|StereoGain|"
            r"MultibandDynamics|PluginDevice|AutoFilter|OriginalSimpler)\b", blob)

        # ── role: tier A, then B, then honest null ──────────────────────────────
        role, tier, why = None, None, ""
        r = role_from_name(name)
        if r and not name_is_uninformative(name):
            role, tier, why = r, "name", f"name matched the drum lexicon ({name!r})"
        elif feat.get("noteCount", 0) > 0:
            r2, why2 = role_from_notes(feat)
            if r2:
                role, tier, why = r2, "heuristic", why2
            else:
                why = why2
        else:
            why = "no MIDI notes and the name is not a drum term"

        tracks.append({
            "name": name,
            "role": role,
            "roleTier": tier,
            "roleWhy": why,
            "effectiveDb": round(fader_db + utility_db + sampler_db + group_db, 2),
            "gainStages": {"fader": fader_db, "utility": utility_db,
                           "sampler": sampler_db, "group": group_db},
            "pan": round(float(pan.group(1)), 3) if pan else 0.0,
            "lowCutHz": low_cut_hz(blob),
            "devices": devices,
            "notes": feat,
        })

    return {"file": str(path), "tempo": tempo, "masterChain": master,
            "groupCount": len(groups), "tracks": tracks,
            "summary": summarise(tracks)}


def summarise(tracks: list[dict]) -> dict:
    """Only relationships. Absolute dB does not transfer between projects; ratios might."""
    DRUM = {"kick", "snare", "clap", "hat", "openhat", "rim", "shaker", "tom", "cymbal", "perc"}
    drums = [t for t in tracks if t["role"] in DRUM]
    melodic = [t for t in tracks if t["role"] in {"bass", "pad", "chords", "arp", "stab", "lead"}]
    mapped = [t for t in tracks if t["role"]]
    lowcut = [t for t in tracks if t["lowCutHz"]]
    shaping = [t for t in lowcut if t["lowCutHz"] >= SHAPING_LOW_CUT_HZ]

    def summed_power(rows: list[dict]) -> float | None:
        # Five shakers at -20 dB sum to -13 dB. A per-track MEAN across projects with
        # different layer counts is a meaningless number that looks authoritative.
        if not rows:
            return None
        return round(10 * math.log10(sum(10 ** (t["effectiveDb"] / 10) for t in rows)), 2)

    per_role: dict[str, dict] = {}
    for t in mapped:
        per_role.setdefault(t["role"], []).append(t)
    roles_out = {}
    for role, rows in sorted(per_role.items()):
        roles_out[role] = {
            "count": len(rows),
            "summedPowerDb": summed_power(rows),
            "medianDb": round(statistics.median(r["effectiveDb"] for r in rows), 2),
            "insufficient": len(rows) < 3,   # never median a role from fewer than 3
        }

    drum_bus, mel_bus = summed_power(drums), summed_power(melodic)
    return {
        "trackCount": len(tracks),
        "mapped": len(mapped),
        "coverage": round(len(mapped) / len(tracks), 3) if tracks else 0.0,
        "unmappedFraction": round(1 - len(mapped) / len(tracks), 3) if tracks else 0.0,
        "unmappedNames": [t["name"] for t in tracks if not t["role"]],
        "drumBusDb": drum_bus,
        "melodicBusDb": mel_bus,
        "melodicOffsetDb": (round(mel_bus - drum_bus, 2)
                            if drum_bus is not None and mel_bus is not None else None),
        "lowCutTracks": len(lowcut),
        "lowCutFraction": round(len(lowcut) / len(tracks), 3) if tracks else 0.0,
        "lowCutHz": sorted(round(t["lowCutHz"]) for t in lowcut),
        "lowCutRoles": sorted({t["role"] for t in lowcut if t["role"]}),
        # The number to quote when asking "does this producer highpass?" — subsonic
        # cleanup and untouched 30 Hz defaults are excluded here but still listed above.
        "shapingLowCutTracks": len(shaping),
        "shapingLowCutFraction": round(len(shaping) / len(tracks), 3) if tracks else 0.0,
        "shapingLowCutHz": sorted(round(t["lowCutHz"]) for t in shaping),
        "shapingLowCutRoles": sorted({t["role"] for t in shaping if t["role"]}),
        "shapingThresholdHz": SHAPING_LOW_CUT_HZ,
        "perRole": roles_out,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Extract mix/arrangement stats from .als files")
    ap.add_argument("projects", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, help="directory for <name>.stats.json")
    args = ap.parse_args(argv)

    for p in args.projects:
        if not p.is_file():
            print(f"  SKIP {p} (not a file)", file=sys.stderr)
            continue
        data = extract(p)
        s = data["summary"]
        print(f"\n=== {p.name}  tempo={data['tempo']}  tracks={s['trackCount']}  "
              f"groups={data['groupCount']}")
        print(f"  role coverage {s['mapped']}/{s['trackCount']} ({s['coverage']:.0%}), "
              f"unmapped {s['unmappedFraction']:.0%}")
        print(f"  drum bus {s['drumBusDb']} dB | melodic bus {s['melodicBusDb']} dB | "
              f"offset {s['melodicOffsetDb']} dB")
        print(f"  low-cut on {s['lowCutTracks']}/{s['trackCount']} "
              f"({s['lowCutFraction']:.0%}) at {s['lowCutHz'][:8]} on roles {s['lowCutRoles']}")
        print(f"  master chain: {' -> '.join(data['masterChain']) or '(none)'}")
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            dest = args.out / (p.stem + ".stats.json")
            dest.write_text(json.dumps(data, indent=2) + "\n")
            print(f"  wrote {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
