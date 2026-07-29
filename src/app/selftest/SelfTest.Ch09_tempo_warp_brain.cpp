// ── SelfTest.Ch09_tempo_warp_brain.cpp — runSelfTest chapter 9 (RFC 002 A-PR6) ──
// Sections moved VERBATIM from src/app/SelfTest.cpp (pre-split lines 1877-2275), in
// exact pre-split order. The ONLY in-section edits are the identifier adaptations
// forced by promoting compiler-enumerated cross-chapter locals into SelfTestCtx.

#include "app/SelfTest.h"
#include "SelfTestChapters.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "moshops/AgentMemoryStore.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include "state/Migrations.h"
#include "multiplayer/MultiplayerClient.h"
#include "multiplayer/MultiplayerSession.h"
#include "brain/BrainProxy.h"
#include "voice/NativeSpeech.h"
#include "util/Env.h"
#include <juce_cryptography/juce_cryptography.h>
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <map>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    // Thin forwarders keeping the exact pre-split free-function names/signatures,
    // bound to the shared harness state (same instance as SelfTest.cpp's shims).
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    [[maybe_unused]] int& failures = gCtx.failures;
    [[maybe_unused]] int& checks   = gCtx.checks;

    [[maybe_unused]] inline void finishSection()                             { selftest::finishSection (gCtx); }
    [[maybe_unused]] inline void resetSections()                             { selftest::resetSections (gCtx); }
    [[maybe_unused]] inline void section (const juce::String& name)          { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void section (const char* name)                  { selftest::section (gCtx, name); }
    [[maybe_unused]] inline void check (bool cond, const juce::String& what) { selftest::check (gCtx, cond, what); }
    [[maybe_unused]] inline void check (bool cond, const char* what)         { selftest::check (gCtx, cond, what); }

    using selftest::cmd;
    using selftest::args1;
    using selftest::objN;
    using selftest::ok;
    using selftest::tracks;
    using selftest::firstTrack;
    using selftest::trackClips;
    using selftest::trackSnapshotByLogicalId;
    using selftest::selftestTempPath;
}

void runChapter09_tempo_warp_brain (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& trackById = ctx.trackById;

    // ─── Wave T: SES-001 tempo map (tempo / time-sig changes over time) ───
    // The engine's TempoSequence does the math + playback natively; Mosh inserts
    // STEP changes (curve=1.0 -> hold-then-jump; the ramp branch is gated on
    // curve != +-1). ENGINE TRUTH is asserted here via getBpmAt at probe times;
    // the UI's piecewise-constant mapping is exact by construction for steps.
    section ("Wave T: tempo map (SES-001)");
    {
        auto& seq = eng.edit().tempoSequence;
        // Normalize the base for deterministic probes.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "tempo: base 120 ok");
        const int temposBefore = seq.getNumTempos();

        // Insert step changes: 140 @ 10s, 90 @ 20s.
        auto t1 = cmd (ops, "insert_tempo_change", objN ({{ "time", 10.0 }, { "bpm", 140 }}));
        check (ok (t1), "tempo: insert 140 at 10s ok");
        auto t2 = cmd (ops, "insert_tempo_change", objN ({{ "time", 20.0 }, { "bpm", 90 }}));
        check (ok (t2), "tempo: insert 90 at 20s ok");
        check (seq.getNumTempos() == temposBefore + 2, "tempo: two points added");

        // ENGINE truth — step semantics at the probes (exact, no ramp).
        auto bpmAt = [&] (double s) { return seq.getBpmAt (tracktion::TimePosition::fromSeconds (s)); };
        check (std::abs (bpmAt (5.0)  - 120.0) < 0.01, "tempo: engine bpm at 5s == 120");
        check (std::abs (bpmAt (15.0) - 140.0) < 0.01, "tempo: engine bpm at 15s == 140 (step, no ramp)");
        check (std::abs (bpmAt (25.0) -  90.0) < 0.01, "tempo: engine bpm at 25s == 90");
        check (std::abs (bpmAt (9.9)  - 120.0) < 0.01, "tempo: engine bpm just before the change == 120 (hold)");

        // Beats<->seconds round-trip across both boundaries (engine math).
        const auto probeBeats = seq.toBeats (tracktion::TimePosition::fromSeconds (25.0));
        const auto roundTrip  = seq.toTime (probeBeats).inSeconds();
        check (std::abs (roundTrip - 25.0) < 1.0e-6, "tempo: beats<->seconds round-trip across the map");

        // Snapshot serializes the ordered map (additive: session.tempo stays point 0).
        auto sess = ops.snapshot()["session"];
        auto tmv = sess.getProperty ("tempoMap", var());
        check (tmv.isArray() && tmv.size() == temposBefore + 2, "tempo: snapshot tempoMap has all points");
        check (std::abs ((double) tmv[tmv.size() - 1].getProperty ("bpm", 0.0) - 90.0) < 0.01,
               "tempo: snapshot last point is the 90 BPM change");
        check (std::abs ((double) sess.getProperty ("tempo", 0.0) - 120.0) < 0.01,
               "tempo: session.tempo still reports point 0 (back-compat)");

        // Time-sig change @ 30s -> 3/4; map serialized; engine agrees.
        const int sigsBefore = seq.getNumTimeSigs();
        check (ok (cmd (ops, "insert_time_sig_change", objN ({{ "time", 30.0 }, { "numerator", 3 }, { "denominator", 4 }}))),
               "tempo: insert 3/4 at 30s ok");
        check (seq.getNumTimeSigs() == sigsBefore + 1, "tempo: time-sig point added");
        auto sigv = ops.snapshot()["session"].getProperty ("timeSigMap", var());
        check (sigv.isArray() && sigv.size() == sigsBefore + 1, "tempo: snapshot timeSigMap serialized");
        check ((int) sigv[sigv.size() - 1].getProperty ("numerator", 0) == 3, "tempo: last sig point is 3/4");

        // Persistence: the map survives save/reload.
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "tempo: save+reload ok");
        auto& seq2 = eng.edit().tempoSequence;   // reload swapped the Edit
        check (std::abs (seq2.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 140.0) < 0.01,
               "tempo: map survives save/reload (140 at 15s)");

        // remove_tempo_change: drop the middle point -> bpm at 15s reverts to 120.
        check (ok (cmd (ops, "remove_tempo_change", args1 ("index", 1))), "tempo: remove middle point ok");
        check (std::abs (seq2.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 120.0) < 0.01,
               "tempo: bpm at 15s reverts after removal");
        check (ok (cmd (ops, "undo")), "tempo: undo (remove) ok");
        check (std::abs (eng.edit().tempoSequence.getBpmAt (tracktion::TimePosition::fromSeconds (15.0)) - 140.0) < 0.01,
               "tempo: undo restored the 140 change");

        // Guards: index 0 protected; bad args rejected.
        check (! ok (cmd (ops, "remove_tempo_change", args1 ("index", 0))), "tempo: removing point 0 rejected");
        check (! ok (cmd (ops, "remove_tempo_change", args1 ("index", 99))), "tempo: out-of-range index rejected");
        check (! ok (cmd (ops, "insert_tempo_change", objN ({{ "time", -1.0 }, { "bpm", 120 }}))), "tempo: negative time rejected");
        check (! ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 5.0 }, { "bpm", 5000 }}))), "tempo: absurd bpm rejected");
        check (! ok (cmd (ops, "remove_time_sig_change", args1 ("index", 0))), "tempo: removing sig point 0 rejected");
        check (! ok (cmd (ops, "insert_time_sig_change", objN ({{ "time", 5.0 }, { "numerator", 4 }, { "denominator", 5 }}))),
               "tempo: non-power-of-two denominator rejected");

        // JSONL: all four commands undoable:true.
        auto tlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool itU = false, rtU = false, isU = false;
        for (auto& ln : juce::StringArray::fromLines (tlog))
        {
            if (ln.contains ("\"command\": \"insert_tempo_change\"") && ln.contains ("\"undoable\": true")) itU = true;
            if (ln.contains ("\"command\": \"remove_tempo_change\"") && ln.contains ("\"undoable\": true")) rtU = true;
            if (ln.contains ("\"command\": \"insert_time_sig_change\"") && ln.contains ("\"undoable\": true")) isU = true;
        }
        check (itU, "tempo: insert_tempo_change logged undoable:true");
        check (rtU, "tempo: remove_tempo_change logged undoable:true");
        check (isU, "tempo: insert_time_sig_change logged undoable:true");
    }

    // ─── Wave V: tempo RAMPS (Bezier curves) ───
    // curve lives on the point that STARTS a span and shapes the glide TO the next
    // point: 1.0 = step (hold-then-jump), values in (-1,1) ramp. Engine truth via
    // getBpmAt mid-ramp; the snapshot emits the engine-faithful fine sections
    // (its own subdivision boundaries) so the UI mapping stays exact.
    section ("Wave V: tempo ramps (curves)");
    {
        auto& seq = eng.edit().tempoSequence;
        // Clean slate: drop any leftover points from earlier blocks, base 120.
        while (seq.getNumTempos() > 1) cmd (ops, "remove_tempo_change", args1 ("index", 1));
        while (seq.getNumTimeSigs() > 1) cmd (ops, "remove_time_sig_change", args1 ("index", 1));
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "ramp: base 120 ok");

        check (ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 8.0 }, { "bpm", 60 }}))),
               "ramp: insert 60 at 8s ok (step by default)");
        auto bpmAt = [&] (double s) { return seq.getBpmAt (tracktion::TimePosition::fromSeconds (s)); };
        check (std::abs (bpmAt (4.0) - 120.0) < 0.01, "ramp: step span holds 120 mid-way");
        auto snapBefore = ops.snapshot()["session"];
        check (! snapBefore.hasProperty ("tempoSections"), "ramp: step-only map emits NO tempoSections (lean snapshot)");

        // Turn the base span into a LINEAR ramp: 120 glides to 60 across 0..8s.
        check (ok (cmd (ops, "set_tempo_curve", objN ({{ "index", 0 }, { "curve", 0.0 }}))),
               "ramp: set_tempo_curve index 0 -> linear ok");
        const double mid = bpmAt (4.0);
        check (mid < 119.0 && mid > 61.0, "ramp: engine bpm mid-ramp is strictly between 60 and 120");
        check (bpmAt (1.0) > bpmAt (7.0), "ramp: engine bpm decreases monotonically across the ramp");

        // The snapshot now carries the curve + the engine-faithful fine sections.
        auto sess = ops.snapshot()["session"];
        auto tm = sess.getProperty ("tempoMap", var());
        check (std::abs ((double) tm[0].getProperty ("curve", 1.0)) < 0.01, "ramp: tempoMap[0].curve == 0 serialized");
        auto secs = sess.getProperty ("tempoSections", var());
        check (secs.isArray() && secs.size() > seq.getNumTempos(), "ramp: fine tempoSections emitted (more than the points)");
        bool increasing = true;
        for (int i = 1; i < secs.size(); ++i)
            if ((double) secs[i].getProperty ("time", 0.0) <= (double) secs[i - 1].getProperty ("time", 0.0))
                increasing = false;
        check (increasing, "ramp: section times strictly increasing");

        // Undo restores the step (and the lean snapshot); redo restores the ramp.
        check (ok (cmd (ops, "undo")), "ramp: undo (set_tempo_curve) ok");
        check (std::abs (bpmAt (4.0) - 120.0) < 0.01, "ramp: undo restored the step (120 mid-way)");
        check (! ops.snapshot()["session"].hasProperty ("tempoSections"), "ramp: undo removed tempoSections");
        check (ok (cmd (ops, "redo")), "ramp: redo ok");
        check (bpmAt (4.0) < 119.0, "ramp: redo restored the ramp");

        // insert_tempo_change accepts a curve arg directly.
        check (ok (cmd (ops, "insert_tempo_change", objN ({{ "time", 16.0 }, { "bpm", 100 }, { "curve", 0.0 }}))),
               "ramp: insert with curve arg ok");
        auto tm2v = ops.snapshot()["session"].getProperty ("tempoMap", var());
        check (std::abs ((double) tm2v[tm2v.size() - 1].getProperty ("curve", 1.0)) < 0.01,
               "ramp: inserted point carries curve 0");

        // Guards + JSONL.
        check (! ok (cmd (ops, "set_tempo_curve", objN ({{ "index", 99 }, { "curve", 0.0 }}))), "ramp: bad index rejected");
        check (! ok (cmd (ops, "set_tempo_curve", args1 ("index", 0))), "ramp: missing curve rejected");
        auto rlog2 = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool curveU = false;
        for (auto& ln : juce::StringArray::fromLines (rlog2))
            if (ln.contains ("\"command\": \"set_tempo_curve\"") && ln.contains ("\"undoable\": true")) curveU = true;
        check (curveU, "ramp: set_tempo_curve logged undoable:true");

        // Clean up for the warp block: flat 120 map, step curve.
        cmd (ops, "set_tempo_curve", objN ({{ "index", 0 }, { "curve", 1.0 }}));
        while (seq.getNumTempos() > 1) cmd (ops, "remove_tempo_change", args1 ("index", 1));
        cmd (ops, "set_tempo", args1 ("bpm", 120));
    }

    // ─── Wave V: audio WARP (auto-tempo time-stretch) ───
    // setAutoTempo re-anchors the clip in BEATS: its seconds-length re-derives from
    // the live tempo map IMMEDIATELY (no proxy wait) — the headless contract is
    // that halving the tempo doubles the clip's seconds length. Stretching uses
    // the engine's vendored SoundTouch (enabled at build). Warp MARKERS deferred.
    section ("Wave V: audio warp (auto-tempo)");
    {
        auto wt = cmd (ops, "create_track", args1 ("name", "WarpTrack"))["data"].getProperty ("trackId", var()).toString();
        auto wc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 2.0 }, { "freq", 311.0 }}));
        check (ok (wc), "warp: 2s tone clip ok");
        const auto wcid = wc["data"].getProperty ("clipId", var()).toString();
        auto clipLen = [&]() -> double {
            auto tv = trackById (wt);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == wcid)
                        return (double) c.getProperty ("length", 0.0);
            return -1.0;
        };
        check (std::abs (clipLen() - 2.0) < 0.05, "warp: clip starts at 2.0s");

        // Enable warp: 1:1 at the current tempo (sourceBpm defaults to the map).
        auto w1 = cmd (ops, "set_clip_warp", objN ({{ "clipId", wcid }, { "autoTempo", true }}));
        check (ok (w1), "warp: enable ok");
        check (w1["data"].getProperty ("stretchMode", var()).toString().containsIgnoreCase ("soundtouch"),
               "warp: stretch mode is SoundTouch (vendored stretcher compiled in)");
        check (std::abs (clipLen() - 2.0) < 0.05, "warp: enabling at the same tempo is a 1:1 no-op");
        {
            auto tv = trackById (wt);
            auto cv = tv.getProperty ("clips", var());
            bool autoT = false; double srcBpm = 0;
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == wcid)
                    { autoT = (bool) c.getProperty ("autoTempo", false); srcBpm = (double) c.getProperty ("sourceBpm", 0.0); }
            check (autoT, "warp: snapshot clip carries autoTempo");
            check (std::abs (srcBpm - 120.0) < 0.5, "warp: sourceBpm defaulted to the map tempo (120)");
        }

        // THE CONTRACT: halve the tempo -> the warped clip's seconds-length doubles.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 60))), "warp: tempo 120 -> 60 ok");
        check (std::abs (clipLen() - 4.0) < 0.1, "warp: half tempo DOUBLES the clip length (4.0s)");
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 120))), "warp: tempo back to 120 ok");
        check (std::abs (clipLen() - 2.0) < 0.1, "warp: restoring tempo restores the length (2.0s)");

        // Warp OFF: the clip is seconds-anchored again; tempo changes leave it alone.
        check (ok (cmd (ops, "set_clip_warp", objN ({{ "clipId", wcid }, { "autoTempo", false }}))), "warp: disable ok");
        cmd (ops, "set_tempo", args1 ("bpm", 60));
        check (std::abs (clipLen() - 2.0) < 0.1, "warp: unwarped clip ignores the tempo change");
        cmd (ops, "set_tempo", args1 ("bpm", 120));

        // Guards + posture.
        check (! ok (cmd (ops, "set_clip_warp", args1 ("clipId", wcid))), "warp: missing autoTempo rejected");
        check (! ok (cmd (ops, "set_clip_warp", objN ({{ "clipId", "no-such" }, { "autoTempo", true }}))), "warp: bad clipId rejected");
        auto wlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool warpU = false;
        for (auto& ln : juce::StringArray::fromLines (wlog))
            if (ln.contains ("\"command\": \"set_clip_warp\"") && ln.contains ("\"undoable\": true")) warpU = true;
        check (warpU, "warp: set_clip_warp logged undoable:true");

        cmd (ops, "remove_track", args1 ("trackId", wt));   // tidy
    }

    // Ableton-style "easy warp": stretch a clip to a target length / bar count
    // (deriving sourceBpm) and detect a loop's BPM offline. stretch_clip drives the
    // drag-to-stretch gesture + the Inspector Fit/×2/÷2 helpers; detect_clip_bpm feeds
    // the auto-lock-to-grid path. Deterministic — the detector is pure C++ (no service).
    section ("Wave V2: stretch_clip + detect_clip_bpm (easy warp)");
    {
        auto st = cmd (ops, "create_track", args1 ("name", "StretchTrack"))["data"].getProperty ("trackId", var()).toString();
        auto sc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        check (ok (sc), "stretch: 2s tone clip ok");
        const auto scid = sc["data"].getProperty ("clipId", var()).toString();
        auto len = [&]() -> double {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == scid)
                        return (double) c.getProperty ("length", 0.0);
            return -1.0;
        };
        auto warpedOn = [&]() -> bool {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == scid)
                        return (bool) c.getProperty ("autoTempo", false);
            return false;
        };
        check (std::abs (len() - 2.0) < 0.05, "stretch: clip starts at 2.0s");

        // Stretch to a 3.0s warped length -> the clip fills 3.0s and warp turns on.
        auto s1 = cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "length", 3.0 }}));
        check (ok (s1), "stretch: to 3.0s ok");
        check (std::abs (len() - 3.0) < 0.1, "stretch: clip is now 3.0s");
        check (warpedOn(), "stretch: enabling stretch turns auto-tempo on");
        check (std::abs ((double) s1["data"].getProperty ("length", 0.0) - 3.0) < 0.1, "stretch: result reports 3.0s length");

        // ÷2 (stretch to 1.5s), then fit-to-bars at 120bpm 4/4 (1 bar = 2.0s, 2 bars = 4.0s).
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "length", 1.5 }}))), "stretch: to 1.5s ok");
        check (std::abs (len() - 1.5) < 0.1, "stretch: halved to 1.5s");
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "bars", 1.0 }}))), "stretch: fit 1 bar ok");
        check (std::abs (len() - 2.0) < 0.1, "stretch: 1 bar == 2.0s at 120bpm 4/4");
        check (ok (cmd (ops, "stretch_clip", objN ({{ "clipId", scid }, { "bars", 2.0 }}))), "stretch: fit 2 bars ok");
        check (std::abs (len() - 4.0) < 0.1, "stretch: 2 bars == 4.0s at 120bpm 4/4");

        // Undo restores the 1-bar length; the command is logged undoable.
        check (ok (cmd (ops, "undo")), "stretch: undo ok");
        check (std::abs (len() - 2.0) < 0.1, "stretch: undo restores 1-bar length (2.0s)");
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool stretchU = false;
            for (auto& ln : juce::StringArray::fromLines (slog))
                if (ln.contains ("\"command\": \"stretch_clip\"") && ln.contains ("\"undoable\": true")) stretchU = true;
            check (stretchU, "stretch: stretch_clip logged undoable:true");
        }

        // Guards.
        check (! ok (cmd (ops, "stretch_clip", args1 ("clipId", scid))), "stretch: missing length/bars rejected");
        check (! ok (cmd (ops, "stretch_clip", objN ({{ "clipId", "nope" }, { "length", 2.0 }}))), "stretch: bad clipId rejected");

        // detect_clip_bpm on a pure tone: read-only, no pulse -> either errors or low
        // confidence. Must not crash and must not spuriously claim a strong beat.
        auto dTone = cmd (ops, "detect_clip_bpm", args1 ("clipId", scid));
        if (ok (dTone))
            check ((double) dTone["data"].getProperty ("confidence", 1.0) < 0.5, "detect: pure tone -> low confidence");
        else
            check (true, "detect: pure tone reported no reliable pulse (ok)");

        // detect_clip_bpm on a synthesized 120bpm click track -> ~120 with confidence.
        auto makeClickWav = [&] (double bpm, double seconds, const juce::String& name) -> juce::File
        {
            const double sr = 44100.0;
            const juce::int64 n = (juce::int64) (sr * seconds);
            juce::AudioBuffer<float> buf (1, (int) n);
            buf.clear();
            const int clickLen = (int) (sr * 0.01);   // 10ms click
            const double period = 60.0 / bpm;         // seconds per beat
            for (double t = 0.0; t < seconds; t += period)
            {
                const juce::int64 s0 = (juce::int64) (t * sr);
                for (int i = 0; i < clickLen && (s0 + i) < n; ++i)
                {
                    const float env = 1.0f - (float) i / (float) clickLen;
                    buf.setSample (0, (int) (s0 + i), env * std::sin ((float) i * 0.9f));
                }
            }
            auto dir = eng.sessionDir().getChildFile ("stretch-test");
            dir.createDirectory();
            auto f = dir.getChildFile (name);
            f.deleteFile();
            juce::WavAudioFormat fmt;
            if (auto os = std::unique_ptr<juce::FileOutputStream> (f.createOutputStream()))
            {
                std::unique_ptr<juce::AudioFormatWriter> w (
                    fmt.createWriterFor (os.get(), sr, 1u, 16, {}, 0));
                if (w != nullptr) { os.release(); w->writeFromAudioSampleBuffer (buf, 0, (int) n); }
            }
            return f;
        };
        auto clickFile = makeClickWav (120.0, 4.0, "click120.wav");
        check (clickFile.existsAsFile(), "detect: synthesized a 120bpm click WAV");
        auto imp = cmd (ops, "import_clip", objN ({{ "trackId", st }, { "file", clickFile.getFullPathName() }}));
        check (ok (imp), "detect: import click track ok");
        const auto clickId = imp["data"].getProperty ("clipId", var()).toString();
        auto det = cmd (ops, "detect_clip_bpm", args1 ("clipId", clickId));
        check (ok (det), "detect: 120bpm click detected ok");
        const double dbpm = (double) det["data"].getProperty ("bpm", 0.0);
        check (std::abs (dbpm - 120.0) < 3.0, "detect: reported BPM ~120");
        check ((double) det["data"].getProperty ("confidence", 0.0) > 0.2, "detect: strong pulse -> good confidence");

        // Enabling warp with detect:true on the click locks sourceBpm to the detected
        // tempo (~120); the DEFAULT path (no detect) stays a 1:1 no-op (proven above).
        auto wd = cmd (ops, "set_clip_warp", objN ({{ "clipId", clickId }, { "autoTempo", true }, { "detect", true }}));
        check (ok (wd), "detect: set_clip_warp detect:true ok");
        {
            auto tv = trackById (st);
            auto cv = tv.getProperty ("clips", var());
            double srcBpm = 0.0;
            if (auto* arr = cv.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clickId)
                        srcBpm = (double) c.getProperty ("sourceBpm", 0.0);
            check (std::abs (srcBpm - 120.0) < 3.0, "detect: warp detect locked sourceBpm to ~120");
        }
        check (! ok (cmd (ops, "detect_clip_bpm", args1 ("clipId", "no-such"))), "detect: bad clipId rejected");

        cmd (ops, "remove_track", args1 ("trackId", st));   // tidy
    }

    section ("Moshi brain proxy + native voice (packaged-app pieces)");
    {
        // Deterministic provider resolution — set known env, no network calls.
        mosh::setEnvVar ("MOSH_IGNORE_BUNDLED_BRAIN_CONFIG", "1");
        mosh::setEnvVar ("DEEPSEEK_BASE_URL", "https://api.deepseek.test");
        mosh::setEnvVar ("DEEPSEEK_MODEL", "deepseek-test");
        mosh::setEnvVar ("DEEPSEEK_API_KEY", "sk-test-deepseek");
        mosh::setEnvVar ("XAI_BASE_URL", "https://api.x.test");
        mosh::setEnvVar ("XAI_MODEL", "grok-test");
        mosh::setEnvVar ("XAI_API_KEY", "sk-test-xai");
        mosh::unsetEnvVar ("OPENAI_API_KEY");          // leave openai incomplete
        mosh::setEnvVar ("MOSHI_BRAIN_PROVIDER", "xai");

        auto info  = BrainProxy::providersInfo();
        auto provs = info.getProperty ("providers", var());
        check (provs.isArray() && provs.getArray()->size() == 3,
               "brain: three providers enumerated (deepseek/openai/xai)");

        auto chosen = BrainProxy::resolve();    // honours MOSHI_BRAIN_PROVIDER=xai
        check (chosen.id == "xai", "brain: MOSHI_BRAIN_PROVIDER selects the default provider");
        check (chosen.url == "https://api.x.test" && chosen.model == "grok-test",
               "brain: resolved provider carries its env url/model");

        check (BrainProxy::resolve ("deepseek").id == "deepseek",
               "brain: an explicit complete provider is honoured over the default");

        auto fallback = BrainProxy::resolve ("openai");   // incomplete → fall back
        check (fallback.id != "openai" && fallback.isComplete(),
               "brain: an incomplete requested provider falls back to a configured one");

        auto badShape = BrainProxy::chat (var(), "deepseek");   // not an array → no HTTP
        check (! (bool) badShape.getProperty ("ok", true)
                   && badShape.getProperty ("error", var()).toString().isNotEmpty(),
               "brain: chat() rejects a non-array messages payload with an error shape");

        // Clear every key → no provider resolves and chat() errors cleanly (no network).
        mosh::unsetEnvVar ("DEEPSEEK_API_KEY"); mosh::unsetEnvVar ("XAI_API_KEY"); mosh::unsetEnvVar ("MOSHI_BRAIN_PROVIDER");
        check (! BrainProxy::resolve().isComplete(), "brain: nothing resolves when no key is set");
        auto noProv = BrainProxy::chat (var (Array<var>{}), juce::String());
        check (! (bool) noProv.getProperty ("ok", true),
               "brain: chat() with no provider returns { ok:false } (no crash, no network)");
        mosh::unsetEnvVar ("MOSH_IGNORE_BUNDLED_BRAIN_CONFIG");

        // Native speech: probe availability + lifecycle without requesting permission.
       #if JUCE_MAC
        check (NativeSpeech::isSupported(), "voice: macOS Speech available (SFSpeechRecognizer present)");
       #endif
        NativeSpeech sp;
        check (! sp.isListening(), "voice: a fresh NativeSpeech is idle");
        sp.stop();   // stop-while-idle must be a safe no-op
        check (! sp.isListening(), "voice: stop() while idle is a safe no-op");
    }
}

} // namespace mosh
