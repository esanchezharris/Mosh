// ── SelfTest.Ch01_commands_arrangement.cpp — runSelfTest chapter 1 (RFC 002 A-PR5) ──────
// Sections moved VERBATIM by prefix-motion from src/app/SelfTest.cpp
// (pre-split lines 116-386), in exact pre-split order:
//   . "Stage 1: command surface / cold snapshot"
//   . "Agent batch: N edits = one undo step"
//   . "Stage 2: arrangement + mixer"
//   . "BRW-007: import_clip_data (bytes-over-bridge)"
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

void runChapter01_commands_arrangement (selftest::SelfTestCtx& ctx)
{
    using namespace juce;
    auto& eng = *ctx.eng;
    auto& ops = *ctx.ops;

    section ("Stage 1: command surface / cold snapshot");

    // Capture emitted events (type history + the latest full event, so a scoped-invalidation
    // check can inspect the payload).
    auto& eventTypes = ctx.eventTypes;
    auto& lastEvent = ctx.lastEvent;
    ops.setEventSink ([&] (const var& e) { eventTypes.push_back (e.getProperty ("type", var()).toString()); lastEvent = e; });

    auto& hadEvent = ctx.hadEvent = [&] (const String& t) {
        for (auto& e : eventTypes) if (e == t) return true; return false; };

    // 1. cold snapshot
    check (tracks (ops) == 0, "cold snapshot has no tracks");
    check ((int) ops.snapshot().getProperty ("schemaVersion", 0) == 1, "snapshot schemaVersion == 1");

    // 1a. MOSH_SELFTEST_SESSION isolation: when set, the harness must run in its
    // own private session dir (so concurrent worktree runs don't clobber each other).
    // MOSH_SELFTEST_SESSION may be a nested path (`_harness/<leaf>`) — harness runs nest
    // so their leaves cannot pile up beside the owner's real data in ~/Library/Mosh.
    // Compare LEAF to LEAF: `getFileName()` returns only the last component, so matching it
    // against the raw env value would fail for any nested value. `fromLastOccurrenceOf`
    // returns the whole string when there is no '/', so a flat value behaves exactly as before.
    if (const auto s = SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).trim(); s.isNotEmpty())
        check (eng.sessionDir().getFileName() == s.fromLastOccurrenceOf ("/", false, false),
               "MOSH_SELFTEST_SESSION isolates the session dir (" + s + ")");

    // 1a'. ALWAYS: whichever route got us here, this run must own its session dir. A bare
    // shared leaf means a concurrent selftest is wiping our exports/save/log mid-run and
    // every result below is untrustworthy -- so assert it rather than emit a plausible
    // pass. (SLF-CONC-001: a plain run auto-isolates per process; an explicit
    // MOSH_SELFTEST_SESSION is the caller's own private leaf.)
    {
        const auto leaf = eng.sessionDir().getFileName();
        // Same leaf-vs-path point as 1a: an explicit MOSH_SELFTEST_SESSION may nest.
        const auto explicitLeaf = SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {})
                                      .trim().fromLastOccurrenceOf ("/", false, false);
        check (mosh::sessionpaths::isAutoIsolatedLeaf (leaf) || (explicitLeaf.isNotEmpty() && leaf == explicitLeaf),
               "session dir is private to this run, not a shared fixed path (" + leaf + ")");
    }

    // 1b. import-error integrity (no partial mutation): importing an INVALID audio
    // file onto an edit with no audio tracks must NOT auto-create a stray track.
    // importWaveFileToTrack used to begin its undo transaction + create the track
    // BEFORE validating the file, so a failed import left an orphan track in a
    // "failed" command's transaction. Regression guard for validate-before-mutate.
    {
        auto badFile = eng.sessionDir().getChildFile ("selftest-not-audio.txt");
        badFile.replaceWithText ("this is plainly not a wav/aiff file");
        auto badImp = cmd (ops, "import_clip", args1 ("file", badFile.getFullPathName()));
        check (! ok (badImp), "import_clip of an invalid file fails");
        check (tracks (ops) == 0, "failed invalid import created no stray track (no partial mutation)");
        badFile.deleteFile();
    }

    // 2. create_track
    auto r = cmd (ops, "create_track", args1 ("name", "Drums"));
    check (ok (r), "create_track ok");
    check (tracks (ops) == 1, "snapshot has 1 track after create_track");
    check (firstTrack (ops).getProperty ("name", var()).toString() == "Drums", "track name == Drums");
    check (hadEvent ("snapshot_invalidated"), "create_track emitted snapshot_invalidated");

    // 3. add_test_tone_clip -> wave clip on the track
    auto toneArgs = new DynamicObject();
    toneArgs->setProperty ("seconds", 2.0);
    toneArgs->setProperty ("freq", 220.0);
    auto rt = cmd (ops, "add_test_tone_clip", var (toneArgs));
    check (ok (rt), "add_test_tone_clip ok");
    auto t0 = firstTrack (ops);
    check (trackClips (t0) == 1, "track has 1 clip");
    auto clip0 = t0["clips"][0];
    check (clip0.getProperty ("type", var()).toString() == "wave", "clip type == wave");
    check (std::abs ((double) clip0.getProperty ("length", 0.0) - 2.0) < 0.05, "clip length ~= 2.0s");
    const auto clipId = clip0.getProperty ("id", var()).toString();
    check (File (clip0.getProperty ("sourceFile", var()).toString()).existsAsFile(), "clip source WAV exists on disk");

    // 4. transport: play -> playing; stop; seek
    auto rp = cmd (ops, "set_transport", args1 ("action", "play"));
    check (ok (rp), "set_transport play ok");
    if (eng.hasAudio())
    {
        check ((bool) rp["data"].getProperty ("playing", false), "transport reports playing after play");
        check (eng.edit().getTransport().getCurrentPlaybackContext() != nullptr, "playback context allocated (audio attached)");
    }
    else
        std::cerr << "  ..   (no-audio headless run — live-playback checks done via the GUI)\n";
    cmd (ops, "set_transport", args1 ("action", "stop"));
    auto seekArgs = new DynamicObject(); seekArgs->setProperty ("position", 1.0);
    cmd (ops, "set_transport", var (seekArgs));
    check (std::abs ((double) ops.snapshot()["transport"].getProperty ("position", 0.0) - 1.0) < 0.05, "seek to 1.0s reflected in snapshot");
    check (hadEvent ("transport"), "set_transport emitted a transport event");

    // 5. add_render_layer on the clip (RenderLayer model, 01 §4)
    auto rl = cmd (ops, "add_render_layer", args1 ("clipId", clipId));
    check (ok (rl), "add_render_layer ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "clip now hasRenderLayer");

    // 6. undo / redo through MoshOps (one command = one undo step)
    cmd (ops, "undo");   // undo add_render_layer
    check (! (bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", true), "undo removed the render layer");
    cmd (ops, "undo");   // undo import_clip
    check (trackClips (firstTrack (ops)) == 0, "undo removed the clip");
    cmd (ops, "undo");   // undo create_track
    check (tracks (ops) == 0, "undo removed the track");
    cmd (ops, "redo");   // redo create_track
    check (tracks (ops) == 1, "redo restored the track");
    cmd (ops, "redo");   // redo import_clip
    check (trackClips (firstTrack (ops)) == 1, "redo restored the clip");

    // 7. save -> reload restores state (incl. MOSH_RENDERLAYER survives once redone)
    cmd (ops, "redo");   // redo add_render_layer so it's part of saved state
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "render layer restored by redo");
    check (ok (cmd (ops, "save")), "save ok");
    check (ok (cmd (ops, "reload")), "reload ok");
    check (tracks (ops) == 1, "reload restored 1 track");
    auto reclip = firstTrack (ops)["clips"][0];
    check (trackClips (firstTrack (ops)) == 1, "reload restored 1 clip");
    check ((bool) reclip.getProperty ("hasRenderLayer", false), "reload restored MOSH_RENDERLAYER node");

    // 8. JSONL log records the semantic commands
    auto log = eng.sessionDir().getChildFile ("mosh-log.jsonl");
    check (log.existsAsFile(), "JSONL log file exists");
    auto logText = log.loadFileAsString();
    auto logsCommand = [&] (const String& c) { return logText.contains ("\"command\"") && logText.contains (c); };
    check (logsCommand ("create_track"), "JSONL records create_track");
    check (logsCommand ("import_clip"),  "JSONL records import_clip");
    check (logsCommand ("set_transport"),"JSONL records set_transport");
    check (logsCommand ("undo"),         "JSONL records undo");

    // ─── Agent batch (batch_begin/end): N edits coalesce into ONE undo step ───
    // This is what "Monster changes" rides on — the agent brackets its edits so a
    // single Undo reverts the whole thing. Leaves state unchanged for Stage 2.
    section ("Agent batch: N edits = one undo step");
    const int batchBase = tracks (ops);
    check (ok (cmd (ops, "batch_begin", objN ({ { "name", "agent edit" } }))), "batch_begin ok");
    check (! ok (cmd (ops, "batch_begin")), "second batch_begin errors (already open)");
    cmd (ops, "create_track", objN ({ { "name", "Agent A" } }));
    cmd (ops, "create_track", objN ({ { "name", "Agent B" } }));
    check (tracks (ops) == batchBase + 2, "two tracks created inside the batch");
    check (ok (cmd (ops, "batch_end")), "batch_end ok");
    check (! ok (cmd (ops, "batch_end")), "second batch_end errors (none open)");
    cmd (ops, "undo");
    check (tracks (ops) == batchBase, "one undo reverts the whole batch (both tracks gone)");
    cmd (ops, "redo");
    check (tracks (ops) == batchBase + 2, "one redo restores the whole batch");
    cmd (ops, "undo");
    check (tracks (ops) == batchBase, "batch undone again — clean state for Stage 2");

    // ─── Stage 2: arrangement editing + mixer stub ───
    section ("Stage 2: arrangement + mixer");
    const auto cid = firstTrack (ops)["clips"][0].getProperty ("id", var()).toString();
    const auto& tid = ctx.tid = firstTrack (ops).getProperty ("id", var()).toString();

    // move_clip -> start 2.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("start", 2.0);
      check (ok (cmd (ops, "move_clip", var (a))), "move_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("start", 0.0) - 2.0) < 0.05, "clip moved to 2.0s");

    // trim_clip -> length 1.0s
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("length", 1.0);
      check (ok (cmd (ops, "trim_clip", var (a))), "trim_clip ok"); }
    check (std::abs ((double) firstTrack (ops)["clips"][0].getProperty ("length", 0.0) - 1.0) < 0.05, "clip trimmed to 1.0s");

    // split_clip -> 2 clips
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("time", 2.5);
      check (ok (cmd (ops, "split_clip", var (a))), "split_clip ok"); }
    check (trackClips (firstTrack (ops)) == 2, "split produced 2 clips");

    // P1 split-point normalization: the left child spans [2.0, 2.5] — a request of 0.25
    // is outside absolutely but resolves clip-relatively to 2.25 (must split); the exact
    // start and a far-outside value must ERROR (not silently no-op).
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("time", 0.25);
      check (ok (cmd (ops, "split_clip", var (a))), "split_clip clip-relative time resolves"); }
    check (trackClips (firstTrack (ops)) == 3, "relative split produced 3 clips");
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("time", 2.0);
      check (! ok (cmd (ops, "split_clip", var (a))), "split at exact clip start errors"); }
    { auto* a = new DynamicObject(); a->setProperty ("clipId", cid); a->setProperty ("time", 99.0);
      check (! ok (cmd (ops, "split_clip", var (a))), "split far outside clip errors"); }

    // mixer: volume / pan / mute / solo
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("db", -6.0);
      check (ok (cmd (ops, "set_track_volume", var (a))), "set_track_volume ok"); }
    check (std::abs ((double) firstTrack (ops).getProperty ("volumeDb", 0.0) + 6.0) < 0.5, "track volume ~= -6 dB");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("pan", 0.5);
      cmd (ops, "set_track_pan", var (a)); }
    check (std::abs ((double) firstTrack (ops).getProperty ("pan", 0.0) - 0.5) < 0.05, "track pan ~= 0.5");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("mute", true);
      cmd (ops, "set_track_mute", var (a)); }
    check ((bool) firstTrack (ops).getProperty ("mute", false), "track muted");
    { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("solo", true);
      cmd (ops, "set_track_solo", var (a)); }
    check ((bool) firstTrack (ops).getProperty ("solo", false), "track soloed");

    // get_clip_peaks -> non-empty peak array (waveform from backend)
    { auto* a = new DynamicObject(); a->setProperty ("clipId", firstTrack (ops)["clips"][0].getProperty ("id", var()));
      a->setProperty ("buckets", 200);
      auto pk = cmd (ops, "get_clip_peaks", var (a));
      check (ok (pk), "get_clip_peaks ok");
      check ((int) pk["data"].getProperty ("buckets", 0) > 0, "peaks array non-empty"); }

    // ─── BRW-007: drag-and-drop audio import via import_clip_data ───
    // The drag GESTURE itself is GUI-gated (WKWebView HTML5 drop) and is NOT
    // faked here; the headless import_clip_data command IS fully testable: it
    // decodes base64 bytes, validates real audio, and inserts an undoable clip.
    section ("BRW-007: import_clip_data (bytes-over-bridge)");
    {
        // Read a known-good small WAV (the test-tone source on the first clip)
        // into memory and base64-encode it (inverse of convertFromBase64).
        File wav (firstTrack (ops)["clips"][0].getProperty ("sourceFile", var()).toString());
        check (wav.existsAsFile(), "have a real source WAV for import_clip_data");
        MemoryBlock raw;
        wav.loadFileAsData (raw);
        const auto wavB64 = juce::Base64::toBase64 (raw.getData(), raw.getSize());
        check (wavB64.isNotEmpty(), "WAV base64-encoded");

        const int clipsBefore = trackClips (firstTrack (ops));
        // The WAV's TRUE full duration (source length) -- NOT clip[0].length, which may
        // be trimmed -- to compare against the imported clip.
        const double srcDuration = (double) firstTrack (ops)["clips"][0].getProperty ("sourceLength", 0.0);

        // Happy path: import the decoded WAV onto the first track.
        auto rImp = cmd (ops, "import_clip_data",
                         objN ({ { "name", "dropped.wav" }, { "dataBase64", wavB64 }, { "trackId", tid } }));
        check (ok (rImp), "import_clip_data ok");
        check (trackClips (firstTrack (ops)) == clipsBefore + 1, "import_clip_data added a clip");
        // Find the ACTUALLY-imported clip by its (uniquified) source path -- it lands at
        // start 0, so it is NOT necessarily the last index (clips are ordered by start).
        const auto importedPath = rImp["data"].getProperty ("file", var()).toString();
        double importedLen = -1.0;
        {
            auto ft = firstTrack (ops);
            auto ftClips = ft.getProperty ("clips", var());
            if (auto* arr = ftClips.getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("sourceFile", var()).toString() == importedPath)
                        importedLen = (double) c.getProperty ("length", 0.0);
        }
        check (importedLen > 0.0, "found the imported clip by its source path");
        check (std::abs (importedLen - srcDuration) < 0.05, "imported clip length matches the true source duration");
        check (File (importedPath).existsAsFile(), "imported file exists under sessionDir/imports");

        // Undoable: undo removes the just-imported clip.
        cmd (ops, "undo");
        check (trackClips (firstTrack (ops)) == clipsBefore, "undo removed the imported clip");
        cmd (ops, "redo");   // restore so later tests see the same state as before
        check (trackClips (firstTrack (ops)) == clipsBefore + 1, "redo restored the imported clip");
        cmd (ops, "undo");   // leave the arrangement as it was pre-import
        check (trackClips (firstTrack (ops)) == clipsBefore, "import_clip_data undone (clean state for later tests)");

        // Invalid base64 -> errResult, no crash.
        auto rBad = cmd (ops, "import_clip_data",
                         objN ({ { "name", "bad.wav" }, { "dataBase64", "!!!notbase64!!!" } }));
        check (! ok (rBad), "import_clip_data rejects invalid base64");

        // Valid base64 of NON-audio bytes -> errResult + no clip + no garbage file.
        const char* hello = "hello world";
        const auto helloB64 = juce::Base64::toBase64 (hello, (size_t) std::strlen (hello));
        const int clipsNow = trackClips (firstTrack (ops));
        auto rNon = cmd (ops, "import_clip_data",
                         objN ({ { "name", "notaudio.wav" }, { "dataBase64", helloB64 }, { "trackId", tid } }));
        check (! ok (rNon), "import_clip_data rejects non-audio bytes");
        check (trackClips (firstTrack (ops)) == clipsNow, "non-audio import added no clip");
        File garbage (eng.sessionDir().getChildFile ("imports").getChildFile ("notaudio.wav"));
        check (! garbage.existsAsFile(), "non-audio temp file was deleted (no garbage)");

        // Missing name / missing dataBase64 -> errResult.
        check (! ok (cmd (ops, "import_clip_data", objN ({ { "dataBase64", wavB64 } }))),
               "import_clip_data rejects missing name");
        check (! ok (cmd (ops, "import_clip_data", objN ({ { "name", "x.wav" } }))),
               "import_clip_data rejects missing dataBase64");
    }
}

} // namespace mosh
