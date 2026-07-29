// ── SelfTest.Modes.cpp — the self-contained non-runSelfTest entry points ──────
// (RFC 002 — selftest chapter split, scaffolding.) Moved VERBATIM from
// src/app/SelfTest.cpp: runDeepPluginScan, runGoldenSelfTest, runUndoSelfTest,
// runLiveAudioSmoke, the --demoN walkthroughs, runCommandScript, runVoiceSmoke,
// plus the mode-private helpers (LiveAudioProbe, GoldenCanonicalizer,
// goldenDir/checkGoldenXml). The anonymous-namespace shims below bind the moved
// bodies to the shared harness state in selftest/SelfTestSupport.* — the same
// instance SelfTest.cpp's runSelfTest uses — so the bodies stay byte-identical
// to their pre-split form.

#include "app/SelfTest.h"
#include "SelfTestSupport.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include "voice/NativeSpeech.h"
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <thread>
#include <vector>

namespace mosh
{
namespace
{
    // Thin forwarders keeping the exact pre-split free-function names/signatures.
    selftest::SelfTestCtx& gCtx = selftest::globalCtx();
    int& failures = gCtx.failures;
    int& checks   = gCtx.checks;

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

    class GoldenCanonicalizer
    {
    public:
        juce::String canonicalizeXml (const juce::String& raw)
        {
            auto xml = juce::parseXML (raw);
            if (xml == nullptr)
                return {};

            canonicalizeElement (*xml);
            auto text = xml->toString();
            text = text.replace ("\r\n", "\n");
            return text.trimEnd() + "\n";
        }

    private:
        juce::String canonicalId (const juce::String& value)
        {
            const auto key = value.trim();
            if (key.isEmpty())
                return key;

            auto it = ids.find (key);
            if (it != ids.end())
                return it->second;

            const auto token = "ID_" + juce::String (++nextId).paddedLeft ('0', 3);
            ids.emplace (key, token);
            return token;
        }

        juce::String canonicalPath (const juce::String& value)
        {
            const auto key = value.trim();
            if (key.isEmpty())
                return key;

            auto it = paths.find (key);
            if (it != paths.end())
                return it->second;

            const auto token = "PATH_" + juce::String (++nextPath).paddedLeft ('0', 3);
            paths.emplace (key, token);
            return token;
        }

        void canonicalizeElement (juce::XmlElement& xml)
        {
            for (int i = 0; i < xml.getNumAttributes(); ++i)
            {
                const auto attr = xml.getAttributeName (i);
                const auto lower = attr.toLowerCase();
                const auto value = xml.getStringAttribute (attr);

                if (lower.contains ("id"))
                    xml.setAttribute (attr, canonicalId (value));
                else if (lower.contains ("path")
                         || lower.contains ("file")
                         || lower == "source"
                         || lower.endsWith ("source"))
                    xml.setAttribute (attr, canonicalPath (value));
            }

            for (auto* child = xml.getFirstChildElement(); child != nullptr; child = child->getNextElement())
                canonicalizeElement (*child);
        }

        std::map<juce::String, juce::String> ids;
        std::map<juce::String, juce::String> paths;
        int nextId = 0;
        int nextPath = 0;
    };

    juce::File goldenDir()
    {
        const auto env = juce::SystemStats::getEnvironmentVariable ("MOSH_GOLDEN_DIR", {}).trim();
        if (env.isNotEmpty())
        {
            const juce::File asFile (env.startsWithChar (juce::File::getSeparatorChar())
                                         ? env
                                         : juce::File::getCurrentWorkingDirectory().getChildFile (env).getFullPathName());
            return asFile;
        }
        return juce::File::getCurrentWorkingDirectory().getChildFile ("tests/golden");
    }

    void checkGoldenXml (const juce::File& sessionDir,
                         const juce::String& fixtureName,
                         const juce::String& actual)
    {
        const auto expectedFile = goldenDir().getChildFile (fixtureName);
        const auto actualFile = sessionDir.getChildFile (fixtureName + ".actual.xml");
        actualFile.getParentDirectory().createDirectory();

        if (! expectedFile.existsAsFile())
        {
            actualFile.replaceWithText (actual);
            check (false, "missing golden fixture " + expectedFile.getFullPathName()
                        + " (wrote " + actualFile.getFullPathName() + ")");
            return;
        }

        const auto expected = expectedFile.loadFileAsString().replace ("\r\n", "\n").trimEnd() + "\n";
        if (expected != actual)
        {
            actualFile.replaceWithText (actual);
            check (false, "golden mismatch for " + fixtureName
                        + " (wrote " + actualFile.getFullPathName() + ")");
            return;
        }

        if (actualFile.existsAsFile())
            actualFile.deleteFile();
        check (true, "golden fixture matched: " + fixtureName);
    }
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

int runGoldenSelfTest (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    failures = 0; checks = 0;
    resetSections();
    std::cerr << "===== Golden selftest: command ValueTree fixtures =====\n";

    section ("Layer 1: create_track ValueTree golden");
    const auto create = cmd (ops, "create_track", args1 ("name", "Golden Track"));
    check (ok (create), "create_track ok");
    const auto trackId = create.getProperty ("data", var()).getProperty ("trackId", var()).toString();
    check (trackId.isNotEmpty(), "create_track returned trackId");

    const auto serialized = cmd (ops, "mp_serialize_track", args1 ("trackId", trackId));
    check (ok (serialized), "mp_serialize_track ok");
    const auto blob = serialized.getProperty ("data", var()).getProperty ("blob", var()).toString();
    check (blob.isNotEmpty(), "mp_serialize_track produced XML");

    GoldenCanonicalizer canonicalizer;
    const auto actual = canonicalizer.canonicalizeXml (blob);
    check (actual.isNotEmpty(), "canonical XML produced");
    if (actual.isNotEmpty())
        checkGoldenXml (eng.sessionDir(), "moshop_create_track.xml", actual);

    section ("Layer 2: phone command body routes through MoshOps");
    auto* phoneArgs = new DynamicObject();
    phoneArgs->setProperty ("action", "record");
    phoneArgs->setProperty ("source", "phone_controller");
    auto* phoneCommand = new DynamicObject();
    phoneCommand->setProperty ("command", "set_transport");
    phoneCommand->setProperty ("args", var (phoneArgs));
    auto* phoneBody = new DynamicObject();
    phoneBody->setProperty ("command", var (phoneCommand));
    const var phoneEnvelope (phoneBody);
    const auto phonePayload = phoneEnvelope.getProperty ("command", var());
    check (phonePayload.isObject(), "phone body carries the standard command object");
    const auto phoneResult = ops.execute (phonePayload);
    check (ok (phoneResult), "phone set_transport record applies through MoshOps");
    check (phoneResult.getProperty ("command", var()).toString() == "set_transport",
           "phone command keeps the normal set_transport command name");
    const auto phoneLog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
    check (phoneLog.contains ("\"source\": \"phone_controller\""), "phone source survives into the command log");

    section ("Layer 3: peer apply committed track ValueTree golden");
    MoshEngine receiverEng (false, true, "session-golden-selftest-receiver");
    MoshOps receiverOps (receiverEng);

    const auto senderCreate = cmd (ops, "create_track", args1 ("name", "Peer Sender"));
    check (ok (senderCreate), "sender create_track ok");
    const auto senderTrackId = senderCreate.getProperty ("data", var()).getProperty ("trackId", var()).toString();
    check (senderTrackId.isNotEmpty(), "sender trackId resolved");

    const auto senderTone = cmd (ops, "add_test_tone_clip",
                                 objN ({ { "trackId", senderTrackId },
                                         { "seconds", 1.0 },
                                         { "freq", 220.0 } }));
    check (ok (senderTone), "sender add_test_tone_clip ok");

    const auto senderCommit = cmd (ops, "mp_serialize_track", args1 ("trackId", senderTrackId));
    check (ok (senderCommit), "sender mp_serialize_track ok");
    const auto senderBlob = senderCommit.getProperty ("data", var()).getProperty ("blob", var()).toString();
    check (senderBlob.isNotEmpty(), "sender commit blob produced");

    const auto apply = cmd (receiverOps, "apply_remote_track", args1 ("blob", senderBlob));
    check (ok (apply), "receiver apply_remote_track ok");
    check (apply.getProperty ("data", var()).getProperty ("mode", var()).toString() == "created",
           "receiver created the incoming peer track");
    const auto peerLogicalId = apply.getProperty ("data", var()).getProperty ("logicalId", var()).toString();
    check (peerLogicalId.isNotEmpty(), "receiver apply returned logicalId");

    auto receiverTrack = trackSnapshotByLogicalId (receiverOps, peerLogicalId);
    check (receiverTrack.isObject(), "receiver track found by logicalId");
    bool hasResolvedWave = false;
    bool hasCleanPendingWave = false;
    if (auto* clips = receiverTrack.getProperty ("clips", var()).getArray())
        for (auto& clip : *clips)
            if (clip.getProperty ("type", var()).toString() == "wave")
            {
                const auto sourceFile = clip.getProperty ("sourceFile", var()).toString();
                const bool missing = (bool) clip.getProperty ("sourceMissing", false);
                hasResolvedWave = hasResolvedWave || (sourceFile.isNotEmpty() && juce::File (sourceFile).existsAsFile());
                hasCleanPendingWave = hasCleanPendingWave || missing;
            }
    check (hasResolvedWave || hasCleanPendingWave, "receiver wave source resolves locally or is cleanly pending");

    const auto receiverTrackId = receiverTrack.getProperty ("id", var()).toString();
    check (receiverTrackId.isNotEmpty(), "receiver engine trackId resolved");
    const auto receiverSerialized = cmd (receiverOps, "mp_serialize_track", args1 ("trackId", receiverTrackId));
    check (ok (receiverSerialized), "receiver mp_serialize_track ok");
    const auto receiverBlob = receiverSerialized.getProperty ("data", var()).getProperty ("blob", var()).toString();
    check (receiverBlob.isNotEmpty(), "receiver serialized XML produced");

    GoldenCanonicalizer peerCanonicalizer;
    const auto peerActual = peerCanonicalizer.canonicalizeXml (receiverBlob);
    check (peerActual.isNotEmpty(), "receiver canonical XML produced");
    if (peerActual.isNotEmpty())
        checkGoldenXml (eng.sessionDir(), "peer_apply_committed_track.xml", peerActual);

    finishSection();
    std::cerr << "===== golden selftest complete: " << checks << " checks, "
              << failures << " failed =====\n";
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

        // ── GAP 4 — barge-in: run the CONTINUOUS recognizer WHILE the take records ──
        // THE core hands-free unknown: can macOS Speech (AVAudioEngine input tap) and
        // Tracktion's recording (JUCE AudioDeviceManager) capture the SAME mic at once?
        // Gated on MOSH_VOICE_BARGE_IN=1 (needs Speech authorization + a real mic) so the
        // plain GAP-2 recording smoke still runs without it. `speech` is declared AFTER the
        // captured locals so it (and its callbacks) tear down BEFORE them.
        const bool bargeIn = SystemStats::getEnvironmentVariable ("MOSH_VOICE_BARGE_IN", "0").getIntValue() != 0;
        std::atomic<bool> voiceStarted { false };
        std::atomic<int>  voiceErrors  { 0 };
        String voiceErr;
        std::unique_ptr<NativeSpeech> speech;
        if (bargeIn)
        {
            section ("GAP 4 — barge-in (continuous speech sharing the mic with a live take)");
            check (NativeSpeech::isSupported(), "GAP4: macOS Speech available");
            speech = std::make_unique<NativeSpeech>();
            NativeSpeech::Callbacks cb;
            cb.onStart = [&voiceStarted] { voiceStarted.store (true); };
            cb.onError = [&voiceErrors, &voiceErr] (const String& e) { voiceErrors.fetch_add (1); voiceErr = e; };
            speech->startContinuous (std::move (cb));   // async: auth + AVAudioEngine on the message thread
        }

        // Longer window under barge-in so the async auth + engine-start + a few mic buffers
        // all land while the take is still recording.
        const auto recEnd = Time::getMillisecondCounter() + (uint32) (bargeIn ? 2500 : 1200);
        while (Time::getMillisecondCounter() < recEnd)
        {
            if (mm != nullptr) mm->runDispatchLoopUntil (50);
            else Thread::sleep (50);
        }

        if (bargeIn && speech != nullptr)
        {
            // The take is STILL recording here. Assert the recognizer opened its OWN input
            // client and actually pulled mic buffers CONCURRENTLY (the simultaneous-capture
            // proof — stronger than "the engine started"), then release it before the take is
            // stopped + checked for non-silence (which then proves the voice client didn't
            // starve/glitch the DAW capture).
            check (eng.edit().getTransport().isRecording(), "GAP4: DAW transport still recording while voice ran");
            if (voiceErrors.load() > 0) std::cerr << "  ..   GAP4 voice error: " << voiceErr << "\n";
            check (voiceErrors.load() == 0, "GAP4: continuous voice started without error (grant Speech permission if this fails)");
            check (voiceStarted.load(), "GAP4: AVAudioEngine started while the take recorded (two simultaneous input clients)");
            check (speech->isListening(), "GAP4: continuous recognizer listening during the take");
            std::cerr << "  ..   GAP4 diag: tapBuffers=" << speech->tapBufferCount() << "\n";
            check (speech->tapBufferCount() > 0, "GAP4: mic tap captured audio buffers concurrently with the take");
            speech->stopContinuous();
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

    // A "Gtr" track with a Tier-B generative RenderLayer on its clip.
    auto t = cmd ("create_track", obj ({{ "name", "Gtr" }}))["data"].getProperty ("trackId", var()).toString();
    auto tone = cmd ("add_test_tone_clip", obj ({{ "trackId", t }, { "seconds", 2.5 }, { "freq", 131.0 }}));
    auto cid = tone["data"].getProperty ("clipId", var()).toString();

    cmd ("create_render_layer", obj ({{ "clipId", cid }, { "adapter", "fake" }}));
    Array<var> colors; { auto* c = new DynamicObject(); c->setProperty ("name", "grit"); c->setProperty ("value", 62); colors.add (var (c)); }
    cmd ("set_render_param", obj ({{ "clipId", cid }, { "seed", 3 }, { "nl", 0.4 }, { "colors", colors }}));

    // A second track so the arrangement looks like a session.
    auto t2 = cmd ("create_track", obj ({{ "name", "Pad" }}))["data"].getProperty ("trackId", var()).toString();
    cmd ("add_test_tone_clip", obj ({{ "trackId", t2 }, { "seconds", 4.0 }, { "freq", 196.0 }}));
}

// ── Headless batch command runner (`Mosh --run-script`) ─────────────────────────
// Replays a JSONL command script through the one mutation path (MoshOps::execute)
// against an isolated headless session. The driver behind the offline render-to-WAV
// verification harness: a script ends with an export_audio command, and the harness
// then analyses the WAV the chain rendered. Pure replay of the public command
// surface — no privileged backdoor.
int runCommandScript (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    ignoreUnused (eng);

    const auto scriptPath = SystemStats::getEnvironmentVariable ("MOSH_RUN_SCRIPT", {}).trim();
    if (scriptPath.isEmpty())
    {
        std::cerr << "run-script: set MOSH_RUN_SCRIPT=<path to a JSONL command script>\n";
        return 2;
    }
    const File scriptFile (scriptPath);
    if (! scriptFile.existsAsFile())
    {
        std::cerr << "run-script: no such file: " << scriptPath.toStdString() << "\n";
        return 2;
    }

    const auto outPath = SystemStats::getEnvironmentVariable ("MOSH_RUN_SCRIPT_OUT", {}).trim();

    auto* mm = MessageManager::getInstanceWithoutCreating();
    auto pump = [mm] (int ms)
    {
        const auto end = Time::getMillisecondCounter() + (uint32) jmax (0, ms);
        while (Time::getMillisecondCounter() < end)
        {
            if (mm != nullptr) mm->runDispatchLoopUntil (50);
            else Thread::sleep (50);
        }
    };

    // Captured variables: a command may "capture":{"VAR":"dataField"} a field of its
    // result.data, and any later string arg of the exact form "${VAR}" is replaced with
    // the captured value. This keeps scripts self-contained and robust to engine-assigned
    // ids (trackId/clipId/index) without hard-coding them. Substitution RECURSES into
    // arrays and nested objects — commands like create_group_track {trackIds:["${T1}"]}
    // and delete_time_range {trackIds:[...]} take captured ids inside arrays, and the
    // old top-level-only pass left them as literal "${T1}" strings, silently no-op'ing
    // (found by the DAW-parity P3 families).
    HashMap<String, var> vars;
    std::function<var (const var&)> subst = [&vars, &subst] (const var& v) -> var
    {
        if (v.isString())
        {
            const auto s = v.toString();
            if (s.startsWith ("${") && s.endsWith ("}"))
            {
                const auto key = s.substring (2, s.length() - 1);
                if (vars.contains (key)) return vars[key];
            }
            return v;
        }
        if (v.isArray())
        {
            Array<var> out;
            for (const auto& e : *v.getArray())
                out.add (subst (e));
            return var (out);
        }
        if (auto* o = v.getDynamicObject())
        {
            auto* no = new DynamicObject();
            for (const auto& p : o->getProperties())
                no->setProperty (p.name, subst (p.value));
            return var (no);
        }
        return v;
    };

    StringArray outLines;
    const auto lines = StringArray::fromLines (scriptFile.loadFileAsString());
    int executed = 0, failures = 0;

    for (const auto& raw : lines)
    {
        const auto line = raw.trim();
        if (line.isEmpty() || line.startsWith ("#") || line.startsWith ("//"))
            continue;

        const auto command = JSON::parse (line);
        if (! command.isObject())
        {
            std::cerr << "run-script: not a JSON object, skipping: " << line.toStdString() << "\n";
            ++failures;
            continue;
        }

        const auto name = command.getProperty ("command", var()).toString();

        // __wait pseudo-command: pump the message loop so async work (a generative
        // render job, any callAsync) can progress between commands. Not a MoshOps
        // command — handled here, emits no result line.
        if (name == "__wait")
        {
            pump ((int) command.getProperty ("args", var()).getProperty ("ms", 1000));
            continue;
        }

        // __snapshot pseudo-command: emit the current session snapshot as a result line
        // (read-only — no mutation, no transaction, no JSONL log; mirrors get_command_log's
        // read-only posture). Lets the DAW-conformance harness assert expected_state / undo
        // without a privileged backdoor — it replays the SAME snapshot() the WebView sees.
        // An optional args.label rides through so the harness can correlate which step a
        // snapshot belongs to. Emits a result line, runs no MoshOps command.
        if (name == "__snapshot")
        {
            auto* so = new DynamicObject();
            so->setProperty ("command", "__snapshot");
            so->setProperty ("ok", true);
            if (auto lbl = command.getProperty ("args", var()).getProperty ("label", var()); ! lbl.isVoid())
                so->setProperty ("label", lbl);
            so->setProperty ("data", ops.snapshot());
            const auto snapLine = JSON::toString (var (so), true);
            outLines.add (snapLine);
            std::cout << snapLine.toStdString() << std::endl;
            continue;
        }

        // __bench_snapshot pseudo-command (D1): time ops.snapshot() (build + JSON marshal,
        // the per-edit cost the WebView pays on every snapshot_invalidated) over N iterations
        // and report avg ms + serialized bytes. A MEASUREMENT to decide whether snapshot()
        // needs scoped invalidation at scale — not itself a fix. Read-only.
        if (name == "__bench_snapshot")
        {
            const int iters = jmax (1, (int) command.getProperty ("args", var()).getProperty ("iterations", 20));
            const auto t0 = Time::getMillisecondCounterHiRes();
            int bytes = 0;
            for (int i = 0; i < iters; ++i)
                bytes = JSON::toString (ops.snapshot(), false).getNumBytesAsUTF8();
            const auto totalMs = Time::getMillisecondCounterHiRes() - t0;
            auto* d = new DynamicObject();
            d->setProperty ("iterations", iters);
            d->setProperty ("totalMs", totalMs);
            d->setProperty ("avgMs", totalMs / (double) iters);
            d->setProperty ("jsonBytes", bytes);
            auto* bo = new DynamicObject();
            bo->setProperty ("command", "__bench_snapshot");
            bo->setProperty ("ok", true);
            bo->setProperty ("data", var (d));
            const auto bl = JSON::toString (var (bo), true);
            outLines.add (bl);
            std::cout << bl.toStdString() << std::endl;
            continue;
        }

        // __crash pseudo-command (A3 test): simulate an UNCLEAN exit — set the session-running
        // sentinel and STOP without saving. A subsequent MOSH_RUNSCRIPT_KEEP_SESSION run then
        // detects the crash + replays the recovery-journal tail (recover_session). Runs no
        // MoshOps command; ends the script here (the "crash").
        if (name == "__crash")
        {
            eng.markSessionRunning();
            std::cout << "{\"command\":\"__crash\",\"ok\":true}" << std::endl;
            break;
        }

        // Substitute ${VAR} references in the (top-level) args before executing.
        var argsOut = command.getProperty ("args", var());
        if (auto* ao = argsOut.getDynamicObject())
        {
            auto* na = new DynamicObject();
            for (const auto& p : ao->getProperties())
                na->setProperty (p.name, subst (p.value));
            argsOut = var (na);
        }
        auto* co = new DynamicObject();
        co->setProperty ("command", name);
        co->setProperty ("args", argsOut);

        const auto result = ops.execute (var (co));
        ++executed;
        if (! (bool) result.getProperty ("ok", false))
            ++failures;

        // Capture requested result.data fields into the variable map.
        if (const auto capV = command.getProperty ("capture", var()); capV.isObject())
        {
            const auto data = result.getProperty ("data", var());
            if (auto* cap = capV.getDynamicObject())
                for (const auto& p : cap->getProperties())
                    vars.set (p.name.toString(), data.getProperty (Identifier (p.value.toString()), var()));
        }

        const auto resultLine = JSON::toString (result, true);
        outLines.add (resultLine);
        std::cout << resultLine.toStdString() << std::endl;
    }

    if (outPath.isNotEmpty())
        File (outPath).replaceWithText (outLines.joinIntoString ("\n") + "\n");

    std::cerr << "run-script: " << executed << " command(s), " << failures << " failure(s)\n";
    return failures;
}

// ── Voice STT smoke (`Mosh --voice-smoke`) ──────────────────────────────────────
// Synthesizes a known phrase with macOS `say`, transcribes it through the SAME
// SFSpeechRecognizer the app uses, and asserts the transcript — proving speech-to-text
// end-to-end with nobody speaking. FILE mode (default) reads a `say`-rendered file (no
// mic; needs only a Speech grant). MIC mode (MOSH_VOICE_SMOKE_MIC=1) drives the live
// mic recognizer while `say` plays into the default input — set that input to BlackHole
// for a reliable digital loopback. Returns 0 on a matching transcript.
int runVoiceSmoke (MoshEngine& eng, MoshOps& ops)
{
    using namespace juce;
    ignoreUnused (eng, ops);

    const auto phrase   = SystemStats::getEnvironmentVariable ("MOSH_VOICE_SMOKE_PHRASE", "create a drum track");
    const bool micMode  = SystemStats::getEnvironmentVariable ("MOSH_VOICE_SMOKE_MIC", "0") == "1";
    const int  timeoutMs = jmax (4000, SystemStats::getEnvironmentVariable ("MOSH_VOICE_SMOKE_TIMEOUT_MS", "25000").getIntValue());

    // Also write the verdict to a fixed file. TCC attributes a shell-launched binary to
    // the terminal (not the granted Mosh.app), so the smoke must be `open`-launched to
    // see the Speech/Mic grant — and an `open` run can't return its stderr, so the
    // driver reads this file instead.
    auto resultFile = File::getSpecialLocation (File::userHomeDirectory)
                          .getChildFile ("Library/Mosh/voice-smoke-result.txt");
    resultFile.getParentDirectory().createDirectory();
    resultFile.deleteFile();
    auto finish = [&resultFile] (int rc, const String& summary)
    {
        resultFile.replaceWithText (String (rc) + "\t" + summary + "\n");
        std::cerr << "  [result] rc=" << rc << "  " << summary.toStdString() << "\n";
        return rc;
    };

    std::cerr << "===== Mosh voice smoke (" << (micMode ? "MIC / loopback" : "FILE") << ") =====\n";
    std::cerr << "  phrase: \"" << phrase.toStdString() << "\"\n";

    if (! NativeSpeech::isSupported())
    {
        std::cerr << "  FAIL: native speech-to-text is unsupported here\n";
        return finish (1, "native speech-to-text unsupported");
    }

    // Gate on the SYNCHRONOUS auth status. A headless process can't raise the system
    // Speech/Mic prompt (those need a GUI app context), and entering the async
    // recognition path unauthorized risks a teardown-time crash — so skip cleanly.
    const int auth = NativeSpeech::authorizationStatus();
    if (auth != 3)   // 3 = authorized
    {
        const char* why = auth == 0 ? "not yet granted (notDetermined)"
                        : auth == 1 ? "denied"
                        : auth == 2 ? "restricted"
                                    : "unavailable";
        std::cerr << "  SKIP: Speech Recognition is " << why << " (status " << auth << ").\n"
                     "  Grant it ONCE via the GUI — launch the app, use voice (the 👂 cap / hold-to-talk),\n"
                     "  approve the Speech" << (micMode ? " + Microphone" : "") << " prompt — then re-run this. A headless\n"
                     "  run can't surface the system prompt. Returning 2 (skipped, not a failure).\n";
        return finish (2, "skip: speech auth status " + String (auth));
    }
    std::cerr << "  Speech Recognition authorized ✓\n";

    auto* mm = MessageManager::getInstanceWithoutCreating();
    auto pump = [mm] (int ms)
    {
        const auto end = Time::getMillisecondCounter() + (uint32) jmax (0, ms);
        while (Time::getMillisecondCounter() < end) { if (mm != nullptr) mm->runDispatchLoopUntil (50); else Thread::sleep (50); }
    };

    // Lowercase + non-alphanumerics → spaces, so word matching ignores punctuation/case.
    auto norm = [] (const String& s)
    {
        const auto low = s.toLowerCase();
        String out;
        for (int i = 0; i < low.length(); ++i)
            out += (CharacterFunctions::isLetterOrDigit (low[i]) ? String::charToString (low[i]) : String (" "));
        return out;
    };

    NativeSpeech speech;
    String transcript, error;
    std::atomic<bool> finished { false }, gotFinal { false };
    NativeSpeech::Callbacks cb;
    cb.onStart = []                       { std::cerr << "  recognizer started…\n"; };
    cb.onFinal = [&] (const String& t)    { transcript = t; gotFinal = true; };
    cb.onError = [&] (const String& e)    { error = e; };
    cb.onStop  = [&]                      { finished = true; };

    if (! micMode)
    {
        auto aiff = selftestTempPath (eng, "voice-smoke.aiff");
        aiff.deleteFile();
        ChildProcess say;
        say.start (StringArray { "say", "-o", aiff.getFullPathName(), phrase });
        say.waitForProcessToFinish (15000);
        if (! aiff.existsAsFile() || aiff.getSize() == 0)
        {
            std::cerr << "  FAIL: `say` produced no audio at " << aiff.getFullPathName().toStdString() << "\n";
            return finish (1, "say produced no audio");
        }
        std::cerr << "  synthesized " << aiff.getSize() << " bytes via `say`, transcribing…\n";
        speech.transcribeFile (aiff.getFullPathName(), cb);
    }
    else
    {
        std::cerr << "  (MIC mode: set the default input to BlackHole 2ch and route `say` there for a clean loopback)\n";
        speech.startContinuous (cb);
        pump (2000);   // let auth + the AVAudioEngine come up before speaking
        ChildProcess say;
        say.start (StringArray { "say", phrase });
        say.waitForProcessToFinish (15000);
    }

    const auto deadline = Time::getMillisecondCounter() + (uint32) timeoutMs;
    while (! gotFinal && ! finished && Time::getMillisecondCounter() < deadline) pump (100);
    pump (200);
    if (micMode) speech.stopContinuous();

    if (! gotFinal)
    {
        if (error.isNotEmpty())
        {
            std::cerr << "  FAIL: " << error.toStdString() << "\n";
            if (error.containsIgnoreCase ("not authorized"))
                std::cerr << "  → Speech Recognition is not granted yet. Approve it once (the prompt, or System\n"
                             "    Settings › Privacy & Security › Speech Recognition) and re-run.\n";
        }
        else
            std::cerr << "  FAIL: no transcript within " << timeoutMs << "ms\n";
        return finish (1, error.isNotEmpty() ? ("error: " + error) : "no transcript within timeout");
    }

    std::cerr << "  transcript: \"" << transcript.toStdString() << "\"\n";

    const auto nt = " " + norm (transcript) + " ";
    auto words = StringArray::fromTokens (norm (phrase), " ", "");
    words.removeEmptyStrings();
    int hits = 0;
    for (const auto& w : words) if (nt.containsIgnoreCase (" " + w + " ")) ++hits;
    const bool pass = words.size() > 0 && hits >= jmax (1, (words.size() * 2) / 3);   // ≥ 2/3 of the words
    std::cerr << "  matched " << hits << "/" << words.size() << " phrase words → " << (pass ? "PASS" : "FAIL") << "\n";
    return finish (pass ? 0 : 1, "transcript=\"" + transcript + "\"; matched " + String (hits) + "/" + String (words.size()) + " words");
}

} // namespace mosh
