#include "SelfTest.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include "brain/BrainProxy.h"
#include "voice/NativeSpeech.h"
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    int failures = 0;
    int checks = 0;
    juce::String activeSection;
    double activeSectionStartedMs = 0.0;
    int activeSectionStartChecks = 0;
    int activeSectionStartFailures = 0;

    void finishSection()
    {
        if (activeSection.isEmpty())
            return;

        const auto elapsed = (juce::Time::getMillisecondCounterHiRes() - activeSectionStartedMs) / 1000.0;
        std::cerr << "  ..   section \"" << activeSection.toStdString() << "\" completed in "
                  << juce::String (elapsed, 3).toStdString() << "s ("
                  << (checks - activeSectionStartChecks) << " checks, "
                  << (failures - activeSectionStartFailures) << " failed)" << std::endl;
        activeSection.clear();
    }

    void resetSections()
    {
        activeSection.clear();
        activeSectionStartedMs = 0.0;
        activeSectionStartChecks = checks;
        activeSectionStartFailures = failures;
    }

    void section (const juce::String& name)
    {
        finishSection();
        activeSection = name;
        activeSectionStartedMs = juce::Time::getMillisecondCounterHiRes();
        activeSectionStartChecks = checks;
        activeSectionStartFailures = failures;
        std::cerr << "--- " << name.toStdString() << " ---" << std::endl;
    }

    void check (bool cond, const juce::String& what)
    {
        ++checks;
        std::cerr << (cond ? "  ok   " : "  FAIL ");
        if (! cond && activeSection.isNotEmpty())
            std::cerr << "[" << activeSection.toStdString() << "] ";
        std::cerr << what << std::endl;  // flush each line
        if (! cond) ++failures;
    }

    juce::var cmd (MoshOps& ops, const juce::String& name, juce::var args = juce::var())
    {
        auto* c = new juce::DynamicObject();
        c->setProperty ("command", name);
        if (! args.isVoid()) c->setProperty ("args", args);
        return ops.execute (juce::var (c));
    }

    juce::var args1 (const char* k, juce::var v)
    {
        auto* o = new juce::DynamicObject();
        o->setProperty (k, v);
        return juce::var (o);
    }

    juce::var objN (std::initializer_list<std::pair<const char*, juce::var>> kv)
    {
        auto* o = new juce::DynamicObject();
        for (auto& p : kv) o->setProperty (p.first, p.second);
        return juce::var (o);
    }

    class LiveAudioProbe final : public juce::AudioIODeviceCallback
    {
    public:
        void audioDeviceAboutToStart (juce::AudioIODevice* device) override
        {
            sampleRate = device != nullptr ? device->getCurrentSampleRate() : 48000.0;
            if (sampleRate <= 0.0)
                sampleRate = 48000.0;
            phase = 0.0;
        }

        void audioDeviceStopped() override {}

        void audioDeviceIOCallbackWithContext (const float* const* inputChannelData,
                                               int numInputChannels,
                                               float* const* outputChannelData,
                                               int numOutputChannels,
                                               int numSamples,
                                               const juce::AudioIODeviceCallbackContext&) override
        {
            callbacks.fetch_add (1, std::memory_order_relaxed);
            samples.fetch_add (numSamples, std::memory_order_relaxed);
            inputSamples.fetch_add (numSamples * juce::jmax (0, numInputChannels), std::memory_order_relaxed);

            for (int ch = 0; ch < numInputChannels; ++ch)
                if (auto* in = inputChannelData[ch])
                    for (int i = 0; i < numSamples; ++i)
                        if (std::abs (in[i]) > 0.01f)
                            inputNonSilentSamples.fetch_add (1, std::memory_order_relaxed);

            const auto inc = juce::MathConstants<double>::twoPi * 440.0 / sampleRate;
            int writtenThisBlock = 0;
            for (int i = 0; i < numSamples; ++i)
            {
                const auto s = (float) (std::sin (phase) * 0.35);
                for (int ch = 0; ch < numOutputChannels; ++ch)
                    if (auto* out = outputChannelData[ch])
                    {
                        out[i] = s;
                        ++writtenThisBlock;
                    }

                phase += inc;
                if (phase >= juce::MathConstants<double>::twoPi)
                    phase -= juce::MathConstants<double>::twoPi;
            }
            writtenSamples.fetch_add (writtenThisBlock, std::memory_order_relaxed);
        }

        int getCallbackCount() const { return callbacks.load (std::memory_order_relaxed); }
        int getSampleCount() const { return samples.load (std::memory_order_relaxed); }
        int getWrittenSampleCount() const { return writtenSamples.load (std::memory_order_relaxed); }
        int getInputSampleCount() const { return inputSamples.load (std::memory_order_relaxed); }
        int getInputNonSilentSampleCount() const { return inputNonSilentSamples.load (std::memory_order_relaxed); }

    private:
        double phase = 0.0;
        double sampleRate = 48000.0;
        std::atomic<int> callbacks { 0 };
        std::atomic<int> samples { 0 };
        std::atomic<int> writtenSamples { 0 };
        std::atomic<int> inputSamples { 0 };
        std::atomic<int> inputNonSilentSamples { 0 };
    };

    bool ok (const juce::var& r) { return (bool) r.getProperty ("ok", false); }

    int tracks (MoshOps& ops) { return ops.snapshot().getProperty ("tracks", juce::var()).size(); }

    juce::var firstTrack (MoshOps& ops) { return ops.snapshot()["tracks"][0]; }
    int trackClips (const juce::var& t) { return t.getProperty ("clips", juce::var()).size(); }
}

// Headless deep plugin scan (--scan-plugins-deep): a synchronous out-of-process
// VST3 + AudioUnit sweep with the hang-watchdog engaged, then prints the catalog +
// the quarantine list. This is the terminal entry for cataloging a big/hostile
// plugin set (e.g. a conflicting Waves install) without tying up the GUI.
int runDeepPluginScan (MoshOps& ops)
{
    using namespace juce;
    std::cerr << "===== Deep plugin scan: out-of-process VST3 + AudioUnit (hang-watchdog) =====\n";

    // PRECONDITION: this runs on a BACKGROUND thread (Main spawns it) while the JUCE
    // message loop keeps pumping. That matters — te's out-of-process scanner manages
    // its child via the message thread, so if we blocked the message thread here the
    // OOP path would fall back to IN-PROCESS scanning and a hostile plugin (e.g. a
    // WaveShell that builds an NSWindow on load) would crash this process off-main.
    const auto t0 = Time::getMillisecondCounterHiRes();
    const int total = ops.pluginHostForScan().rescan (/*clearFirst=*/false, /*includeVST3=*/true,
                                                      /*includeAU=*/true, /*slowVST3=*/true);
    const auto secs = (Time::getMillisecondCounterHiRes() - t0) / 1000.0;
    std::cerr << "  rescan done: " << total << " catalog types in "
              << String (secs, 1).toStdString() << "s\n";

    auto data = cmd (ops, "list_plugins")["data"];
    auto counts = data.getProperty ("counts", var());
    std::cerr << "  catalog: vst3=" << (int) counts.getProperty ("vst3", -1)
              << "  au=" << (int) counts.getProperty ("au", -1)
              << "  total=" << (int) counts.getProperty ("total", -1) << "\n";

    if (auto* bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var()).getArray())
    {
        std::cerr << "  quarantined/blocklisted (" << bl->size() << "):\n";
        for (auto& b : *bl)
            std::cerr << "    x " << b.getProperty ("id", b).toString().toStdString() << "\n";
    }

    std::cerr << "===== deep scan complete =====\n";
    return 0;
}

// The harness hosts a REAL external plugin to exercise VST3 hosting, but it must NEVER
// host an arbitrary user-installed plugin. Many installed plugins destabilise the HOST
// itself (not merely themselves) on teardown, aborting the whole Mosh process:
//   • a cracked/badly-behaved VST3 spawns a background thread that outlives its instance
//     and locks an already-freed std::mutex -> EINVAL -> uncaught std::system_error
//     (observed: SIR Audio Tools "StandardCLIP" / its QueueControlThread);
//   • a stock Apple AudioUnit leaves a CoreAudio CAEventReceiver timer whose std::function
//     is cleared on teardown -> bad_function_call when the timer next fires during a
//     message-loop pump (observed: AUSampler / AUVectorPanner).
// The scanned-catalog order is not even stable run-to-run, so "the first installed effect"
// was a different plugin each run -> a ~50% crash. (Root-caused 2026-06-18.) Rather than
// blocklist each crasher (whack-a-mole), POSITIVELY allow only VST3s from a small set of
// vendors verified to load + tear down cleanly. AudioUnits are excluded wholesale (their
// teardown race is format-level). Extend the allowlist as more vendors are verified; an
// unknown/cracked vendor is never hosted (the section then skips gracefully, like the
// no-plugins-installed path).
static bool isHarnessHostablePlugin (const juce::var& p)
{
    if (p.getProperty ("format", juce::var()).toString() != "VST3")
        return false;
    const auto m = p.getProperty ("manufacturer", juce::var()).toString();
    return m == "Xfer Records"          // Serum 2 / Serum 2 FX / OTT
        || m == "Vital Audio"           // Vital
        || m == "Valhalla DSP, LLC";    // ValhallaVintageVerb / Room / UberMod / ...
}

int runSelfTest (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0; checks = 0;
    resetSections();
    std::cerr << "\n===== Mosh Stage 1 command-surface harness =====\n";
    section ("Stage 1: command surface / cold snapshot");

    // Capture emitted events.
    std::vector<String> eventTypes;
    ops.setEventSink ([&] (const var& e) { eventTypes.push_back (e.getProperty ("type", var()).toString()); });

    auto hadEvent = [&] (const String& t) {
        for (auto& e : eventTypes) if (e == t) return true; return false; };

    // 1. cold snapshot
    check (tracks (ops) == 0, "cold snapshot has no tracks");
    check ((int) ops.snapshot().getProperty ("schemaVersion", 0) == 1, "snapshot schemaVersion == 1");

    // 1a. MOSH_SELFTEST_SESSION isolation: when set, the harness must run in its
    // own private session dir (so concurrent worktree runs don't clobber each other).
    if (const auto s = SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SESSION", {}).trim(); s.isNotEmpty())
        check (eng.sessionDir().getFileName() == s, "MOSH_SELFTEST_SESSION isolates the session dir (" + s + ")");

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
    const auto tid = firstTrack (ops).getProperty ("id", var()).toString();

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

    // ─── Stage 3: VST3 hosting + MIDI ───
    section ("Stage 3: VST3 hosting + MIDI");
    auto trackById = [&] (const String& id) -> var {
        auto snap = ops.snapshot();                 // keep the temporary alive (no dangling array)
        if (auto* arr = snap["tracks"].getArray())
            for (auto& tr : *arr)
                if (tr.getProperty ("id", var()).toString() == id) return tr;
        return {};
    };
    auto externalPluginIndex = [&] (const var& track) -> int {
        if (auto* arr = track.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
                if ((bool) p.getProperty ("external", false)) return (int) p.getProperty ("index", -1);
        return -1;
    };

    auto lp = cmd (ops, "list_plugins");
    check (ok (lp), "list_plugins ok");
    const int nPlugins = lp["data"].getProperty ("plugins", var()).size();
    std::cerr << "  ..    " << nPlugins << " VST3 plugin(s) scanned\n";

    String fxId, instId;
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            if (! isHarnessHostablePlugin (p)) continue;   // only host vetted, host-safe VST3s
            const bool inst = (bool) p.getProperty ("isInstrument", false);
            if (inst && instId.isEmpty()) instId = p.getProperty ("id", var()).toString();
            if (! inst && fxId.isEmpty()) fxId = p.getProperty ("id", var()).toString();
        }

    if (nPlugins == 0)
    {
        std::cerr << "  (no VST3s available — skipping host checks; commands compiled+dispatch ok)\n";
    }
    else
    {
        // Effect on the existing wave track (tid).
        if (fxId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("pluginId", fxId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (effect) on wave track ok"); }
            int idx = externalPluginIndex (trackById (tid));
            check (idx >= 0, "effect appears in the plugin chain");
            if (idx >= 0)
            {
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("paramIndex", 0); a->setProperty ("value", 0.5);
                  check (ok (cmd (ops, "set_plugin_param", var (a))), "set_plugin_param ok"); }
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid); a->setProperty ("index", idx);
                  a->setProperty ("bypassed", true);
                  cmd (ops, "bypass_plugin", var (a)); }
                // enabled==false reflected
                bool bypassed = false;
                { auto trk = trackById (tid);   // bind to a local (no dangling temporary)
                  if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                    for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == idx) bypassed = ! (bool) p.getProperty ("enabled", true); }
                check (bypassed, "bypass_plugin disabled the plugin");
                // persists across save/reload
                cmd (ops, "save"); cmd (ops, "reload");
                check (externalPluginIndex (trackById (tid)) >= 0, "hosted plugin persists across save/reload");
                { auto* a = new DynamicObject(); a->setProperty ("trackId", tid);
                  a->setProperty ("index", externalPluginIndex (trackById (tid)));
                  check (ok (cmd (ops, "remove_plugin", var (a))), "remove_plugin ok"); }
                check (externalPluginIndex (trackById (tid)) < 0, "plugin removed from chain");
            }
        }

        // MIDI synth: new track + MIDI clip + instrument.
        auto ct = cmd (ops, "create_track", args1 ("name", "Synth"));
        const auto synthTid = ct["data"].getProperty ("trackId", var()).toString();
        { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid);
          check (ok (cmd (ops, "add_midi_clip", var (a))), "add_midi_clip ok"); }
        check (trackClips (trackById (synthTid)) == 1, "MIDI clip on synth track");
        auto synthClips = trackById (synthTid).getProperty ("clips", var());
        check (synthClips.size() > 0 && synthClips[0].getProperty ("type", var()).toString() == "midi", "clip type == midi");
        if (instId.isNotEmpty())
        {
            { auto* a = new DynamicObject(); a->setProperty ("trackId", synthTid); a->setProperty ("pluginId", instId);
              check (ok (cmd (ops, "load_plugin", var (a))), "load_plugin (instrument) on MIDI track ok"); }
            bool hasInst = false;
            { auto trk = trackById (synthTid);   // bind to a local (no dangling temporary)
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((bool) p.getProperty ("isInstrument", false)) hasInst = true; }
            check (hasInst, "instrument appears in the synth track chain");
        }
    }

    // ─── INS-002 / INS-005: AU hosting + plugin scan / blocklist / management ───
    // Headless-verifiable COMMAND SURFACE only. We do NOT trigger a real AU sweep
    // (MOSH_SCAN_AU is unset here, so rescan_plugins stays VST3-only + inline) and
    // we do NOT assert any machine-specific AU content -- only shape/ok, so the
    // gate stays green on a box with zero .component files.
    section ("INS-002/INS-005: AU hosting + scan / blocklist");
    {
        // The AudioUnit format is registered (proves the JUCE_PLUGINHOST_AU flag is
        // live) -- machine-independent; the format object exists even with no AUs.
        bool auFormatRegistered = false;
        auto& pfm = eng.engine().getPluginManager().pluginFormatManager;
        for (int i = 0; i < pfm.getNumFormats(); ++i)
            if (pfm.getFormat (i)->getName() == "AudioUnit") auFormatRegistered = true;
       #if JUCE_PLUGINHOST_AU
        check (auFormatRegistered, "AudioUnit format registered in the format manager");
       #else
        std::cerr << "  (JUCE_PLUGINHOST_AU off in this build -- skipping AU format check)\n";
       #endif

        // list_plugins now carries a per-format counts object + a format field per entry.
        auto lp2 = cmd (ops, "list_plugins");
        check (ok (lp2), "list_plugins ok (INS-005)");
        auto counts = lp2["data"].getProperty ("counts", var());
        check (counts.isObject(), "list_plugins payload carries a counts object");
        const int total  = (int) counts.getProperty ("total", -1);
        const int nList  = lp2["data"].getProperty ("plugins", var()).size();
        check (total == nList, "counts.total == plugins array size");
        check ((int) counts.getProperty ("vst3", -1) >= 0
            && (int) counts.getProperty ("au", -1) >= 0, "counts.vst3 and counts.au are present");
        // Every entry carries a format field (VST3 / AudioUnit).
        bool allHaveFormat = true;
        { auto pv = lp2["data"].getProperty ("plugins", var());
          if (auto* arr = pv.getArray())
            for (auto& p : *arr)
                if (p.getProperty ("format", var()).toString().isEmpty()) allHaveFormat = false; }
        check (allHaveFormat, "every list_plugins entry has a non-empty format field");

        // rescan_plugins (VST3-only, inline) dispatches + returns ok with a count.
        // Idempotent: the catalog must not shrink across a rescan.
        auto rs = cmd (ops, "rescan_plugins", objN ({{ "format", "vst3" }, { "wait", true }}));
        check (ok (rs), "rescan_plugins (vst3) ok");
        check ((int) rs["data"].getProperty ("count", -1) >= total, "rescan_plugins reports a count (>= prior total)");

        // get_plugin_blocklist returns a well-formed (possibly empty) array.
        auto gb = cmd (ops, "get_plugin_blocklist");
        check (ok (gb), "get_plugin_blocklist ok");
        check (gb["data"].getProperty ("blocklist", var()).isArray(), "get_plugin_blocklist returns an array");

        // block_plugin real round-trip: prefer a VST3 actually in the catalog so
        // we exercise the resolve-to-fileOrIdentifier path (fix for INS-005 id-namespace
        // mismatch).  Fall back to a raw "AudioUnit:..." id if the catalog is empty
        // (e.g. on a box with no VST3 bundles present), which is accepted as a
        // raw-identifier direct block.  Never assert machine-specific content.
        {
            // Snapshot the catalog before we touch it.
            auto lp3 = cmd (ops, "list_plugins");
            auto pv  = lp3["data"].getProperty ("plugins", var());
            String blockTarget;   // the UI-facing id we will pass to block_plugin
            bool   useRealEntry = false;
            if (auto* arr = pv.getArray())
            {
                for (auto& p : *arr)
                {
                    if (p.getProperty ("format", var()).toString() == "VST3")
                    {
                        blockTarget  = p.getProperty ("id", var()).toString();
                        useRealEntry = true;
                        break;
                    }
                }
            }
            // Fall back: a raw "AudioUnit:..." string is accepted as a direct block
            // (no catalog lookup required, as per cmdBlockPlugin implementation).
            const String fallbackId = "AudioUnit:Effect/aufx,fake,MOSH";
            if (blockTarget.isEmpty())
                blockTarget = fallbackId;

            // Calling block_plugin with a bogus (non-path, non-AU, non-VST3-id)
            // string must produce errResult (validates the bad-id path).
            check (! ok (cmd (ops, "block_plugin", args1 ("pluginId", "not-a-real-plugin-id"))),
                   "block_plugin rejects an unresolvable id with errResult");

            // block_plugin with a valid target must succeed.
            check (ok (cmd (ops, "block_plugin", args1 ("pluginId", blockTarget))),
                   "block_plugin ok (real catalog entry or raw AU id)");

            // The blocked entry must appear in get_plugin_blocklist.
            // For a real catalog entry the 'id' field is the UI-facing id (idFor form).
            // For the raw AU fallback the 'id' field equals the raw string (no catalog match).
            bool inBlock = false;
            { auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
              if (auto* arr = bl.getArray())
                for (auto& e : *arr)
                    if (e.getProperty ("id",    var()).toString() == blockTarget ||
                        e.getProperty ("rawId", var()).toString() == blockTarget) inBlock = true; }
            check (inBlock, "blocked id appears in get_plugin_blocklist");

            // If we blocked a real catalog entry it must have disappeared from list_plugins.
            if (useRealEntry)
            {
                auto lp4 = cmd (ops, "list_plugins");
                auto pv4 = lp4["data"].getProperty ("plugins", var());
                bool stillPresent = false;
                if (auto* arr = pv4.getArray())
                    for (auto& p : *arr)
                        if (p.getProperty ("id", var()).toString() == blockTarget) stillPresent = true;
                check (! stillPresent, "blocked VST3 removed from list_plugins immediately");
            }
        }

        // clear_plugin_blocklist empties it again.
        check (ok (cmd (ops, "clear_plugin_blocklist")), "clear_plugin_blocklist ok");
        { auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
          check (bl.isArray() && bl.size() == 0, "blocklist empty after clear_plugin_blocklist"); }

        // READ-ONLY proof: get_plugin_blocklist must NOT be logged (would pollute
        // nothing here, but the contract is read-only).
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (! plog.contains ("get_plugin_blocklist"), "get_plugin_blocklist is READ-ONLY (not logged)");
    }

    // ─── Wave 2: tempo / time-signature / metronome / record / navigation ───
    section ("Wave 2: tempo / meter / metronome / nav");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Tempo control.
        check (ok (cmd (ops, "set_tempo", args1 ("bpm", 140.0))), "set_tempo ok");
        check (std::abs ((double) sess().getProperty ("tempo", 0.0) - 140.0) < 0.5, "snapshot tempo reflects set_tempo");
        cmd (ops, "set_tempo", args1 ("bpm", 99999.0));
        check ((double) sess().getProperty ("tempo", 0.0) <= 999.0, "set_tempo clamps absurd BPM to <= 999");

        // Time signature.
        check (ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 3 }, { "denominator", 4 }}))), "set_time_signature ok");
        check ((int) sess().getProperty ("timeSigNumerator", 0) == 3, "snapshot numerator == 3");
        check ((int) sess().getProperty ("timeSigDenominator", 0) == 4, "snapshot denominator == 4");
        check (! ok (cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 5 }}))), "set_time_signature rejects non-power-of-two denominator");

        // Metronome toggle.
        cmd (ops, "set_metronome", args1 ("enabled", true));
        check ((bool) sess().getProperty ("metronome", false), "metronome enabled in snapshot");
        cmd (ops, "set_metronome", args1 ("enabled", false));
        check (! (bool) sess().getProperty ("metronome", true), "metronome disabled in snapshot");

        // Navigation: go-to-end / go-to-start.
        const double len = (double) sess().getProperty ("length", 0.0);
        cmd (ops, "set_transport", args1 ("action", "to_end"));
        const double endPos = (double) ops.snapshot()["transport"].getProperty ("position", -1.0);
        check (len > 0.0 && std::abs (endPos - len) < 0.05, "to_end moves the playhead to the edit length");
        cmd (ops, "set_transport", args1 ("action", "to_start"));
        check ((double) ops.snapshot()["transport"].getProperty ("position", -1.0) < 0.01, "to_start returns the playhead to 0");

        // Leave a clean musical default for later stages.
        cmd (ops, "set_tempo", args1 ("bpm", 120.0));
        cmd (ops, "set_time_signature", objN ({{ "numerator", 4 }, { "denominator", 4 }}));
    }

    // ─── Wave 5: mixer — master bus + pan ───
    section ("Wave 5: mixer / master / pan");
    {
        auto master = [&] { return ops.snapshot().getProperty ("master", var()); };
        check (master().isObject(), "snapshot exposes a master bus");

        check (ok (cmd (ops, "set_master_volume", args1 ("db", -6.0))), "set_master_volume ok");
        check (std::abs ((double) master().getProperty ("volumeDb", 0.0) - (-6.0)) < 0.5, "master volume reflects in snapshot");
        check (ok (cmd (ops, "set_master_pan", args1 ("pan", -0.5))), "set_master_pan ok");
        check (std::abs ((double) master().getProperty ("pan", 0.0) - (-0.5)) < 0.02, "master pan reflects in snapshot");

        // Per-track pan (set_track_pan existed but was never covered).
        check (ok (cmd (ops, "set_track_pan", objN ({{ "trackId", tid }, { "pan", 0.4 }}))), "set_track_pan ok");
        check (std::abs ((double) trackById (tid).getProperty ("pan", 0.0) - 0.4) < 0.02, "track pan reflects in snapshot");

        cmd (ops, "set_master_volume", args1 ("db", -3.0));   // restore a sane default
    }

    // ─── Wave 6: clip editing (delete / rename / mute / gain / duplicate) ───
    section ("Wave 6: clip editing");
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

        auto et = cmd (ops, "create_track", args1 ("name", "Edit"))["data"].getProperty ("trackId", var()).toString();
        auto cid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 1.0 }, { "freq", 330.0 }}))["data"].getProperty ("clipId", var()).toString();
        check (cid.isNotEmpty(), "tone clip created for editing");

        check (ok (cmd (ops, "rename_clip", objN ({{ "clipId", cid }, { "name", "Renamed" }}))), "rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() == "Renamed", "clip name reflects rename");

        check (ok (cmd (ops, "set_clip_mute", objN ({{ "clipId", cid }, { "mute", true }}))), "set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "clip mute reflects in snapshot");

        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}))), "set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 6.0) < 0.5, "clip gain reflects in snapshot");

        const int before = trackById (et).getProperty ("clips", var()).size();
        auto dup = cmd (ops, "duplicate_clip", args1 ("clipId", cid));
        check (ok (dup), "duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "duplicate adds a clip to the track");
        const auto newId = dup["data"].getProperty ("newClipId", var()).toString();
        check ((double) clipById (newId).getProperty ("start", 0.0) > 0.5, "duplicate lands after the original");

        check (ok (cmd (ops, "remove_clip", args1 ("clipId", cid))), "remove_clip ok");
        check (! clipById (cid).isObject(), "remove_clip deletes the clip");
    }

    // ─── Wave 7: parameter automation ───
    section ("Wave 7: parameter automation");
    {
        auto paramVar = [&] (const String& trkId, int plugIdx, int paramIdx) -> var {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return pr;
            return {};
        };

        auto at = cmd (ops, "create_track", args1 ("name", "Auto"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", at }, { "type", "compressor" }}));
        int pidx = -1;
        { auto trk = trackById (at);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") pidx = (int) p.getProperty ("index", -1); }
        check (pidx >= 0, "compressor loaded for automation");

        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 0.0 }, { "value", 0.2 }}))), "add_automation_point ok");
        check (ok (cmd (ops, "add_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "time", 2.0 }, { "value", 0.8 }}))), "second automation point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 2, "snapshot serialises 2 automation points");
        check ((bool) paramVar (at, pidx, 0).getProperty ("automated", false), "param flagged automated");
        { auto pts = paramVar (at, pidx, 0).getProperty ("points", var());
          check (pts.size() == 2 && std::abs ((double) pts[0].getProperty ("v", 0.0) - 0.2) < 0.03
                 && std::abs ((double) pts[1].getProperty ("v", 0.0) - 0.8) < 0.03, "automation point values round-trip 0..1"); }

        check (ok (cmd (ops, "set_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }, { "time", 0.5 }, { "value", 0.5 }}))), "set_automation_point ok");
        check (ok (cmd (ops, "remove_automation_point", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }, { "pointIndex", 0 }}))), "remove_automation_point ok");
        check (paramVar (at, pidx, 0).getProperty ("points", var()).size() == 1, "remove drops an automation point");

        check (ok (cmd (ops, "clear_automation", objN ({{ "trackId", at }, { "pluginIndex", pidx }, { "paramIndex", 0 }}))), "clear_automation ok");
        check (! (bool) paramVar (at, pidx, 0).getProperty ("automated", true), "clear_automation removes all points");
    }

    // ─── Wave 1: engine built-in plugin palette (effects + instruments) ───
    section ("Wave 1: built-in plugin palette");
    {
        auto builtinIndex = [&] (const var& track, const char* type) -> int {
            if (auto* arr = track.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        auto lb = cmd (ops, "list_builtins");
        check (ok (lb), "list_builtins ok");
        const int nB = lb["data"].getProperty ("plugins", var()).size();
        check (nB >= 10, "built-in palette has the full catalog");
        bool sawComp = false, sawSynth = false;
        if (auto* arr = lb["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
            {
                if (p.getProperty ("type", var()).toString() == "compressor") sawComp = true;
                if (p.getProperty ("type", var()).toString() == "4osc"
                    && (bool) p.getProperty ("isInstrument", false)) sawSynth = true;
            }
        check (sawComp, "catalog includes compressor (effect)");
        check (sawSynth, "catalog includes 4osc (instrument)");

        auto bt = cmd (ops, "create_track", args1 ("name", "Built-ins"))["data"].getProperty ("trackId", var()).toString();

        // Effect: a built-in compressor lands in the chain, flagged + categorised.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "compressor" }}))), "load_builtin (compressor) ok");
        int cidx = builtinIndex (trackById (bt), "compressor");
        check (cidx >= 0, "compressor appears in the chain");
        bool compFlagged = false, compCategorised = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == cidx)
            { compFlagged = (bool) p.getProperty ("builtin", false);
              compCategorised = p.getProperty ("category", var()).toString() == "Dynamics"; } }
        check (compFlagged, "built-in plugin flagged builtin=true in snapshot");
        check (compCategorised, "built-in plugin carries its category");
        if (cidx >= 0)
            check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", bt }, { "index", cidx }, { "paramIndex", 0 }, { "value", 0.5 }}))),
                   "set_plugin_param on a built-in ok");

        // Instrument: a built-in synth on the same track is flagged isInstrument.
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "4osc" }}))), "load_builtin (4osc synth) ok");
        bool hasBuiltinInst = false;
        { auto trk = trackById (bt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == "4osc")
                hasBuiltinInst = (bool) p.getProperty ("isInstrument", false); }
        check (hasBuiltinInst, "built-in 4osc flagged as an instrument");

        // Persistence + validation.
        cmd (ops, "save"); cmd (ops, "reload");
        check (builtinIndex (trackById (bt), "compressor") >= 0, "built-in plugin persists across save/reload");
        check (! ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "no_such_plugin" }}))), "load_builtin rejects unknown type");
        // The scratch "Built-ins" track is left in place: the only later count
        // check in this run is relative (tracksBefore+1), and absolute-count
        // checks live in the separate runUndoSelfTest with its own fresh engine.
    }

    // ─── Stage 4: Tier-A real-time neural insert ───
    section ("Stage 4: Tier-A neural insert (RT-safe / PDC / ASTD)");
    {
        auto nt = cmd (ops, "create_track", args1 ("name", "Neural"))["data"].getProperty ("trackId", var()).toString();
        auto ar = cmd (ops, "add_neural_insert", objN ({{ "trackId", nt }, { "modelId", "nam" }}));
        check (ok (ar), "add_neural_insert ok");
        const int nidx = (int) ar["data"].getProperty ("index", -1);

        NeuralInsertPlugin* n = nullptr;
        if (auto* t = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (nt)))
            for (auto* p : t->pluginList.getPlugins())
                if (auto* nn = dynamic_cast<NeuralInsertPlugin*> (p)) n = nn;
        check (n != nullptr, "neural insert is in the track chain (built-in type registered)");

        if (n != nullptr)
        {
            n->initialise ({ {}, 44100.0, 512 });   // alloc delay line + warm up

            auto process = [&] (float amp, int len) {
                AudioBuffer<float> buf (2, len); buf.clear();
                buf.setSample (0, 0, amp); buf.setSample (1, 0, amp);
                te::MidiMessageArray midi;
                te::PluginRenderContext ctx (&buf, AudioChannelSet::stereo(), 0, len, &midi, 0.0,
                                             tracktion::TimeRange(), true, false, false, false);
                n->applyToBuffer (ctx);
                return buf;
            };

            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "mix" }, { "value", 100.0 }}));
            {
                auto out = process (0.5f, 64);
                check (std::abs (out.getSample (0, 0) - 0.5f) > 0.1f, "neural model alters the driven signal (real inference)");
                check (std::abs (out.getSample (0, 10)) < 1e-4f, "silence stays silent (no DC injected by the net)");
            }

            // Bypass: the known inverted-logic bug (04 §2.4): bypassed -> passthrough.
            cmd (ops, "bypass_plugin", objN ({{ "trackId", nt }, { "index", nidx }, { "bypassed", true }}));
            {
                auto out = process (0.5f, 64);
                check (std::abs (out.getSample (0, 0) - 0.5f) < 1e-5f, "bypass passes audio through unchanged");
            }
            cmd (ops, "bypass_plugin", objN ({{ "trackId", nt }, { "index", nidx }, { "bypassed", false }}));

            // ASTD clamp + Lab unlock (read raw via the param's normalised value).
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            const float normClamped = n->getAutomatableParameter (0)->getCurrentNormalisedValue();
            check (std::abs (normClamped - (12.0f - 1.0f) / (25.0f - 1.0f)) < 0.02f, "ASTD clamps drive UI=100 below quality-collapse (not raw max)");
            cmd (ops, "set_neural_lab_mode", objN ({{ "trackId", nt }, { "index", nidx }, { "on", true }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 100.0 }}));
            const float normLab = n->getAutomatableParameter (0)->getCurrentNormalisedValue();
            check (normLab > normClamped + 0.1f, "Lab mode unlocks drive beyond the clamp");
            check (std::abs (normLab - 1.0f) < 0.02f, "Lab UI=100 reaches the full raw range");

            // PDC: true latency + delay-line correctness (no drift vs dry).
            n->resetModel();
            cmd (ops, "set_neural_latency", objN ({{ "trackId", nt }, { "index", nidx }, { "samples", 128 }}));
            check (std::abs (n->getLatencySeconds() - 128.0 / 44100.0) < 1e-9, "getLatencySeconds() reports the TRUE delay (PDC)");
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 50.0 }}));
            {
                auto out = process (0.5f, 256);
                check (std::abs (out.getSample (0, 0)) < 1e-4f && std::abs (out.getSample (0, 64)) < 1e-4f, "no output before the reported latency");
                check (std::abs (out.getSample (0, 128)) > 0.05f, "impulse emerges at exactly the reported latency (delay == reported, no drift)");
            }

            // ── GAP 1 — real Tier-A model load (load_neural_model) ──
            // Return latency to 0 + full mix/drive so we compare model-vs-inline on the
            // SAME first sample with no delay-line offset.
            cmd (ops, "set_neural_latency", objN ({{ "trackId", nt }, { "index", nidx }, { "samples", 0 }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "mix" }, { "value", 100.0 }}));
            cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx }, { "paramId", "drive" }, { "value", 50.0 }}));
            n->resetModel();

            // Capture the inline-MLP output for the driven probe BEFORE loading any model.
            const float inlineY = process (0.5f, 8).getSample (0, 0);

           #if MOSH_HAVE_RTNEURAL
            // CI-runnable: the in-repo fixture path (compile-time repo dir), env override
            // MOSH_SELFTEST_RTNEURAL_MODEL wins when set.
            juce::String fixturePath = juce::SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_RTNEURAL_MODEL", {});
            if (fixturePath.isEmpty())
                fixturePath = juce::String (MOSH_REPO_SOURCE_DIR) + "/assets/neural_waveshaper.json";
            const juce::File fixture (fixturePath);
            check (fixture.existsAsFile(), "RTNeural model fixture present (assets/neural_waveshaper.json)");

            auto lm = cmd (ops, "load_neural_model", objN ({{ "trackId", nt }, { "pluginIndex", nidx }, { "path", fixturePath }}));
            check (ok (lm), "load_neural_model ok (RTNeural built)");
            check ((bool) lm["data"].getProperty ("applied", false), "load_neural_model applied:true (RTNeural built)");

            n->resetModel();
            {
                auto out = process (0.5f, 8);
                const float modelY = out.getSample (0, 0);
                check (std::abs (modelY - inlineY) > 1e-3f, "RTNeural model output DIFFERS numerically from the inline MLP (same input)");
                // silence-in → silence-out with the model loaded.
                check (std::abs (out.getSample (0, 4)) < 1e-4f, "silence stays silent with the RTNeural model loaded");
            }

            // Persisted model path survives save/reload (re-loads the file on restore).
            check (n->describe().getProperty ("modelPath", var()).toString() == fixturePath, "describe() reports the loaded modelPath");
            check (n->describe().getProperty ("modelName", var()).toString().isNotEmpty(), "describe() reports a modelName");
            check (ok (cmd (ops, "save")),   "save (neural model path) ok");
            check (ok (cmd (ops, "reload")), "reload (neural model path) ok");
            {
                // Re-find the plugin after reload (the Edit was reconstructed).
                NeuralInsertPlugin* n2 = nullptr;
                if (auto* t = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (nt)))
                    for (auto* p : t->pluginList.getPlugins())
                        if (auto* nn = dynamic_cast<NeuralInsertPlugin*> (p)) n2 = nn;
                check (n2 != nullptr, "neural insert still present after reload");
                if (n2 != nullptr)
                {
                    check (n2->describe().getProperty ("modelPath", var()).toString() == fixturePath, "model path restored after save+reload");
                    // initialise() is the deterministic re-load hook (loads the persisted
                    // model file on the message thread once the plugin is prepared).
                    n2->initialise ({ {}, 44100.0, 512 });
                    check ((bool) n2->describe().getProperty ("modelLoaded", false), "RTNeural model re-loaded on reload (file re-read from persisted path)");
                    // Find the neural plugin's index in the reloaded chain so the param
                    // set targets the right plugin (the volume plugin sits at index 0).
                    int nidx2 = -1;
                    if (auto* t = te::findAudioTrackForID (eng.edit(), te::EditItemID::fromString (nt)))
                    {
                        const auto& plugs = t->pluginList.getPlugins();
                        for (int i = 0; i < plugs.size(); ++i)
                            if (dynamic_cast<NeuralInsertPlugin*> (plugs[i].get()) != nullptr) nidx2 = i;
                    }
                    auto procN2 = [&] (float amp, int len) {
                        AudioBuffer<float> buf (2, len); buf.clear();
                        buf.setSample (0, 0, amp); buf.setSample (1, 0, amp);
                        te::MidiMessageArray midi;
                        te::PluginRenderContext ctx (&buf, AudioChannelSet::stereo(), 0, len, &midi, 0.0,
                                                     tracktion::TimeRange(), true, false, false, false);
                        n2->applyToBuffer (ctx);
                        return buf;
                    };
                    cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx2 }, { "paramId", "drive" }, { "value", 50.0 }}));
                    cmd (ops, "set_neural_param", objN ({{ "trackId", nt }, { "index", nidx2 }, { "paramId", "mix" }, { "value", 100.0 }}));
                    n2->resetModel();
                    const float reloadedY = procN2 (0.5f, 8).getSample (0, 0);
                    check (std::abs (reloadedY - inlineY) > 1e-3f, "reloaded model still transforms differently from the inline MLP (path re-loaded)");

                    // PDC null test still holds with the model loaded.
                    n2->resetModel();
                    cmd (ops, "set_neural_latency", objN ({{ "trackId", nt }, { "index", nidx2 }, { "samples", 128 }}));
                    auto outL = procN2 (0.5f, 256);
                    check (std::abs (outL.getSample (0, 0)) < 1e-4f && std::abs (outL.getSample (0, 64)) < 1e-4f, "PDC: no output before latency with model loaded");
                    check (std::abs (outL.getSample (0, 128)) > 0.02f, "PDC: impulse emerges at the reported latency with model loaded");
                }
            }
           #else
            // DEFAULT build (no RTNeural): load_neural_model is a graceful no-op, and the
            // inline MLP still does real inference (alters the driven signal, silence stays
            // silent). This keeps the default selftest green.
            juce::ignoreUnused (inlineY);
            auto lm = cmd (ops, "load_neural_model",
                           objN ({{ "trackId", nt }, { "pluginIndex", nidx }, { "path", juce::String ("/does/not/matter.json") }}));
            check (ok (lm), "load_neural_model returns ok (graceful, RTNeural not built)");
            check (! (bool) lm["data"].getProperty ("applied", true), "load_neural_model applied:false (RTNeural not built)");
            check (lm["data"].getProperty ("reason", var()).toString() == "RTNeural not built", "load_neural_model reason: RTNeural not built");
            {
                // Inline MLP still alters a driven signal + keeps silence silent.
                cmd (ops, "set_neural_latency", objN ({{ "trackId", nt }, { "index", nidx }, { "samples", 0 }}));
                auto out = process (0.5f, 8);
                check (std::abs (out.getSample (0, 0) - 0.5f) > 0.05f, "inline MLP still alters the driven signal (default build)");
                check (std::abs (out.getSample (0, 4)) < 1e-4f, "inline MLP keeps silence silent (default build)");
            }
           #endif
        }
    }

    // ─── MON-004: total plugin delay compensation (PDC) readout in the snapshot ───
    section ("MON-004: PDC / reported-latency readout");
    {
        auto sess = ops.snapshot().getProperty ("session", var());
        // Fields present + numeric (the UI reads these for the transport readout).
        check (sess.hasProperty ("totalLatencySamples"), "session.totalLatencySamples present");
        check (sess.hasProperty ("totalLatencyMs"), "session.totalLatencyMs present");
        check (sess.hasProperty ("latencyContextReady"), "session.latencyContextReady present");
        const int  latSamples = (int) sess.getProperty ("totalLatencySamples", -1);
        const double latMs     = (double) sess.getProperty ("totalLatencyMs", -1.0);
        const bool ready       = (bool) sess.getProperty ("latencyContextReady", true);
        check (latSamples >= 0, "totalLatencySamples is non-negative");
        check (latMs >= 0.0, "totalLatencyMs is non-negative");
        // ms is consistent with samples / sampleRate (guard against a divide-by-zero SR).
        const double sr = (double) sess.getProperty ("sampleRate", 44100.0);
        const double sr2 = sr > 0.0 ? sr : 44100.0;
        check (std::abs (latMs - (double) latSamples / sr2 * 1000.0) < 1e-6, "totalLatencyMs == samples / sampleRate * 1000 (consistent)");

        // Honest headless posture: with no audio device the playback graph is never
        // prepared, so the context is null -> ready=false + 0 samples (NOT a false 0 ms
        // claimed as real). The number is verified live via the GUI / live-audio smoke.
        if (! eng.hasAudio())
        {
            check (! ready, "no-audio headless -> latencyContextReady=false (honest, not a false 0.0 ms)");
            check (latSamples == 0, "no-audio headless -> totalLatencySamples=0");
        }
        else
            check (ready, "audio attached -> latencyContextReady=true (graph prepared)");
    }

    // ─── Stage 5: Tier-B generative layer (FakeAdapter) ───
    section ("Stage 5: generative layer (FakeAdapter, full loop)");
    {
        // Fresh track + source clip for the generative flow.
        auto gt = cmd (ops, "create_track", args1 ("name", "Gen"))["data"].getProperty ("trackId", var()).toString();
        auto tone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt }, { "seconds", 1.5 }, { "freq", 196.0 }}));
        const auto gcid = tone["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", gcid }, { "adapter", "fake" }}));
        check (ok (crl), "create_render_layer ok");

        Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 60); colors.add (var (c)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 1 }, { "nl", 0.4 }, { "colors", colors }}));

        // Render (wait inline — spawns the Python service via the job manager).
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (ok (r1), "render_layer ok (service spawned, job ran)");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first render is a cache MISS");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "render completed -> status ready");
        // snapshot reflects the rendered layer
        bool hasArtifact = false;
        { auto trk = trackById (gt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == gcid)
                hasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (hasArtifact, "render produced a cached artifact (output.wav)");

        // Re-render with identical fingerprint -> cache HIT.
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical re-render is a cache HIT (full fingerprint)");

        // Change a param -> fingerprint changes -> cache MISS (re-render).
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 2 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "param change -> dirty -> re-render (cache MISS)");

        // Accept -> lands as a new clip on the "Neural Renders" lane.
        const int tracksBefore = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", gcid))), "accept_render ok");
        check (tracks (ops) == tracksBefore + 1, "accept landed a new clip on a neural lane");
        bool laneHasClip = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                laneHasClip = trackClips (t) >= 1; }
        check (laneHasClip, "neural lane carries the accepted render");

        // JSONL records accept/reject as TASTE LABELS (05 §9).
        auto renderLogText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (renderLogText.contains ("accept_render"), "JSONL records accept_render (taste label)");
        cmd (ops, "reject_render", args1 ("clipId", gcid));
        renderLogText = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (renderLogText.contains ("reject_render"), "JSONL records reject_render (taste label)");

        // --- NRL-004: render-layer management (bypass / freeze / bounce / remove) ---
        section ("NRL-004: render-layer management");
        // Resolve the clip's render-layer var off the gen track by clipId (bind the
        // snapshot to a local so the array doesn't dangle).
        auto layerOf = [&] (const String& cid) -> var {
            auto trk = trackById (gt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return c.getProperty ("renderLayer", var());
            return {};
        };
        auto layerStatus = [&] (const String& cid) { return layerOf (cid).getProperty ("status", var()).toString(); };

        // reject_render kept the layer (it is NOT a remove — the #1 trap).
        check ((bool) trackById (gt).getProperty ("clips", var())[0].getProperty ("hasRenderLayer", false)
                   || layerOf (gcid).isObject(),
               "reject_render did NOT remove the layer (still present)");
        check (layerStatus (gcid) == "dirty", "reject_render set status=dirty (re-roll, not remove)");

        // bypass_layer toggles status ready<->bypassed.
        check (ok (cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", true }}))), "bypass_layer ok");
        check (layerStatus (gcid) == "bypassed", "bypass_layer{true} -> status bypassed");
        cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", false }}));
        check (layerStatus (gcid) == "ready", "bypass_layer{false} -> status ready");

        // Re-render so a cached artifact exists for freeze/bounce (cache HIT path).
        cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));

        // freeze_layer requires a cached artifact -> status frozen.
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid))), "freeze_layer ok (artifact present)");
        check (layerStatus (gcid) == "frozen", "freeze_layer -> status frozen");

        // bounce_layer_to_clip = accept + finalize: lands a clip on the neural lane.
        cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));   // refresh artifact (frozen status doesn't gate render)
        const int tracksBeforeBounce = tracks (ops);
        check (ok (cmd (ops, "bounce_layer_to_clip", args1 ("clipId", gcid))), "bounce_layer_to_clip ok");
        check (layerStatus (gcid) == "bounced", "bounce_layer_to_clip -> status bounced");
        check (tracks (ops) >= tracksBeforeBounce, "bounce landed audio on the neural lane (no track lost)");

        // freeze on a layer with NO artifact errors (gate the button on hasArtifact).
        auto gt2 = cmd (ops, "create_track", args1 ("name", "Gen2"))["data"].getProperty ("trackId", var()).toString();
        auto tone2 = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", gt2 }, { "seconds", 1.0 }, { "freq", 210.0 }}));
        const auto gcid2 = tone2["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", gcid2 }, { "adapter", "fake" }}));
        check (! ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid2))), "freeze_layer on un-rendered layer errors (nothing to freeze)");

        // remove_render_layer clears the node; create_render_layer then succeeds again.
        auto layerOf2 = [&] (const String& cid) -> bool {
            auto trk = trackById (gt2);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return (bool) c.getProperty ("hasRenderLayer", false);
            return false;
        };
        check (layerOf2 (gcid2), "layer present before remove_render_layer");
        check (ok (cmd (ops, "remove_render_layer", args1 ("clipId", gcid2))), "remove_render_layer ok");
        check (! layerOf2 (gcid2), "remove_render_layer cleared MOSH_RENDERLAYER (hasRenderLayer=false)");
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", gcid2 }, { "adapter", "fake" }}))),
               "create_render_layer succeeds again after remove (no 'already has a layer')");
        // undo restores the removed-then-recreated layer state; just prove remove is undoable.
        cmd (ops, "undo");                                   // undo the re-create
        cmd (ops, "undo");                                   // undo the remove -> layer back
        check (layerOf2 (gcid2), "remove_render_layer is undoable (layer restored)");
        check (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString().contains ("remove_render_layer"),
               "JSONL records remove_render_layer");
    }

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

        // Tier-A neural insert
        auto an = cmd (ops, "add_neural_insert", objN ({{ "trackId", mt }, { "modelId", "nam" }}));
        const int ni = (int) an["data"].getProperty ("index", -1);
        cmd (ops, "set_neural_param", objN ({{ "trackId", mt }, { "index", ni }, { "paramId", "drive" }, { "value", 55.0 }}));

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

    // --- DRM-001: drums make sound (working sampler + bundled kit + track type) ---
    // Mirrors the neural "driven signal altered / silence stays silent" gate, but for
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

    // ─── Wave: settings — audio device gate + project lifecycle ───
    // Headless (--selftest, no audio) eng.hasAudio()==false: the audio-engine gate
    // reports honestly, device commands return graceful errors (never crash), and
    // device enumeration content + a successful device round-trip + the FileChooser
    // dialog are hardware/GUI-gated (verified manually in the GUI — see the plan).
    section ("Wave: settings (audio gate / device / project lifecycle)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Audio-engine gate (MON-007 / FLY-004): honest false with no device.
        check (sess().hasProperty ("audioEnabled"), "snapshot session has audioEnabled gate field");
        check (! (bool) sess().getProperty ("audioEnabled", true), "audioEnabled is false headless (no device)");
        check (sess().hasProperty ("bitDepth"), "snapshot session has bitDepth readout");
        check (sess().hasProperty ("bufferSize"), "snapshot session has bufferSize readout");
        check (sess().hasProperty ("outputLatencyMs"), "snapshot session has outputLatencyMs readout");
        check (sess().hasProperty ("audioDeviceName"), "snapshot session has audioDeviceName readout");
        check (ops.snapshot().getProperty ("audio", var()).isObject(), "snapshot exposes the audio selection block");

        // list_audio_devices: read-only, ok + audioEnabled:false + well-formed types array.
        auto ld = cmd (ops, "list_audio_devices");
        check (ok (ld), "list_audio_devices ok");
        check (! (bool) ld["data"].getProperty ("audioEnabled", true), "list_audio_devices audioEnabled:false headless");
        {
            auto typesVar = ld["data"].getProperty ("types", var());   // bind temporary before getArray
            check (typesVar.isArray(), "list_audio_devices types is an array (shape, possibly empty headless)");
            auto srVar = ld["data"].getProperty ("sampleRates", var());
            check (srVar.isArray(), "list_audio_devices sampleRates is an array (empty with no open device)");
        }

        // set_audio_device / set_buffer_size: graceful no-device errResult, not a crash.
        auto sd = cmd (ops, "set_audio_device", objN ({{ "bufferSize", 256 }}));
        check (! ok (sd), "set_audio_device returns graceful error with no device");
        check (sd.getProperty ("error", var()).toString().contains ("no audio device"), "set_audio_device error mentions no audio device");
        auto sb = cmd (ops, "set_buffer_size", args1 ("bufferSize", 512));
        check (! ok (sb), "set_buffer_size returns graceful error with no device");

        // Project lifecycle — run entirely on TEMP files so the persistent session
        // the prior checks rely on is never corrupted. Restore it at the end.
        const auto sessionEdit = eng.editFile();
        const int tracksBefore = tracks (ops);
        check (tracksBefore > 0, "session has tracks before new_project (sanity)");

        // new_project -> ok, empty tracks, editFile path changed, fresh file on disk.
        auto npFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-new.tracktionedit");
        npFile.deleteFile();
        auto np = cmd (ops, "new_project", args1 ("name", "selftest-new"));
        check (ok (np), "new_project ok");
        check (tracks (ops) == 0, "new_project starts with zero tracks");
        const auto newEdit = sess().getProperty ("editFile", var()).toString();
        check (newEdit != sessionEdit.getFullPathName(), "new_project changed session.editFile path");
        check (File (newEdit).existsAsFile() && File (newEdit).getSize() > 0, "new_project wrote a fresh non-empty .tracktionedit");

        // create_track + save + open_project round-trips the track count.
        check (ok (cmd (ops, "create_track", args1 ("name", "RoundTrip"))), "create_track in new project ok");
        check (tracks (ops) == 1, "new project has 1 track after create_track");
        check (ok (cmd (ops, "save")), "save new project ok");
        // Swap to ANOTHER project, then open the saved one back.
        auto npFile2 = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-new2.tracktionedit");
        npFile2.deleteFile();
        check (ok (cmd (ops, "new_project", args1 ("name", "selftest-new2"))), "second new_project ok");
        check (tracks (ops) == 0, "second new project is empty");
        auto op = cmd (ops, "open_project", args1 ("file", newEdit));
        check (ok (op), "open_project ok");
        check (tracks (ops) == 1, "open_project round-trips the saved track count");

        // save_as(tmp) -> ok, file exists non-empty, subsequent save targets the new path.
        auto saFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-saveas.tracktionedit");
        saFile.deleteFile();
        auto sa = cmd (ops, "save_as", args1 ("file", saFile.getFullPathName()));
        check (ok (sa), "save_as ok");
        check (saFile.existsAsFile() && saFile.getSize() > 0, "save_as wrote a non-empty file");
        check (sess().getProperty ("editFile", var()).toString() == saFile.getFullPathName(), "save_as re-points session.editFile to the new path");
        check (ok (cmd (ops, "save")), "subsequent save (after save_as) ok");

        // open_project / new_project with bad args -> graceful validation errors.
        check (! ok (cmd (ops, "open_project", args1 ("file", "/no/such/file.tracktionedit"))), "open_project missing file errors");

        // Undo correctness + isolation. editFile is engine state (never on the Edit undo
        // stack), so we do NOT use it as the probe — that would pass even if undo were
        // broken. Instead: (1) prove undo genuinely works — a create_track is a real
        // transaction, so an undo must drop the track count by exactly one; (2) prove the
        // whole-Edit project commands leave NO stray transaction — immediately after
        // open_project (a fresh Edit with an empty undo stack) an undo must be a no-op
        // (count unchanged). A leaked empty transaction would instead walk back into the
        // freshly-opened Edit and the count check would fail.
        const int nBefore = tracks (ops);
        check (ok (cmd (ops, "create_track", args1 ("name", "UndoProbe"))), "create_track undo probe ok");
        check (tracks (ops) == nBefore + 1, "create_track added a track");
        check (ok (cmd (ops, "undo")), "undo ok");
        check (tracks (ops) == nBefore, "undo reverted the create_track (count dropped by 1)");
        // Re-open the saved project: its undo stack is empty, so an immediate undo must be
        // a no-op, proving new/open/save_as pushed no stray transaction.
        check (ok (cmd (ops, "open_project", args1 ("file", newEdit))), "re-open saved project ok");
        const int nFresh = tracks (ops);
        check (ok (cmd (ops, "undo")), "undo on freshly-opened project ok");
        check (tracks (ops) == nFresh, "undo is a no-op after open_project (no stray transaction leaked)");
        check (ops.snapshot().hasProperty ("tracks"), "snapshot still well-formed after project-undo isolation");

        // JSONL: device + project commands logged undoable:false.
        auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (slog.contains ("set_audio_device"), "JSONL records set_audio_device");
        check (slog.contains ("new_project"), "JSONL records new_project");
        check (slog.contains ("save_as"), "JSONL records save_as");
        bool devPref = false, newPref = false, saPref = false;
        for (auto& ln : juce::StringArray::fromLines (slog))
        {
            if (ln.contains ("\"command\": \"set_audio_device\"") && ln.contains ("\"undoable\": false")) devPref = true;
            if (ln.contains ("\"command\": \"new_project\"") && ln.contains ("\"undoable\": false")) newPref = true;
            if (ln.contains ("\"command\": \"save_as\"") && ln.contains ("\"undoable\": false")) saPref = true;
        }
        check (devPref, "set_audio_device logged undoable:false (machine preference)");
        check (newPref, "new_project logged undoable:false (whole-Edit replacement)");
        check (saPref, "save_as logged undoable:false (whole-Edit persist)");

        // Restore the in-memory Edit to the harness session edit so in-process state is
        // consistent after the temp-file project swaps. (The session-selftest dir is wiped
        // at startup, so idempotency across runs does not depend on this.)
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (clean teardown)");
        npFile.deleteFile(); npFile2.deleteFile(); saFile.deleteFile();
    }

    // ─── Project safety: auto-save / dirty flag (DATA-LOSS gap 1) ───
    // Closing the window with unsaved changes used to lose work (no save-on-quit, no
    // auto-save). The fix is a dirty flag every mutation sets, cleared on save; the GUI
    // app drives a periodic auto-save + save-on-quit off it. The timer itself is GUI-only
    // (no message loop headless), so we test the underlying mechanism directly.
    section ("Project safety: auto-save / dirty flag (gap 1)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        const int n0 = tracks (ops);

        // A clean save zeroes the flag; the snapshot mirrors it.
        check (ok (cmd (ops, "save")), "save establishes a clean baseline");
        check (! eng.isDirty(), "engine clean immediately after save");
        check (! (bool) sess().getProperty ("dirty", true), "snapshot.session.dirty false when clean");

        // A mutating command marks the Edit dirty (so auto-save / quit will persist it).
        check (ok (cmd (ops, "create_track", args1 ("name", "DirtyProbe"))), "create_track ok");
        check (eng.isDirty(), "mutating command marks the engine dirty");
        check ((bool) sess().getProperty ("dirty", false), "snapshot.session.dirty true when dirty");

        // saveIfDirty persists + clears; a second call is a no-op (nothing to save).
        check (eng.saveIfDirty(), "saveIfDirty saves when dirty (returns true)");
        check (! eng.isDirty(), "engine clean after saveIfDirty");
        check (! eng.saveIfDirty(), "saveIfDirty is a no-op when clean (returns false)");

        // The plain save command also clears the flag.
        check (ok (cmd (ops, "create_track", args1 ("name", "DirtyProbe2"))), "second mutation ok");
        check (eng.isDirty(), "dirty again after another mutation");
        check (ok (cmd (ops, "save")), "save command ok");
        check (! eng.isDirty(), "save command clears the dirty flag");

        // Teardown: revert the two probe tracks (each its own transaction) + persist clean.
        check (ok (cmd (ops, "undo")), "undo probe 2"); check (ok (cmd (ops, "undo")), "undo probe 1");
        check (tracks (ops) == n0, "probe tracks reverted (clean teardown)");
        cmd (ops, "save");
    }

    // ─── Project safety: reopen last project on relaunch (gap 2) ───
    // Relaunch always loaded the fixed session.tracktionedit, never the project the user
    // last worked in (no Recent list either). The fix persists session/last-project.json
    // on every new/open/save-as; the ctor resolves the startup edit via startupEditFile().
    // The app-restart path itself went untested (why this gap was undetected), so we test
    // the decision method directly here.
    section ("Project safety: reopen last project on relaunch (gap 2)");
    {
        const auto sessionEdit = eng.editFile();
        const auto defaultEdit = eng.sessionDir().getChildFile ("session.tracktionedit");
        const auto lastJson    = eng.sessionDir().getChildFile ("last-project.json");

        // (a) rememberProject persists the path; startupEditFile resolves to it — i.e. a
        // relaunch would reopen it (this is the previously-untested app-restart decision).
        auto probe = eng.sessionDir().getChildFile ("projects").getChildFile ("relaunch-probe.tracktionedit");
        probe.getParentDirectory().createDirectory();
        probe.replaceWithText ("<EDIT/>");   // a real file so existsAsFile() passes
        eng.rememberProject (probe);
        check (lastJson.existsAsFile(), "rememberProject writes last-project.json");
        check (eng.startupEditFile() == probe, "startupEditFile resolves to the remembered project (relaunch reopens it)");

        // (b) a missing remembered project falls back to the default session file.
        eng.rememberProject (eng.sessionDir().getChildFile ("projects").getChildFile ("does-not-exist.tracktionedit"));
        check (eng.startupEditFile() == defaultEdit, "startupEditFile falls back to session.tracktionedit when the last project is missing");

        // (c) new_project records itself as last + appears in the snapshot Recent list,
        // newest-first; open_project updates it too.
        check (ok (cmd (ops, "new_project", args1 ("name", "relaunch-A"))), "new_project relaunch-A ok");
        const auto editA = eng.editFile();
        check (eng.startupEditFile() == editA, "new_project updates the remembered last project");
        check (ok (cmd (ops, "new_project", args1 ("name", "relaunch-B"))), "new_project relaunch-B ok");
        const auto editB = eng.editFile();
        auto recents = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        check (recents.isArray() && recents.size() >= 2, "snapshot.session.recentProjects lists projects");
        check (recents[0].getProperty ("path", var()).toString() == editB.getFullPathName(), "recentProjects is newest-first (relaunch-B first)");
        check (ok (cmd (ops, "open_project", args1 ("file", editA.getFullPathName()))), "open_project relaunch-A ok");
        check (eng.startupEditFile() == editA, "open_project updates the remembered last project");

        // teardown: restore the harness session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (gap2 teardown)");
        probe.deleteFile();
    }

    // ─── Project safety: portable projects + relink (gap 3) ───
    // Projects shared one absolute-path audio pool (~/Library/Mosh/session), so a saved/
    // copied .tracktionedit pointed back at the pool and broke when moved. The fix sets a
    // filePathResolver and consolidates referenced audio into a project-local audio/ dir on
    // Save As (relative refs → portable), plus a relink_clip command + a sourceMissing flag.
    section ("Project safety: portable projects + relink (gap 3)");
    {
        const auto sessionEdit = eng.editFile();
        const auto poolAudio   = eng.sessionDir().getChildFile ("audio");

        // local snapshot helpers (the trackById/clip helpers elsewhere are out of scope here)
        auto trackVar = [&] (const String& tid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid) return trks[i];
            return var();
        };
        auto clipById = [&] (const String& cid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i) {
                auto cl = trks[i].getProperty ("clips", var());
                for (int j = 0; j < cl.size(); ++j)
                    if (cl[j].getProperty ("id", var()).toString() == cid) return cl[j];
            }
            return var();
        };

        // A project with one wave clip whose audio lives in the shared session pool.
        check (ok (cmd (ops, "new_project", args1 ("name", "portable-src"))), "new_project portable-src ok");
        auto trk = cmd (ops, "create_track", args1 ("name", "Aud"));
        const auto trackId = trk["data"].getProperty ("trackId", var()).toString();
        check (trackId.isNotEmpty(), "create_track returned a trackId");
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", trackId }, { "seconds", 1 }, { "freq", 330 } }))), "add_test_tone_clip ok");
        const auto poolSrc = File (firstTrack (ops)["clips"][0].getProperty ("sourceFile", var()).toString());
        check (poolSrc.isAChildOf (poolAudio), "clip audio starts in the shared session pool");

        // DRM-001 — a drum track's sampler sounds (the bundled kit, stored as ABSOLUTE
        // bundle paths) must ALSO consolidate into the portable project, or the project
        // breaks when moved to another machine/install.
        check (ok (cmd (ops, "create_track", objN ({ { "name", "Kit" }, { "type", "drum" } }))), "drum track for portability ok");

        // Save As to a standalone dir OUTSIDE the pool → consolidation copies audio local.
        auto destDir  = File::getSpecialLocation (File::tempDirectory).getChildFile ("mosh-portable-src");
        destDir.deleteRecursively(); destDir.createDirectory();
        auto destEdit = destDir.getChildFile ("portable.tracktionedit");
        check (ok (cmd (ops, "save_as", args1 ("file", destEdit.getFullPathName()))), "save_as ok");
        check (destDir.getChildFile ("audio").isDirectory(), "save_as created a project-local audio/ dir");
        check (destDir.getChildFile ("audio").getNumberOfChildFiles (File::findFiles) >= 1, "save_as consolidated audio into the project");
        // The drum kit's sample (e.g. kick.wav) must be copied into the project audio/ too.
        check (destDir.getChildFile ("audio").getChildFile ("kick.wav").existsAsFile(),
               "save_as consolidated the drum-kit sampler sounds into the project");

        // On-disk edit must reference audio RELATIVELY (portable), never the shared pool.
        const auto xml = destEdit.loadFileAsString();
        check (! xml.contains (poolAudio.getFullPathName()), "saved edit has no shared-pool absolute audio path");
        check (! xml.contains ("Resources/drumkits"),
               "saved edit references the kit by a relative path, not the absolute app-bundle path");
        check (xml.contains ("audio/") && ! xml.contains ("../audio"), "saved edit references audio by a co-located relative path (no ../)");

        // PROVE portability: copy the whole project elsewhere, hide the ORIGINAL pool source
        // so resolution can ONLY succeed via the co-located copy, then open the copy.
        auto moved = File::getSpecialLocation (File::tempDirectory).getChildFile ("mosh-portable-moved");
        moved.deleteRecursively();
        check (destDir.copyDirectoryTo (moved), "copied the project dir to a new location");
        auto poolBak = poolSrc.getSiblingFile (poolSrc.getFileName() + ".gap3bak");
        poolBak.deleteFile(); poolSrc.moveFileTo (poolBak);     // hide the original
        check (ok (cmd (ops, "open_project", args1 ("file", moved.getChildFile ("portable.tracktionedit").getFullPathName()))), "open the moved project ok");
        auto movedClip = firstTrack (ops)["clips"][0];
        check (! (bool) movedClip.getProperty ("sourceMissing", true), "moved project's clip resolves to co-located audio (portable)");
        check (File (movedClip.getProperty ("sourceFile", var()).toString()).isAChildOf (moved), "resolved source is inside the moved project dir");
        poolBak.moveFileTo (poolSrc);                            // restore the pool original

        // relink: a clip whose source goes missing reports sourceMissing; relink_clip fixes it.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "reopened session edit");
        auto rtrk = cmd (ops, "create_track", args1 ("name", "Relink"));
        const auto rtid = rtrk["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", rtid }, { "seconds", 1 }, { "freq", 440 }, { "name", "relinkme" } }))), "add relink probe clip ok");
        auto rClip = trackVar (rtid).getProperty ("clips", var())[0];
        const auto rClipId = rClip.getProperty ("id", var()).toString();
        File rSrc (rClip.getProperty ("sourceFile", var()).toString());
        check (! (bool) rClip.getProperty ("sourceMissing", true), "relink probe clip initially present");
        // copy to a relink target, then delete the original source
        auto relinkTarget = eng.sessionDir().getChildFile ("audio").getChildFile ("relink-target.wav");
        relinkTarget.deleteFile(); rSrc.copyFileTo (relinkTarget); rSrc.deleteFile();
        check ((bool) clipById (rClipId).getProperty ("sourceMissing", false), "deleted source reports sourceMissing");
        check (ok (cmd (ops, "relink_clip", objN ({ { "clipId", rClipId }, { "file", relinkTarget.getFullPathName() } }))), "relink_clip ok");
        check (! (bool) clipById (rClipId).getProperty ("sourceMissing", true), "relink_clip clears sourceMissing");

        // teardown
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (gap3 teardown)");
        destDir.deleteRecursively(); moved.deleteRecursively();
    }

    // ─── PRF-001 — multicore audio thread preference + readout ───
    // A GENUINE, load-bearing knob (drives EngineBehaviour::getNumberOfCPUsToUseForAudio()
    // -> setNumThreads(N-1) on the parallel graph), valid headless (no audio device).
    // Only the command path / clamping / readout / JSONL are headless-testable; the
    // audible single- vs multi-thread A/B and the live thread-pool-resize gap are
    // hardware-gated (need an open device + real DSP load).
    section ("PRF-001 (multicore audio threads)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };

        // Snapshot readout: availableCores >= 1, audioThreads present + in [1..cores].
        check (sess().hasProperty ("availableCores"), "snapshot session has availableCores readout");
        const int cores = (int) sess().getProperty ("availableCores", 0);
        check (cores >= 1, "availableCores >= 1");
        check (sess().hasProperty ("audioThreads"), "snapshot session has audioThreads readout");
        const int threads0 = (int) sess().getProperty ("audioThreads", 0);
        check (threads0 >= 1 && threads0 <= cores, "audioThreads within [1..availableCores]");
        check ((bool) sess().getProperty ("audioThreadsAuto", false), "audioThreads defaults to auto (resolved core count)");

        // set_audio_threads applies WITHOUT an audio device (proves it is not device-gated,
        // unlike set_buffer_size) and echoes availableCores + audioThreads in the result.
        const int want = cores >= 2 ? 2 : 1;
        auto st = cmd (ops, "set_audio_threads", args1 ("threads", want));
        check (ok (st), "set_audio_threads ok with no audio device (not device-gated)");
        check ((int) st["data"].getProperty ("availableCores", -1) == cores, "set_audio_threads echoes availableCores");
        check ((int) st["data"].getProperty ("audioThreads", -1) == want, "set_audio_threads echoes the resolved audioThreads");

        // Fresh snapshot reflects the new value (round-trip) and is no longer 'auto'.
        check ((int) sess().getProperty ("audioThreads", -1) == want, "snapshot reflects new audioThreads after set");
        check (! (bool) sess().getProperty ("audioThreadsAuto", true), "audioThreadsAuto is false after an explicit set");

        // Out-of-range -> graceful errResult, never a crash. Above-cores clamps to cores.
        check (! ok (cmd (ops, "set_audio_threads", args1 ("threads", 0))), "set_audio_threads threads=0 errors gracefully");
        check (! ok (cmd (ops, "set_audio_threads", args1 ("threads", 99999))), "set_audio_threads threads=99999 errors gracefully");
        auto clampHigh = cmd (ops, "set_audio_threads", args1 ("threads", cores + 1));
        check (ok (clampHigh), "set_audio_threads cores+1 ok (clamps)");
        check ((int) clampHigh["data"].getProperty ("audioThreads", -1) == cores, "set_audio_threads clamps cores+1 down to availableCores");

        // Missing arg -> errResult.
        check (! ok (cmd (ops, "set_audio_threads", var())), "set_audio_threads missing threads errors");

        // JSONL: logged undoable:false (machine preference) — mirror the devPref check.
        auto tlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (tlog.contains ("set_audio_threads"), "JSONL records set_audio_threads");
        bool thrPref = false;
        for (auto& ln : juce::StringArray::fromLines (tlog))
            if (ln.contains ("\"command\": \"set_audio_threads\"") && ln.contains ("\"undoable\": false")) thrPref = true;
        check (thrPref, "set_audio_threads logged undoable:false (machine preference)");

        // Read-only: snapshot() must not append a set_audio_threads log line (the
        // readout-only path never writes). Count occurrences before/after a snapshot.
        const auto countLines = [&] (const String& needle) {
            int n = 0;
            for (auto& ln : juce::StringArray::fromLines (
                     eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (ln.contains (needle)) ++n;
            return n;
        };
        const int before = countLines ("\"command\": \"set_audio_threads\"");
        ops.snapshot(); ops.snapshot();
        check (countLines ("\"command\": \"set_audio_threads\"") == before, "snapshot does not log set_audio_threads (read-only readout)");

        // Restore auto so later blocks see the default. (threads=cores then... there is
        // no 'set to auto' arg; leaving an explicit pref is harmless — it resolves to a
        // real value. We simply assert the restored value is valid.)
        check (ok (cmd (ops, "set_audio_threads", args1 ("threads", cores))), "restore set_audio_threads to all cores ok");
    }

    // ─── BRW-001 — content/file browser (read-only list_directory + import reuse) ───
    // list_directory is STRICTLY READ-ONLY (no log / transaction / event), never
    // recurses, never writes, and is graceful on missing / denied / relative paths.
    // Import reuses the existing import_clip command (no new mutation path). The GUI
    // browsing experience (popover, folder descent, breadcrumb) is hardware/GUI-gated;
    // the command shape, filtering, navigation, safety + the import seam are headless.
    section ("BRW-001 (content browser / list_directory)");
    {
        // Seed a known dir under the session: one audio file + one non-audio file +
        // one sub-directory. The session-selftest dir is wiped each run, so seed fresh.
        auto browseDir = eng.sessionDir().getChildFile ("browse-test");
        browseDir.deleteRecursively();
        browseDir.createDirectory();
        auto wav = browseDir.getChildFile ("probe-tone.wav");
        // Reuse the engine's deterministic test-tone WAV generator (writes to the audio
        // dir), then copy it into browseDir so we control the listing contents exactly.
        auto srcTone = eng.generateTestTone (0.25, 330.0, "browse-probe");
        check (srcTone.existsAsFile() && srcTone.copyFileTo (wav), "seeded a real .wav into the browse dir");
        auto txt = browseDir.getChildFile ("notes.txt");
        txt.replaceWithText ("not audio");
        auto childDir = browseDir.getChildFile ("subfolder");
        childDir.createDirectory();

        // Capture log-line + event counts to prove read-only.
        const auto logCount = [&] (const String& needle) {
            int n = 0;
            for (auto& ln : juce::StringArray::fromLines (
                     eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (ln.contains (needle)) ++n;
            return n;
        };
        const int ldLogBefore = logCount ("list_directory");
        eventTypes.clear();

        auto ld = cmd (ops, "list_directory", args1 ("path", browseDir.getFullPathName()));
        check (ok (ld), "list_directory ok");
        auto data = ld["data"];
        check ((bool) data.getProperty ("exists", false), "list_directory exists:true for a real dir");
        check (data.getProperty ("path", var()).toString() == browseDir.getFullPathName(), "list_directory path round-trips (normalized)");

        // roots is a non-empty array containing a Home entry pointing at a real dir.
        {
            auto rootsVar = data.getProperty ("roots", var());
            check (rootsVar.isArray() && rootsVar.size() > 0, "list_directory roots is a non-empty array");
            bool homeOk = false;
            if (auto* ra = rootsVar.getArray())
                for (auto& r : *ra)
                    if (r.getProperty ("name", var()).toString() == "Home"
                        && File (r.getProperty ("path", var()).toString()).isDirectory())
                        homeOk = true;
            check (homeOk, "list_directory roots includes a Home pointing at a real directory");
        }

        // entries: the seeded .wav is present (isDir:false, size>0); the .txt is filtered
        // out; the subfolder is present (isDir:true).
        bool sawWav = false, sawTxt = false, sawDir = false;
        {
            auto entriesVar = data.getProperty ("entries", var());
            check (entriesVar.isArray(), "list_directory entries is an array");
            if (auto* ea = entriesVar.getArray())
                for (auto& e : *ea)
                {
                    const auto nm = e.getProperty ("name", var()).toString();
                    const bool isDir = (bool) e.getProperty ("isDir", false);
                    if (nm == "probe-tone.wav") { sawWav = true;
                        check (! isDir, "wav entry isDir:false");
                        check ((double) e.getProperty ("size", 0.0) > 0.0, "wav entry size > 0"); }
                    if (nm == "notes.txt")  sawTxt = true;
                    if (nm == "subfolder" && isDir) sawDir = true;
                }
        }
        check (sawWav, "list_directory lists the seeded .wav (extension filter passes audio)");
        check (! sawTxt, "list_directory filters out the .txt (extension filter excludes non-audio)");
        check (sawDir, "list_directory lists the subfolder (isDir:true)");

        // Folder navigation: descend into the child, parent points back at browseDir.
        auto into = cmd (ops, "list_directory", args1 ("path", childDir.getFullPathName()));
        check (ok (into) && (bool) into["data"].getProperty ("exists", false), "list_directory into subfolder exists:true");
        check (into["data"].getProperty ("parent", var()).toString() == browseDir.getFullPathName(),
               "list_directory subfolder parent points back to the parent dir");

        // Graceful failures: missing path -> ok:true, exists:false, error set, roots present.
        auto missing = cmd (ops, "list_directory", args1 ("path", "/no/such/dir/xyz123"));
        check (ok (missing), "list_directory missing path still ok (graceful shape)");
        check (! (bool) missing["data"].getProperty ("exists", true), "list_directory missing path exists:false");
        check (missing["data"].getProperty ("error", var()).toString().isNotEmpty(), "list_directory missing path has an error string");
        {
            auto mr = missing["data"].getProperty ("roots", var());
            check (mr.isArray() && mr.size() > 0, "list_directory still returns roots on a missing path");
            auto me = missing["data"].getProperty ("entries", var());
            check (me.isArray() && me.size() == 0, "list_directory missing path has empty entries");
        }

        // Relative path -> invalid (never resolved against cwd, never builds a File()).
        auto rel = cmd (ops, "list_directory", args1 ("path", "relative/path"));
        check (ok (rel), "list_directory relative path returns ok (graceful)");
        check (! (bool) rel["data"].getProperty ("exists", true), "list_directory relative path exists:false (not resolved against cwd)");

        // Empty path defaults to Home (a real dir).
        auto home = cmd (ops, "list_directory", var());
        check (ok (home) && (bool) home["data"].getProperty ("exists", false), "list_directory with no path defaults to a real Home dir");

        // READ-ONLY: no JSONL line written, no snapshot_invalidated emitted.
        check (logCount ("list_directory") == ldLogBefore, "list_directory is READ-ONLY (not logged)");
        bool sawInvalidate = false;
        for (auto& t : eventTypes) if (t == "snapshot_invalidated") sawInvalidate = true;
        check (! sawInvalidate, "list_directory emits no snapshot_invalidated (read-only)");

        // End-to-end seam: a path from entries feeds import_clip and a clip lands
        // (proves the browser -> import path headlessly, no new mutation path).
        auto trk = cmd (ops, "create_track", args1 ("name", "BrowseImport"));
        const auto trkId = trk["data"].getProperty ("trackId", var()).toString();
        check (ok (trk), "create track for browse import ok");
        // Clip count on the freshly-created (empty) BrowseImport track, found by id.
        const auto clipsOn = [&] (const String& id) {
            auto tracksVar = ops.snapshot().getProperty ("tracks", var());
            if (auto* ta = tracksVar.getArray())
                for (auto& t : *ta)
                    if (t.getProperty ("id", var()).toString() == id)
                        return (int) t.getProperty ("clips", var()).size();
            return -1;
        };
        const int clipsBefore = clipsOn (trkId);
        auto imp = cmd (ops, "import_clip", objN ({{ "file", wav.getFullPathName() }, { "trackId", trkId }}));
        check (ok (imp), "import_clip on a browsed file ok (reuses existing import path)");
        check (clipsOn (trkId) > clipsBefore, "browsed file imported as a real clip (browser -> import_clip seam)");

        // ── file_peaks + audition (sample-browser thumbnail + preview seam) ──
        // file_peaks: waveform peaks for an un-imported file (read-only, like
        // get_clip_peaks but path-addressed). Drives the browser thumbnails.
        auto fp = cmd (ops, "file_peaks", objN ({{ "path", wav.getFullPathName() }, { "buckets", 64 }}));
        check (ok (fp), "file_peaks ok for a real wav");
        check (fp["data"].getProperty ("peaks", var()).isArray()
               && fp["data"].getProperty ("peaks", var()).size() > 0, "file_peaks returns a non-empty peak array");
        check (! ok (cmd (ops, "file_peaks", objN ({{ "path", "/no/such/file.wav" }}))),
               "file_peaks errors on a missing file");

        // audition_file / stop_audition: a transient preview (no undo txn, no log).
        // Headless has no device so it can't sound; the contract + clean start/stop
        // (and graceful missing-file error) are what's asserted.
        check (ok (cmd (ops, "audition_file", objN ({{ "path", wav.getFullPathName() }}))),
               "audition_file ok for a real wav");
        check (ok (cmd (ops, "stop_audition")), "stop_audition ok");
        check (! ok (cmd (ops, "audition_file", objN ({{ "path", "/no/such/file.wav" }}))),
               "audition_file errors on a missing file");

        browseDir.deleteRecursively();
        cmd (ops, "remove_track", args1 ("trackId", trkId));   // tidy up the probe track
    }

    // ─── Wave: keyboard shortcuts + clip clipboard (CTL-002 / AED-001) ───
    // The keyboard layer is window 'keydown' handlers in the React UI (App mounts
    // useKeyboardShortcuts) — pure view code, NOT headless-testable, so it is NOT
    // asserted here (no synthetic key events). What IS headless-verifiable, and is
    // proven below, is the one backend half: paste_clip reconstructs a clip from a
    // clipToVar-shaped descriptor (the UI clipboard's payload) on a target track.
    section ("Wave: clip clipboard / paste_clip (AED-001)");
    {
        // Track A with a wave clip; read A's clip descriptor from the snapshot
        // (this is exactly the object the UI clipboard captures via clipToVar).
        auto a = cmd (ops, "create_track", args1 ("name", "PasteSrc"));
        const auto trackA = a["data"].getProperty ("trackId", var()).toString();
        check (ok (a), "create track A ok");
        auto toneA = cmd (ops, "add_test_tone_clip",
                          objN ({{ "trackId", trackA }, { "seconds", 1.5 }, { "freq", 196.0 }}));
        check (ok (toneA), "add_test_tone_clip on A ok");

        // Locate track A in the snapshot + grab its first clip descriptor. Bind the
        // snapshot var to a local before getArray() (a pointer into a temporary var
        // dangles — has bitten prior waves).
        const auto snapA = ops.snapshot();
        var clipDesc;
        String sourceName;
        if (auto* trackArr = snapA.getProperty ("tracks", var()).getArray())
            for (auto& t : *trackArr)
                if (t.getProperty ("id", var()).toString() == trackA)
                    if (auto* clipArr = t.getProperty ("clips", var()).getArray())
                        if (! clipArr->isEmpty())
                        {
                            clipDesc = clipArr->getReference (0);
                            sourceName = clipDesc.getProperty ("name", var()).toString();
                        }
        check (clipDesc.isObject(), "captured A's clip descriptor from the snapshot");
        check (clipDesc.getProperty ("type", var()).toString() == "wave", "captured descriptor is a wave clip");
        const double srcLen = (double) clipDesc.getProperty ("length", 0.0);

        // Track B; paste the descriptor onto B at start S.
        auto b = cmd (ops, "create_track", args1 ("name", "PasteDst"));
        const auto trackB = b["data"].getProperty ("trackId", var()).toString();
        check (ok (b), "create track B ok");

        const double pasteStart = 3.0;
        auto pasted = cmd (ops, "paste_clip",
                           objN ({{ "trackId", trackB }, { "start", pasteStart }, { "clip", clipDesc }}));
        check (ok (pasted), "paste_clip onto B ok");

        // B now has one clip; its length matches the source and it has a name.
        auto findTrackVar = [&] (const String& id) -> var {
            const auto snap = ops.snapshot();
            if (auto* arr = snap.getProperty ("tracks", var()).getArray())
                for (auto& t : *arr)
                    if (t.getProperty ("id", var()).toString() == id) return t;
            return {};
        };
        const auto bTrack = findTrackVar (trackB);
        const auto bClips = bTrack.getProperty ("clips", var());
        check (bClips.size() == 1, "B has exactly one clip after paste_clip");
        const auto bClip = bClips[0];
        check (std::abs ((double) bClip.getProperty ("length", 0.0) - srcLen) < 1.0e-6,
               "pasted clip length matches the source clip");
        check (bClip.getProperty ("name", var()).toString().isNotEmpty(), "pasted clip has a name");
        check (std::abs ((double) bClip.getProperty ("start", 0.0) - pasteStart) < 1.0e-6,
               "pasted clip starts at the requested time");

        // Copy/paste, not move: the source clip on A is untouched.
        const auto aTrack = findTrackVar (trackA);
        check (aTrack.getProperty ("clips", var()).size() == 1, "source clip on A untouched (copy, not move)");

        // paste_clip is genuinely undoable: undo removes the pasted clip from B.
        check (ok (cmd (ops, "undo")), "undo after paste_clip ok");
        check (findTrackVar (trackB).getProperty ("clips", var()).size() == 0,
               "undo removed the pasted clip from B (paste_clip is undoable)");

        // MIDI: paste carries the notes across.
        auto mt = cmd (ops, "create_track", args1 ("name", "MidiSrc"));
        const auto midiTrack = mt["data"].getProperty ("trackId", var()).toString();
        // Pass an EMPTY notes array so cmdAddMidiClip does NOT seed its default
        // 4-note arpeggio — we add exactly 2 notes below so the count is known.
        auto mClip = cmd (ops, "add_midi_clip", objN ({{ "trackId", midiTrack }, { "notes", var (Array<var>()) }}));
        const auto midiClipId = mClip["data"].getProperty ("clipId", var()).toString();
        check (ok (mClip), "add_midi_clip ok");
        check (ok (cmd (ops, "add_note", objN ({{ "clipId", midiClipId }, { "pitch", 64 }, { "start", 0.0 }, { "length", 1.0 }, { "velocity", 100 }}))), "add_note 1 ok");
        check (ok (cmd (ops, "add_note", objN ({{ "clipId", midiClipId }, { "pitch", 67 }, { "start", 1.0 }, { "length", 1.0 }, { "velocity", 90 }}))), "add_note 2 ok");

        // Read the MIDI clip's descriptor (with its notes[]) from the snapshot.
        var midiDesc;
        int srcNoteCount = 0;
        {
            const auto mTrackVar = findTrackVar (midiTrack);
            if (auto* clipArr = mTrackVar.getProperty ("clips", var()).getArray())
                if (! clipArr->isEmpty())
                {
                    midiDesc = clipArr->getReference (0);
                    auto notesVar = midiDesc.getProperty ("notes", var());  // bind before getArray
                    srcNoteCount = notesVar.isArray() ? notesVar.size() : 0;
                }
        }
        check (midiDesc.isObject(), "captured the MIDI clip descriptor");
        check (srcNoteCount == 2, "source MIDI clip carries 2 notes");

        auto mDst = cmd (ops, "create_track", args1 ("name", "MidiDst"));
        const auto midiDst = mDst["data"].getProperty ("trackId", var()).toString();
        auto mPaste = cmd (ops, "paste_clip", objN ({{ "trackId", midiDst }, { "start", 0.0 }, { "clip", midiDesc }}));
        check (ok (mPaste), "paste_clip (midi) onto another track ok");
        {
            const auto dstTrackVar = findTrackVar (midiDst);
            const auto dstClips = dstTrackVar.getProperty ("clips", var());
            check (dstClips.size() == 1, "MIDI destination has one pasted clip");
            auto notesVar = dstClips[0].getProperty ("notes", var());  // bind before size
            check (notesVar.isArray() && notesVar.size() == srcNoteCount,
                   "pasted MIDI clip carries the same note count");
        }

        // Bad args -> graceful errResult (no crash).
        check (! ok (cmd (ops, "paste_clip", objN ({{ "start", 0.0 }, { "clip", clipDesc }}))),
               "paste_clip with missing trackId errors");
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 }}))),
               "paste_clip with missing clip errors");
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 },
                                                    { "clip", objN ({{ "type", "bogus" }, { "length", 1.0 }}) }}))),
               "paste_clip with unknown clip type errors");

        // Zero-side-effect validation: a wave descriptor with a non-existent sourceFile
        // on a VALID track must error WITHOUT creating an orphan clip (the source check
        // is hoisted above the transaction / track auto-create).
        auto bBefore = trackById (trackB);
        auto bBeforeClips = bBefore.getProperty ("clips", var());
        const int bCountBefore = bBeforeClips.isArray() ? bBeforeClips.getArray()->size() : 0;
        check (! ok (cmd (ops, "paste_clip", objN ({{ "trackId", trackB }, { "start", 0.0 },
                   { "clip", objN ({{ "type", "wave" }, { "length", 1.0 }, { "sourceFile", "/no/such/file.wav" }}) }}))),
               "paste_clip wave with missing source errors");
        auto bAfter = trackById (trackB);
        auto bAfterClips = bAfter.getProperty ("clips", var());
        const int bCountAfter = bAfterClips.isArray() ? bAfterClips.getArray()->size() : 0;
        check (bCountAfter == bCountBefore, "failed wave paste left no orphan clip (zero side effects)");

        // JSONL records paste_clip with undoable:true.
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (plog.contains ("paste_clip"), "JSONL records paste_clip");
        bool pasteUndoable = false;
        for (auto& ln : juce::StringArray::fromLines (plog))
            if (ln.contains ("\"command\": \"paste_clip\"") && ln.contains ("\"undoable\": true"))
                pasteUndoable = true;
        check (pasteUndoable, "paste_clip logged undoable:true (genuine edit)");
    }

    // ─── Wave: command-log inspector (AGT-001) ───
    // get_command_log is a READ-ONLY window over the canonical command log
    // (mosh-log.jsonl). It must NOT log/transact/emit (doing so would pollute the
    // very file it returns and make it appear in its own results). Fully headless:
    // run a couple of known commands, then read them back most-recent-first.
    // (The UI-scale control is pure UI-local view state -- like theme -- and is NOT
    //  a command, so it is documented, not asserted here.)
    section ("Wave: command-log inspector (AGT-001)");
    {
        // Fresh, known commands so the log tail is predictable. The LAST undoable
        // edit we issue before reading is rename_track, so it must be entry[0].
        // Capture the total first so we can assert it grows by EXACTLY the 2 commands
        // we issue (create_track + rename_track) -- get_command_log itself never logs.
        const int totalBefore = (int) cmd (ops, "get_command_log", args1 ("limit", 1))["data"].getProperty ("total", -1);
        check (ok (cmd (ops, "create_track", args1 ("name", "LogProbe"))), "create_track LogProbe ok");
        auto lpSnap = ops.snapshot();
        juce::String logProbeId;
        if (auto* trackArr = lpSnap.getProperty ("tracks", var()).getArray())
            for (auto& t : *trackArr)
                if (t.getProperty ("name", var()).toString() == "LogProbe")
                    logProbeId = t.getProperty ("id", var()).toString();
        check (logProbeId.isNotEmpty(), "found the LogProbe track id");
        check (ok (cmd (ops, "rename_track", objN ({{ "trackId", logProbeId }, { "name", "LogProbe2" }}))),
               "rename_track LogProbe2 ok (this is the most-recent command before get_command_log)");

        // get_command_log { limit: 5 } -> ok, well-formed bounded array.
        auto gl = cmd (ops, "get_command_log", args1 ("limit", 5));
        check (ok (gl), "get_command_log ok");
        auto entriesVar = gl["data"].getProperty ("entries", var());   // bind before getArray
        check (entriesVar.isArray(), "get_command_log entries is an array");
        const int total = (int) gl["data"].getProperty ("total", -1);
        // >= (not ==): the 2 commands we issued definitely logged; late async generative-
        // service callbacks (cancelled HTTP jobs from earlier stages) may append more lines
        // between the two reads, so an exact count is non-deterministic. The meaningful
        // assertion is that `total` tracks real appended commands (not a vacuous >= 0).
        check (total >= totalBefore + 2, "get_command_log total grew by at least the 2 commands issued (create_track + rename_track)");
        if (auto* entries = entriesVar.getArray())
        {
            check (entries->size() <= 5, "get_command_log honours limit (<= 5 entries)");
            check (entries->size() > 0, "get_command_log returned at least one entry");

            // Most-recent-first: entry[0] is the LAST command issued before the read
            // (rename_track) -- NOT get_command_log itself (it is not logged).
            auto first = entries->getReference (0);
            check (first.getProperty ("command", var()).toString() == "rename_track",
                   "most-recent-first: entry[0].command == rename_track (the last command issued)");

            // Every entry is well-formed: non-empty command + bool ok + bool undoable.
            bool allShaped = true;
            bool sawGetCommandLog = false;
            for (auto& e : *entries)
            {
                if (e.getProperty ("command", var()).toString().isEmpty()) allShaped = false;
                if (! e.getProperty ("ok", var()).isBool()) allShaped = false;
                if (! e.getProperty ("undoable", var()).isBool()) allShaped = false;
                if (e.getProperty ("command", var()).toString() == "get_command_log") sawGetCommandLog = true;
            }
            check (allShaped, "every entry has command (non-empty), ok (bool), undoable (bool)");
            // READ-ONLY proof: get_command_log never logs itself.
            check (! sawGetCommandLog, "get_command_log is READ-ONLY: it does NOT appear in the log it returns");
        }

        // Zero / no limit still returns ok with a well-formed entries array (default
        // applies; clamp never crashes), and still does not log itself.
        auto gl0 = cmd (ops, "get_command_log", args1 ("limit", 0));
        check (ok (gl0), "get_command_log with zero limit still ok (default applies)");
        auto entries0Var = gl0["data"].getProperty ("entries", var());
        check (entries0Var.isArray(), "get_command_log zero-limit entries is a well-formed array");

        // Malformed / non-object JSONL lines must be skipped, never crash the inspector.
        // Inject a corrupt line + a valid-but-non-object line, then restore the file.
        auto logFile = eng.sessionDir().getChildFile ("mosh-log.jsonl");
        const auto logBackup = logFile.loadFileAsString();
        const int totalClean = (int) cmd (ops, "get_command_log", args1 ("limit", 1))["data"].getProperty ("total", -1);
        logFile.appendText ("{ this is not valid json\n");   // malformed
        logFile.appendText ("12345\n");                        // valid JSON, but not an object
        auto glBad = cmd (ops, "get_command_log", args1 ("limit", 5));
        check (ok (glBad), "get_command_log tolerates malformed/partial lines (no crash)");
        check ((int) glBad["data"].getProperty ("total", -1) == totalClean,
               "malformed / non-object lines are skipped (total unchanged)");
        logFile.replaceWithText (logBackup);                   // restore: drop the injected garbage

        // Cross-check against the raw JSONL: get_command_log was issued several times
        // above yet the log must contain ZERO occurrences of it (it is never written).
        auto rawLog = logFile.loadFileAsString();
        check (! rawLog.contains ("get_command_log"),
               "mosh-log.jsonl contains NO get_command_log token (read-only confirmed at the file)");
    }

    // ─── Wave A — PRJ-008 / PRE-001 / ARE-003 ───
    // PRJ-008: per-project format / time-base INTENT persisted on the Edit's own
    // ValueTree (MOSH_PROJECT child) — saves/reloads with the .tracktionedit, no new
    // storage format. set_project_settings is a NON-undoable preference (cmdSetMetronome
    // template). PRE-001: device-pref persistence (graceful-degradation headless;
    // full cross-restart is hardware-gated). ARE-003: latency-compensated recording —
    // verify the readout fields + the headless record graceful-degradation (the take
    // landing alignment rides Wave B + is hardware-gated).
    section ("Wave A: project format (PRJ-008) / device prefs (PRE-001) / record latency (ARE-003)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };

        // Snapshot exposes session.project with the three fields (device-readout fallback
        // before any set_project_settings — never absent).
        check (proj().isObject(), "snapshot session.project block present");
        check (proj().hasProperty ("sampleRate"), "session.project has sampleRate");
        check (proj().hasProperty ("bitDepth"), "session.project has bitDepth");
        check (proj().hasProperty ("timeBase"), "session.project has timeBase");
        check (proj().getProperty ("timeBase", var()).toString() == "seconds", "session.project.timeBase defaults to seconds");

        // Validation: bad sampleRate / bitDepth / timeBase all error (storage untouched).
        check (! ok (cmd (ops, "set_project_settings", args1 ("sampleRate", 6000))), "set_project_settings rejects sampleRate < 7000");
        check (! ok (cmd (ops, "set_project_settings", args1 ("bitDepth", 20))), "set_project_settings rejects bitDepth not in {16,24,32}");
        check (! ok (cmd (ops, "set_project_settings", args1 ("timeBase", "ticks"))), "set_project_settings rejects unknown timeBase");

        // Set valid settings (all three at once), then assert the snapshot reflects them.
        check (ok (cmd (ops, "set_project_settings",
                        objN ({{ "sampleRate", 96000 }, { "bitDepth", 16 }, { "timeBase", "barsBeats" }}))),
               "set_project_settings ok");
        check ((double) proj().getProperty ("sampleRate", 0.0) == 96000.0, "session.project.sampleRate == 96000 after set");
        check ((int) proj().getProperty ("bitDepth", 0) == 16, "session.project.bitDepth == 16 after set");
        check (proj().getProperty ("timeBase", var()).toString() == "barsBeats", "session.project.timeBase == barsBeats after set");

        // Save -> reload -> the project settings round-trip with the .tracktionedit
        // (mirrors the existing save/reload checks — proves MOSH_PROJECT persists).
        check (ok (cmd (ops, "save")),   "save (project settings) ok");
        check (ok (cmd (ops, "reload")), "reload (project settings) ok");
        check ((double) proj().getProperty ("sampleRate", 0.0) == 96000.0, "session.project.sampleRate survived save+reload");
        check ((int) proj().getProperty ("bitDepth", 0) == 16, "session.project.bitDepth survived save+reload");
        check (proj().getProperty ("timeBase", var()).toString() == "barsBeats", "session.project.timeBase survived save+reload");

        // set_project_settings is NON-undoable (preference): logged undoable:false, and an
        // undo immediately after must NOT revert it (no transaction was pushed).
        auto plog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool projPref = false;
        for (auto& ln : juce::StringArray::fromLines (plog))
            if (ln.contains ("\"command\": \"set_project_settings\"") && ln.contains ("\"undoable\": false")) projPref = true;
        check (projPref, "set_project_settings logged undoable:false (preference)");

        // export_audio defaults its bit depth + rate from the stored project setting when
        // omitted (we set 96000/16 above). Seed a fresh renderable track + clip so the
        // render ALWAYS produces output -> the default-resolution asserts run
        // DETERMINISTICALLY (no render-state-dependent branch).
        {
            auto seed = cmd (ops, "create_track", args1 ("name", "ExportSeed"));
            check (ok (seed), "create renderable seed track for export-default ok");
            const auto seedId = seed["data"].getProperty ("trackId", var()).toString();
            check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", seedId }, { "seconds", 0.5 }}))),
                   "seed a renderable clip for export-default ok");
            auto exFile = eng.sessionDir().getChildFile ("exports").getChildFile ("wavea-export.wav");
            exFile.deleteFile();
            auto ex = cmd (ops, "export_audio", args1 ("file", exFile.getFullPathName()));
            check (ok (ex), "export_audio (with a renderable seed clip) ok");
            check ((int) ex["data"].getProperty ("bitDepth", -1) == 16, "export_audio defaults bitDepth from project setting (16)");
            check ((double) ex["data"].getProperty ("sampleRate", 0.0) == 96000.0, "export_audio defaults sampleRate from project setting (96000)");
            exFile.deleteFile();
            cmd (ops, "remove_track", args1 ("trackId", seedId));   // tidy the seed track
        }

        // Restore defaults so later runs / blocks see a clean project (idempotent dir is
        // wiped each run, but keep in-process state tidy).
        check (ok (cmd (ops, "set_project_settings",
                        objN ({{ "sampleRate", 44100 }, { "bitDepth", 24 }, { "timeBase", "seconds" }}))),
               "set_project_settings restore defaults ok");

        // ── PRE-001 — device prefs (graceful degradation headless) ──
        // list_audio_devices is read-only ok with audioEnabled:false; set_audio_device
        // returns the no-device error shape (NOT a crash). Full cross-restart persistence
        // of the device setup (audio-device.xml round-trip) is HARDWARE-GATED — it needs
        // a real interface to open and is verified on a machine with one.
        auto ld = cmd (ops, "list_audio_devices");
        check (ok (ld), "PRE-001: list_audio_devices ok headless");
        check (! (bool) ld["data"].getProperty ("audioEnabled", true), "PRE-001: list_audio_devices audioEnabled:false headless");
        auto sd = cmd (ops, "set_audio_device", objN ({{ "outputDevice", "Nope" }}));
        check (! ok (sd), "PRE-001: set_audio_device returns graceful error with no device");
        check (sd.getProperty ("error", var()).toString().contains ("no audio device"), "PRE-001: set_audio_device error mentions no audio device");

        // ── ARE-003 — latency-compensated recording (verify-only) ──
        // The PDC readout fields are present (the take-landing alignment in Wave B rides
        // these). set_transport {action:"record"} degrades gracefully when !hasAudio()
        // (the record branch already guards on hasAudio) — it logs ok + does nothing,
        // never a crash. Landed-clip alignment is hardware-gated.
        check (sess().hasProperty ("totalLatencyMs"), "ARE-003: session has totalLatencyMs readout");
        check (sess().hasProperty ("latencyContextReady"), "ARE-003: session has latencyContextReady readout");
        check (! (bool) sess().getProperty ("latencyContextReady", true), "ARE-003: latencyContextReady false headless (no prepared graph)");
        auto rec = cmd (ops, "set_transport", args1 ("action", "record"));
        check (ok (rec), "ARE-003: set_transport record degrades gracefully headless (no crash)");
        check (! (bool) ops.snapshot().getProperty ("transport", var()).getProperty ("recording", false), "ARE-003: not recording headless (no audio device)");
    }

    // ─── KEY-001 — the project's musical key (tonic + mode) ───
    // Stored on the same MOSH_PROJECT node as the format/time-base prefs (saves/reloads
    // with the .tracktionedit). set_key is a NON-undoable preference (cmdSetProjectSettings
    // template). The tonic/mode domains mirror voice.js NOTE_PC / SCALES exactly, so the
    // host only accepts keys Moshi's in-key voice can sing. The key also feeds the
    // RenderLayer fingerprint (proven separately in the generative section); here we cover
    // the snapshot surface + validation + persistence + non-undoability.
    section ("KEY-001: musical key (set_key, snapshot.project.key, persistence)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto key  = [&] { return sess().getProperty ("project", var()).getProperty ("key", var()); };

        // Snapshot ALWAYS exposes session.project.key with the A/minor default (never absent).
        check (key().isObject(), "snapshot session.project.key block present");
        check (key().hasProperty ("tonic"), "session.project.key has tonic");
        check (key().hasProperty ("mode"), "session.project.key has mode");
        check (key().getProperty ("tonic", var()).toString() == "A", "session.project.key.tonic defaults to A");
        check (key().getProperty ("mode", var()).toString() == "minor", "session.project.key.mode defaults to minor");

        // Valid set (both fields) → ok + reflected in the snapshot.
        check (ok (cmd (ops, "set_key", objN ({{ "tonic", "F#" }, { "mode", "dorian" }}))), "set_key (F# dorian) ok");
        check (key().getProperty ("tonic", var()).toString() == "F#", "session.project.key.tonic == F# after set");
        check (key().getProperty ("mode", var()).toString() == "dorian", "session.project.key.mode == dorian after set");

        // Invalid tonic AND invalid mode each rejected; storage stays at the last good value.
        check (! ok (cmd (ops, "set_key", args1 ("tonic", "H"))), "set_key rejects a tonic outside NOTE_PC");
        check (key().getProperty ("tonic", var()).toString() == "F#", "rejected tonic left storage untouched (still F#)");
        check (! ok (cmd (ops, "set_key", args1 ("mode", "lydian"))), "set_key rejects a mode outside SCALES");
        check (key().getProperty ("mode", var()).toString() == "dorian", "rejected mode left storage untouched (still dorian)");

        // Save → reload → the key round-trips with the .tracktionedit.
        check (ok (cmd (ops, "save")),   "save (musical key) ok");
        check (ok (cmd (ops, "reload")), "reload (musical key) ok");
        check (key().getProperty ("tonic", var()).toString() == "F#", "session.project.key.tonic survived save+reload");
        check (key().getProperty ("mode", var()).toString() == "dorian", "session.project.key.mode survived save+reload");

        // NON-undoable preference: logged undoable:false, and an undo right after must NOT
        // revert it (no transaction was pushed).
        auto klog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool keyPref = false;
        for (auto& ln : juce::StringArray::fromLines (klog))
            if (ln.contains ("\"command\": \"set_key\"") && ln.contains ("\"undoable\": false")) keyPref = true;
        check (keyPref, "set_key logged undoable:false (preference)");
        cmd (ops, "undo");
        check (key().getProperty ("tonic", var()).toString() == "F#", "undo after set_key does NOT revert the key (non-undoable)");

        // Restore the default so later blocks see a clean project.
        check (ok (cmd (ops, "set_key", objN ({{ "tonic", "A" }, { "mode", "minor" }}))), "set_key restore default (A minor) ok");
    }

    // ─── itemID-allocator regression (engine patch: createNewItemID scans ALL caches) ───
    // Before the patch, this load -> save -> reload -> remove -> load sequence could hand
    // the second plugin an itemID still held by the first in automatableEditItemCache ->
    // EditItemCache::addItem jassert (and a silently overwritten itemID->item map in
    // release). The BINDING proof is the run-wide JUCE-Assertion count being 0
    // (Mosh --selftest 2>&1 | grep -c 'JUCE Assertion'); here we assert the sequence runs
    // clean as a regression guard.
    section ("itemID allocator regression (engine patch)");
    {
        auto findIdByName = [&] (const juce::String& nm) -> juce::String {
            auto snap = ops.snapshot();
            auto tv = snap.getProperty ("tracks", var());
            if (auto* arr = tv.getArray())
                for (auto& tr : *arr)
                    if (tr.getProperty ("name", var()).toString() == nm)
                        return tr.getProperty ("id", var()).toString();
            return {};
        };
        check (ok (cmd (ops, "create_track", args1 ("name", "IdProbe"))), "id-probe: create_track ok");
        const auto pid = findIdByName ("IdProbe");
        check (pid.isNotEmpty(), "id-probe: found the probe track");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", pid }, { "type", "4bandEq" }}))),
               "id-probe: load built-in effect ok");
        check (ok (cmd (ops, "save")),   "id-probe: save ok");
        check (ok (cmd (ops, "reload")), "id-probe: reload ok");
        const auto pid2 = findIdByName ("IdProbe");   // track itemID persists across reload
        check (pid2.isNotEmpty(), "id-probe: probe track survived reload");
        check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", pid2 }, { "index", 0 }}))),
               "id-probe: remove_plugin ok");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", pid2 }, { "type", "compressor" }}))),
               "id-probe: load a second plugin after remove (no duplicate-itemID assert)");
    }

    // ─── Wave C: ARR-010 time-range as a true delete target ───
    section ("Wave C: delete_time_range (ARR-010)");
    {
        // A single clip spanning 0..4s; delete [1,2] -> two clips with a 1..2s gap.
        auto dt = cmd (ops, "create_track", args1 ("name", "RangeDel"))["data"].getProperty ("trackId", var()).toString();
        check (dt.isNotEmpty(), "range: track created");
        auto rc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", dt }, { "seconds", 4.0 }, { "freq", 217.0 }}));
        check (ok (rc), "range: 0..4s tone clip created");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: track has 1 clip before delete");

        // start >= end errors (graceful, no mutation).
        check (! ok (cmd (ops, "delete_time_range", objN ({{ "start", 2.0 }, { "end", 1.0 }}))), "range: start>end errors");
        check (! ok (cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 1.0 }}))), "range: start==end errors");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: errored delete left the clip untouched");

        // The real delete: [1,2] on this track only.
        auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 },
                                                         { "trackIds", var (juce::Array<var> { var (dt) }) }}));
        check (ok (del), "range: delete_time_range [1,2] ok");
        {
            auto trk = trackById (dt);
            check (trk.getProperty ("clips", var()).size() == 2, "range: clip split into 2 segments");
            // Collect the segment time spans and assert the 1..2s gap.
            double seg0Start = 1e9, seg0End = 0.0, seg1Start = 1e9, seg1End = 0.0;
            if (auto* clips = trk.getProperty ("clips", var()).getArray())
            {
                juce::Array<double> starts, ends;
                for (auto& c : *clips)
                {
                    const double s = (double) c.getProperty ("start", 0.0);
                    const double e = s + (double) c.getProperty ("length", 0.0);
                    starts.add (s); ends.add (e);
                }
                // sort by start
                if (starts.size() == 2)
                {
                    int lo = starts[0] <= starts[1] ? 0 : 1, hi = 1 - lo;
                    seg0Start = starts[lo]; seg0End = ends[lo];
                    seg1Start = starts[hi]; seg1End = ends[hi];
                }
            }
            check (std::abs (seg0Start - 0.0) < 0.05 && std::abs (seg0End - 1.0) < 0.05, "range: left segment is 0..1s");
            check (std::abs (seg1Start - 2.0) < 0.05 && std::abs (seg1End - 4.0) < 0.05, "range: right segment is 2..4s (1..2s gap)");
        }

        // Undo restores the single clip.
        check (ok (cmd (ops, "undo")), "range: undo ok");
        {
            auto trk = trackById (dt);
            check (trk.getProperty ("clips", var()).size() == 1, "range: undo restored a single clip");
            auto c0 = trk["clips"][0];
            check (std::abs ((double) c0.getProperty ("start", 1.0) - 0.0) < 0.05
                   && std::abs ((double) c0.getProperty ("length", 0.0) - 4.0) < 0.05,
                   "range: restored clip spans 0..4s");
        }

        // A no-overlap range is a graceful no-op (clip stays whole, command ok).
        auto noop = cmd (ops, "delete_time_range", objN ({{ "start", 10.0 }, { "end", 12.0 },
                                                          { "trackIds", var (juce::Array<var> { var (dt) }) }}));
        check (ok (noop), "range: no-overlap range is ok (no-op)");
        check ((int) noop["data"].getProperty ("removed", -1) == 0, "range: no-overlap removed nothing");
        check (trackById (dt).getProperty ("clips", var()).size() == 1, "range: no-overlap left the clip whole");

        // An empty track in the target set is a graceful no-op too.
        auto et2 = cmd (ops, "create_track", args1 ("name", "RangeEmpty"))["data"].getProperty ("trackId", var()).toString();
        auto emptyDel = cmd (ops, "delete_time_range", objN ({{ "start", 0.0 }, { "end", 4.0 },
                                                             { "trackIds", var (juce::Array<var> { var (et2) }) }}));
        check (ok (emptyDel), "range: empty-track delete is ok (no-op)");
        check ((int) emptyDel["data"].getProperty ("removed", -1) == 0, "range: empty track removed nothing");

        // Clip ENTIRELY inside the range is removed whole. Fresh track, single
        // 1s clip moved to start at 1.5s, then delete the enclosing [1,3].
        auto wt = cmd (ops, "create_track", args1 ("name", "RangeWhole"))["data"].getProperty ("trackId", var()).toString();
        auto wc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 1.0 }, { "freq", 213.0 }}));
        if (ok (wc))
        {
            const auto wcid = wc["data"].getProperty ("clipId", var()).toString();
            cmd (ops, "move_clip", objN ({{ "clipId", wcid }, { "start", 1.5 }}));
            check (trackById (wt).getProperty ("clips", var()).size() == 1, "range: enclosed clip present before delete");
            auto wholeDel = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 3.0 },
                                                                 { "trackIds", var (juce::Array<var> { var (wt) }) }}));
            check (ok (wholeDel), "range: enclosing-range delete ok");
            check ((int) wholeDel["data"].getProperty ("removed", 0) == 1, "range: clip fully inside was removed whole");
            check (trackById (wt).getProperty ("clips", var()).size() == 0, "range: track empty after enclosing delete");
        }
    }

    // ─── Wave D: MIX-008 group (submix) tracks ───
    // A FolderTrack created asSubmix=true genuinely sums its children (the graph
    // builder routes them through a SummingNode + the folder's plugin chain — the
    // engine's own nested-submix test proves the audio). Headless we verify the
    // command surface, the snapshot structure, the group fader, and undo/redo.
    section ("Wave D: group / submix tracks (MIX-008)");
    {
        auto ga = cmd (ops, "create_track", args1 ("name", "GrpA"))["data"].getProperty ("trackId", var()).toString();
        auto gb = cmd (ops, "create_track", args1 ("name", "GrpB"))["data"].getProperty ("trackId", var()).toString();
        check (ga.isNotEmpty() && gb.isNotEmpty(), "group: two member tracks created");

        // Create a group over both members (ONE undoable transaction).
        auto gr = cmd (ops, "create_group_track",
                       objN ({{ "name", "Drums" },
                              { "trackIds", var (juce::Array<var> { var (ga), var (gb) }) }}));
        check (ok (gr), "group: create_group_track ok");
        const auto gid = gr["data"].getProperty ("groupId", var()).toString();
        check (gid.isNotEmpty(), "group: returned a groupId");
        check ((int) gr["data"].getProperty ("moved", 0) == 2, "group: moved both member tracks");

        auto gv = trackById (gid);
        check (gv.getProperty ("type", var()).toString() == "group", "group: snapshot entry has type group");
        check ((bool) gv.getProperty ("isGroup", false), "group: snapshot entry flagged isGroup");
        check (gv.getProperty ("name", var()).toString() == "Drums", "group: snapshot entry carries the name");
        check (gv.hasProperty ("volumeDb"), "group: snapshot entry has a real fader (submix VolumeAndPan)");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: member A carries parentId");
        check (trackById (gb).getProperty ("parentId", var()).toString() == gid, "group: member B carries parentId");

        // The group fader + rename drive the FolderTrack via the EXISTING commands.
        check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", gid }, { "db", -6.0 }}))),
               "group: set_track_volume on the group ok");
        check (std::abs ((double) trackById (gid).getProperty ("volumeDb", 0.0) - (-6.0)) < 0.25,
               "group: group fader reflects -6 dB");
        check (ok (cmd (ops, "rename_track", objN ({{ "trackId", gid }, { "name", "DrumBus" }}))),
               "group: rename_track on the group ok");
        check (trackById (gid).getProperty ("name", var()).toString() == "DrumBus", "group: rename reflects");

        // One undo step per command: undo(rename) -> undo(volume) -> undo(create+move).
        cmd (ops, "undo"); cmd (ops, "undo");
        check (ok (cmd (ops, "undo")), "group: undo (create_group_track) ok");
        check (! trackById (gid).isObject() || trackById (gid).getProperty ("type", var()).toString() != "group",
               "group: undo removed the group entry");
        check (trackById (ga).getProperty ("parentId", var()).toString().isEmpty(), "group: undo restored A to top level");
        check (ok (cmd (ops, "redo")), "group: redo ok");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: redo re-grouped A");

        // Ungroup: hoists the members back to top level + deletes the group.
        auto ug = cmd (ops, "ungroup_track", args1 ("trackId", gid));
        check (ok (ug), "group: ungroup_track ok");
        check ((int) ug["data"].getProperty ("hoisted", 0) == 2, "group: ungroup hoisted both members");
        check (trackById (ga).getProperty ("parentId", var()).toString().isEmpty(), "group: A back at top level");
        check (trackById (ga).isObject() && trackById (gb).isObject(), "group: both members survived the ungroup");
        check (! trackById (gid).isObject(), "group: group entry gone after ungroup");
        check (ok (cmd (ops, "undo")), "group: undo (ungroup) ok");
        check (trackById (ga).getProperty ("parentId", var()).toString() == gid, "group: undo restored the grouping");
        cmd (ops, "redo");   // leave the edit flat (group removed) for hygiene

        // Graceful bad args.
        check (! ok (cmd (ops, "ungroup_track", args1 ("trackId", "no-such-group"))), "group: ungroup bad id errors");
        auto gunk = cmd (ops, "create_group_track",
                         objN ({{ "trackIds", var (juce::Array<var> { var ("bogus-id") }) }}));
        check (ok (gunk), "group: unknown member ids are skipped, not fatal");
        check ((int) gunk["data"].getProperty ("moved", -1) == 0, "group: nothing moved for unknown ids");
        check ((int) gunk["data"].getProperty ("unknownTrackIds", 0) == 1, "group: unknown ids reported");
        cmd (ops, "ungroup_track", args1 ("trackId", gunk["data"].getProperty ("groupId", var()).toString()));

        // JSONL records both commands as undoable Edit mutations.
        auto glog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool gUndoable = false, ugUndoable = false;
        for (auto& ln : juce::StringArray::fromLines (glog))
        {
            if (ln.contains ("\"command\": \"create_group_track\"") && ln.contains ("\"undoable\": true")) gUndoable = true;
            if (ln.contains ("\"command\": \"ungroup_track\"") && ln.contains ("\"undoable\": true")) ugUndoable = true;
        }
        check (gUndoable, "group: create_group_track logged undoable:true");
        check (ugUndoable, "group: ungroup_track logged undoable:true");
    }

    // ─── Wave R: RTG-001 input choice + RTG-002 output routing ───
    // Engine machinery exists fully (WaveInputDevice-per-pair; te::TrackOutput with
    // route-to-device AND route-to-track). Headless: enumeration shape, the stored
    // input CHOICE round-trip, and the track->track output routing (ValueTree-backed,
    // no hardware needed) incl. cycle rejection, undo, and persistence. Real capture
    // from a chosen pair / audible multi-out are hardware-gated (verified live).
    section ("Wave R: routing (RTG-001 inputs / RTG-002 outputs)");
    {
        // Read-only enumerations: ok + shape; not logged.
        auto lwiBefore = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        auto lwi = cmd (ops, "list_wave_inputs", var());
        check (ok (lwi), "routing: list_wave_inputs ok");
        auto lwiInputs = lwi["data"].getProperty ("inputs", var());
        check (lwiInputs.isArray(), "routing: list_wave_inputs inputs is an array (empty headless)");
        auto lto = cmd (ops, "list_track_outputs", var());
        check (ok (lto), "routing: list_track_outputs ok");
        auto ltoOuts = lto["data"].getProperty ("outputs", var());
        auto ltoTracks = lto["data"].getProperty ("tracks", var());
        check (ltoOuts.isArray(), "routing: list_track_outputs outputs is an array");
        check (ltoTracks.isArray() && ltoTracks.size() > 0, "routing: list_track_outputs lists candidate tracks");
        auto lwiAfter = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        check (lwiAfter == lwiBefore, "routing: list commands are READ-ONLY (not logged)");

        // RTG-001 — the input CHOICE: stored on the track, graceful headless, persists.
        auto ra = cmd (ops, "create_track", args1 ("name", "RouteA"))["data"].getProperty ("trackId", var()).toString();
        auto rb = cmd (ops, "create_track", args1 ("name", "RouteB"))["data"].getProperty ("trackId", var()).toString();
        check (ra.isNotEmpty() && rb.isNotEmpty(), "routing: two tracks created");
        auto sti = cmd (ops, "set_track_input", objN ({{ "trackId", ra }, { "deviceID", "in-3-4" }}));
        check (ok (sti), "routing: set_track_input ok (graceful headless)");
        check (! (bool) sti["data"].getProperty ("applied", true), "routing: applied:false headless (choice stored)");
        check (trackById (ra)["input"].getProperty ("deviceID", var()).toString() == "in-3-4",
               "routing: chosen input deviceID in the snapshot");
        check (! ok (cmd (ops, "set_track_input", args1 ("trackId", ra))), "routing: set_track_input missing deviceID errors");
        check (! ok (cmd (ops, "set_track_input", objN ({{ "trackId", "nope" }, { "deviceID", "x" }}))),
               "routing: set_track_input bad trackId errors");
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "routing: save+reload ok");
        check (trackById (ra)["input"].getProperty ("deviceID", var()).toString() == "in-3-4",
               "routing: input choice persists across save/reload");

        // RTG-002 — track->track routing (fully headless: ValueTree-backed).
        check (! trackById (ra).hasProperty ("output"), "routing: default output emits no output field");
        auto sto = cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "destTrackId", rb }}));
        check (ok (sto), "routing: set_track_output A->B ok");
        auto outv = trackById (ra)["output"];
        check ((bool) outv.getProperty ("isTrack", false), "routing: output isTrack");
        check (outv.getProperty ("destId", var()).toString() == rb, "routing: output destId == B");
        // Cycle + self rejection.
        check (! ok (cmd (ops, "set_track_output", objN ({{ "trackId", rb }, { "destTrackId", ra }}))),
               "routing: B->A rejected (cycle)");
        check (! ok (cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "destTrackId", ra }}))),
               "routing: A->A rejected (self)");
        // Persistence + undo.
        check (ok (cmd (ops, "save")) && ok (cmd (ops, "reload")), "routing: save+reload ok (output)");
        check (trackById (ra)["output"].getProperty ("destId", var()).toString() == rb,
               "routing: A->B routing persists across save/reload");
        check (ok (cmd (ops, "set_track_output", objN ({{ "trackId", ra }, { "output", "default" }}))),
               "routing: reset to default ok");
        check (! trackById (ra).hasProperty ("output"), "routing: reset removed the output field");
        check (ok (cmd (ops, "undo")), "routing: undo (reset) ok");
        check (trackById (ra)["output"].getProperty ("destId", var()).toString() == rb,
               "routing: undo restored the A->B routing");
        check (! ok (cmd (ops, "set_track_output", args1 ("trackId", ra))),
               "routing: set_track_output with no destination errors");

        // JSONL postures: input choice is a preference, output routing is undoable.
        auto rlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool inPref = false, outUndo = false;
        for (auto& ln : juce::StringArray::fromLines (rlog))
        {
            if (ln.contains ("\"command\": \"set_track_input\"") && ln.contains ("\"undoable\": false")) inPref = true;
            if (ln.contains ("\"command\": \"set_track_output\"") && ln.contains ("\"undoable\": true")) outUndo = true;
        }
        check (inPref, "routing: set_track_input logged undoable:false (preference)");
        check (outUndo, "routing: set_track_output logged undoable:true (Edit mutation)");
    }

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

    section ("Moshi brain proxy + native voice (packaged-app pieces)");
    {
        // Deterministic provider resolution — set known env, no network calls.
        ::setenv ("DEEPSEEK_BASE_URL", "https://api.deepseek.test", 1);
        ::setenv ("DEEPSEEK_MODEL", "deepseek-test", 1);
        ::setenv ("DEEPSEEK_API_KEY", "sk-test-deepseek", 1);
        ::setenv ("XAI_BASE_URL", "https://api.x.test", 1);
        ::setenv ("XAI_MODEL", "grok-test", 1);
        ::setenv ("XAI_API_KEY", "sk-test-xai", 1);
        ::unsetenv ("OPENAI_API_KEY");          // leave openai incomplete
        ::setenv ("MOSHI_BRAIN_PROVIDER", "xai", 1);

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
        ::unsetenv ("DEEPSEEK_API_KEY"); ::unsetenv ("XAI_API_KEY"); ::unsetenv ("MOSHI_BRAIN_PROVIDER");
        check (! BrainProxy::resolve().isComplete(), "brain: nothing resolves when no key is set");
        auto noProv = BrainProxy::chat (var (Array<var>{}), {});
        check (! (bool) noProv.getProperty ("ok", true),
               "brain: chat() with no provider returns { ok:false } (no crash, no network)");

        // Native speech: probe availability + lifecycle without requesting permission.
       #if JUCE_MAC
        check (NativeSpeech::isSupported(), "voice: macOS Speech available (SFSpeechRecognizer present)");
       #endif
        NativeSpeech sp;
        check (! sp.isListening(), "voice: a fresh NativeSpeech is idle");
        sp.stop();   // stop-while-idle must be a safe no-op
        check (! sp.isListening(), "voice: stop() while idle is a safe no-op");
    }

    finishSection();
    std::cerr << "===== " << (checks - failures) << "/" << checks
              << " checks passed, " << failures << " failed =====\n\n";
    return failures;
}

int runUndoSelfTest (MoshEngine&, MoshOps& ops)
{
    using namespace juce;
    failures = 0;
    checks = 0;
    resetSections();

    std::cerr << "\n===== Mosh focused undo harness =====\n";
    section ("focused undo transaction coverage");

    auto r = cmd (ops, "create_track", args1 ("name", "Undo Probe"));
    check (ok (r), "create_track ok");
    check (tracks (ops) == 1, "track exists after create_track");

    auto toneArgs = new DynamicObject();
    toneArgs->setProperty ("seconds", 0.25);
    toneArgs->setProperty ("freq", 220.0);
    auto rt = cmd (ops, "add_test_tone_clip", var (toneArgs));
    check (ok (rt), "add_test_tone_clip ok");
    check (trackClips (firstTrack (ops)) == 1, "clip exists after add_test_tone_clip");

    const auto clipId = firstTrack (ops)["clips"][0].getProperty ("id", var()).toString();
    check (ok (cmd (ops, "add_render_layer", args1 ("clipId", clipId))), "add_render_layer ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "render layer exists");

    check (ok (cmd (ops, "undo")), "undo render layer command ok");
    check (! (bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", true), "undo removed render layer");
    check (ok (cmd (ops, "undo")), "undo clip command ok");
    check (trackClips (firstTrack (ops)) == 0, "undo removed clip");
    check (ok (cmd (ops, "undo")), "undo track command ok");
    check (tracks (ops) == 0, "undo removed track");

    check (ok (cmd (ops, "redo")), "redo track command ok");
    check (tracks (ops) == 1, "redo restored track");
    check (ok (cmd (ops, "redo")), "redo clip command ok");
    check (trackClips (firstTrack (ops)) == 1, "redo restored clip");
    check (ok (cmd (ops, "redo")), "redo render layer command ok");
    check ((bool) firstTrack (ops)["clips"][0].getProperty ("hasRenderLayer", false), "redo restored render layer");

    finishSection();
    std::cerr << "===== " << checks - failures << "/" << checks
              << " focused undo checks passed, " << failures << " failed =====\n";
    return failures;
}

int runLiveAudioSmoke (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0;
    checks = 0;
    resetSections();

    std::cerr << "\n===== Mosh live-audio smoke =====\n";
    section ("live-audio CoreAudio callback smoke");

    auto& deviceManager = eng.engine().getDeviceManager().deviceManager;
    auto* device = deviceManager.getCurrentAudioDevice();
    check (eng.hasAudio(), "audio mode is enabled");
    check (eng.audioDeviceError().isEmpty(), "requested audio device opened");
    check (device != nullptr, "JUCE audio device is open");

    const auto requested = SystemStats::getEnvironmentVariable ("MOSH_AUDIO_OUTPUT_DEVICE", {}).trim();
    const auto requestedInput = SystemStats::getEnvironmentVariable ("MOSH_AUDIO_INPUT_DEVICE", {}).trim();
    if (device != nullptr)
    {
        std::cerr << "  ..   device=" << device->getName()
                  << " type=" << device->getTypeName()
                  << " rate=" << device->getCurrentSampleRate()
                  << " block=" << device->getCurrentBufferSizeSamples() << "\n";

        if (requested.isNotEmpty())
            check (device->getName().equalsIgnoreCase (requested), "current output matches MOSH_AUDIO_OUTPUT_DEVICE");
    }

    auto track = cmd (ops, "create_track", args1 ("name", "Live Smoke"));
    check (ok (track), "create_track ok");
    const auto trackId = track["data"].getProperty ("trackId", var()).toString();

    check (ok (cmd (ops, "add_test_tone_clip",
                   objN ({{ "trackId", trackId }, { "seconds", 2.0 }, { "freq", 440.0 }}))),
           "add_test_tone_clip ok");

    check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "transport seek ok");

    // ── GAP 3 — metering live-smoke (gated on MOSH_AUDIO_OUTPUT_DEVICE) ──
    // Enable the track meter + attach the level sink BEFORE playback, so the
    // LevelMeterPlugin tap is present when the playback graph is prepared (this matches
    // the product, which calls enable_all_meters at init — a meter inserted into an
    // already-prepared graph isn't tapped until the next rebuild). We then capture the
    // decimated "levels" events the 30 Hz timer emits while the tone plays and assert at
    // least one level above the -100 floor. Env-gated out of the default headless run.
    const bool gap3 = requested.isNotEmpty();
    std::atomic<double> maxLevelSeen { -1000.0 };
    std::atomic<int> levelEvents { 0 };
    std::atomic<double> maxTrack { -1000.0 }, maxMaster { -1000.0 };
    if (gap3)
    {
        check (ok (cmd (ops, "enable_track_meter", args1 ("trackId", trackId))), "GAP3: enable_track_meter ok");
        ops.setEventSink ([&] (const var& e)
        {
            if (e.getProperty ("type", var()).toString() != "levels") return;
            levelEvents.fetch_add (1);
            auto fold = [] (std::atomic<double>& dst, double l, double r)
            {
                const double hi = jmax (l, r);
                double cur = dst.load();
                while (hi > cur && ! dst.compare_exchange_weak (cur, hi)) {}
            };
            // The "levels" event is wrapped { type, payload } (the UI reads ev.payload.*).
            auto payload = e.getProperty ("payload", var());
            auto tracks = payload.getProperty ("tracks", var());
            if (auto* arr = tracks.getArray())
                for (auto& tv : *arr)
                    fold (maxTrack, (double) tv.getProperty ("l", -1000.0), (double) tv.getProperty ("r", -1000.0));
            // The MASTER tap (ctx->masterLevels) is the authoritative engine output level
            // — what actually reaches the device. A track LevelMeterPlugin can still read
            // the floor if it isn't yet in the prepared graph, so the master is the
            // ground-truth "audio is live" signal (the tone is audible on the device).
            auto master = payload.getProperty ("master", var());
            fold (maxMaster, (double) master.getProperty ("l", -1000.0), (double) master.getProperty ("r", -1000.0));
            const double both = jmax (maxTrack.load(), maxMaster.load());
            double cur = maxLevelSeen.load();
            while (both > cur && ! maxLevelSeen.compare_exchange_weak (cur, both)) {}
        });
    }

    check (ok (cmd (ops, "set_transport", args1 ("action", "play"))), "transport play ok");
    check (eng.edit().getTransport().getCurrentPlaybackContext() != nullptr, "playback context allocated");

    // MON-004: with the playback graph prepared, the PDC readout is live (ready=true).
    {
        auto sess = ops.snapshot().getProperty ("session", var());
        check ((bool) sess.getProperty ("latencyContextReady", false), "PDC: latencyContextReady=true with the graph prepared");
        check ((int) sess.getProperty ("totalLatencySamples", -1) >= 0, "PDC: totalLatencySamples non-negative (live graph)");
    }

    LiveAudioProbe probe;
    deviceManager.addAudioCallback (&probe);

    auto* mm = MessageManager::getInstanceWithoutCreating();
    auto smokeMs = SystemStats::getEnvironmentVariable ("MOSH_LIVE_AUDIO_SMOKE_MS", "3500").getIntValue();
    smokeMs = jlimit (500, 15000, smokeMs);
    const auto end = Time::getMillisecondCounter() + (uint32) smokeMs;
    while (Time::getMillisecondCounter() < end)
    {
        if (mm != nullptr) mm->runDispatchLoopUntil (50);
        else Thread::sleep (50);
    }

    deviceManager.removeAudioCallback (&probe);
    check (probe.getCallbackCount() > 0, "live-audio probe callback ran");
    check (probe.getSampleCount() > 0, "live-audio probe observed audio frames");
    check (probe.getWrittenSampleCount() > 0, "live-audio probe had writable output channels");
    if (requestedInput.isNotEmpty())
    {
        check (probe.getInputSampleCount() > 0, "live-audio probe observed input frames");
        check (probe.getInputNonSilentSampleCount() > 0, "live-audio probe captured loopback input");
    }
    check (ok (cmd (ops, "set_transport", args1 ("action", "stop"))), "transport stop ok");

    if (gap3)
    {
        ops.setEventSink ({});   // detach before the local maxLevelSeen goes out of scope
        std::cerr << "  ..   GAP3 diag: levels events=" << levelEvents.load()
                  << "  maxTrack=" << maxTrack.load() << "dB  maxMaster=" << maxMaster.load() << "dB\n";
        check (maxLevelSeen.load() > -100.0, "GAP3: captured a 'levels' event above the -100 floor (meter live)");
    }

    // ── GAP 2 — recording live-smoke (gated on MOSH_AUDIO_INPUT_DEVICE) ──
    // arm a fresh track → record ~1s of the live input → stop → assert a clip landed
    // with a non-silent source WAV. Needs a real, non-silent input device; the env gate
    // keeps it out of the default headless selftest.
    if (requestedInput.isNotEmpty())
    {
        auto rt = cmd (ops, "create_track", args1 ("name", "Record Smoke"));
        check (ok (rt), "GAP2: create_track (record) ok");
        const auto recTrackId = rt["data"].getProperty ("trackId", var()).toString();

        auto arm = cmd (ops, "arm_track", objN ({{ "trackId", recTrackId }, { "armed", true }}));
        check (ok (arm), "GAP2: arm_track ok");
        check ((bool) arm["data"].getProperty ("applied", false), "GAP2: arm_track applied (input assigned)");
        check ((bool) arm["data"].getProperty ("armed", false), "GAP2: track reports armed");
        // The track snapshot should report it has an input now.
        {
            auto tv = ops.snapshot().getProperty ("tracks", var());
            bool hasInput = false;
            if (auto* arr = tv.getArray())
                for (auto& t : *arr)
                    if (t.getProperty ("id", var()).toString() == recTrackId)
                        hasInput = (bool) t.getProperty ("hasInput", false);
            check (hasInput, "GAP2: armed track reports hasInput");
        }

        check (ok (cmd (ops, "set_transport", args1 ("position", 0.0))), "GAP2: seek to 0 ok");
        check (ok (cmd (ops, "set_transport", args1 ("action", "record"))), "GAP2: set_transport record ok");

        const auto recEnd = Time::getMillisecondCounter() + (uint32) 1200;
        while (Time::getMillisecondCounter() < recEnd)
        {
            if (mm != nullptr) mm->runDispatchLoopUntil (50);
            else Thread::sleep (50);
        }

        auto stop = cmd (ops, "stop_recording");
        check (ok (stop), "GAP2: stop_recording ok");
        auto landed = stop["data"].getProperty ("clips", var());
        const int nLanded = landed.isArray() ? landed.size() : 0;
        check (nLanded > 0, "GAP2: a take clip landed on the armed track");
        if (nLanded > 0)
        {
            const auto srcPath = landed[0].getProperty ("sourceFile", var()).toString();
            check (srcPath.isNotEmpty(), "GAP2: landed clip has a sourceFile");
            const File src (srcPath);
            check (src.existsAsFile(), "GAP2: recorded source WAV exists on disk");

            // Non-silent: read the WAV and check any sample above a small floor.
            bool nonSilent = false;
            AudioFormatManager fm; fm.registerBasicFormats();
            if (std::unique_ptr<AudioFormatReader> reader { fm.createReaderFor (src) })
            {
                const int toRead = (int) jmin ((int64) 96000, reader->lengthInSamples);
                if (toRead > 0)
                {
                    AudioBuffer<float> buf ((int) reader->numChannels, toRead);
                    reader->read (&buf, 0, toRead, 0, true, true);
                    for (int ch = 0; ch < buf.getNumChannels() && ! nonSilent; ++ch)
                        if (buf.getMagnitude (ch, 0, toRead) > 0.001f)
                            nonSilent = true;
                }
            }
            check (nonSilent, "GAP2: recorded source WAV is non-silent (captured live input)");
        }
    }

    finishSection();
    std::cerr << "===== " << checks - failures << "/" << checks
              << " live-audio checks passed, " << failures << " failed =====\n";
    return failures;
}

// Shared helpers for the visual --demoN walkthroughs below: build a command var and
// run it through MoshOps, and build a small args object. The demos used to each carry
// an identical copy of these as local lambdas.
static juce::var moshDemoCmd (MoshOps& ops, const juce::String& n, juce::var a = juce::var())
{
    auto* c = new juce::DynamicObject(); c->setProperty ("command", n);
    if (! a.isVoid()) c->setProperty ("args", a);
    return ops.execute (juce::var (c));
}
static juce::var moshDemoObj (std::initializer_list<std::pair<const char*, juce::var>> kv)
{
    auto* o = new juce::DynamicObject();
    for (auto& p : kv) o->setProperty (p.first, p.second);
    return juce::var (o);
}

void runPluginDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) { return moshDemoCmd (ops, n, a); };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) { return moshDemoObj (kv); };

    // Find an effect + an instrument from the scan. Prefer Serum 2 for demo3
    // when present because the UI gate verifies its native editor specifically.
    String fxId, instId, fallbackInstId;
    auto lp = cmd ("list_plugins");
    if (auto* arr = lp["data"].getProperty ("plugins", var()).getArray())
        for (auto& p : *arr)
        {
            const bool isInstrument = (bool) p.getProperty ("isInstrument", false);
            const auto id = p.getProperty ("id", var()).toString();
            if (isInstrument)
            {
                if (fallbackInstId.isEmpty())
                    fallbackInstId = id;

                if (p.getProperty ("name", var()).toString() == "Serum 2"
                    && p.getProperty ("manufacturer", var()).toString() == "Xfer Records")
                    instId = id;
            }
            else if (fxId.isEmpty())
            {
                fxId = id;
            }
        }
    if (instId.isEmpty())
        instId = fallbackInstId;

    // Wave track + tone + effect.
    auto t1 = cmd ("create_track", obj ({{ "name", "Drums" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t1 }, { "seconds", 2.0 }, { "freq", 110.0 }}));
    if (fxId.isNotEmpty())
        cmd ("load_plugin", obj ({{ "trackId", t1 }, { "pluginId", fxId }}));

    // Synth track + MIDI + instrument, then open its native editor.
    auto t2 = cmd ("create_track", obj ({{ "name", "Synth" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_midi_clip", obj ({{ "trackId", t2 }}));
    if (instId.isNotEmpty())
    {
        auto r = cmd ("load_plugin", obj ({{ "trackId", t2 }, { "pluginId", instId }}));
        const int idx = (int) r["data"].getProperty ("index", -1);
        if (idx >= 0)
            cmd ("open_plugin_editor", obj ({{ "trackId", t2 }, { "index", idx }}));
    }
}

// Audible A/B of a REAL Tier-A neural model (`Mosh --neural-ab`). Imports a DI clip,
// inserts a neural plugin, loads a real RTNeural model (MOSH_NEURAL_AB_MODEL), then
// plays the clip through the device alternating WET (amp on) / DRY (bypassed) so a
// human can A/B it. Needs a real output device (MOSH_AUDIO_OUTPUT_DEVICE) + the model
// and DI paths via env. Returns 0 when the model loaded, 1 otherwise.
int runNeuralAB (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    ignoreUnused (eng);
    auto cmd = [&] (const String& n, var a = var()) { return moshDemoCmd (ops, n, a); };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) { return moshDemoObj (kv); };
    auto* mm = MessageManager::getInstanceWithoutCreating();
    auto pump = [&] (int ms) {
        const auto end = Time::getMillisecondCounter() + (uint32) jmax (0, ms);
        while (Time::getMillisecondCounter() < end)
        { if (mm != nullptr) mm->runDispatchLoopUntil (50); else Thread::sleep (50); }
    };

    const auto modelPath = SystemStats::getEnvironmentVariable ("MOSH_NEURAL_AB_MODEL", {});
    const auto wavPath   = SystemStats::getEnvironmentVariable ("MOSH_NEURAL_AB_WAV", {});
    const int  secs      = jlimit (1, 30, SystemStats::getEnvironmentVariable ("MOSH_NEURAL_AB_SECS", "6").getIntValue());
    std::cerr << "\n===== Mosh neural A/B (real Tier-A model) =====\n";
    if (modelPath.isEmpty() || wavPath.isEmpty())
    {
        std::cerr << "  set MOSH_NEURAL_AB_MODEL=<model.json> and MOSH_NEURAL_AB_WAV=<di.wav>\n";
        return 1;
    }
    std::cerr << "  model: " << modelPath << "\n  input: " << wavPath << "\n";

    auto t = cmd ("create_track", obj ({{ "name", "Amp A/B" }}))["data"].getProperty ("trackId", var()).toString();
    std::cerr << "  import_clip: " << (ok (cmd ("import_clip", obj ({{ "file", wavPath }, { "trackId", t }}))) ? "ok" : "FAILED") << "\n";
    const int idx = (int) cmd ("add_neural_insert", obj ({{ "trackId", t }, { "modelId", "nam" }}))["data"].getProperty ("index", -1);
    auto loadArgs = obj ({{ "trackId", t }, { "index", idx }, { "path", modelPath }});
    const auto skipEnv = SystemStats::getEnvironmentVariable ("MOSH_NEURAL_AB_SKIP", {});   // ""=self-describe, 0/1=force
    if (skipEnv.isNotEmpty())
        loadArgs.getDynamicObject()->setProperty ("skip", skipEnv.getIntValue() != 0);
    auto lm = cmd ("load_neural_model", loadArgs);
    const bool applied   = (bool) lm["data"].getProperty ("applied", false);
    const auto modelName = lm["data"].getProperty ("describe", var()).getProperty ("modelName", var()).toString();
    std::cerr << "  load_neural_model: applied=" << (applied ? "true" : "false")
              << (modelName.isNotEmpty() ? ("  model=" + modelName) : String()) << "\n";
    if (! applied)
        std::cerr << "  (model did not load — build with -DMOSH_ENABLE_RTNEURAL=ON and an RTNeural-native JSON)\n";
    cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "mix" }, { "value", 100.0 }}));

    for (int cycle = 0; cycle < 2; ++cycle)
    {
        cmd ("bypass_plugin", obj ({{ "trackId", t }, { "index", idx }, { "bypassed", false }}));
        std::cerr << "  >> WET  — amp ON  (" << (modelName.isNotEmpty() ? modelName : String ("model")) << ") — listen...\n";
        cmd ("set_transport", obj ({{ "position", 0.0 }}));
        cmd ("set_transport", obj ({{ "action", "play" }}));
        pump (secs * 1000);
        cmd ("set_transport", obj ({{ "action", "stop" }}));

        cmd ("bypass_plugin", obj ({{ "trackId", t }, { "index", idx }, { "bypassed", true }}));
        std::cerr << "  >> DRY  — bypassed (clean DI) — listen...\n";
        cmd ("set_transport", obj ({{ "position", 0.0 }}));
        cmd ("set_transport", obj ({{ "action", "play" }}));
        pump (secs * 1000);
        cmd ("set_transport", obj ({{ "action", "stop" }}));
    }
    std::cerr << "===== neural A/B done =====\n";
    return applied ? 0 : 1;
}

void runNeuralDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) { return moshDemoCmd (ops, n, a); };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) { return moshDemoObj (kv); };

    auto t = cmd ("create_track", obj ({{ "name", "Guitar" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 3.0 }, { "freq", 110.0 }}));
    auto r = cmd ("add_neural_insert", obj ({{ "trackId", t }, { "modelId", "nam" }}));
    const int idx = (int) r["data"].getProperty ("index", -1);
    if (idx >= 0)
    {
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "drive" }, { "value", 72.0 }}));
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "mix" }, { "value", 85.0 }}));
    }
}

void runGenerativeDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) { return moshDemoCmd (ops, n, a); };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) { return moshDemoObj (kv); };

    auto t = cmd ("create_track", obj ({{ "name", "Vox" }}))["data"].getProperty ("trackId", var()).toString();
    auto tone = cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 2.0 }, { "freq", 147.0 }}));
    auto cid = tone["data"].getProperty ("clipId", var()).toString();
    // SA3 render layer with a 2-colour rack (falls back to the fake render if SA3 is off).
    const bool sa3 = juce::SystemStats::getEnvironmentVariable ("MOSH_ENABLE_SA3", "0") == "1";
    cmd ("create_render_layer", obj ({{ "clipId", cid },
        { "adapter", sa3 ? "stable_audio3" : "fake" }, { "mode", "reimagine" },
        { "modelVariant", sa3 ? "sa3-medium" : "" }}));
    Array<var> colors;
    { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 68); colors.add (var (c)); }
    { auto* c = new DynamicObject(); c->setProperty ("name", "air");  c->setProperty ("value", 60); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 1 }, { "nl", 0.42 }, { "colors", colors }}));
    // NB: the actual render_layer (which spawns the service) is left to the user
    // button - running it here would block the message thread on a TCC/service
    // prompt before the WebView paints. The full render loop is proven headless.
}

void runConsolidationDemo (MoshOps& ops)
{
    using namespace juce;
    auto cmd = [&] (const String& n, var a = var()) { return moshDemoCmd (ops, n, a); };
    auto obj = [] (std::initializer_list<std::pair<const char*, var>> kv) { return moshDemoObj (kv); };

    // A "Gtr" track with BOTH tiers on it: a Tier-A neural insert + a Tier-B
    // generative RenderLayer on its clip.
    auto t = cmd ("create_track", obj ({{ "name", "Gtr" }}))["data"].getProperty ("trackId", var()).toString();
    auto tone = cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 2.5 }, { "freq", 131.0 }}));
    auto cid = tone["data"].getProperty ("clipId", var()).toString();

    auto an = cmd ("add_neural_insert", obj ({{ "trackId", t }, { "modelId", "nam" }}));
    const int idx = (int) an["data"].getProperty ("index", -1);
    if (idx >= 0)
        cmd ("set_neural_param", obj ({{ "trackId", t }, { "index", idx }, { "paramId", "drive" }, { "value", 68.0 }}));

    cmd ("create_render_layer", obj ({{ "clipId", cid }, { "adapter", "fake" }}));
    Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 62); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 3 }, { "nl", 0.4 }, { "colors", colors }}));

    // A second track so the arrangement looks like a session.
    auto t2 = cmd ("create_track", obj ({{ "name", "Pad" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t2 }, { "seconds", 4.0 }, { "freq", 196.0 }}));
}

} // namespace mosh
