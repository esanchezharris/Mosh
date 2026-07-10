"""Golden test for the whole-clip coverage DSP (service/stitch.py + coverage.py).

Deterministic + stdlib-only (no model): proves tile_to_length / stitch_windows produce the
right length and BYTE-IDENTICAL output across runs (so golden checksums stay stable), and that
coverage.render routes loop→tile / long→stitch / short→single. Run via gate.sh run_py_tests
(named *_test.py); meant to pass 3× deterministically.
"""
import hashlib
import math
import os
import struct
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # service/
import coverage
import stitch


def _mk(path, secs, sr=44100, freq=220.0, ch=2):
    with wave.open(path, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(sr)
        body = bytearray()
        for i in range(int(sr * secs)):
            v = int(0.4 * 32767 * math.sin(2 * math.pi * freq * i / sr))
            body += struct.pack("<" + "h" * ch, *([v] * ch))
        w.writeframes(bytes(body))


def _mk24(path, secs, sr=44100, freq=220.0, ch=2):
    """Synthesize a 24-bit PCM WAV — what bounceClipToWav (bitDepth=24) produces for
    MIDI/drum bounces that feed whole-clip stitch coverage."""
    with wave.open(path, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(3); w.setframerate(sr)
        body = bytearray()
        for i in range(int(sr * secs)):
            v = int(0.4 * 8388607 * math.sin(2 * math.pi * freq * i / sr)) & 0xFFFFFF
            frame = bytes((v & 0xFF, (v >> 8) & 0xFF, (v >> 16) & 0xFF)) * ch
            body += frame
        w.writeframes(bytes(body))


def _pcm(path):
    """Return (sampwidth, raw PCM body) so we can assert byte-exact round-trip fidelity."""
    with wave.open(path, "rb") as w:
        return w.getsampwidth(), w.readframes(w.getnframes())


def _md5(path):
    return hashlib.md5(open(path, "rb").read()).hexdigest()


def main():
    td = tempfile.mkdtemp(prefix="stitch-test-")
    src1 = os.path.join(td, "cycle.wav"); _mk(src1, 2.0, freq=220.0)
    win0 = os.path.join(td, "w0.wav"); _mk(win0, 8.0, freq=180.0)
    win1 = os.path.join(td, "w1.wav"); _mk(win1, 8.0, freq=240.0)

    # tile_to_length: a 2s cycle filled to 9s, exact length + deterministic.
    t1 = os.path.join(td, "tile_a.wav"); stitch.tile_to_length(src1, t1, 9.0)
    t2 = os.path.join(td, "tile_b.wav"); stitch.tile_to_length(src1, t2, 9.0)
    assert abs(stitch.wav_duration(t1) - 9.0) < 0.01, "tile length"
    assert _md5(t1) == _md5(t2), "tile deterministic"

    # stitch_windows: two 8s windows → 16s continuous, exact length + deterministic.
    s1 = os.path.join(td, "stitch_a.wav"); stitch.stitch_windows([win0, win1], s1, 16.0)
    s2 = os.path.join(td, "stitch_b.wav"); stitch.stitch_windows([win0, win1], s2, 16.0)
    assert abs(stitch.wav_duration(s1) - 16.0) < 0.05, "stitch length"
    assert _md5(s1) == _md5(s2), "stitch deterministic"

    # 24-bit input (MIDI/drum bounces are bitDepth=24): slice must not raise, must stay
    # 24-bit, and round-trip the sliced PCM byte-for-byte (whole-clip stitch coverage feeds
    # slice_wav the DAW-staged input directly).
    in24 = os.path.join(td, "in24.wav"); _mk24(in24, 1.0, freq=220.0)
    sl24 = os.path.join(td, "slice24.wav"); stitch.slice_wav(in24, sl24, 0.0, 0.5)
    sw_sl, _ = _pcm(sl24)
    assert sw_sl == 3, "24-bit slice preserves sample width"
    assert abs(stitch.wav_duration(sl24) - 0.5) < 0.01, "24-bit slice length"
    # slicing the ENTIRE clip [0, dur) must return the source PCM byte-identically.
    full24 = os.path.join(td, "full24.wav"); stitch.slice_wav(in24, full24, 0.0, 1.0)
    assert _pcm(full24) == _pcm(in24), "24-bit slice round-trip fidelity (byte-identical)"
    # deterministic across runs (byte-identical) → golden checksums stay stable.
    sl24b = os.path.join(td, "slice24b.wav"); stitch.slice_wav(in24, sl24b, 0.0, 0.5)
    assert _md5(sl24) == _md5(sl24b), "24-bit slice deterministic"

    # coverage.render routing with a trivial passthrough window renderer.
    def passthrough(in_wav, out_wav, params):
        seg, ch, sr, sw = stitch._read(in_wav)
        stitch._write(out_wav, seg, ch, sr, sw)
        return {"ok": True}

    long_in = os.path.join(td, "long.wav"); _mk(long_in, 20.0)
    # capped window (8s) + no explicit loop → stitch to 20s.
    o_st = os.path.join(td, "cov_stitch.wav")
    m = coverage.render(passthrough, long_in, o_st, {"coverage": "auto", "duration_s": 20.0}, 8.0)
    assert m["coverage"] == "stitch" and abs(stitch.wav_duration(o_st) - 20.0) < 0.1, "coverage stitch"
    # explicit loop → tile one 8s cycle to 20s.
    o_lp = os.path.join(td, "cov_loop.wav")
    m = coverage.render(passthrough, long_in, o_lp, {"coverage": "loop", "duration_s": 20.0, "loop_seconds": 4.0}, 8.0)
    assert m["coverage"] == "loop" and abs(stitch.wav_duration(o_lp) - 20.0) < 0.1, "coverage loop"
    # short clip (fits the window) → single passthrough.
    short_in = os.path.join(td, "short.wav"); _mk(short_in, 3.0)
    o_sg = os.path.join(td, "cov_single.wav")
    m = coverage.render(passthrough, short_in, o_sg, {"coverage": "auto", "duration_s": 3.0}, 8.0)
    assert m["coverage"] == "single" and abs(stitch.wav_duration(o_sg) - 3.0) < 0.1, "coverage single"

    print("stitch_test: OK (tile/stitch length + determinism, coverage routing loop/stitch/single)")


if __name__ == "__main__":
    main()
