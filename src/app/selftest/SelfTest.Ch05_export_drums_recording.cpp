// ── SelfTest.Ch05_export_drums_recording.cpp — runSelfTest chapter 5 (RFC 002 A-PR5) ──────
// Sections moved VERBATIM by prefix-motion from src/app/SelfTest.cpp
// (pre-split lines 2728-4330), in exact pre-split order:
//   . "Stage 6: full producer loop + export" (+ 1 nested)
//   . "Export range + tail policy (G1)"
//   . "Serum render compatibility (optional local plugin gate)"
//   . "G7: per-track stem export (common zero point)"
//   . "Drums make sound (DRM-001)"
//   . "add_drum_pattern (DRM-002)" (+ 3 nested gated)
//   . "Wave 4: MIDI note editing"
//   . "Wave 8: sends / returns / aux buses"
//   . "Wave 9: channel metering"
//   . "METER-001: auto-meter every track-creation path"
//   . "Wave: recording (arm / input monitor)" (+ 1 nested)
//   . "MON-003: monitoring round-trip latency readout"
// The ONLY in-section edits are the identifier adaptations forced by promoting
// compiler-enumerated cross-chapter locals into SelfTestCtx (SelfTestSupport.h);
// the check messages and their order are byte-identical to the pre-split file.

#include "app/SelfTest.h"
#include "SelfTestChapters.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "engine/SessionPaths.h"
#include "moshops/MoshOps.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
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

void runChapter05_export_drums_recording (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;
    auto& eventTypes = ctx.eventTypes;
    auto& hadEvent = ctx.hadEvent;
    auto& trackById = ctx.trackById;

    // --- Stage 6: full producer loop -> export, undo/redo correct throughout ---
    section ("Stage 6: full producer loop + export");
    {
        // import/record -> arrange
        auto mt = cmd (ops, "create_track", args1 ("name", "Mix"))["data"].getProperty ("trackId", var()).toString();
        auto mtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", mt }, { "seconds", 1.0 }, { "freq", 165.0 }}));
        auto mcid = mtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "move_clip", objN ({{ "clipId", mcid }, { "start", 0.5 }}));
        cmd (ops, "trim_clip", objN ({{ "clipId", mcid }, { "length", 0.8 }}));

        // host VST3 (if any scanned)
        String fxId2;
        { auto lp2 = cmd (ops, "list_plugins");
          if (auto* arr = lp2["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if (isHarnessHostablePlugin (p) && ! (bool) p.getProperty ("isInstrument", false) && fxId2.isEmpty())
                fxId2 = p.getProperty ("id", var()).toString(); }
        if (fxId2.isNotEmpty())
            check (ok (cmd (ops, "load_plugin", objN ({{ "trackId", mt }, { "pluginId", fxId2 }}))), "host VST3 effect on the mix track");

        // generative transform (Tier B)
        cmd (ops, "create_render_layer", objN ({{ "clipId", mcid }, { "adapter", "fake" }}));
        cmd (ops, "set_render_param", objN ({{ "clipId", mcid }, { "seed", 7 }}));
        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (rr), "generative transform rendered");
        cmd (ops, "accept_render", args1 ("clipId", mcid));

        // mix
        cmd (ops, "set_track_volume", objN ({{ "trackId", mt }, { "db", -4.0 }}));

        // export
        auto exp = cmd (ops, "export_audio", objN ({{ "file", "" }}));
        check (ok (exp), "export_audio ok");
        const auto exportFile = exp["data"].getProperty ("file", var()).toString();
        check (File (exportFile).existsAsFile() && (juce::int64) exp["data"].getProperty ("bytes", 0) > 1000,
               "export produced a non-empty WAV (full producer loop)");

        check (std::abs ((double) trackById (mt).getProperty ("volumeDb", 0.0) + 4.0) < 0.5, "mix volume applied (-4 dB)");

        // undo/redo correct throughout (a clean undoable op after the full loop)
        cmd (ops, "rename_track", objN ({{ "trackId", mt }, { "name", "Master Bus" }}));
        check (trackById (mt).getProperty ("name", var()).toString() == "Master Bus", "rename applied");
        cmd (ops, "undo");
        check (trackById (mt).getProperty ("name", var()).toString() == "Mix", "undo reverted the rename");
        cmd (ops, "redo");
        check (trackById (mt).getProperty ("name", var()).toString() == "Master Bus", "redo restored the rename");

        // --- IOX-002 / IOX-007: export format / bit-depth / sample-rate options ---
        // Renders headless (no device) like the export above. Each check exercises the
        // format-resolution + bit-depth-validation path, not just the happy WAV case.
        section ("Export format / depth options (IOX-002, IOX-007)");
        auto wavFile  = eng.sessionDir().getChildFile ("exports").getChildFile ("opt-test.wav");
        auto aiffFile = eng.sessionDir().getChildFile ("exports").getChildFile ("opt-test.aiff");

        auto expWav = cmd (ops, "export_audio", objN ({{ "file", wavFile.getFullPathName() },
                                                       { "format", "wav" }, { "bitDepth", 16 }}));
        check (ok (expWav), "export_audio wav 16-bit ok");
        {
            const auto outName = expWav["data"].getProperty ("file", var()).toString();
            File out (outName);
            check (out.existsAsFile() && out.getSize() > 0 && out.getFileExtension().toLowerCase() == ".wav",
                   "wav export produced a non-empty .wav file");
            check (expWav["data"].getProperty ("format", var()).toString() == "wav",
                   "wav export reports format wav");
            check ((int) expWav["data"].getProperty ("bitDepth", 0) == 16,
                   "wav export reports bitDepth 16");
        }

        auto expAiff = cmd (ops, "export_audio", objN ({{ "file", aiffFile.getFullPathName() },
                                                        { "format", "aiff" }, { "bitDepth", 24 }}));
        check (ok (expAiff), "export_audio aiff 24-bit ok");
        {
            const auto outName = expAiff["data"].getProperty ("file", var()).toString();
            File out (outName);
            check (out.existsAsFile() && out.getSize() > 0 && out.getFileExtension().toLowerCase() == ".aiff",
                   "aiff export produced a non-empty .aiff file");
            check (expAiff["data"].getProperty ("format", var()).toString() == "aiff",
                   "aiff export reports format aiff");
            check ((int) expAiff["data"].getProperty ("bitDepth", 0) == 24,
                   "aiff export reports bitDepth 24 (depth arg honored for non-wav)");
        }

        auto expBadFormat = cmd (ops, "export_audio", objN ({{ "file", wavFile.getFullPathName() },
                                                             { "format", "mp3" }}));
        check (! ok (expBadFormat), "export_audio rejects an unsupported format (mp3)");

        auto expBadDepth = cmd (ops, "export_audio", objN ({{ "file", wavFile.getFullPathName() },
                                                            { "format", "wav" }, { "bitDepth", 7 }}));
        check (! ok (expBadDepth), "export_audio rejects an unsupported bit depth (wav 7)");

        // Clean up the temp export files.
        wavFile.deleteFile();
        aiffFile.deleteFile();
    }

    // --- G1: export range/section + delay-tail policy --------------------------
    // export_audio {range,start,end,tail,tailSeconds} — invariants 78 (render the
    // intended span: full/loop/custom) and 81 (delay/reverb tails include-or-cut on
    // an explicit policy). new_project isolates a clean edit (mirrors the mp-export
    // and relink-export isolation sections above) so edit.getLength() is exactly the
    // one 4s test-tone clip we add here, not the cumulative length of every clip the
    // earlier sections in this run have staged.
    section ("Export range + tail policy (G1)");
    {
        // gap 2 — the project you LEAVE must stay reachable from Recent.
        //
        // This rides the harness's FIRST project operation on purpose: rememberProject
        // was only ever called for the INCOMING file, so a project that entered editPath
        // WITHOUT being opened never made it into last-project.json at all. In-process the
        // only such project is the cold-start edit — which is exactly the one a producer
        // is looking at when the launch picker offers "Start empty". Anywhere later in the
        // harness the outgoing project has already been remembered as some earlier
        // command's incoming file, so the check would pass with or without the fix.
        const auto coldStartEdit = eng.editFile();
        {
            auto before = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
            bool listedBefore = false;
            for (int i = 0; i < before.size(); ++i)
                if (before[i].getProperty ("path", var()).toString() == coldStartEdit.getFullPathName())
                    listedBefore = true;
            // Anti-vacuity: if the cold-start edit were ALREADY in Recent, the assertion
            // below would pass for the wrong reason. Runs isolated (the default), so this
            // holds; a reused MOSH_SELFTEST_SESSION would trip it, which is the honest
            // signal that the run is not clean.
            check (! listedBefore, "cold-start edit is not yet in Recent (precondition)");
        }

        check (ok (cmd (ops, "new_project", args1 ("name", "g1-export-selftest"))), "new_project (G1 export isolation) ok");

        {
            auto after = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
            bool listedAfter = false;
            for (int i = 0; i < after.size(); ++i)
                if (after[i].getProperty ("path", var()).toString() == coldStartEdit.getFullPathName())
                    listedAfter = true;
            check (listedAfter, "new_project keeps the OUTGOING (cold-start) project in Recent");
            check (after.size() > 0 && after[0].getProperty ("path", var()).toString() == eng.editFile().getFullPathName(),
                   "the newly-created project is still Recent[0] (newest-first preserved)");
        }

        auto gt = cmd (ops, "create_track", args1 ("name", "G1 Tone"))["data"].getProperty ("trackId", var()).toString();
        // freq 337 is unique to this section: add_test_tone_clip caches the generated
        // WAV by int(freq) and reuses it (duration is NOT in the key — see the LoRA
        // rack section's note above), so sharing a frequency with another section that
        // expects a different duration (e.g. the 220Hz/2s tone elsewhere in this file)
        // would silently give G1's clip the WRONG length and fail the rangeEnd/seconds
        // assertions below.
        check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt }, { "seconds", 4.0 }, { "freq", 337.0 }}))),
               "G1: add_test_tone_clip (4s) ok");

        auto g1Dir = eng.sessionDir().getChildFile ("exports");

        // range:'loop' with NO loop set yet (a fresh edit's loop is {0,0}) -> error,
        // BEFORE any loop has been configured below.
        check (! ok (cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-noloop.wav").getFullPathName() },
                                                       { "range", "loop" }}))),
               "G1: range:'loop' errors when no loop region is set");

        // Invalid enums / a degenerate custom range all error BEFORE any render
        // (no partial file is ever produced by these).
        check (! ok (cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-bogus-range.wav").getFullPathName() },
                                                       { "range", "bogus" }}))),
               "G1: rejects an invalid range enum");
        check (! ok (cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-bogus-tail.wav").getFullPathName() },
                                                       { "tail", "bogus" }}))),
               "G1: rejects an invalid tail enum");
        check (! ok (cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-bad-custom.wav").getFullPathName() },
                                                       { "range", "custom" }, { "start", 3.0 }, { "end", 1.0 }}))),
               "G1: rejects a custom range where end <= start");
        check (! ok (cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-missing-custom.wav").getFullPathName() },
                                                       { "range", "custom" }}))),
               "G1: range:'custom' without start/end errors");

        // Full export (no new args) — behaviorally identical to pre-G1: whole edit, no tail.
        auto expFull = cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-full.wav").getFullPathName() }}));
        check (ok (expFull), "G1: full export (no new args) ok");
        check (expFull["data"].getProperty ("range", var()).toString() == "full", "G1: full export reports range=='full'");
        check (std::abs ((double) expFull["data"].getProperty ("rangeStart", -1.0)) < 1.0e-6, "G1: full export rangeStart==0");
        check (std::abs ((double) expFull["data"].getProperty ("rangeEnd", -1.0) - 4.0) < 0.05, "G1: full export rangeEnd~=4");
        check (std::abs ((double) expFull["data"].getProperty ("seconds", -1.0) - 4.0) < 0.05, "G1: full export seconds~=4");
        const juce::int64 bytesFull = (juce::int64) expFull["data"].getProperty ("bytes", 0);
        check (bytesFull > 1000, "G1: full export produced a non-trivial file");

        // Custom range renders ONLY [start,end] — the direct proof of invariant 78:
        // a shorter requested span must produce a proportionally smaller file.
        auto expCustom = cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-custom.wav").getFullPathName() },
                                                          { "range", "custom" }, { "start", 1.0 }, { "end", 3.0 }}));
        check (ok (expCustom), "G1: custom range export ok");
        check (expCustom["data"].getProperty ("range", var()).toString() == "custom", "G1: custom export reports range=='custom'");
        check (std::abs ((double) expCustom["data"].getProperty ("rangeStart", -1.0) - 1.0) < 0.05, "G1: custom rangeStart~=1");
        check (std::abs ((double) expCustom["data"].getProperty ("rangeEnd", -1.0) - 3.0) < 0.05, "G1: custom rangeEnd~=3");
        check (std::abs ((double) expCustom["data"].getProperty ("seconds", -1.0) - 2.0) < 0.05, "G1: custom seconds~=2");
        const juce::int64 bytesCustom = (juce::int64) expCustom["data"].getProperty ("bytes", 0);
        check (bytesCustom > 0 && bytesCustom < bytesFull,
               "G1: custom (2s) render is SMALLER than full (4s) render — proves only the range rendered");

        // range:'loop' renders the transport loop region.
        check (ok (cmd (ops, "set_transport", objN ({{ "loopStart", 0.5 }, { "loopEnd", 2.5 }}))),
               "G1: set_transport loop 0.5-2.5 ok");
        auto expLoop = cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-loop.wav").getFullPathName() },
                                                        { "range", "loop" }}));
        check (ok (expLoop), "G1: loop export ok");
        check (expLoop["data"].getProperty ("range", var()).toString() == "loop", "G1: loop export reports range=='loop'");
        check (std::abs ((double) expLoop["data"].getProperty ("rangeStart", -1.0) - 0.5) < 0.05, "G1: loop rangeStart~=0.5");
        check (std::abs ((double) expLoop["data"].getProperty ("rangeEnd", -1.0) - 2.5) < 0.05, "G1: loop rangeEnd~=2.5");

        // Delay-tail policy (invariant 81) — needs something actually decaying: load a
        // built-in reverb, pushed hot (big room, fully wet) so the tail rings well past
        // the render's end, then compare tail:'cut' vs tail:'include' on the SAME short
        // custom range. A silence-trim edge case (no decaying source) would make
        // include==cut — see the spec's §6 note; the reverb is what makes this definitive.
        auto rvLoad = cmd (ops, "load_builtin", objN ({{ "trackId", gt }, { "type", "reverb" }}));
        check (ok (rvLoad), "G1: load reverb on the tone track ok");
        const int rvIndex = (int) rvLoad["data"].getProperty ("index", -1);
        // Param order (tracktion_Reverb.cpp): 0 roomSize, 1 damping, 2 wetLevel, 3 dryLevel, 4 width, 5 mode.
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", rvIndex }, { "paramIndex", 0 }, { "value", 0.95 }}))),
               "G1: reverb roomSize set high");
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", rvIndex }, { "paramIndex", 2 }, { "value", 1.0 }}))),
               "G1: reverb wetLevel set high");

        auto expCut = cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-tail-cut.wav").getFullPathName() },
                                                       { "range", "custom" }, { "start", 0.0 }, { "end", 1.0 }, { "tail", "cut" }}));
        check (ok (expCut), "G1: tail=cut export ok");
        check (expCut["data"].getProperty ("tail", var()).toString() == "cut", "G1: tail=cut echoed in result");
        check (std::abs ((double) expCut["data"].getProperty ("endAllowance", -1.0)) < 1.0e-6, "G1: tail=cut endAllowance==0");
        const juce::int64 bytesCut = (juce::int64) expCut["data"].getProperty ("bytes", 0);

        auto expInclude = cmd (ops, "export_audio", objN ({{ "file", g1Dir.getChildFile ("g1-tail-include.wav").getFullPathName() },
                                                           { "range", "custom" }, { "start", 0.0 }, { "end", 1.0 },
                                                           { "tail", "include" }, { "tailSeconds", 2.0 }}));
        check (ok (expInclude), "G1: tail=include export ok");
        check (expInclude["data"].getProperty ("tail", var()).toString() == "include", "G1: tail=include echoed in result");
        check (std::abs ((double) expInclude["data"].getProperty ("endAllowance", -1.0) - 2.0) < 0.05, "G1: tail=include endAllowance~=2");
        const juce::int64 bytesInclude = (juce::int64) expInclude["data"].getProperty ("bytes", 0);
        check (bytesInclude > bytesCut,
               "G1: tail=include (reverb ringing) produces MORE audio than tail=cut — the tail is actually captured");

        // Clean up the temp export files.
        for (auto* nm : { "g1-full.wav", "g1-custom.wav", "g1-loop.wav", "g1-tail-cut.wav", "g1-tail-include.wav" })
            g1Dir.getChildFile (nm).deleteFile();
    }

    section ("Serum render compatibility (optional local plugin gate)");
    if (File ("/Library/Audio/Plug-Ins/VST3/Serum2.vst3").exists())
    {
        String serumId;
        {
            // Serum 2 ships BOTH a VST3 and an AudioUnit (same name/manufacturer/isInstrument).
            // This section gates the VST3 render path (the file/identifier checks below require
            // Serum2.vst3), so pin the format explicitly — otherwise list_plugins scan order
            // non-deterministically hands back the AU twin and the metadata check flakes.
            auto lpSerum = cmd (ops, "list_plugins");
            if (auto* arr = lpSerum["data"].getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("name", var()).toString() == "Serum 2"
                        && p.getProperty ("manufacturer", var()).toString() == "Xfer Records"
                        && p.getProperty ("format", var()).toString() == "VST3"
                        && (bool) p.getProperty ("isInstrument", false))
                    {
                        serumId = p.getProperty ("id", var()).toString();
                        break;
                    }
        }
        check (serumId.isNotEmpty(), "Serum 2 VST3 is discoverable by exact name/manufacturer");

        if (serumId.isNotEmpty())
        {
            auto serumTrack = cmd (ops, "create_track", args1 ("name", "Serum Probe"))["data"].getProperty ("trackId", var()).toString();
            check (ok (cmd (ops, "add_midi_clip", objN ({{ "trackId", serumTrack }, { "length", 1.0 }}))), "Serum probe MIDI clip added");
            auto loadSerum = cmd (ops, "load_plugin", objN ({{ "trackId", serumTrack }, { "pluginId", serumId }}));
            check (ok (loadSerum), "Serum 2 loaded by exact plugin id");
            const int serumIndex = (int) loadSerum["data"].getProperty ("index", -1);

            bool hasMetadata = false;
            {
                auto trk = trackById (serumTrack);
                if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                    for (auto& p : *arr)
                        if ((int) p.getProperty ("index", -1) == serumIndex)
                        {
                            hasMetadata = p.hasProperty ("manufacturer")
                                          && p.hasProperty ("file")
                                          && p.hasProperty ("identifier")
                                          && p.hasProperty ("numInputs")
                                          && p.hasProperty ("numOutputs")
                                          && p.hasProperty ("isNonRealtime")
                                          && p.getProperty ("manufacturer", var()).toString() == "Xfer Records"
                                          && p.getProperty ("file", var()).toString().contains ("Serum2.vst3");
                        }
            }
            check (hasMetadata, "snapshot exposes hosted Serum metadata and realtime diagnostics");

            auto autoFile = eng.sessionDir().getChildFile ("exports").getChildFile ("serum-auto.wav");
            auto fastFile = eng.sessionDir().getChildFile ("exports").getChildFile ("serum-fast.wav");
            auto autoExport = cmd (ops, "export_audio", objN ({{ "file", autoFile.getFullPathName() }, { "renderMode", "auto" }}));
            check (ok (autoExport), "Serum auto export ok");
            check (autoExport["data"].getProperty ("renderMode", var()).toString() == "realtime",
                   "Serum auto export selects realtime render mode");
            check (autoExport["data"].getProperty ("renderModeReason", var()).toString().contains ("Serum"),
                   "Serum auto export reports the compatibility reason");

            auto fastExport = cmd (ops, "export_audio", objN ({{ "file", fastFile.getFullPathName() }, { "renderMode", "fast" }}));
            check (ok (fastExport), "explicit fast export remains available with Serum");
            check (fastExport["data"].getProperty ("renderMode", var()).toString() == "fast",
                   "explicit fast export reports fast render mode");
        }
    }
    else
    {
        std::cerr << "  ..   (Serum2.vst3 not installed — skipping Serum-specific local gate)\n";
    }

    // --- G7: per-track stem export (common zero point) ---------------------------
    // Reality-pack invariant 84: "Stem export names and aligns each stem from the
    // same zero point." export_stems mirrors export_audio's render but loops
    // tracks (bounceClipToWav's single-track primitive); every stem shares the
    // SAME {0, editLength} window, so re-imported stems land aligned by construction.
    section ("G7: per-track stem export (common zero point)");
    {
        // Frame-count reader (mirrors DRM-001's wavMagnitude helper below) — proves
        // the structural half of "common zero point": every stem is the SAME length.
        auto wavFrames = [] (const File& f) -> int64
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
                return reader->lengthInSamples;
            return -1;
        };

        // Content-isolation readers — prove the OTHER half of "per-track stem": each
        // stem contains ONLY its own track's audio, not the full mix. Frame-count/
        // existence/naming checks (above) can't tell an isolated stem from an
        // accidental full-mix render (a real regression: te::toBitSet() in the
        // pinned tracktion_engine doesn't actually restrict tracksToDo to the given
        // track — see the comment above MoshOps::cmdExportStems — so a "stem" built
        // from tracksToDo alone silently renders every track). Reads the whole file
        // as mono (channel-summed) samples so RMS/diff comparisons are format-agnostic.
        auto wavMonoSamples = [] (const File& f) -> std::vector<float>
        {
            std::vector<float> out;
            AudioFormatManager fm; fm.registerBasicFormats();
            std::unique_ptr<AudioFormatReader> reader (fm.createReaderFor (f));
            if (reader == nullptr) return out;
            const int numSamples = (int) reader->lengthInSamples;
            if (numSamples <= 0) return out;
            AudioBuffer<float> buf (juce::jmax (1, (int) reader->numChannels), numSamples);
            if (! reader->read (&buf, 0, numSamples, 0, true, true)) return out;
            out.resize ((size_t) numSamples);
            for (int i = 0; i < numSamples; ++i)
            {
                float sum = 0.0f;
                for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                    sum += buf.getSample (ch, i);
                out[(size_t) i] = sum / (float) juce::jmax (1, buf.getNumChannels());
            }
            return out;
        };
        auto wavRms = [] (const std::vector<float>& v) -> double
        {
            if (v.empty()) return 0.0;
            double sumSq = 0.0;
            for (float s : v) sumSq += (double) s * (double) s;
            return std::sqrt (sumSq / (double) v.size());
        };
        // RMS of the sample-by-sample DIFFERENCE between two equal-length signals —
        // ~0.0 if they're the identical signal (e.g. both secretly the full mix),
        // large if they're genuinely different content. Mirrors verify.py's diff_rms.
        auto wavDiffRms = [] (const std::vector<float>& a, const std::vector<float>& b) -> double
        {
            if (a.empty() || b.empty() || a.size() != b.size()) return -1.0;
            double sumSq = 0.0;
            for (size_t i = 0; i < a.size(); ++i)
            {
                const double d = (double) a[i] - (double) b[i];
                sumSq += d * d;
            }
            return std::sqrt (sumSq / (double) a.size());
        };

        // Fresh edit so the track/stem counts below are exact.
        check (ok (cmd (ops, "new_project", args1 ("name", "stem-export-selftest"))), "new_project (stem export isolation) ok");

        auto ta = cmd (ops, "create_track", args1 ("name", "Track A"))["data"].getProperty ("trackId", var()).toString();
        auto tb = cmd (ops, "create_track", args1 ("name", "Track B"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", ta }, { "seconds", 1.0 }, { "freq", 220.0 }}))),
               "stem test: Track A tone (220 Hz) added");
        check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tb }, { "seconds", 1.0 }, { "freq", 660.0 }}))),
               "stem test: Track B tone (660 Hz) added");

        auto stemDir = eng.sessionDir().getChildFile ("exports").getChildFile ("stems-selftest");
        stemDir.deleteRecursively();

        auto exp = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }}));
        check (ok (exp), "export_stems ok");
        check ((int) exp["data"].getProperty ("count", -1) == 2, "two stems for two non-empty tracks");
        check (exp["data"].getProperty ("dir", var()).toString().isNotEmpty(), "export_stems reports the destination dir");

        {
            int64 firstLen = -1;
            bool sawIndex0 = false, sawIndex1 = false;
            File fileByIndex[2];
            if (auto* arr = exp["data"].getProperty ("stems", var()).getArray())
            {
                check (arr->size() == 2, "stems array has exactly 2 entries");
                for (auto& s : *arr)
                {
                    File f (s.getProperty ("file", var()).toString());
                    check (f.existsAsFile() && f.getSize() > 0, "stem file exists and is non-empty");
                    check (f.getFileExtension().toLowerCase() == ".wav", "stem defaults to .wav");
                    check (s.getProperty ("name", var()).toString().isNotEmpty(), "stem entry carries the track name");
                    check (s.getProperty ("logicalId", var()).toString().isNotEmpty(), "stem entry carries a logicalId");
                    check (s.getProperty ("trackId", var()).toString().isNotEmpty(), "stem entry carries a trackId");

                    const int idx = (int) s.getProperty ("index", -1);
                    check (idx == 0 || idx == 1, "stem index is 0 or 1 for a fresh two-track edit");
                    if (idx == 0) { sawIndex0 = true; fileByIndex[0] = f; }
                    if (idx == 1) { sawIndex1 = true; fileByIndex[1] = f; }
                    check (f.getFileName().startsWith (String (idx).paddedLeft ('0', 2) + "-"),
                           "stem filename starts with its zero-padded index");

                    const auto frames = wavFrames (f);
                    check (frames > 0, "stem WAV has readable audio frames");
                    if (firstLen < 0) firstLen = frames;
                    else check (frames == firstLen, "both stems share the SAME frame count (common zero point)");
                }
            }
            else
            {
                check (false, "export_stems returned a stems array");
            }
            check (sawIndex0 && sawIndex1, "stem indices 0 and 1 each appear exactly once");

            // ── Content isolation — the check this whole section exists to have.
            // Track A carries a 220 Hz tone, Track B a 660 Hz tone (added above): two
            // genuinely different signals. A broken isolation mechanism renders BOTH
            // "stems" as the identical full mix (both tones summed) — frame-count,
            // existence, and naming checks alone cannot detect that; a diff between
            // the two stems' actual samples can.
            if (sawIndex0 && sawIndex1)
            {
                const auto a = wavMonoSamples (fileByIndex[0]);
                const auto b = wavMonoSamples (fileByIndex[1]);
                check (! a.empty(), "stem A (index 0, Track A / 220 Hz) samples are readable");
                check (! b.empty(), "stem B (index 1, Track B / 660 Hz) samples are readable");
                check (wavRms (a) > 0.01, "stem A is non-silent (carries Track A's own tone)");
                check (wavRms (b) > 0.01, "stem B is non-silent (carries Track B's own tone)");

                const double diffRms = wavDiffRms (a, b);
                // If both stems were secretly the full mix, diffRms would be ~0.0
                // (identical signals). Two different sine tones diverge by a wide
                // margin sample-for-sample, so genuine per-track isolation clears
                // this threshold easily; a full-mix regression would read ~0.0 here.
                check (diffRms > 0.05,
                       "stem A and stem B are genuinely DIFFERENT signals, i.e. actually "
                       "isolated per-track — not both secretly the full mix (diffRms="
                       + String (diffRms, 4) + ")");
            }
        }

        // Empty (clip-less) track is skipped by default; includeEmpty:true renders it too.
        auto tc = cmd (ops, "create_track", args1 ("name", "Track C (empty)"))["data"].getProperty ("trackId", var()).toString();
        juce::ignoreUnused (tc);
        auto expSkip = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }}));
        check (ok (expSkip) && (int) expSkip["data"].getProperty ("count", -1) == 2,
               "clip-less track skipped by default (count stays 2)");

        auto expInclude = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }, { "includeEmpty", true }}));
        check (ok (expInclude) && (int) expInclude["data"].getProperty ("count", -1) == 3,
               "includeEmpty:true renders the clip-less track too (count 3)");

        // Hidden-track exclusion: the Phase-2 beneath-render track (created by a MIDI
        // re-imagine landing its hidden audio) must never produce a stem. Synthesized via
        // the REAL production path (create_render_layer + render_layer on a MIDI clip),
        // not a hand-rolled flag, so this proves the actual moshHidden gate in cmdExportStems.
        {
            auto mt = cmd (ops, "create_track", args1 ("name", "MidiGen"))["data"].getProperty ("trackId", var()).toString();
            auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", mt }, { "length", 1.0 }}));
            check (ok (mc), "stem test: MIDI clip added");
            const auto mcid = mc["data"].getProperty ("clipId", var()).toString();
            cmd (ops, "add_note", objN ({{ "clipId", mcid }, { "pitch", 60 }, { "start", 0.0 }, { "length", 0.5 }, { "velocity", 100 }}));
            cmd (ops, "create_render_layer", objN ({{ "clipId", mcid }, { "adapter", "fake" }}));
            auto rr = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
            check (ok (rr), "stem test: MIDI re-imagine rendered (creates the hidden beneath-render track)");

            auto expHidden = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }}));
            check (ok (expHidden), "export_stems ok with a hidden render track present");
            // Visible non-empty tracks: A, B, MidiGen (has a muted MIDI clip -> counted,
            // silent by design — see the spec's mute/solo semantics note); C stays skipped
            // (still clip-less). The hidden beneath-render track must NOT add a 4th.
            check ((int) expHidden["data"].getProperty ("count", -1) == 3,
                   "hidden beneath-render track excluded from the stem set (count 3, not 4)");
            if (auto* arr2 = expHidden["data"].getProperty ("stems", var()).getArray())
                for (auto& s : *arr2)
                    check (! s.getProperty ("name", var()).toString().containsIgnoreCase ("hidden"),
                           "no stem is named for the hidden render track");
        }

        // Format / bit-depth rejection — validated before any render (shared with
        // export_audio's resolution logic, duplicated rather than extracted; see the
        // comment above cmdExportStems).
        auto badFormat = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }, { "format", "mp3" }}));
        check (! ok (badFormat), "export_stems rejects an unsupported format (mp3)");
        auto badDepth = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }, { "format", "wav" }, { "bitDepth", 7 }}));
        check (! ok (badDepth), "export_stems rejects an unsupported bit depth (wav 7)");

        // No renderable tracks -> a clean error, not a hang/crash.
        check (ok (cmd (ops, "new_project", args1 ("name", "stem-export-empty"))), "new_project (empty edit) ok");
        auto expEmpty = cmd (ops, "export_stems", objN ({{ "dir", stemDir.getFullPathName() }}));
        check (! ok (expEmpty), "export_stems on an edit with no non-empty tracks returns a clean error");

        stemDir.deleteRecursively();
    }

    // --- DRM-001: drums make sound (working sampler + bundled kit + track type) ---
    // Same shape as the SA3 "differs from input / silence stays silent" gate, but for
    // the drum instrument: a programmed beat exports NON-SILENT audio, an empty drum
    // clip exports SILENT. new_project isolates the render so the drum track is the
    // ONLY track — the export then reflects exactly its sampler.
    section ("Drums make sound (DRM-001)");
    {
        auto drumKitDir = [] () -> File
        {
            const auto env = SystemStats::getEnvironmentVariable ("MOSH_DRUMKIT_DIR", {});
            if (env.isNotEmpty()) { File d (env); if (d.isDirectory()) return d; }
            auto b = File::getSpecialLocation (File::currentApplicationFile)
                         .getChildFile ("Contents/Resources/drumkits/mosh-kit");
            if (b.isDirectory()) return b;
            return File::getSpecialLocation (File::currentExecutableFile)
                       .getParentDirectory().getChildFile ("drumkits/mosh-kit");
        };

        // Peak magnitude of a rendered WAV (mirrors the GAP2 readback).
        auto wavMagnitude = [] (const File& f) -> float
        {
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (f) })
            {
                const int toRead = (int) jmin ((int64) 4'000'000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    float mag = 0.0f;
                    for (int ch = 0; ch < buf.getNumChannels(); ++ch)
                        mag = jmax (mag, buf.getMagnitude (ch, 0, toRead));
                    return mag;
                }
            }
            return -1.0f;
        };

        check (drumKitDir().isDirectory(), "bundled drum kit is present (Resources/drumkits/mosh-kit)");

        // Fresh edit so the export reflects ONLY the drum track we add below.
        check (ok (cmd (ops, "new_project", args1 ("name", "drum-selftest"))), "new_project (drum render isolation) ok");

        // A drum track auto-loads the working sampler + kit at creation.
        auto mk = cmd (ops, "create_track", objN ({{ "name", "Beat" }, { "type", "drum" }}));
        check (ok (mk), "create_track type:drum ok");
        const auto dt = mk["data"].getProperty ("trackId", var()).toString();
        check (mk["data"].getProperty ("type", var()).toString() == "drum", "create_track reports type drum");
        check ((bool) mk["data"].getProperty ("isInstrument", false), "drum track auto-loaded an instrument");

        // Snapshot serialises the type + the hosted sampler.
        {
            auto trk = trackById (dt);
            check (trk.getProperty ("type", var()).toString() == "drum", "snapshot serialises track type drum");
            check ((bool) trk.getProperty ("isInstrument", false), "snapshot marks the drum track as an instrument host");
            bool hasSampler = false;
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == "sampler") hasSampler = true;
            check (hasSampler, "drum track hosts the built-in sampler");
        }

        // Empty drum clip → export is SILENT (the "silence stays silent" control).
        auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", dt }, { "length", 2.0 }, { "notes", var (Array<var>()) }}));
        check (ok (mc), "empty drum MIDI clip added");
        const auto dc = mc["data"].getProperty ("clipId", var()).toString();

        auto silentFile = eng.sessionDir().getChildFile ("exports").getChildFile ("drum-silent.wav");
        check (ok (cmd (ops, "export_audio", objN ({{ "file", silentFile.getFullPathName() }, { "format", "wav" }, { "bitDepth", 16 }}))),
               "export of the empty drum track ok");
        check (wavMagnitude (silentFile) < 0.001f, "empty drum clip renders SILENT (no phantom drum sound)");

        // Program a beat: kick (36) four-on-the-floor + snare (38) on beats 2 and 4.
        for (int b = 0; b < 4; ++b)
            cmd (ops, "add_note", objN ({{ "clipId", dc }, { "pitch", 36 }, { "start", (double) b }, { "length", 0.5 }, { "velocity", 122 }}));
        cmd (ops, "add_note", objN ({{ "clipId", dc }, { "pitch", 38 }, { "start", 1.0 }, { "length", 0.5 }, { "velocity", 110 }}));
        cmd (ops, "add_note", objN ({{ "clipId", dc }, { "pitch", 38 }, { "start", 3.0 }, { "length", 0.5 }, { "velocity", 110 }}));

        auto beatFile = eng.sessionDir().getChildFile ("exports").getChildFile ("drum-beat.wav");
        check (ok (cmd (ops, "export_audio", objN ({{ "file", beatFile.getFullPathName() }, { "format", "wav" }, { "bitDepth", 16 }}))),
               "export of the programmed beat ok");
        check (wavMagnitude (beatFile) > 0.02f, "programmed drum beat renders NON-SILENT (sampler+kit actually sounds)");

        // Persistence: the trackType flag + the sampler's kit sounds serialize into the
        // .tracktionedit and survive save/reload — the beat still renders afterwards (the
        // sampler reconstructs its sounds from the persisted state on load). Done here
        // while the drum track is the only track, so the re-export stays isolated.
        {
            check (ok (cmd (ops, "save")), "save before reload ok");
            check (ok (cmd (ops, "reload")), "reload ok");
            // The sampler reloads its sample files on an AsyncUpdate; drain it before render.
            if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
                mm->runDispatchLoopUntil (50);
            auto rtrk = trackById (dt);   // item ids are persisted, so dt still resolves
            check (rtrk.getProperty ("type", var()).toString() == "drum", "drum track type survives save/reload");
            bool hasSampler = false;
            if (auto* arr = rtrk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == "sampler") hasSampler = true;
            check (hasSampler, "the sampler survives save/reload");
            auto reloadFile = eng.sessionDir().getChildFile ("exports").getChildFile ("drum-reload.wav");
            check (ok (cmd (ops, "export_audio", objN ({{ "file", reloadFile.getFullPathName() }, { "format", "wav" }, { "bitDepth", 16 }}))),
                   "re-export after reload ok");
            check (wavMagnitude (reloadFile) > 0.02f, "drum beat still NON-SILENT after save/reload (sampler sounds restored)");
            reloadFile.deleteFile();
        }

        // assign_sample: map a kit sample onto a fresh pad/note and confirm it lands.
        if (auto crash = drumKitDir().getChildFile ("crash.wav"); crash.existsAsFile())
        {
            auto as = cmd (ops, "assign_sample", objN ({{ "trackId", dt }, { "note", 60 },
                                                        { "file", crash.getFullPathName() }, { "name", "Crash@60" }}));
            check (ok (as), "assign_sample maps a sample to a pad/note");
            check ((int) as["data"].getProperty ("sounds", 0) > 8, "assign_sample added a 9th pad");

            // melodic mode: the SAME sample mapped as a pitched instrument across the
            // keyboard, note-gated — "regular 808 functionality". Plumbing guard here;
            // the 2-distinct-pitches AUDIO proof lives in the offline render harness.
            auto asMel = cmd (ops, "assign_sample", objN ({{ "trackId", dt }, { "note", 36 },
                                                           { "file", crash.getFullPathName() },
                                                           { "name", "808@36" }, { "mode", "melodic" }}));
            check (ok (asMel), "assign_sample mode:melodic lands (pitched 808/bass path)");
            check (asMel["data"].getProperty ("mode", var()).toString() == "melodic",
                   "assign_sample echoes melodic mode");
        }

        // load_drum_kit re-loads the 8 pads onto a track's sampler.
        auto ld = cmd (ops, "load_drum_kit", args1 ("trackId", dt));
        check (ok (ld) && (int) ld["data"].getProperty ("pads", 0) == 8, "load_drum_kit (re)loads the 8-pad kit");

        // FL drum-lane mute/solo (set_drum_lane): state rides the snapshot, persists,
        // and silences the lane's sampler pad. (Audibility isn't asserted headlessly;
        // the contract checked here is the snapshot/persist round-trip.)
        auto laneHas = [&] (const String& tid, const char* key, int note) {
            auto trk = trackById (tid);                      // hold the var (no dangling temporary)
            auto arrVar = trk.getProperty (key, var());
            if (auto* a = arrVar.getArray())
                for (auto& v : *a) if ((int) v == note) return true;
            return false;
        };
        check (ok (cmd (ops, "set_drum_lane", objN ({{ "trackId", dt }, { "note", 36 }, { "mute", true }}))), "set_drum_lane mute ok");
        check (laneHas (dt, "drumMutedPitches", 36), "muted kick (36) rides the snapshot");
        check (ok (cmd (ops, "set_drum_lane", objN ({{ "trackId", dt }, { "note", 38 }, { "solo", true }}))), "set_drum_lane solo ok");
        check (laneHas (dt, "drumSoloPitches", 38), "soloed snare (38) rides the snapshot");
        check (ok (cmd (ops, "set_drum_lane", objN ({{ "trackId", dt }, { "note", 36 }, { "mute", false }}))), "set_drum_lane unmute ok");
        check (! laneHas (dt, "drumMutedPitches", 36), "unmuting clears the kick from the muted set");
        cmd (ops, "save"); cmd (ops, "reload");
        check (laneHas (dt, "drumSoloPitches", 38), "drum-lane solo persists across save/reload");
        cmd (ops, "set_drum_lane", objN ({{ "trackId", dt }, { "note", 38 }, { "solo", false }})); // reset for later sections

        // set_track_type round-trip on a plain track; undo restores type + removes the kit.
        auto plain = cmd (ops, "create_track", args1 ("name", "FlipMe"))["data"].getProperty ("trackId", var()).toString();
        check (trackById (plain).getProperty ("type", var()).toString() == "audio", "new plain track is type audio");
        check (ok (cmd (ops, "set_track_type", objN ({{ "trackId", plain }, { "type", "drum" }}))), "set_track_type drum ok");
        check (trackById (plain).getProperty ("type", var()).toString() == "drum", "set_track_type flips the snapshot type");
        check ((bool) trackById (plain).getProperty ("isInstrument", false), "set_track_type drum auto-loads the kit");
        cmd (ops, "undo");
        check (trackById (plain).getProperty ("type", var()).toString() == "audio", "undo reverts set_track_type to audio");
        check (! (bool) trackById (plain).getProperty ("isInstrument", true), "undo removes the auto-loaded kit");

        // Default-instrument policy: a MIDI clip on a plain audio track auto-loads 4OSC.
        auto mel = cmd (ops, "create_track", args1 ("name", "Mel"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "add_midi_clip", objN ({{ "trackId", mel }, { "length", 1.0 }}));
        {
            auto trk = trackById (mel);
            check ((bool) trk.getProperty ("isInstrument", false), "MIDI clip on a plain track auto-loads a default instrument");
            bool has4osc = false;
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == "4osc") has4osc = true;
            check (has4osc, "the melodic default instrument is 4OSC");
        }

        // Regression (DRM-001): a MIDI clip on a track that ALREADY holds wave audio must
        // NOT auto-insert a front-of-chain synth — that would clear the track buffer and
        // silence the wave clips. The default-instrument policy skips such tracks.
        {
            auto wav = cmd (ops, "create_track", args1 ("name", "WaveTrack"))["data"].getProperty ("trackId", var()).toString();
            cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wav }, { "seconds", 1.0 }, { "freq", 220.0 }}));
            cmd (ops, "add_midi_clip", objN ({{ "trackId", wav }, { "length", 1.0 }}));
            check (! (bool) trackById (wav).getProperty ("isInstrument", false),
                   "MIDI clip on a wave track does NOT auto-load an instrument (wave audio preserved)");
        }

        // QA: keep the real engine-rendered beat for an audible listen when asked
        // (MOSH_DRUM_DEMO_DIR=<dir> Mosh --selftest → <dir>/mosh-drum-beat.wav).
        if (const auto demoDir = SystemStats::getEnvironmentVariable ("MOSH_DRUM_DEMO_DIR", {}); demoDir.isNotEmpty())
        {
            File dir (demoDir); dir.createDirectory();
            beatFile.copyFileTo (dir.getChildFile ("mosh-drum-beat.wav"));
            std::cerr << "  ..   kept rendered beat → " << dir.getChildFile ("mosh-drum-beat.wav").getFullPathName() << "\n";
        }

        silentFile.deleteFile();
        beatFile.deleteFile();
    }

    // --- DRM-002: add_drum_pattern — a whole drum grid in ONE undoable command ---
    // Parser semantics (DSL chars, tiling, aliases, errors) are pinned hermetically by
    // tests/test_drum_pattern.cpp ⇄ ui drumPatternUtil.test.ts; THIS section pins the
    // COMMAND semantics: landing geometry, track policy (auto-fix to drum / instrument
    // untouched / wave-audio rejection), per-lane replace, and undo atomicity.
    section ("add_drum_pattern (DRM-002)");
    {
        auto clipById = [&] (const String& cid) -> var {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray())
                for (auto& tr : *tracks)
                    if (auto* clips = tr.getProperty ("clips", var()).getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == cid) return c;
            return {};
        };
        // Count a clip's notes on a pitch, optionally pinned to a beat and/or velocity.
        auto pitchCount = [] (const var& clip, int pitch, double atBeat = -1.0, int vel = -1) {
            int n = 0;
            if (auto* notes = clip.getProperty ("notes", var()).getArray())
                for (auto& nn : *notes)
                    if ((int) nn.getProperty ("pitch", -1) == pitch
                        && (atBeat < 0.0 || std::abs ((double) nn.getProperty ("start", -1.0) - atBeat) < 1e-6)
                        && (vel < 0 || (int) nn.getProperty ("velocity", -1) == vel))
                        ++n;
            return n;
        };
        auto totalNotes = [] (const var& clip) {
            if (auto* notes = clip.getProperty ("notes", var()).getArray()) return notes->size();
            return 0;
        };
        auto trackCount = [&] () {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray()) return tracks->size();
            return 0;
        };
        auto hasPluginType = [&] (const String& tid, const String& type) {
            auto trk = trackById (tid);
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == type) return true;
            return false;
        };

        // Pin the tempo/meter the geometry checks below assume.
        cmd (ops, "set_tempo", args1 ("bpm", 120.0));
        cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 4 }}));

        // (1) flat-string form, no trackId → new Drums drum track + populated clip.
        const int tracksBefore = trackCount();
        auto r = cmd (ops, "add_drum_pattern", args1 ("pattern",
            "kick: x...x...x...x...; snare: ....x.......x...; hat: x.x.x.x.x.x.x.x."));
        check (ok (r), "add_drum_pattern (flat string, no trackId) ok");
        const auto dpTrack = r["data"].getProperty ("trackId", var()).toString();
        const auto dpClip  = r["data"].getProperty ("clipId", var()).toString();
        check ((int) r["data"].getProperty ("noteCount", -1) == 14, "pattern lands 14 notes (4 kick + 2 snare + 8 hat)");
        check ((int) r["data"].getProperty ("steps", -1) == 16, "pattern reports 16 steps");
        check ((int) r["data"].getProperty ("bars", -1) == 1, "pattern reports 1 bar");

        // (2) the created track is a working drum track.
        {
            auto trk = trackById (dpTrack);
            check (trk.getProperty ("name", var()).toString() == "Drums", "created track is named Drums");
            check (trk.getProperty ("type", var()).toString() == "drum", "created track is type drum");
            check ((bool) trk.getProperty ("isInstrument", false), "created track hosts an instrument (kit)");
        }
        check (trackCount() == tracksBefore + 1, "exactly one track was created");

        // (3)+(4) clip geometry + drum-sequencer note positions.
        {
            auto c = clipById (dpClip);
            check (std::abs ((double) c.getProperty ("start", -1.0)) < 1e-3, "clip starts at 0 s (native default, not playhead)");
            check (std::abs ((double) c.getProperty ("length", -1.0) - 2.0) < 1e-2, "clip spans 1 bar (2.0 s at 120 BPM 4/4)");
            check (pitchCount (c, 36, 0.0) == 1, "kick lands at beat 0");
            check (pitchCount (c, 38, 1.0) == 1, "snare lands at beat 1.0 (step 4 of 16)");
            check (pitchCount (c, 42, -1.0, 100) == 8, "8 hats at velocity 100");
        }

        // (5) 'X' accent + start (seconds) honored.
        {
            auto ra = cmd (ops, "add_drum_pattern", objN ({{ "pattern", "kick: X...x..." }, { "stepsPerBar", 8 }, { "start", 4.0 }}));
            check (ok (ra), "accent pattern ok");
            auto c = clipById (ra["data"].getProperty ("clipId", var()).toString());
            check (pitchCount (c, 36, 0.0, 127) == 1, "'X' accent lands velocity 127");
            check (pitchCount (c, 36, 2.0, 100) == 1, "'x' lands the default velocity 100");
            check (std::abs ((double) c.getProperty ("start", -1.0) - 4.0) < 1e-3, "start (seconds) honored");
        }

        // (6) object-form ≡ string-form.
        {
            auto ro = cmd (ops, "add_drum_pattern", args1 ("pattern",
                objN ({{ "kick", "x...x...x...x..." }, { "snare", "....x.......x..." }, { "hat", "x.x.x.x.x.x.x.x." }})));
            check (ok (ro) && (int) ro["data"].getProperty ("noteCount", -1) == 14, "object-form pattern lands the same 14 notes");
        }

        // (7) tiling + (8) raw-pitch lanes.
        {
            auto rt = cmd (ops, "add_drum_pattern", args1 ("pattern", "hat: x."));
            check (ok (rt) && (int) rt["data"].getProperty ("noteCount", -1) == 8, "short lane tiles (\"x.\" = 8th hats)");
            auto rp = cmd (ops, "add_drum_pattern", args1 ("pattern", "47: x..............."));
            check (ok (rp) && pitchCount (clipById (rp["data"].getProperty ("clipId", var()).toString()), 47, 0.0) == 1,
                   "raw-pitch lane lands pitch 47");
        }

        // (9)+(10)+(11a) clipId per-lane replace, all-rest clear, undo restoring exactly.
        {
            cmd (ops, "add_note", objN ({{ "clipId", dpClip }, { "pitch", 45 }, { "start", 0.5 }, { "length", 0.25 }, { "velocity", 100 }}));
            const int beforeTotal = totalNotes (clipById (dpClip));   // 15

            auto rr = cmd (ops, "add_drum_pattern", objN ({{ "clipId", dpClip }, { "pattern", "kick: x.x.x.x.x.x.x.x." }}));
            check (ok (rr), "clipId per-lane replace ok");
            auto after = clipById (dpClip);
            check (pitchCount (after, 36) == 8, "kick lane replaced (4 -> 8 hits)");
            check (pitchCount (after, 38) == 2 && pitchCount (after, 42) == 8, "snare + hats untouched by the kick replace");
            check (pitchCount (after, 45) == 1, "manually-added tom survives the replace");

            check (ok (cmd (ops, "undo")), "undo (per-lane replace) ok");
            auto undone = clipById (dpClip);
            check (pitchCount (undone, 36) == 4 && totalNotes (undone) == beforeTotal,
                   "one undo restores the replaced lane AND the note count exactly");

            auto rc = cmd (ops, "add_drum_pattern", objN ({{ "clipId", dpClip }, { "pattern", "snare: ................" }}));
            check (ok (rc), "all-rest lane ok");
            auto cleared = clipById (dpClip);
            check (pitchCount (cleared, 38) == 0, "all-rest lane cleared the snares");
            check (pitchCount (cleared, 36) == 4 && pitchCount (cleared, 42) == 8, "other lanes untouched by the clear");
            cmd (ops, "undo");   // restore for later sections
        }

        // (11b) undo after the create path removes track+clip+kit in ONE step.
        {
            const int n0 = trackCount();
            cmd (ops, "add_drum_pattern", args1 ("pattern", "kick: x..."));
            check (trackCount() == n0 + 1, "create path adds one track");
            check (ok (cmd (ops, "undo")), "undo (create path) ok");
            check (trackCount() == n0, "one undo removes track+clip+kit (single transaction)");
        }

        // (12) a track that already has an instrument is left untouched (melodic-808 safe).
        {
            auto mel = cmd (ops, "create_track", args1 ("name", "Mel808"))["data"].getProperty ("trackId", var()).toString();
            cmd (ops, "add_midi_clip", objN ({{ "trackId", mel }, { "length", 1.0 }}));   // DRM-001 loads 4OSC
            check (hasPluginType (mel, "4osc"), "precondition: track carries a (non-sampler) instrument");
            auto rm = cmd (ops, "add_drum_pattern", objN ({{ "trackId", mel }, { "pattern", "36: x..." }}));
            check (ok (rm), "pattern on an instrument-bearing track ok");
            check (trackById (mel).getProperty ("type", var()).toString() == "audio", "instrument-bearing track type NOT flipped");
            check (hasPluginType (mel, "4osc") && ! hasPluginType (mel, "sampler"),
                   "existing instrument untouched (no sampler clobber)");
        }

        // (13) instrument-less audio track → drum type + kit, one undo reverts both.
        {
            auto plain = cmd (ops, "create_track", args1 ("name", "PlainBeat"))["data"].getProperty ("trackId", var()).toString();
            auto rp2 = cmd (ops, "add_drum_pattern", objN ({{ "trackId", plain }, { "pattern", "kick: x...x...x...x..." }}));
            check (ok (rp2), "pattern on an instrument-less audio track ok");
            check (trackById (plain).getProperty ("type", var()).toString() == "drum", "instrument-less track flipped to drum");
            check ((bool) trackById (plain).getProperty ("isInstrument", false), "kit auto-loaded (DRM-001 posture)");
            check (ok (cmd (ops, "undo")), "undo (auto-fix path) ok");
            check (trackById (plain).getProperty ("type", var()).toString() == "audio"
                   && ! (bool) trackById (plain).getProperty ("isInstrument", true),
                   "one undo reverts type flip + kit + clip together");
        }

        // (14) a track holding wave audio is rejected (a sampler would silence it).
        String waveClipId;
        {
            auto wav = cmd (ops, "create_track", args1 ("name", "WaveBeat"))["data"].getProperty ("trackId", var()).toString();
            waveClipId = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wav }, { "seconds", 0.5 }, { "freq", 220.0 }}))["data"]
                             .getProperty ("clipId", var()).toString();
            auto rw = cmd (ops, "add_drum_pattern", objN ({{ "trackId", wav }, { "pattern", "kick: x..." }}));
            check (! ok (rw), "pattern on a wave-audio track is rejected");
            check (rw.getProperty ("error", var()).toString().contains ("wave"), "error names the wave-audio conflict");
        }

        // (15) error matrix — all fail closed, pre-transaction (no stray tracks).
        {
            const int n0 = trackCount();
            auto kick = args1 ("pattern", "kick: x...");
            auto fails = [&] (const juce::var& args, const char* what) { check (! ok (cmd (ops, "add_drum_pattern", args)), what); };
            fails (objN ({{ "pattern", "kick: x..." }, { "stepsPerBar", 0 }}),  "stepsPerBar 0 rejected");
            fails (objN ({{ "pattern", "kick: x..." }, { "bars", 20 }}),        "bars 20 rejected");
            fails (objN ({{ "pattern", "kick: x..." }, { "velocity", 0 }}),     "velocity 0 rejected");
            fails (args1 ("pattern", "kick: x..q"),                             "bad step char rejected");
            fails (args1 ("pattern", "cowbell: x..."),                          "unknown lane rejected");
            fails (objN ({{ "pattern", "kick: xxxxxxxxxxxxxxxxx" }, { "bars", 1 }}), "17-step lane into 1 explicit bar rejected");
            fails (juce::var (new DynamicObject()),                             "missing pattern rejected");
            fails (objN ({{ "pattern", "kick: x..." }, { "trackId", "nope" }}), "unknown trackId rejected");
            fails (objN ({{ "pattern", "kick: x..." }, { "clipId", waveClipId }}), "clipId of a wave clip rejected");
            check (trackCount() == n0, "failed calls create no stray tracks (validation is pre-transaction)");
            juce::ignoreUnused (kick);
        }

        // (16) 3/4 meter: numerator-relative steps + bar-sized clip. Restore 4/4 after.
        {
            cmd (ops, "set_time_signature", objN ({{ "numerator", 3 }, { "denominator", 4 }}));
            auto r34 = cmd (ops, "add_drum_pattern", args1 ("pattern", "kick: ....x..........."));
            check (ok (r34), "3/4 pattern ok");
            auto c = clipById (r34["data"].getProperty ("clipId", var()).toString());
            check (pitchCount (c, 36, 0.75) == 1, "in 3/4, step 4 of 16 lands at beat 0.75");
            check (std::abs ((double) c.getProperty ("length", -1.0) - 1.5) < 1e-2, "3/4 bar spans 1.5 s at 120 BPM");
            cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 4 }}));   // hermeticity
        }
    }

    // --- Stage 5 (SA3): the real StableAudio3Adapter - GATED on MOSH_SELFTEST_SA3 ---
    // (separate from MOSH_ENABLE_SA3, which now defaults on: real model + judge QA is
    //  ~30s, too heavy for the default --selftest. Opt in explicitly to exercise it.)
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SA3", "0") == "1")
    {
        section ("Stage 5 (SA3): real Stable Audio 3 backend");
        // /colors handshake
        auto lc = cmd (ops, "list_colors");
        const int nColors = lc["data"].getProperty ("colors", var()).size();
        check (ok (lc) && nColors > 0, "list_colors returns the SA3 colour rack");

        auto st = cmd (ops, "create_track", args1 ("name", "SA3"))["data"].getProperty ("trackId", var()).toString();
        auto tn = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 110.0 }}));
        const auto scid = tn["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", scid },
            { "adapter", "stable_audio3" }, { "mode", "reimagine" }, { "modelVariant", "sa3-medium" }}));
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();
        check (ok (crl), "create_render_layer (stable_audio3) ok");

        Array<var> gcolors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 70); gcolors.add (var (c)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", scid }, { "seed", 5 }, { "nl", 0.45 }, { "colors", gcolors }}));

        std::cerr << "  ..   rendering with SA3 (model load + inference; ~10s first time)...\n";
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (ok (r1) && r1["data"].getProperty ("cache", var()).toString() == "miss", "SA3 render ran (cache MISS)");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "SA3 render completed -> ready");

        // The real artifact + its manifest.
        auto manifestFile = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("output_manifest.json");
        var mf = manifestFile.existsAsFile() ? JSON::parse (manifestFile.loadFileAsString()) : var();
        check (mf.getProperty ("adapter", var()).toString() == "stable_audio3", "manifest from the real SA3 adapter");
        check (mf.getProperty ("mode", var()).toString() == "audio_to_audio", "SA3 ran the re-imagine path");
        check (mf.getProperty ("steers", var()).size() > 0, "grit colour applied as a steering vector");

        // Cache HIT on identical re-render (full fingerprint incl. SA3 service build).
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical SA3 re-render is a cache HIT");

        check (ok (cmd (ops, "accept_render", args1 ("clipId", scid))), "accept SA3 render -> lands on the neural lane");
    }
    else
        std::cerr << "  ..   (SA3 self-test skipped — set MOSH_SELFTEST_SA3=1 to exercise the real model)\n";

    // --- Audio→MIDI (Basic Pitch): GATED on MOSH_SELFTEST_TRANSCRIBE (needs the
    //     transcribe venv + service; ~3s inference, so opt in explicitly). ---
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_TRANSCRIBE", "0") == "1")
    {
        section ("Audio→MIDI: real Basic Pitch transcription");
        auto tct = cmd (ops, "create_track", args1 ("name", "TC"))["data"].getProperty ("trackId", var()).toString();
        auto ttn = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tct }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        const auto wcid = ttn["data"].getProperty ("clipId", var()).toString();
        check (ok (ttn), "test-tone wave clip created for transcription");

        const int tracksBefore = tracks (ops);
        std::cerr << "  ..   transcribing a test tone with Basic Pitch (model load + inference; ~3s)...\n";
        auto tr = cmd (ops, "transcribe_clip", objN ({{ "clipId", wcid }, { "mode", "mono" }, { "wait", true }}));
        check (ok (tr), "transcribe_clip (wait) ok");
        check (tr["data"].getProperty ("status", var()).toString() == "done", "transcription completed -> done");
        check ((int) tr["data"].getProperty ("noteCount", 0) > 0, "transcription produced >=1 MIDI note");
        check (tracks (ops) == tracksBefore + 1, "transcription landed a new MIDI track");

        auto newTrack = ops.snapshot()["tracks"][tracksBefore];   // the just-added track
        check (newTrack["clips"][0].getProperty ("type", var()).toString() == "midi", "new clip is a MIDI clip");
        check (newTrack["clips"][0].getProperty ("notes", var()).size() > 0, "MIDI clip carries the transcribed notes");
    }
    else
        std::cerr << "  ..   (transcribe self-test skipped — set MOSH_SELFTEST_TRANSCRIBE=1 to exercise Basic Pitch)\n";

    // --- Sketch Phase 0 (beatbox → drum MoshOps): GATED on MOSH_SELFTEST_SKETCH (needs
    //     the sketch venv + service + the committed fixture WAVs; point MOSH_SKETCH_FIXTURE_DIR
    //     at service/sketch/fixtures). Proves: recognisable kick/snare/hat hits land in a real
    //     editable clip, the tempo is set, and the transduction is byte-identical across runs. ---
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SKETCH", "0") == "1")
    {
        section ("Sketch: beatbox WAV → drum MoshOps (real librosa transduction)");
        juce::File fixDir (SystemStats::getEnvironmentVariable ("MOSH_SKETCH_FIXTURE_DIR", {}));
        const auto boombap = fixDir.getChildFile ("boombap_90.wav");
        const auto trap    = fixDir.getChildFile ("trap_140.wav");
        check (boombap.existsAsFile() && trap.existsAsFile(),
               "MOSH_SKETCH_FIXTURE_DIR points at the committed fixtures (boombap_90 + trap_140)");

        if (boombap.existsAsFile() && trap.existsAsFile())
        {
            // does the returned note array contain a note at this GM pitch?
            auto hasPitch = [] (const juce::var& data, int pitch) {
                if (auto* arr = data.getProperty ("notes", var()).getArray())
                    for (auto& n : *arr) if ((int) n.getProperty ("pitch", 0) == pitch) return true;
                return false;
            };

            const int before = tracks (ops);
            std::cerr << "  ..   transducing a boom-bap beatbox via librosa (onset + 3-class heuristic)...\n";
            auto bb = cmd (ops, "sketch_beatbox", objN ({{ "file", boombap.getFullPathName() },
                                                         { "bpm", 90.0 }, { "bars", 1 }, { "wait", true }}));
            check (ok (bb), "sketch_beatbox (boombap, wait) ok");
            const auto bbData = bb.getProperty ("data", var());
            if (! ok (bb))
                check (false, "sketch_beatbox failed without crashing: " + bb.getProperty ("error", var()).toString());
            check (bbData.getProperty ("status", var()).toString() == "done", "transduction completed -> done");
            check ((int) bbData.getProperty ("noteCount", 0) > 0, "boom-bap produced >=1 drum note");
            check (tracks (ops) == before + 1, "boom-bap landed a new drum track");
            check (hasPitch (bbData, 36), "boom-bap has a kick (GM 36)");
            check (hasPitch (bbData, 38), "boom-bap has a snare (GM 38)");
            check (hasPitch (bbData, 42), "boom-bap has a hat (GM 42)");

            // Emitted PURELY as MoshOps: the first op is set_tempo carrying the known bpm.
            auto moshopsVar = bbData.getProperty ("moshops", var());
            auto* moshops = moshopsVar.getArray();
            if (moshops != nullptr && ! moshops->isEmpty())
            {
                auto op0 = moshops->getReference (0);
                check (op0.getProperty ("command", var()).toString() == "set_tempo", "first emitted op is set_tempo");
                check ((double) op0.getProperty ("args", var()).getProperty ("bpm", 0.0) == 90.0, "set_tempo carries the known bpm (90)");
            }
            else
            {
                check (false, "sketch result carries emitted MoshOps");
            }

            // The clip is real + editable: it shows up in the snapshot as a MIDI clip with notes.
            auto snapAfterSketch = ops.snapshot();
            auto tracksAfterSketch = snapAfterSketch["tracks"];
            if (tracksAfterSketch.isArray() && tracksAfterSketch.size() > before)
            {
                auto newTrack = tracksAfterSketch[before];
                auto clipsVar = newTrack["clips"];
                if (clipsVar.isArray() && clipsVar.size() > 0)
                {
                    auto firstClip = clipsVar[0];
                    check (firstClip.getProperty ("type", var()).toString() == "midi", "landed clip is a MIDI clip");
                    check (firstClip.getProperty ("notes", var()).size() > 0, "drum clip carries the transduced notes");
                }
                else
                {
                    check (false, "landed sketch track carries a clip");
                    check (false, "drum clip carries the transduced notes");
                }
            }
            else
            {
                check (false, "landed clip is a MIDI clip");
                check (false, "drum clip carries the transduced notes");
            }

            // Determinism: same WAV + same bpm + same bars → byte-identical hits + notes.
            auto bb2 = cmd (ops, "sketch_beatbox", objN ({{ "file", boombap.getFullPathName() },
                                                          { "bpm", 90.0 }, { "bars", 1 }, { "wait", true }}));
            const auto bb2Data = bb2.getProperty ("data", var());
            const auto hits1 = juce::JSON::toString (bbData.getProperty ("hits", var()));
            const auto hits2 = juce::JSON::toString (bb2Data.getProperty ("hits", var()));
            check (hits1.isNotEmpty() && hits1 == hits2, "determinism: identical transduced hits across 2 runs");
            const auto notes1 = juce::JSON::toString (bbData.getProperty ("notes", var()));
            const auto notes2 = juce::JSON::toString (bb2Data.getProperty ("notes", var()));
            check (notes1 == notes2, "determinism: identical emitted notes across 2 runs");

            // A second, different genre/tempo (trap @ 140) also yields all three roles, and
            // proves the whole sketch is ONE atomic undo step (set_tempo + track + clip
            // coalesced): a single undo restores both the track count and the prior tempo.
            std::cerr << "  ..   transducing a trap-hat beatbox @ 140 BPM...\n";
            auto tempoNow = [&] { return (double) ops.snapshot().getProperty ("session", var()).getProperty ("tempo", 0.0); };
            const int beforeTrap = tracks (ops);
            const double tempoBeforeTrap = tempoNow();
            auto tp = cmd (ops, "sketch_beatbox", objN ({{ "file", trap.getFullPathName() },
                                                         { "bpm", 140.0 }, { "bars", 1 }, { "wait", true }}));
            check (ok (tp), "sketch_beatbox (trap, wait) ok");
            const auto tpData = tp.getProperty ("data", var());
            check (hasPitch (tpData, 36) && hasPitch (tpData, 38) && hasPitch (tpData, 42),
                   "trap pattern has kick + snare + hat");
            check (tracks (ops) == beforeTrap + 1, "trap landed exactly one new drum track");
            check (std::abs (tempoNow() - 140.0) < 0.5, "tempo set to 140");
            cmd (ops, "undo");
            check (tracks (ops) == beforeTrap, "ONE undo reverts the whole sketch (atomic: track removed)");
            check (std::abs (tempoNow() - tempoBeforeTrap) < 0.5,
                   "ONE undo also restores the prior tempo (atomic: set_tempo coalesced)");
        }
    }
    else
        std::cerr << "  ..   (sketch self-test skipped — set MOSH_SELFTEST_SKETCH=1 + MOSH_SKETCH_FIXTURE_DIR to exercise the beatbox transduction)\n";

    // Settle the generative service's async backlog before the downstream pure-command
    // blocks. The Tier-B render jobs above cancel in-flight HTTP requests whose completion
    // callbacks callAsync onto the message thread; if those land mid-block during a later
    // runDispatchLoopUntil drain they perturb engine state and make file/render-dependent
    // checks (content browser, export) flaky. Pump the loop here so the backlog clears now.
    if (auto* mm = juce::MessageManager::getInstanceWithoutCreating())
        mm->runDispatchLoopUntil (250);

    // ─── Wave 4: MIDI note editing (piano-roll command surface) ───
    section ("Wave 4: MIDI note editing");
    {
        auto clipNotes = [&] (const String& cid) -> var {
            auto snap = ops.snapshot();
            if (auto* tracks = snap["tracks"].getArray())
                for (auto& tr : *tracks)
                    if (auto* clips = tr.getProperty ("clips", var()).getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == cid)
                                return c.getProperty ("notes", var());
            return {};
        };

        auto mt = cmd (ops, "create_track", args1 ("name", "Notes"))["data"].getProperty ("trackId", var()).toString();
        Array<var> seed;
        for (int k = 0; k < 3; ++k)
        {
            auto* n = new DynamicObject();
            n->setProperty ("pitch", 60 + k); n->setProperty ("start", (double) k);
            n->setProperty ("length", 1.0); n->setProperty ("velocity", 90);
            seed.add (var (n));
        }
        auto* ca = new DynamicObject(); ca->setProperty ("trackId", mt); ca->setProperty ("notes", var (seed));
        const auto mClip = cmd (ops, "add_midi_clip", var (ca))["data"].getProperty ("clipId", var()).toString();
        check (clipNotes (mClip).size() == 3, "MIDI clip serialises its 3 notes into the snapshot");

        check (ok (cmd (ops, "add_note", objN ({{ "clipId", mClip }, { "pitch", 72 }, { "start", 1.4 }, { "length", 1.0 }, { "velocity", 100 }}))), "add_note ok");
        check (clipNotes (mClip).size() == 4, "add_note adds a note");

        check (ok (cmd (ops, "set_note", objN ({{ "clipId", mClip }, { "noteIndex", 0 }, { "pitch", 48 }, { "velocity", 127 }}))), "set_note ok");
        { auto ns = clipNotes (mClip);
          check (ns.size() > 0 && (int) ns[0].getProperty ("pitch", -1) == 48 && (int) ns[0].getProperty ("velocity", -1) == 127, "set_note edits pitch + velocity"); }

        check (ok (cmd (ops, "quantize_notes", objN ({{ "clipId", mClip }, { "division", 1.0 }}))), "quantize_notes ok");
        { auto ns = clipNotes (mClip); bool allOnGrid = ns.size() > 0;
          if (auto* arr = ns.getArray()) for (auto& n : *arr) {
              const double s = (double) n.getProperty ("start", 0.0);
              if (std::abs (s - std::round (s)) > 0.02) allOnGrid = false; }
          check (allOnGrid, "quantize_notes snaps every note onto the beat grid"); }

        // Regression: setStartAndLength() triggers tracktion's synchronous MidiList
        // re-sort, so walking seq.getNote(i) LIVE during the mutation loop can skip a
        // note that gets sorted past an already-visited index. beats 0.6/0.7 with
        // division=1.0/strength=1.0 reproduce it deterministically: quantizing 0.6 ->
        // 1.0 crosses the still-unquantized note at 0.7, so under the old live-index
        // loop the second note is silently left un-quantized (and "moved" undercounts).
        {
            const auto qt = cmd (ops, "create_track", args1 ("name", "QuantizeReorder"))["data"].getProperty ("trackId", var()).toString();
            auto* qc = new DynamicObject(); qc->setProperty ("trackId", qt);
            const auto qClip = cmd (ops, "add_midi_clip", var (qc))["data"].getProperty ("clipId", var()).toString();
            check (ok (cmd (ops, "add_note", objN ({{ "clipId", qClip }, { "pitch", 64 }, { "start", 0.6 }, { "length", 0.5 }, { "velocity", 90 }}))), "quantize-reorder fixture: note A (0.6) added");
            check (ok (cmd (ops, "add_note", objN ({{ "clipId", qClip }, { "pitch", 65 }, { "start", 0.7 }, { "length", 0.5 }, { "velocity", 90 }}))), "quantize-reorder fixture: note B (0.7) added");

            auto qResult = cmd (ops, "quantize_notes", objN ({{ "clipId", qClip }, { "division", 1.0 }, { "strength", 1.0 }}));
            check (ok (qResult), "quantize_notes (reorder fixture) ok");
            check ((int) qResult["data"].getProperty ("moved", -1) == 2, "quantize_notes moves BOTH reordered notes, not just the first (moved==2)");

            auto qns = clipNotes (qClip);
            bool bothOnGrid = qns.size() == 2;
            if (auto* arr = qns.getArray())
                for (auto& n : *arr) {
                    const double s = (double) n.getProperty ("start", -1.0);
                    if (std::abs (s - std::round (s)) > 0.02) bothOnGrid = false;
                }
            check (bothOnGrid, "quantize_notes: a note reordered mid-loop is not silently skipped (both land on-grid)");
        }

        const int before = clipNotes (mClip).size();
        check (ok (cmd (ops, "remove_note", objN ({{ "clipId", mClip }, { "noteIndex", 0 }}))), "remove_note ok");
        check (clipNotes (mClip).size() == before - 1, "remove_note removes a note");

        cmd (ops, "save"); cmd (ops, "reload");
        check (clipNotes (mClip).size() == before - 1, "notes persist across save/reload");
        check (! ok (cmd (ops, "set_note", objN ({{ "clipId", mClip }, { "noteIndex", 999 }}))), "set_note rejects an out-of-range noteIndex");

        // Phase 1: emptying a MIDI clip must NOT delete the clip. (The "clip vanishes
        // when you delete all its notes" bug was a UI keyboard-handler issue, never a
        // backend prune — this guards the backend contract: an empty clip persists.)
        auto clipExists = [&] (const String& cid) -> bool {
            auto snap = ops.snapshot();
            if (auto* tarr = snap.getProperty ("tracks", var()).getArray())
                for (auto& t : *tarr)
                    if (auto* carr = t.getProperty ("clips", var()).getArray())
                        for (auto& c : *carr)
                            if (c.getProperty ("id", var()).toString() == cid) return true;
            return false;
        };
        while (clipNotes (mClip).size() > 0)
            cmd (ops, "remove_note", objN ({{ "clipId", mClip }, { "noteIndex", 0 }}));
        check (clipNotes (mClip).size() == 0, "remove every note empties the sequence");
        check (clipExists (mClip), "an emptied MIDI clip is NOT auto-deleted (stays in the arrangement)");
    }

    // ─── Wave 8: sends / returns / aux buses ───
    section ("Wave 8: sends / returns / aux buses");
    {
        auto buses  = [&] { return ops.snapshot().getProperty ("buses", var()); };
        auto sendsOf = [&] (const String& tid) -> var { return trackById (tid).getProperty ("sends", var()); };

        const int busesBefore = buses().size();
        auto cb = cmd (ops, "create_bus", args1 ("name", "Reverb"));
        check (ok (cb), "create_bus ok");
        const int bus0 = (int) cb["data"].getProperty ("busNumber", -1);
        const auto rtid = cb["data"].getProperty ("trackId", var()).toString();
        check (buses().size() == busesBefore + 1, "snapshot lists the new bus");
        check ((bool) trackById (rtid).getProperty ("isReturn", false), "return track flagged isReturn");
        check ((int) trackById (rtid).getProperty ("returnBus", -1) == bus0, "return track carries the bus number");
        { bool hasReturn = false;
          auto rt = trackById (rtid);                          // bind to a local (no dangling temporary)
          auto pv = rt.getProperty ("plugins", var());
          if (auto* plugins = pv.getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "auxreturn") hasReturn = true;
          check (hasReturn, "return track carries an auxreturn plugin"); }

        auto cb2 = cmd (ops, "create_bus", args1 ("name", "Delay"));
        check ((int) cb2["data"].getProperty ("busNumber", -1) == bus0 + 1, "second bus gets the next number");

        auto gt = cmd (ops, "create_track", args1 ("name", "Gtr"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -6.0 }}))), "add_send ok");
        { auto s = sendsOf (gt);
          check (s.size() == 1 && (int) s[0].getProperty ("bus", -1) == bus0
                 && std::abs ((double) s[0].getProperty ("db", 0.0) - (-6.0)) < 0.6, "send appears with the right bus + dB"); }
        check (! ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", bus0 }}))), "duplicate send to a bus rejected");
        check (! ok (cmd (ops, "add_send", objN ({{ "trackId", gt }, { "bus", 99 }}))), "send to a nonexistent bus rejected");

        check (ok (cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -3.0 }}))), "set_send_level ok");
        check (std::abs ((double) sendsOf (gt)[0].getProperty ("db", 0.0) - (-3.0)) < 0.6, "send level reflects the new dB");
        cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -100.0 }}));
        check ((bool) sendsOf (gt)[0].getProperty ("mute", false), "send mutes at -100 dB");
        cmd (ops, "set_send_level", objN ({{ "trackId", gt }, { "bus", bus0 }, { "db", -6.0 }}));

        cmd (ops, "save"); cmd (ops, "reload");
        { bool found = false; auto bv = buses();              // bind to a local (no dangling temporary)
          if (auto* arr = bv.getArray()) for (auto& b : *arr) if (b.getProperty ("name", var()).toString() == "Reverb") found = true;
          check (found, "bus name persists across save/reload"); }
        check (sendsOf (gt).size() == 1, "send persists across save/reload");

        // remove_send (was uncovered): drop the gt->bus0 send, undo restores it at its level.
        check (ok (cmd (ops, "remove_send", objN ({{ "trackId", gt }, { "bus", bus0 }}))), "remove_send ok");
        check (sendsOf (gt).size() == 0, "remove_send drops the send");
        check (! ok (cmd (ops, "remove_send", objN ({{ "trackId", gt }, { "bus", bus0 }}))), "remove_send on a missing send errors");
        check (ok (cmd (ops, "undo")), "undo remove_send ok");
        check (sendsOf (gt).size() == 1 && std::abs ((double) sendsOf (gt)[0].getProperty ("db", 0.0) - (-6.0)) < 0.6,
               "undo restores the send at its prior level");

        // rename_bus: renames the bus (and its return track) and is NON-undoable.
        auto hasBusNamed = [&] (const String& nm) -> bool {
            auto bv = buses();
            if (auto* arr = bv.getArray())
                for (auto& b : *arr) if (b.getProperty ("name", var()).toString() == nm) return true;
            return false; };
        auto returnTrackName = [&] (int b) -> String {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr)
                    if ((bool) t.getProperty ("isReturn", false) && (int) t.getProperty ("returnBus", -1) == b)
                        return t.getProperty ("name", var()).toString();
            return {}; };

        check (ok (cmd (ops, "rename_bus", objN ({{ "bus", bus0 }, { "name", "Plate" }}))), "rename_bus ok");
        check (hasBusNamed ("Plate") && ! hasBusNamed ("Reverb"), "bus name reflects rename");
        check (returnTrackName (bus0) == "Plate", "rename_bus updates the return track name too");
        check (! ok (cmd (ops, "rename_bus", objN ({{ "bus", 99 }, { "name", "X" }}))), "rename_bus on a missing bus errors");

        // rename_bus is a NON-undoable preference (like set_key): the bus name is non-undoable
        // in Tracktion (Edit::setAuxBusName uses a nullptr UndoManager), so the WHOLE command
        // is non-undoable — undo must NOT revert it, and crucially must NOT HALF-revert (the
        // return-track name reverting while the bus name doesn't = the old partial-undo bug).
        check (ok (cmd (ops, "undo")), "undo after rename_bus ok");
        check (hasBusNamed ("Plate") && returnTrackName (bus0) == "Plate",
               "undo does NOT revert rename_bus — bus name AND return-track name both stay (non-undoable, no partial-undo)");
        cmd (ops, "rename_bus", objN ({{ "bus", bus0 }, { "name", "Reverb" }}));   // restore for downstream remove_bus

        const int busesNow = buses().size();
        check (ok (cmd (ops, "remove_bus", args1 ("bus", bus0))), "remove_bus ok");
        check (buses().size() == busesNow - 1, "remove_bus drops the bus");
        check (sendsOf (gt).size() == 0, "remove_bus sweeps orphan sends");
    }

    // ─── Wave 9: channel metering (command + snapshot plumbing) ───
    section ("Wave 9: channel metering");
    {
        auto meterOn = [&] (const String& tid) { return (bool) trackById (tid).getProperty ("meterEnabled", false); };
        auto hasLevelInRack = [&] (const String& tid) -> bool {
            auto trk = trackById (tid);
            auto pv = trk.getProperty ("plugins", var());
            if (auto* arr = pv.getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == "level") return true;
            return false;
        };

        auto mt = cmd (ops, "create_track", args1 ("name", "Meters"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "enable_track_meter", args1 ("trackId", mt))), "enable_track_meter ok");
        check (meterOn (mt), "track reports meterEnabled");
        check (! hasLevelInRack (mt), "meter tap is hidden from the plugin rack");
        check (ok (cmd (ops, "enable_track_meter", args1 ("trackId", mt))), "enable_track_meter is idempotent");
        check (meterOn (mt), "still metered after idempotent enable");

        auto ea = cmd (ops, "enable_all_meters");
        check (ok (ea) && (int) ea["data"].getProperty ("count", 0) > 0, "enable_all_meters meters every track");

        check (ok (cmd (ops, "disable_track_meter", args1 ("trackId", mt))), "disable_track_meter ok");
        check (! meterOn (mt), "meter removed after disable");

        // Undo / redo of the tap (a normal pluginList mutation; reconcile keeps the
        // client map safe when the plugin is destroyed by undo).
        cmd (ops, "enable_track_meter", args1 ("trackId", mt));
        check (meterOn (mt), "re-enabled before undo");
        cmd (ops, "undo");
        check (! meterOn (mt), "undo removes the meter tap");
        cmd (ops, "redo");
        check (meterOn (mt), "redo restores the meter tap");
    }

    // ─── METER-001: every track-creation path auto-meters (coverage gap fix) ───
    // Previously only enable_all_meters (called once at UI init) covered a track — a
    // track created MID-SESSION via any of these paths never appeared in the "levels"
    // telemetry, silent-forever, until the app was relaunched. Each of these now
    // self-meters with NO explicit enable_track_meter call.
    section ("METER-001: auto-meter every track-creation path");
    {
        auto meterOn = [&] (const String& tid) { return (bool) trackById (tid).getProperty ("meterEnabled", false); };

        // create_track — the main UI/agent "+ track" path (both audio and drum; drum
        // loads a sampler+kit in the SAME transaction, ahead of the meter, so this
        // also proves the tap lands after that same-command instrument load).
        auto ctA = cmd (ops, "create_track", args1 ("name", "AutoMeterAudio"));
        check (ok (ctA), "create_track (audio) ok");
        const auto ctAId = ctA["data"].getProperty ("trackId", var()).toString();
        check (meterOn (ctAId), "METER-001: a freshly created audio track is metered with no explicit enable call");

        auto ctD = cmd (ops, "create_track", objN ({{ "name", "AutoMeterDrum" }, { "type", "drum" }}));
        check (ok (ctD), "create_track (drum) ok");
        const auto ctDId = ctD["data"].getProperty ("trackId", var()).toString();
        check (meterOn (ctDId), "METER-001: a freshly created drum track is metered too");

        // add_midi_clip — auto-creates its own track when trackId is omitted.
        auto amc = cmd (ops, "add_midi_clip", objN ({{ "name", "AutoMIDI" }}));
        check (ok (amc), "add_midi_clip (auto-create track) ok");
        const auto amcTrackId = amc["data"].getProperty ("trackId", var()).toString();
        check (meterOn (amcTrackId), "METER-001: add_midi_clip's auto-created track is metered");

        // add_drum_pattern (DRM-002) — auto-creates a "Drums" track when neither
        // trackId nor clipId is given.
        auto adp = cmd (ops, "add_drum_pattern", args1 ("pattern", "kick: x...x...x...x..."));
        check (ok (adp), "add_drum_pattern (auto-create track) ok");
        const auto adpTrackId = adp["data"].getProperty ("trackId", var()).toString();
        check (meterOn (adpTrackId), "METER-001: add_drum_pattern's auto-created track is metered");

        // create_bus — a return/bus AudioTrack; not surfaced by a v2 meter widget
        // (buses are excluded from TrackLaneHeader, matching classic Mixer.tsx), but
        // enable_all_meters has always covered every AudioTrack including these, so
        // native-side coverage stays consistent.
        auto cb = cmd (ops, "create_bus", args1 ("name", "AutoMeterBus"));
        check (ok (cb), "create_bus ok");
        const auto cbTrackId = cb["data"].getProperty ("trackId", var()).toString();
        check (meterOn (cbTrackId), "METER-001: a freshly created bus/return track is metered");

        // Self-healing proof: a track whose meter was explicitly DISABLED gets re-metered
        // the next time a mutating command (add_midi_clip on an EXISTING track, not the
        // auto-create branch above) touches it — proving the call really lives in the
        // command handler, not just riding create_track's own auto-meter.
        auto healTrack = cmd (ops, "create_track", args1 ("name", "ReHeal"))["data"].getProperty ("trackId", var()).toString();
        check (meterOn (healTrack), "ReHeal track starts metered (create_track)");
        check (ok (cmd (ops, "disable_track_meter", args1 ("trackId", healTrack))), "disable_track_meter on ReHeal ok");
        check (! meterOn (healTrack), "ReHeal track is un-metered after disable");
        check (ok (cmd (ops, "add_midi_clip", objN ({{ "trackId", healTrack }, { "name", "Heal" }}))),
               "add_midi_clip on the existing ReHeal track ok");
        check (meterOn (healTrack), "METER-001: add_midi_clip self-heals a track whose meter was disabled");
    }

    // ─── Wave: recording (arm / input monitor / snapshot plumbing) ───
    // Headless (--selftest, no audio) there is no playback context, so
    // getAllInputDevices() is empty: arm/monitor are graceful no-ops (applied:false,
    // never an error) and the snapshot fields default false/"automatic"/false. The
    // armed=true round-trip and actual capture are hardware/GUI-gated (see the plan).
    section ("Wave: recording (arm / input monitor)");
    {
        auto rt = cmd (ops, "create_track", args1 ("name", "RecTrack"))["data"].getProperty ("trackId", var()).toString();

        // Snapshot shape: every track var carries armed/monitor/hasInput.
        auto rtv = trackById (rt);
        check (rtv.hasProperty ("armed"), "snapshot track has armed field");
        check (rtv.hasProperty ("monitor"), "snapshot track has monitor field");
        check (rtv.hasProperty ("hasInput"), "snapshot track has hasInput field");
        check (! (bool) rtv.getProperty ("armed", true), "armed defaults false headless");
        check (! (bool) rtv.getProperty ("hasInput", true), "hasInput defaults false headless");
        check (rtv.getProperty ("monitor", var()).toString() == "automatic", "monitor defaults automatic headless");

        // arm_track on a valid track: graceful no-op (ok + applied:false) headless.
        eventTypes.clear();
        auto ar = cmd (ops, "arm_track", objN ({{ "trackId", rt }, { "armed", true }}));
        check (ok (ar), "arm_track ok (graceful)");
        check (! (bool) ar["data"].getProperty ("applied", true), "arm_track applied:false headless (no input device)");
        check (hadEvent ("snapshot_invalidated"), "arm_track emitted snapshot_invalidated");
        check (! (bool) trackById (rt).getProperty ("armed", true), "track still not armed headless (no instance)");

        // arm_track with a bad/missing trackId -> validation error.
        check (! ok (cmd (ops, "arm_track", objN ({{ "trackId", "no-such-track" }, { "armed", true }}))), "arm_track bad trackId errors");

        // set_input_monitor: valid mode ok + applied:false no-op; bad mode errors.
        eventTypes.clear();
        auto mr = cmd (ops, "set_input_monitor", objN ({{ "trackId", rt }, { "mode", "on" }}));
        check (ok (mr), "set_input_monitor mode:on ok (graceful)");
        check (! (bool) mr["data"].getProperty ("applied", true), "set_input_monitor applied:false headless");
        check (hadEvent ("snapshot_invalidated"), "set_input_monitor emitted snapshot_invalidated");
        check (! ok (cmd (ops, "set_input_monitor", objN ({{ "trackId", rt }, { "mode", "banana" }}))), "set_input_monitor bad mode errors");
        check (! ok (cmd (ops, "set_input_monitor", objN ({{ "trackId", "nope" }, { "mode", "on" }}))), "set_input_monitor bad trackId errors");

        // arm_track / set_input_monitor are non-undoable monitoring preferences (the
        // engine binds the armed flag with a nullptr UndoManager and monitor mode persists
        // via saveProps, never the Edit undo stack — like set_metronome). So an undo after
        // arm_track walks back to a prior real transaction by design; we only assert it
        // stays ok and the snapshot is still well-formed (no crash).
        check (ok (cmd (ops, "arm_track", objN ({{ "trackId", rt }, { "armed", false }}))), "arm_track disarm ok");
        check (ok (cmd (ops, "undo")), "undo after arm_track ok (no crash)");
        check (ops.snapshot().hasProperty ("tracks"), "snapshot still well-formed after arm-then-undo");

        // JSONL records the recording commands, logged undoable:false (preferences).
        auto rlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (rlog.contains ("arm_track"), "JSONL records arm_track");
        check (rlog.contains ("set_input_monitor"), "JSONL records set_input_monitor");
        bool armPref = false, monPref = false;
        for (auto& ln : juce::StringArray::fromLines (rlog))
        {
            if (ln.contains ("\"command\": \"arm_track\"") && ln.contains ("\"undoable\": false")) armPref = true;
            if (ln.contains ("\"command\": \"set_input_monitor\"") && ln.contains ("\"undoable\": false")) monPref = true;
        }
        check (armPref, "arm_track logged undoable:false (monitoring preference)");
        check (monPref, "set_input_monitor logged undoable:false (monitoring preference)");

        // ── Take lanes (audio): the commands DISPATCH + degrade gracefully. Real takes
        // need live recording (no input device headless), so we verify the surface is wired
        // — a missing clip yields the HANDLER's error ("no wave clip"), not "unknown command".
        {
            auto lt = cmd (ops, "list_takes", objN ({{ "clipId", "no-such-clip" }}));
            check (! ok (lt), "list_takes on a missing clip errors (dispatched, not unknown)");
            check (lt["error"].toString().contains ("wave clip"), "list_takes error is the handler's (no wave clip)");
            check (! ok (cmd (ops, "set_current_take", objN ({{ "clipId", "no-such-clip" }, { "takeIndex", 0 }}))), "set_current_take on a missing clip errors");
            check (! ok (cmd (ops, "keep_take", objN ({{ "clipId", "no-such-clip" }}))), "keep_take on a missing clip errors");
            auto mark = cmd (ops, "mark_take", objN ({
                { "source", "phone_controller" },
                { "controllerEvent", "TAKE_MARK" },
                { "controllerLabel", "flagged" }
            }));
            check (ok (mark), "mark_take logs a phone controller label");
            auto controller = ops.snapshot().getProperty ("controller", var());
            check (controller.isObject(), "snapshot exposes additive controller block");
            check (controller.getProperty ("agent", var()).toString() == "idle", "controller agent state defaults idle");
            check (controller.getProperty ("take", var()).getProperty ("exists", true).isBool(), "controller take state exposes exists");
            auto controllerLog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            check (controllerLog.contains ("\"command\": \"mark_take\""), "JSONL records mark_take");
            check (controllerLog.contains ("\"source\": \"phone_controller\""), "mark_take records phone_controller source");
            check (controllerLog.contains ("\"controllerLabel\": \"flagged\""), "mark_take records flagged label");
        }

        // ── CTL-001: live MIDI controller -> armed instrument track ──
        // Headless there is no MIDI input device enumerated (the engine only adds them
        // once CoreAudio/MIDI is up + ensurePlaybackContext enables them, both audio-
        // gated), so list_midi_inputs is a well-formed empty array and arming an
        // instrument track is a graceful applied:false no-op. The actual note flow
        // (controller -> armed synth -> audible audio) is HARDWARE-GATED (live verify).

        // list_midi_inputs: read-only, ok, well-formed (possibly empty) array; NOT logged.
        auto lmi = cmd (ops, "list_midi_inputs");
        check (ok (lmi), "list_midi_inputs ok");
        check (lmi["data"].getProperty ("inputs", var()).isArray(), "list_midi_inputs returns an inputs array");
        check (lmi["data"].hasProperty ("audioEnabled"), "list_midi_inputs reports audioEnabled gate");
        {
            // Read-only: must not pollute the command log (mirrors list_audio_devices).
            auto lg = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            check (! lg.contains ("list_midi_inputs"), "list_midi_inputs is not logged (read-only)");
        }

        // Build an INSTRUMENT track (4OSC builtin) — arm_track should target a MIDI
        // input on it (vs a wave input on a plain track). Snapshot must report it.
        auto it = cmd (ops, "create_track", args1 ("name", "Instrument"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", it }, { "type", "4osc" }}))), "load 4OSC instrument ok");
        auto itv = trackById (it);
        check ((bool) itv.getProperty ("isInstrument", false), "instrument track reports isInstrument:true");
        check (itv.hasProperty ("inputType"), "snapshot track has inputType field");
        check (itv.getProperty ("inputType", var()).toString() == "wave", "inputType defaults wave (no routed input headless)");

        // A plain track (no synth) is NOT an instrument track. Use a freshly-created
        // bare track (the earlier `rt` may have been undone away by an arm_track+undo
        // probe above — arm is non-undoable so undo walks back to its create_track).
        auto pt = cmd (ops, "create_track", args1 ("name", "Plain"))["data"].getProperty ("trackId", var()).toString();
        check (! (bool) trackById (pt).getProperty ("isInstrument", true), "plain track reports isInstrument:false");

        // arm_track on the instrument track: graceful no-op headless (no MIDI device).
        eventTypes.clear();
        auto ari = cmd (ops, "arm_track", objN ({{ "trackId", it }, { "armed", true }}));
        check (ok (ari), "arm_track on instrument track ok (graceful)");
        check (! (bool) ari["data"].getProperty ("applied", true), "arm_track instrument applied:false headless (no MIDI device)");
        check (hadEvent ("snapshot_invalidated"), "arm_track (instrument) emitted snapshot_invalidated");
        check (! (bool) trackById (it).getProperty ("armed", true), "instrument track still not armed headless (no MIDI instance)");

        // Still a non-undoable preference on the MIDI path (no transaction pushed).
        check (ok (cmd (ops, "arm_track", objN ({{ "trackId", it }, { "armed", false }}))), "arm_track (instrument) disarm ok");
        check (ok (cmd (ops, "undo")), "undo after instrument arm_track ok (no crash)");
        {
            auto ilog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool armInstPref = false;
            for (auto& ln : juce::StringArray::fromLines (ilog))
                if (ln.contains ("\"command\": \"arm_track\"") && ln.contains ("\"undoable\": false")) armInstPref = true;
            check (armInstPref, "arm_track (MIDI path) logged undoable:false (preference)");
        }

        // ── Wave B: record-to-take landing (TRA-002 / MID-001 / ARE-003) ──
        // stop_recording stops the transport KEEPING takes, drains the async clip-add,
        // and returns the landed clip id(s). Headless (--selftest, no audio) there is no
        // playback context and nothing was captured, so it is a graceful no-op
        // (ok + applied:false + clips:[], NEVER an error) — exactly the arm_track posture.
        // The ACTUAL take landing (a wave clip from a live mic, a MIDI clip from a
        // controller) + ARE-003 latency-compensated clip start are HARDWARE-GATED: they
        // need a live interface + keyboard, verified live by the user. We do NOT fake a
        // landed take here.
        section ("Wave B: record-to-take landing (stop_recording)");

        // Use a FRESH wave track: the earlier `rt` may have been undone away by the
        // arm_track+undo probes above (arm is non-undoable, so undo walks back to its
        // create_track). Same precaution the CTL-001 block takes for its `pt`.
        auto rb = cmd (ops, "create_track", args1 ("name", "RecTakeTrack"))["data"].getProperty ("trackId", var()).toString();

        // arm the wave track, then "record" (no-op headless) so stop_recording has the
        // canonical arm -> record -> stop sequence to walk.
        check (ok (cmd (ops, "arm_track", objN ({{ "trackId", rb }, { "armed", true }}))), "arm_track (wave) ok for record-to-take");
        eventTypes.clear();
        auto recR = cmd (ops, "set_transport", objN ({{ "action", "record" }}));
        check (ok (recR), "set_transport record ok (graceful headless)");
        check (hadEvent ("transport"), "set_transport record emitted a transport event");

        // stop_recording headless: ok, applied:false, clips:[], a reason, both events.
        eventTypes.clear();
        auto stopR = cmd (ops, "stop_recording");
        check (ok (stopR), "stop_recording ok (graceful)");
        check (! (bool) stopR["data"].getProperty ("applied", true), "stop_recording applied:false headless (no playback context)");
        {
            auto cl = stopR["data"].getProperty ("clips", var());   // bind to a local before getArray
            check (cl.isArray() && cl.size() == 0, "stop_recording lands no clips headless (clips:[])");
        }
        check (stopR["data"].hasProperty ("reason"), "stop_recording reports a reason headless");
        check (hadEvent ("transport"), "stop_recording emitted a transport event");
        check (hadEvent ("snapshot_invalidated"), "stop_recording emitted snapshot_invalidated");

        // discardRecordings:true is also a graceful no-op headless (throws nothing away,
        // lands nothing) — exercises the discard branch of the command.
        auto discardR = cmd (ops, "stop_recording", objN ({{ "discardRecordings", true }}));
        check (ok (discardR), "stop_recording discardRecordings:true ok (graceful)");
        {
            auto cl = discardR["data"].getProperty ("clips", var());
            check (cl.isArray() && cl.size() == 0, "stop_recording discard lands no clips headless");
        }
        check ((bool) discardR["data"].getProperty ("discarded", false), "stop_recording echoes discarded:true");

        // Idempotent: calling stop_recording again when not recording is a clean no-op.
        check (ok (cmd (ops, "stop_recording")), "stop_recording when not recording is a no-op ok");

        // JSONL records stop_recording, logged undoable:false (a recording-lifecycle op,
        // NOT an undoable session edit).
        {
            auto srlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            check (srlog.contains ("stop_recording"), "JSONL records stop_recording");
            bool srPref = false;
            for (auto& ln : juce::StringArray::fromLines (srlog))
                if (ln.contains ("\"command\": \"stop_recording\"") && ln.contains ("\"undoable\": false")) srPref = true;
            check (srPref, "stop_recording logged undoable:false (recording-lifecycle op)");
        }

        // Disarm so the recording test block leaves no armed input behind.
        check (ok (cmd (ops, "arm_track", objN ({{ "trackId", rb }, { "armed", false }}))), "arm_track (wave) disarm after record-to-take ok");
    }

    // ─── MON-003: monitoring round-trip latency readout ───
    // Hardware input+output latency (getRecordAdjustment*) — the delay a performer
    // hears via software input monitoring. Needs only an open device (NOT a prepared
    // graph), so it is 0 headless. Read-only state, not a command. The real numbers +
    // audible low-latency monitoring are HARDWARE-GATED (verified live).
    section ("MON-003: monitoring round-trip latency readout");
    {
        auto sess = ops.snapshot().getProperty ("session", var());
        check (sess.hasProperty ("roundTripLatencyMs"), "session.roundTripLatencyMs present");
        check (sess.hasProperty ("roundTripLatencySamples"), "session.roundTripLatencySamples present");
        const double rtMs      = (double) sess.getProperty ("roundTripLatencyMs", -1.0);
        const int    rtSamples = (int) sess.getProperty ("roundTripLatencySamples", -1);
        check (rtMs >= 0.0, "roundTripLatencyMs is non-negative");
        check (rtSamples >= 0, "roundTripLatencySamples is non-negative");

        // Honest headless posture: no open device -> getRecordAdjustment* return 0
        // (NOT a false real value); the real figure is GUI / live-audio verified.
        if (! eng.hasAudio())
        {
            check (rtMs == 0.0, "no-audio headless -> roundTripLatencyMs=0 (honest, not a false value)");
            check (rtSamples == 0, "no-audio headless -> roundTripLatencySamples=0");
        }

        // No regression to the existing readout fields the UI also reads.
        check (sess.hasProperty ("bufferSize"), "session.bufferSize still present (no regression)");
        check (sess.hasProperty ("outputLatencyMs"), "session.outputLatencyMs still present (no regression)");
    }
}

} // namespace mosh
