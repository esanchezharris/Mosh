#!/usr/bin/env python3
"""Tests for extract_als.py — `python3 service/references/extract_als_test.py` (gate convention).

Synthetic .als XML, in the style of ui/src/import/parseAls.test.ts (which embeds XML
rather than checking in a real set). Each case pins a mistake that was actually made
while building this, not a hypothetical one.
"""
from __future__ import annotations

import gzip
import importlib.util
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("extract_als", HERE / "extract_als.py")
ex = importlib.util.module_from_spec(spec)
sys.modules["extract_als"] = ex
spec.loader.exec_module(ex)

FAILURES: list[str] = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL {name}" + (f"  [{extra}]" if extra else ""))


def _mixer(vol: str, pan: str = "0") -> str:
    return f"""<Mixer><Pan><Manual Value="{pan}" /></Pan>
      <Volume><Manual Value="{vol}" /></Volume></Mixer>"""


def _eq8(freq: str, mode: str = "1", on: str = "true") -> str:
    return f"""<Eq8 Id="10"><Bands.0><IsOn><Manual Value="{on}" /></IsOn>
      <Mode><Manual Value="{mode}" /></Mode><Freq><Manual Value="{freq}" /></Freq>
      </Bands.0></Eq8>"""


def _simpler(db: str) -> str:
    return f"""<OriginalSimpler Id="3"><VolumeAndPan>
      <Volume><Manual Value="{db}" /></Volume></VolumeAndPan></OriginalSimpler>"""


def _track(name: str, body: str, group: str = "-1", kind: str = "AudioTrack") -> str:
    return (f'<{kind} Id="1"><Name><EffectiveName Value="{name}" /></Name>'
            f'<TrackGroupId Value="{group}" />{body}</{kind}>')


def _als(tracks: str, groups: str = "", master: str = "", tempo: str = "120") -> Path:
    xml = f"""<?xml version="1.0"?><Ableton><LiveSet>
      <Tempo><Manual Value="{tempo}" /></Tempo>
      {groups}{tracks}
      <MasterTrack>{master}</MasterTrack></LiveSet></Ableton>"""
    fd = tempfile.NamedTemporaryFile(suffix=".als", delete=False)
    fd.write(gzip.compress(xml.encode())); fd.close()
    return Path(fd.name)


# ── 1. the unit trap: Simpler volume is dB, the fader is linear amplitude ────────────
# An early probe ran the Simpler value through the linear converter and reported a
# -120 dB kick in a working mix. -12 must stay -12.
p = _als(_track("Kick", _mixer("0.5") + _simpler("-12")))
d = ex.extract(p); t = d["tracks"][0]
check("fader 0.5 linear -> -6.02 dB", abs(t["gainStages"]["fader"] + 6.02) < 0.05,
      str(t["gainStages"]))
check("Simpler -12 is read as dB, NOT converted", abs(t["gainStages"]["sampler"] + 12.0) < 0.01,
      str(t["gainStages"]))
check("effective = fader + sampler (-18.02)", abs(t["effectiveDb"] + 18.02) < 0.05,
      str(t["effectiveDb"]))

# ── 2. group offset is summed in (it does NOT cancel, unlike the uniform Simpler trim) ─
groups = '<GroupTrack Id="7">' + _mixer("0.5") + '</GroupTrack>'
p = _als(_track("Snare", _mixer("1.0"), group="7"), groups=groups)
t = ex.extract(p)["tracks"][0]
check("group -6.02 dB is added to the member track", abs(t["effectiveDb"] + 6.02) < 0.05,
      str(t["gainStages"]))

# ── 3. EQ Eight low-cut band ────────────────────────────────────────────────────────
p = _als(_track("Clap", _mixer("1.0") + _eq8("346")))
check("active low-cut band reads its frequency", ex.extract(p)["tracks"][0]["lowCutHz"] == 346.0)
p = _als(_track("Clap", _mixer("1.0") + _eq8("346", on="false")))
check("a band that is OFF is not a low-cut", ex.extract(p)["tracks"][0]["lowCutHz"] is None)
p = _als(_track("Clap", _mixer("1.0") + _eq8("346", mode="3")))
check("a bell band (mode 3) is not a low-cut", ex.extract(p)["tracks"][0]["lowCutHz"] is None)
# A 30 Hz band IS recorded — deciding which cuts are "real" is the reader's job. What
# the extractor owes is the split, made visible. STMPD carries 30 Hz eight times (the
# EQ Eight default, left on); calling that "this producer highpasses" would be false.
p = _als(_track("Clap", _mixer("1.0") + _eq8("30")))
d30 = ex.extract(p)
check("a 30 Hz low-cut is still RECORDED, not silently dropped",
      d30["tracks"][0]["lowCutHz"] == 30.0)
check("but 30 Hz does not count as SHAPING the part",
      d30["summary"]["shapingLowCutTracks"] == 0 and d30["summary"]["lowCutTracks"] == 1,
      str(d30["summary"]["shapingLowCutTracks"]))
p = _als(_track("Clap", _mixer("1.0") + _eq8("346")))
check("346 Hz counts as shaping", ex.extract(p)["summary"]["shapingLowCutTracks"] == 1)

# ── 4. roles: tier A names, tier B notes, tier C honest null ────────────────────────
p = _als(_track("18-snare - money @sk6xx_", _mixer("1.0")))
t = ex.extract(p)["tracks"][0]
check("tier A: an indexed, suffixed drum name still resolves", t["role"] == "snare", t["roleWhy"])

p = _als(_track("Sylenth1", _mixer("1.0")))
t = ex.extract(p)["tracks"][0]
check("tier C: a plugin name with no notes yields role null", t["role"] is None, str(t["role"]))
check("tier C records WHY it could not decide", bool(t["roleWhy"]))

notes = ("<KeyTrack><MidiKey Value=\"36\" /><Notes>"
         + "".join(f'<MidiNoteEvent Time="{i}" Duration="0.25" Velocity="100" />'
                   for i in range(16))
         + "</Notes></KeyTrack>")
p = _als(_track("7-Analog", _mixer("1.0") + f"<Notes><KeyTracks>{notes}</KeyTracks></Notes>",
                kind="MidiTrack"))
t = ex.extract(p)["tracks"][0]
check("tier B: a plugin-named MIDI track is classified from its NOTES",
      t["role"] is not None and t["roleTier"] == "heuristic", f"{t['role']}/{t['roleTier']}")

# ── 5. summary honesty ──────────────────────────────────────────────────────────────
two = _track("Kick", _mixer("1.0")) + _track("Sylenth1", _mixer("1.0"))
s = ex.extract(_als(two))["summary"]
check("unmapped tracks are counted", s["unmappedFraction"] == 0.5, str(s["unmappedFraction"]))
check("unmapped tracks are NAMED, not just counted", s["unmappedNames"] == ["Sylenth1"],
      str(s["unmappedNames"]))
check("a role with n<3 is flagged insufficient", s["perRole"]["kick"]["insufficient"] is True)

# summed power, not a mean: two equal sources are +3 dB, not the same dB
p = _als(_track("Shaker 1", _mixer("1.0")) + _track("Shaker 2", _mixer("1.0")))
s = ex.extract(p)["summary"]
check("duplicate roles sum in POWER (two at 0 dB -> +3.01)",
      abs(s["perRole"]["shaker"]["summedPowerDb"] - 3.01) < 0.05,
      str(s["perRole"]["shaker"]))

# ── 6. master chain order ───────────────────────────────────────────────────────────
p = _als(_track("Kick", _mixer("1.0")), master="<Limiter /><Eq8 /><GlueCompressor />")
check("master chain keeps device ORDER",
      ex.extract(p)["masterChain"] == ["Limiter", "Eq8", "GlueCompressor"],
      str(ex.extract(p)["masterChain"]))

print()
if FAILURES:
    print(f"FAILED ({len(FAILURES)}): " + ", ".join(FAILURES))
    raise SystemExit(1)
print("extract_als_test: ALL PASS")
