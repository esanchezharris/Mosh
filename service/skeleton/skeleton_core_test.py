#!/usr/bin/env python3
"""Golden tests for the Phase-2 mumble -> rhythmic SKELETON core (Finish-My-Song roadmap §2).

The producer hums/mumbles GIBBERISH (no words); we turn the take into a rhythmic *skeleton*
— syllable count + onsets + a stress contour — and emit the SAME `LineSpec` the Phase-1 engine
already consumes (every slot a `___` gap; the engine fills the words). NO voice synthesis.

This is the deterministic IP: PURE functions over note/F0 lists (stdlib only), so it golden-tests
3× identical with no audio and no model. The note-onset-only path (no F0) MUST equal the existing,
already-trusted `lyrics.mumble.build_spec_from_take(notes, [])` binning — that equivalence is the
safety guarantee (a missing FCPE venv degrades to #178-quality rhythm, never breaks). With an F0
contour, a sustained note that re-articulates (a pitch jump mid-note) splits into N nuclei, raising
the syllable target.

Run:  python3 service/skeleton/skeleton_core_test.py     (exit 0 = all pass)
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SERVICE = os.path.dirname(HERE)
sys.path.insert(0, SERVICE)

from skeleton import core  # noqa: E402
from lyrics import core as lyr  # noqa: E402
from lyrics import mumble  # noqa: E402

fails = []


def check(name, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        fails.append(name)


# Four note onsets: three close together (bar 0) + one a bar later (bar 1) @ 120bpm/4/4 (2s/bar).
NOTES = [
    {"start": 0.00, "end": 0.20, "velocity": 110},
    {"start": 0.30, "end": 0.45, "velocity": 80},
    {"start": 0.60, "end": 0.80, "velocity": 95},
    {"start": 2.10, "end": 2.35, "velocity": 100},
]


def _line0(spec):
    ls = spec.get("lines", [])
    return ls[0] if ls else {}


# ── 1. No-F0 path == the trusted mumble binning (the safety equivalence) ───────────────
sk = core.build_skeleton_spec(NOTES, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8")
mb = mumble.build_spec_from_take(NOTES, [], 120.0, time_sig=(4, 4), grid="1/8")
check("no-F0 skeleton lines == mumble.build_spec_from_take lines",
      sk.get("lines") == mb.get("lines"),
      f"{len(sk.get('lines', []))} vs {len(mb.get('lines', []))} lines")
check("skeleton is ok with 2 bars -> 2 lines", sk.get("ok") and len(sk.get("lines", [])) == 2,
      str(len(sk.get("lines", []))))

# ── 2. It's a WORDLESS skeleton: every slot a gap, no words ever ───────────────────────
seeds = [ln.get("seedText", "") for ln in sk.get("lines", [])]
check("every seedText is all-gaps (no words leak in)",
      all(s.replace("_", "").replace(" ", "") == "" and "_" in s for s in seeds), str(seeds))
check("bar-0 syllableTarget == note count in bar 0 (3)", _line0(sk).get("syllableTarget") == 3,
      str(_line0(sk).get("syllableTarget")))

# ── 3. The skeleton is tagged editable (the human-in-the-loop grid gate) ───────────────
check("spec.source == 'skeleton'", sk.get("source") == "skeleton")
check("spec.editable is True", sk.get("editable") is True)

# ── 4. With an F0 contour, a re-articulated sustained note splits into >1 nucleus ──────
# One long note [0,1.0] held in bar 0; the F0 jumps ~+4 semitones at t=0.5 (a new syllable).
sustained = [{"start": 0.0, "end": 1.0, "velocity": 100}]
f0 = ([{"t": t / 100.0, "hz": 220.0} for t in range(0, 50)]       # A3 for the first half
      + [{"t": t / 100.0, "hz": 277.18} for t in range(50, 100)])  # ~C#4 for the second half
nuc = core.nuclei_from_notes(sustained, f0)
check("F0 re-articulation splits one sustained note into 2 nuclei", len(nuc) == 2, str(len(nuc)))
sk_f0 = core.build_skeleton_spec(sustained, f0=f0, bpm=120.0, time_sig=(4, 4), grid="1/8")
check("F0-split raises the bar-0 syllable target to 2", _line0(sk_f0).get("syllableTarget") == 2,
      str(_line0(sk_f0).get("syllableTarget")))
# …and with NO F0 the same sustained note is a single nucleus (identity).
check("no-F0 sustained note stays 1 nucleus", len(core.nuclei_from_notes(sustained, None)) == 1)

# ── 5. The emitted spec is loop-valid: the Phase-1 engine fills it (fake backend) ──────
done = lyr.complete(sk, backend="fake")
props0 = (done.get("lines", [{}])[0] or {}).get("proposals", []) if done.get("ok") else []
check("Phase-1 complete(skeleton spec) returns proposals", done.get("ok") and len(props0) > 0,
      f"ok={done.get('ok')} props={len(props0)}")

# ── 6. No-notes guard ──────────────────────────────────────────────────────────────────
empty = core.build_skeleton_spec([], f0=None, bpm=120.0)
check("no notes -> no_melody_detected", (not empty.get("ok")) and empty.get("error") == "no_melody_detected")

# ═══ Stage-1 promotion (kill-shot B, GO 2026-07-04): v3 pruner + melisma grouping + v4 ═══
# Envelope lists are hand-built at core.HOP_MS hops (10 ms) — no audio, no models.

# ── 7. v3 pruner: a v1 boundary survives only on EVIDENCE (gap / note / dip) ───────────
FLAT = [0.5] * 100                                        # steady 1-second envelope
F0_STEADY = [{"t": i / 100.0, "hz": 220.0} for i in range(100)]
F0_STEP = ([{"t": i / 100.0, "hz": 220.0} for i in range(50)]
           + [{"t": i / 100.0, "hz": 261.63} for i in range(50, 100)])
TWO = [{"start": 0.0, "end": 0.5, "velocity": 90}, {"start": 0.5, "end": 1.0, "velocity": 80}]

pr = core.prune_v1_nuclei([dict(n) for n in TWO], [57, 57], FLAT, F0_STEADY, 120.0)
check("pruner: no evidence -> boundary merges away", len(pr["nuclei"]) == 1 and pr["merged_away"] == 1,
      str(pr["evidence"]))
DIP_ENV = [0.5] * 45 + [0.1] * 10 + [0.5] * 45
pr = core.prune_v1_nuclei([dict(n) for n in TWO], [57, 57], DIP_ENV, F0_STEADY, 120.0)
check("pruner: envelope dip at the boundary kept as 'dip'", len(pr["nuclei"]) == 2 and pr["evidence"]["dip"] == 1,
      str(pr["evidence"]))
pr = core.prune_v1_nuclei([dict(n) for n in TWO], [57, 60], FLAT, F0_STEP, 120.0)
check("pruner: F0 note change across the boundary kept as 'note'", len(pr["nuclei"]) == 2 and pr["evidence"]["note"] == 1,
      str(pr["evidence"]))
pr = core.prune_v1_nuclei([dict(n) for n in TWO], [57, 60], FLAT, None, 120.0)
check("pruner: no-F0 note change falls back to Basic-Pitch pitches", len(pr["nuclei"]) == 2 and pr["evidence"]["note"] == 1,
      str(pr["evidence"]))
GAPPED = [{"start": 0.0, "end": 0.45, "velocity": 90}, {"start": 0.55, "end": 1.0, "velocity": 80}]
pr = core.prune_v1_nuclei([dict(n) for n in GAPPED], [57, 57], FLAT, F0_STEADY, 120.0)
check("pruner: silence gap >= 30ms kept as 'gap'", len(pr["nuclei"]) == 2 and pr["evidence"]["gap"] == 1,
      str(pr["evidence"]))
OFF = [{"start": 0.0, "end": 0.51, "velocity": 90}, {"start": 0.51, "end": 1.0, "velocity": 80}]
pr = core.prune_v1_nuclei([dict(n) for n in OFF], [57, 60], FLAT, None, 120.0)
check("pruner: evidenced boundary at 0.51 snaps to the 0.5 eighth line",
      abs(float(pr["nuclei"][1]["start"]) - 0.5) < 1e-9 and abs(float(pr["nuclei"][0]["end"]) - 0.5) < 1e-9,
      str(pr["nuclei"]))
g16, ok16 = core._snap16(0.51, bpm=120.0)
check("snap16 prefers the 8th/quarter line within tolerance", ok16 and abs(g16 - 0.5) < 1e-9, str((g16, ok16)))

# ── 8. Melisma grouping: a 'note'-kind continuation is ONE syllable slot ───────────────
TRI = [{"start": 0.0, "end": 0.5, "velocity": 90},
       {"start": 0.5, "end": 1.0, "velocity": 80, "kind": "note"},
       {"start": 1.0, "end": 1.5, "velocity": 85, "kind": "dip"}]
gs = core.articulation_groups(TRI, [57, 60, 60])
check("grouping: note-kind continuation folds into one melisma group",
      len(gs) == 2 and len(gs[0]["segments"]) == 2, str([len(g["segments"]) for g in gs]))
check("grouping: melisma segments keep the per-note pitches",
      [s["pitch"] for s in gs[0]["segments"]] == [57, 60], str(gs[0]))
check("grouping: group velocity is the max over its segments", gs[0]["velocity"] == 90, str(gs[0]))

# ── 9. v4 ASR budget: per-PHRASE folding, never inventing ──────────────────────────────
def _G(a, b, kind="gap", pitch=57):
    return {"start": a, "end": b, "velocity": 90, "kind": kind,
            "segments": [{"start": a, "end": b, "pitch": pitch}]}

fused, st = core.fuse_asr_budget([_G(0.0, 0.25), _G(0.31, 0.45, "dip"), _G(0.5, 0.75)],
                                 [{"start": 0.0, "end": 0.8, "syl": 1}], bpm=120.0)
check("asr: 3 groups in a 1-syllable phrase fold to 1 (weakest first)",
      len(fused) == 1 and st["folded_by_asr"] == 2 and len(fused[0]["segments"]) == 3, str(st))
fused, st = core.fuse_asr_budget([_G(0.0, 0.5)], [{"start": 0.0, "end": 0.6, "syl": 3}], bpm=120.0)
check("asr: NEVER invents slots (1 group under a 3-syl budget stays 1)",
      len(fused) == 1 and st["words_under"] == 1, str(st))
fused, st = core.fuse_asr_budget([_G(3.0, 3.3), _G(3.5, 3.8)], [{"start": 0.0, "end": 0.6, "syl": 1}], bpm=120.0)
check("asr: groups outside any phrase span pass through verbatim",
      len(fused) == 2 and st["unassigned_groups"] == 2, str(st))
fused, st = core.fuse_asr_budget([_G(0.0, 0.2), _G(0.28, 0.45, "dip"), _G(0.5, 0.7)],
                                 [{"start": 0.0, "end": 0.3, "syl": 1}, {"start": 0.45, "end": 0.7, "syl": 1}],
                                 bpm=120.0)
check("asr: words <0.4s apart pool into ONE phrase budget (no per-word over-fold)",
      st["asr_phrases"] == 1 and len(fused) == 2 and st["folded_by_asr"] == 1, str(st))
fused, st = core.fuse_asr_budget([_G(0.0, 0.2), _G(0.25, 0.5)], [{"start": 0.0, "end": 0.6, "syl": 2}], bpm=120.0)
check("asr: exact budget untouched", len(fused) == 2 and st["folded_by_asr"] == 0, str(st))

# ── 10. build_skeleton_spec with an envelope: v3 end-to-end + lineScores ───────────────
DUET = [{"start": 0.0, "end": 0.5, "velocity": 100, "pitch": 57},
        {"start": 0.5, "end": 1.0, "velocity": 90, "pitch": 60}]
sk3 = core.build_skeleton_spec(DUET, f0=F0_STEP, bpm=120.0, time_sig=(4, 4), grid="1/8", env=FLAT)
check("v3: two contiguous notes on one breath count ONE syllable slot",
      _line0(sk3).get("syllableTarget") == 1, str(_line0(sk3).get("syllableTarget")))
check("v3: provenance says algo v3 with 1 melisma group",
      sk3.get("skeleton", {}).get("algo") == "v3" and sk3["skeleton"].get("melisma_groups") == 1,
      str(sk3.get("skeleton")))
check("v3: lineScores align 1:1 with lines",
      len(sk3.get("lineScores", [])) == len(sk3.get("lines", [])) == 1, str(len(sk3.get("lineScores", []))))
slot0 = (sk3.get("lineScores") or [{}])[0].get("slots", [{}])[0]
check("v3: the melisma slot carries 2 segments with the note pitches",
      len(slot0.get("segments", [])) == 2 and [s["pitch"] for s in slot0["segments"]] == [57, 60], str(slot0))
check("v3: lineScore blob is self-contained (v/bar/bpm/timeSig/grid)",
      (sk3["lineScores"][0].get("v") == 1 and sk3["lineScores"][0].get("bar") == 0
       and sk3["lineScores"][0].get("bpm") == 120.0 and sk3["lineScores"][0].get("grid") == "1/8"),
      str(sk3["lineScores"][0]))

# ── 11. Degradation pinned: no envelope -> BYTE-IDENTICAL lines to today's v1 path ─────
sk1 = core.build_skeleton_spec(DUET, f0=F0_STEP, bpm=120.0, time_sig=(4, 4), grid="1/8", env=None)
mb1 = mumble.build_spec_from_take(core.nuclei_from_notes(DUET, F0_STEP), [], 120.0, time_sig=(4, 4), grid="1/8")
check("no-env lines byte-identical to the trusted v1 binning (2 slots, no pruning)",
      sk1.get("lines") == mb1.get("lines") and _line0(sk1).get("syllableTarget") == 2, str(_line0(sk1)))
legacy_keys = {k: v for k, v in sk1.items() if k not in ("lineScores", "skeleton")}
mb1_tagged = dict(mb1); mb1_tagged["source"] = "skeleton"; mb1_tagged["editable"] = True
check("no-env spec == legacy spec + only additive keys", legacy_keys == mb1_tagged, str(sorted(sk1.keys())))
check("no-env still emits single-segment lineScores (algo v1) for the render path",
      sk1.get("skeleton", {}).get("algo") == "v1"
      and [len(s["segments"]) for s in sk1["lineScores"][0]["slots"]] == [1, 1], str(sk1.get("skeleton")))

# ── 12. Words gate a v4 pass (env present + words present) ─────────────────────────────
TRIP = [{"start": 0.0, "end": 0.2, "velocity": 100, "pitch": 57},
        {"start": 0.31, "end": 0.45, "velocity": 90, "pitch": 57},
        {"start": 0.5, "end": 0.75, "velocity": 95, "pitch": 57}]
sk4 = core.build_skeleton_spec(TRIP, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8", env=FLAT,
                               words=[{"start": 0.0, "end": 0.8, "syl": 1}])
check("v4: ASR 1-syllable budget folds the take's 3 slots to 1",
      _line0(sk4).get("syllableTarget") == 1 and sk4.get("skeleton", {}).get("algo") == "v4",
      str((_line0(sk4).get("syllableTarget"), sk4.get("skeleton"))))
check("v4: fold provenance recorded", sk4["skeleton"].get("asr", {}).get("folded_by_asr") == 2,
      str(sk4["skeleton"].get("asr")))
check("v4: folded slot keeps all 3 segments for the render skeleton",
      len(sk4["lineScores"][0]["slots"][0]["segments"]) == 3, str(sk4["lineScores"][0]["slots"][0]))
sk4_nowords = core.build_skeleton_spec(TRIP, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8", env=FLAT)
check("v4 without words == v3 (no whisper venv -> no-op)",
      sk4_nowords.get("skeleton", {}).get("algo") == "v3" and _line0(sk4_nowords).get("syllableTarget") == 3,
      str(_line0(sk4_nowords).get("syllableTarget")))

# ── 13. read_pcm_mono: the WAVE_EXTENSIBLE guard is deterministic across interpreters ──
import struct as _struct
import tempfile as _tempfile
import wave as _wave

_td = _tempfile.mkdtemp(prefix="skeltest-")
_good = os.path.join(_td, "good.wav")
with _wave.open(_good, "wb") as _w:
    _w.setnchannels(1); _w.setsampwidth(2); _w.setframerate(8000)
    _w.writeframes(_struct.pack("<4h", 0, 16000, -16000, 0))
_r = core.read_pcm_mono(_good)
check("read_pcm_mono reads plain 16-bit PCM (fmt tag 1)",
      _r is not None and _r[1] == 8000 and len(_r[0]) == 4 and abs(_r[0][1] - 16000 / 32768.0) < 1e-6,
      str(_r))
# Hand-craft a WAVE_FORMAT_EXTENSIBLE header (fmt tag 0xFFFE): afconvert emits these and
# Python <=3.11 wave rejects them while 3.12+ accepts — the guard must refuse EVERYWHERE.
_ext = os.path.join(_td, "ext.wav")
_fmt = _struct.pack("<HHIIHH", 0xFFFE, 1, 8000, 16000, 2, 16) + b"\x00" * 24
_data = _struct.pack("<4h", 0, 1000, -1000, 0)
with open(_ext, "wb") as _f:
    _body = b"WAVE" + b"fmt " + _struct.pack("<I", len(_fmt)) + _fmt \
            + b"data" + _struct.pack("<I", len(_data)) + _data
    _f.write(b"RIFF" + _struct.pack("<I", len(_body)) + _body)
check("read_pcm_mono REFUSES fmt tag 0xFFFE (WAVE_EXTENSIBLE)", core.read_pcm_mono(_ext) is None)
check("read_pcm_mono refuses non-WAV garbage", core.read_pcm_mono(__file__) is None)
# Audio shorter than one 25ms RMS window must yield [] (adversarial-review find: the
# prefix-sum indexing crashed) and the empty envelope must land on the v1 floor.
check("energy_envelope of sub-window audio is [] (degrades, never crashes)",
      core.energy_envelope([0.1] * 50, 44100) == [])
sk_short = core.build_skeleton_spec(DUET, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8", env=[])
check("empty envelope -> v1 floor", sk_short.get("skeleton", {}).get("algo") == "v1",
      str(sk_short.get("skeleton")))

# ── 14. Lyric EXTRACTION rung (pipeline correction 2026-07-04): his words survive ──────
# bar 0 = three confident real words on three slots -> verbatim sung line;
# bar 1 = filler mumble -> today's wordless gaps. Tier 1 only (hermetic).
X_NOTES = [{"start": 0.1, "end": 0.5, "velocity": 100, "pitch": 57},
           {"start": 0.6, "end": 1.0, "velocity": 95, "pitch": 59},
           {"start": 1.1, "end": 1.5, "velocity": 90, "pitch": 60},
           {"start": 2.2, "end": 2.6, "velocity": 85, "pitch": 57},
           {"start": 2.8, "end": 3.2, "velocity": 80, "pitch": 59}]
X_ENV = [0.5] * 400
X_WORDS = [{"word": "hold", "start": 0.10, "end": 0.45, "confidence": 0.9, "syl": 1},
           {"word": "the", "start": 0.60, "end": 0.95, "confidence": 0.88, "syl": 1},
           {"word": "flame", "start": 1.10, "end": 1.50, "confidence": 0.95, "syl": 1},
           {"word": "la", "start": 2.20, "end": 2.55, "confidence": 0.35, "syl": 1},
           {"word": "mmm", "start": 2.80, "end": 3.10, "confidence": 0.25, "syl": 1}]
skx = core.build_skeleton_spec(X_NOTES, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8",
                               env=X_ENV, words=X_WORDS,
                               extract_lyrics=True, extract_use_llm=False)
lx = skx.get("lines", [{}, {}])
check("extraction: real covered line lands VERBATIM (text + origin sung)",
      lx[0].get("text") == "hold the flame" and lx[0].get("origin") == "sung",
      str((lx[0].get("text"), lx[0].get("origin"))))
check("extraction: anchored seedText carries his words (mumble machinery reused)",
      lx[0].get("seedText") == "hold the flame", str(lx[0].get("seedText")))
check("extraction: filler bar stays wordless (no text/origin — today's behavior)",
      not lx[1].get("text") and "origin" not in lx[1], str(lx[1].get("seedText")))
check("extraction: lineHeard aligned 1:1 (filler words persisted, kept=false)",
      len(skx.get("lineHeard", [])) == 2
      and all(not w["kept"] for w in skx["lineHeard"][1]["words"]),
      str(skx.get("lineHeard", [None, None])[1]))
check("extraction: stats in skeleton provenance",
      skx.get("skeleton", {}).get("extraction", {}).get("sung_lines") == 1,
      str(skx.get("skeleton", {}).get("extraction")))

# The non-extraction call is BYTE-IDENTICAL to the pre-correction path (regression pin).
skx_off = core.build_skeleton_spec(X_NOTES, f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8",
                                   env=X_ENV, words=X_WORDS)
check("no-extraction call: no text/origin/lineHeard leaks in",
      "lineHeard" not in skx_off and not any(l.get("text") or l.get("origin")
                                             for l in skx_off.get("lines", [])),
      str(sorted(skx_off.keys())))
check("no-extraction seedTexts stay ALL-GAPS (pre-correction behavior pinned)",
      all(s.replace("_", "").replace(" ", "") == "" and "_" in s
          for s in (l.get("seedText", "") for l in skx_off["lines"])),
      str([l.get("seedText") for l in skx_off["lines"]]))

# ── 15. Phase C: opt-in energy detector (existence from the envelope, not Basic-Pitch) ──
# detector="energy" swaps the v1-BP-floor + prune ladder for the benchtest-proven gate+dip
# detector, melisma re-derived per-slot from F0. Default ("ladder") is UNCHANGED (every
# check above still passes) — the energy path is the owner-ear-gated adoption candidate.
E_ENV = [0.02] * 10 + [0.5] * 30 + [0.2] * 5 + [0.5] * 30 + [0.02] * 10   # la-la: 1 span, 1 dip
ske = core.build_skeleton_spec([], f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8",
                               env=E_ENV, detector="energy")
check("energy: ok skeleton from the envelope alone (no Basic-Pitch notes needed)",
      ske.get("ok") and ske.get("skeleton", {}).get("algo") == "energy", str(ske.get("skeleton")))
check("energy: gate+dip found 2 syllable nuclei", ske.get("skeleton", {}).get("nuclei") == 2,
      str(ske.get("skeleton")))
check("energy: source/editable tagged like every skeleton", ske.get("source") == "skeleton"
      and ske.get("editable") is True)
check("energy: lineScores emitted for the render path", len(ske.get("lineScores", [])) >= 1,
      str(len(ske.get("lineScores", []))))
# melisma preserved: one continuous span + an F0 step -> 1 slot, 2 pitch segments
E_MEL_ENV = [0.02] * 10 + [0.5] * 80 + [0.02] * 10
E_MEL_F0 = ([{"t": i / 100.0, "hz": 220.0} for i in range(50)]
            + [{"t": i / 100.0, "hz": 277.18} for i in range(50, 100)])
skem = core.build_skeleton_spec([], f0=E_MEL_F0, bpm=120.0, time_sig=(4, 4), grid="1/8",
                                env=E_MEL_ENV, detector="energy")
check("energy: a melisma span is ONE syllable with 2 pitch segments (SoulX glide kept)",
      skem.get("skeleton", {}).get("nuclei") == 1
      and len(((skem.get("lineScores") or [{}])[0].get("slots", [{}])[0]).get("segments", [])) == 2,
      str(skem.get("skeleton")))
# density fix (2026-07-16): a sub-120ms nucleus folds into its neighbour BEFORE binning, so
# no slot ever demands an unsingable syllable. 30-frame span + 6-frame (60ms) span, 50ms gap.
E_SHORT_ENV = [0.02] * 10 + [0.5] * 30 + [0.02] * 5 + [0.5] * 6 + [0.02] * 10
skes = core.build_skeleton_spec([], f0=None, bpm=120.0, time_sig=(4, 4), grid="1/8",
                                env=E_SHORT_ENV, detector="energy")
check("energy: sub-floor nucleus merges into its neighbour (1 slot, not 2)",
      skes.get("skeleton", {}).get("nuclei") == 1, str(skes.get("skeleton")))
check("energy: provenance reports the fold count (shortMerged)",
      skes.get("skeleton", {}).get("shortMerged") == 1, str(skes.get("skeleton")))
# graceful: detector="energy" but no envelope -> the v1 floor (never breaks)
ske_noenv = core.build_skeleton_spec(DUET, f0=None, bpm=120.0, env=None, detector="energy")
check("energy: no envelope -> v1 floor (graceful degrade)",
      ske_noenv.get("skeleton", {}).get("algo") == "v1", str(ske_noenv.get("skeleton")))
# the DEFAULT is unchanged: an env call with no detector arg is still the ladder (v3)
ske_default = core.build_skeleton_spec(DUET, f0=F0_STEP, bpm=120.0, env=FLAT)
check("default detector is still the ladder (v3) — shipped behavior unchanged",
      ske_default.get("skeleton", {}).get("algo") == "v3", str(ske_default.get("skeleton")))

if fails:
    print(f"\nFAILED: {len(fails)} failure(s): {fails}")
    sys.exit(1)
print(f"\nOK: 0 failure(s)")
