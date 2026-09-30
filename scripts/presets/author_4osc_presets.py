#!/usr/bin/env python3
"""Author the five bundled 4OSC presets from musical units.

Every value is converted to the NORMALISED 0..1 form load_preset expects, against the
exact ranges in the pinned Tracktion (tracktion_FourOscPlugin.cpp):
  Tune N          {-36, 36, 1}                 semitones
  Fine Tune N     {-100, 100}                  cents
  Level N         {-100, 0, 0, skew 4}         dB      value = -100 + 100 * p^(1/4)
  Pulse Width N   {0.01, 0.99}
  Detune N        {0, 0.5}                     semitones (only heard with unison > 1)
  Spread N        {-100, 100}                  %
  Pan N           {-1, 1}
  Amp A/D/R       {0.001, 60, 0, skew 0.2}     seconds value = 0.001 + 59.999 * p^5
  Amp Sustain     {0, 100}                     %
  Amp Velocity    {0, 100}                     %
  Filter A/D/R    {0, 60, 0, skew 0.2}         seconds value = 60 * p^5
  Filter Sustain  {0, 100}                     %
  Filter Freq     {0, 135.076232}              MIDI note number (Hz = 440 * 2^((n-69)/12))
  Filter Resonance{0, 100}                     %
  Filter Amount   {-1, 1}                      env depth; cutoff += env * amount * 137 semitones
  Filter Key      {0, 100}                     % key tracking around note 60
  Filter Velocity {0, 100}                     %
Every preset writes the SAME complete key set, so loading one preset after another never
inherits a leftover value (the demo loads Keys, then Bass, on the same track).

usage: python3 scripts/presets/author_4osc_presets.py [out dir, default resources/presets/4osc]
Edit the musical values below, re-run, then render with render_4osc_presets.py and listen.
"""
import json, math, sys
from pathlib import Path

def lin(v, lo, hi): return round((v - lo) / (hi - lo), 4)
def tune(st):       return lin(st, -36, 36)
def cents(c):       return lin(c, -100, 100)
def level(db):      return 0.0 if db <= -100 else round(((db + 100) / 100) ** 4, 4)
def pw(x):          return lin(x, 0.01, 0.99)
def detune(st):     return lin(st, 0, 0.5)
def spread(pct):    return lin(pct, -100, 100)
def pan(x):         return lin(x, -1, 1)
def amp_t(sec):     return round(((max(sec, 0.001) - 0.001) / 59.999) ** 0.2, 4)
def filt_t(sec):    return round((sec / 60.0) ** 0.2, 4)
def pct(x):         return lin(x, 0, 100)
def hz_to_note(hz): return 69 + 12 * math.log2(hz / 440.0)
def ffreq(hz):      return round(hz_to_note(hz) / 135.076232, 4)
def famount(a):     return lin(a, -1, 1)

NONE, SINE, SQUARE, SAW, TRIANGLE, NOISE = range(6)

def patch(*, shapes, voices, ftype, slope, osc, amp, flt, velocity, note):
    """osc: list of 4 dicts {level_db, tune, cents, pw, detune, spread}"""
    params = {}
    for i, o in enumerate(osc, start=1):
        params[f"Level {i}"] = level(o.get("level_db", -100))
        params[f"Tune {i}"] = tune(o.get("tune", 0))
        params[f"Fine Tune {i}"] = cents(o.get("cents", 0))
        params[f"Pulse Width {i}"] = pw(o.get("pw", 0.5))
        params[f"Detune {i}"] = detune(o.get("detune", 0.0))
        params[f"Spread {i}"] = spread(o.get("spread", 0))
        params[f"Pan {i}"] = pan(o.get("pan", 0.0))
    a, d, s, r = amp
    params.update({"Amp Attack": amp_t(a), "Amp Decay": amp_t(d), "Amp Sustain": pct(s),
                   "Amp Release": amp_t(r), "Amp Velocity": pct(velocity)})
    params.update({"Filter Freq": ffreq(flt["hz"]), "Filter Resonance": pct(flt["res"]),
                   "Filter Amount": famount(flt["amount"]), "Filter Key": pct(flt["key"]),
                   "Filter Velocity": pct(flt.get("vel", 0)),
                   "Filter Attack": filt_t(flt["a"]), "Filter Decay": filt_t(flt["d"]),
                   "Filter Sustain": pct(flt["s"]), "Filter Release": filt_t(flt["r"])})
    return {"waveShapes": shapes, "oscVoices": voices, "filterType": ftype, "filterSlope": slope,
            "params": params, "_note": note}

OFF = {"level_db": -100}
LP = 1

PRESETS = {
    # Warm electric-piano-ish: a triangle body with a quiet square an octave up for the
    # tine, a soft (not clicky) attack, a long-ish decay into a moderate sustain, and a
    # 12 dB low-pass whose envelope opens a little on each strike.
    "Keys": patch(
        shapes=[TRIANGLE, SQUARE, NONE, NONE], voices=[1, 1, 1, 1], ftype=LP, slope=12,
        osc=[{"level_db": -10.5}, {"level_db": -24.5, "tune": 12, "pw": 0.35}, OFF, OFF],
        amp=(0.008, 1.4, 45, 0.3), velocity=60,
        flt={"hz": 1400, "res": 10, "amount": 0.18, "key": 50, "a": 0.0, "d": 0.45, "s": 20, "r": 0.3},
        note="Warm EP-ish keys: triangle + quiet square an octave up, soft attack, 12 dB low-pass."),
    # Saw + square sub-octave, 24 dB low-pass with a short envelope snap, tight release.
    "Bass": patch(
        shapes=[SAW, SQUARE, NONE, NONE], voices=[1, 1, 1, 1], ftype=LP, slope=24,
        osc=[{"level_db": -16.5}, {"level_db": -16.5, "tune": -12}, OFF, OFF],
        amp=(0.003, 0.4, 80, 0.12), velocity=40,
        flt={"hz": 420, "res": 15, "amount": 0.22, "key": 30, "a": 0.0, "d": 0.22, "s": 15, "r": 0.12},
        note="Saw + square sub-octave bass, 24 dB low-pass with a short filter snap, short release."),
    # Two detuned 2-voice saws spread in stereo, a slow-ish (0.25 s) swell, 12 dB low-pass.
    "Pad": patch(
        shapes=[SAW, SAW, NONE, NONE], voices=[2, 2, 1, 1], ftype=LP, slope=12,
        osc=[{"level_db": -13.5, "detune": 0.12, "spread": 60},
             {"level_db": -16.5, "detune": 0.2, "spread": -60, "cents": 6}, OFF, OFF],
        amp=(0.25, 1.2, 85, 0.45), velocity=30,
        flt={"hz": 1100, "res": 10, "amount": 0.08, "key": 40, "a": 0.3, "d": 1.0, "s": 60, "r": 0.45},
        note="Detuned saw pad: two 2-voice saws spread wide, 0.25 s swell, 12 dB low-pass."),
    # A 2-voice unison saw with a little square underneath, bright 12 dB low-pass.
    "Lead": patch(
        shapes=[SAW, SQUARE, NONE, NONE], voices=[2, 1, 1, 1], ftype=LP, slope=12,
        osc=[{"level_db": -11, "detune": 0.1, "spread": 35}, {"level_db": -21, "pw": 0.5}, OFF, OFF],
        amp=(0.005, 0.5, 75, 0.2), velocity=50,
        flt={"hz": 4200, "res": 22, "amount": 0.1, "key": 60, "a": 0.0, "d": 0.3, "s": 50, "r": 0.2},
        note="Bright lead: 2-voice unison saw plus a little square, 12 dB low-pass."),
    # Saw + square an octave up through a 24 dB low-pass that snaps open and closes fast.
    "Pluck": patch(
        shapes=[SAW, SQUARE, NONE, NONE], voices=[1, 1, 1, 1], ftype=LP, slope=24,
        osc=[{"level_db": -12}, {"level_db": -20, "tune": 12, "pw": 0.35}, OFF, OFF],
        amp=(0.002, 0.35, 0, 0.15), velocity=60,
        flt={"hz": 330, "res": 25, "amount": 0.35, "key": 50, "a": 0.0, "d": 0.18, "s": 0, "r": 0.15},
        note="Pluck: saw + square an octave up, 24 dB low-pass that snaps open and decays fast."),
}

HEADER = ("Bundled 4OSC starter patch (demo prep 2026-09-23). params are NORMALISED 0..1 against "
          "4OSC's own ranges; waveShapes 0 none/1 sine/2 square/3 saw/4 triangle/5 noise; "
          "filterType 1 = low-pass; oscVoices = per-oscillator unison (max 2). "
          "Generated from musical units by scripts/presets/author_4osc_presets.py (edit there, not here); "
          "owner by-ear approval pending.")

if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2] / "resources" / "presets" / "4osc"
    out.mkdir(parents=True, exist_ok=True)
    for name, p in PRESETS.items():
        p = dict(p)
        p["_note"] = p["_note"] + " " + HEADER
        (out / f"{name}.json").write_text(json.dumps(p, indent=1) + "\n")
        print(name, "release=%.3fs" % (0.001 + 59.999 * p["params"]["Amp Release"] ** 5),
              "attack=%.3fs" % (0.001 + 59.999 * p["params"]["Amp Attack"] ** 5),
              "cutoff=%.0fHz" % (440 * 2 ** ((p["params"]["Filter Freq"] * 135.076232 - 69) / 12)))
