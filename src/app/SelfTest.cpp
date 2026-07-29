#include "SelfTest.h"
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

    void section (const char* name)
    {
        section (juce::String (juce::CharPointer_UTF8 (name)));
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

    void check (bool cond, const char* what)
    {
        check (cond, juce::String (juce::CharPointer_UTF8 (what)));
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

    // ── FS-B2a helpers: the agent batch-TRANSACTION envelope ─────────────────────
    // Transaction metadata rides BESIDE the handler's args (never mixed into them), which
    // is the shape docs/first-stranger-program/lanes/fs-b2.md specifies and the shape the
    // WebView sends (WebBridge passes args[0] whole, so the sibling field survives).
    juce::var txnCmd (MoshOps& ops, const juce::String& name, juce::var args,
                      const juce::String& txnId, const juce::String& requestId, int index)
    {
        auto* t = new juce::DynamicObject();
        t->setProperty ("transactionId", txnId);
        t->setProperty ("requestId", requestId);
        t->setProperty ("index", index);

        auto* c = new juce::DynamicObject();
        c->setProperty ("command", name);
        if (! args.isVoid()) c->setProperty ("args", args);
        c->setProperty ("transaction", juce::var (t));
        return ops.execute (juce::var (c));
    }

    /** A manifest from (requestId, command) pairs, indexed from 0 in order. */
    juce::var txnManifest (std::initializer_list<std::pair<const char*, const char*>> steps)
    {
        juce::Array<juce::var> a;
        int i = 0;
        for (auto& s : steps)
            a.add (objN ({ { "index", i++ }, { "requestId", s.first }, { "command", s.second } }));
        return juce::var (a);
    }

    juce::var txnBegin (MoshOps& ops, const juce::String& txnId, const juce::String& name,
                        juce::var manifest)
    {
        return cmd (ops, "batch_begin", objN ({ { "transactionId", txnId },
                                               { "name", name },
                                               { "commands", manifest } }));
    }

    juce::var txnStatus (MoshOps& ops, const juce::String& txnId)
    {
        return cmd (ops, "batch_status", objN ({ { "transactionId", txnId } }));
    }

    /** A status field out of a batch_status / batch_begin / batch_end result. */
    juce::String txnField (const juce::var& result, const char* field)
    {
        return result.getProperty ("data", juce::var()).getProperty (field, juce::var()).toString();
    }

    /** Read the durable ledger the way the NEXT process will: whatever it says is
        unresolved is what would block skills after a restart. Uses the same pure helper
        MoshOps::initTxnLedger does, so there is no second implementation to drift. */
    juce::StringArray unresolvedIdsInLedger (const juce::File& ledger)
    {
        if (! ledger.existsAsFile()) return {};
        return mosh::agenttxn::unresolvedIdsIn (
            juce::StringArray::fromLines (ledger.loadFileAsString()));
    }

    // A fixed filename in the shared, machine-wide system temp dir collides when two
    // `Mosh --selftest` processes run at once on the same host (a self-hosted CI runner
    // racing a dev's local run, or two concurrent worktree gates): one process's
    // deleteFile()/write races the other's read and false-fails a check that has nothing
    // to do with the code under test. The per-run session dir (isolated via
    // MOSH_SELFTEST_SESSION) is the existing hermeticity boundary, but File::tempDirectory
    // paths escape it. Scope every temp artifact to THIS process — same root-cause class as
    // PR #342's hermetic service ports, for a temp-file path instead of a network port.
    juce::File selftestTempPath (const MoshEngine& eng, const juce::String& leafName)
    {
        // Computed once per process: the isolated session leaf (already unique under the
        // documented MOSH_SELFTEST_SESSION isolation) + a Uuid fragment (unique even when
        // that env override is absent — e.g. a plain `--selftest` racing on both sides).
        static const juce::String tag = eng.sessionDir().getFileName()
                                            + "-" + juce::Uuid().toString().substring (0, 8);
        return juce::File::getSpecialLocation (juce::File::tempDirectory)
                   .getChildFile ("mosh-selftest-" + tag + "-" + leafName);
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

    juce::var trackSnapshotByLogicalId (MoshOps& ops, const juce::String& logicalId)
    {
        auto snapshot = ops.snapshot();
        if (auto* arr = snapshot.getProperty ("tracks", juce::var()).getArray())
            for (auto& track : *arr)
                if (track.getProperty ("logicalId", juce::var()).toString() == logicalId)
                    return track;
        return {};
    }

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
    // Pin the FAKE transform adapter for the deterministic selftest, regardless of whether
    // real RAVE models happen to be installed in RAVE_MODEL_DIR on this machine (the
    // spawned generative service inherits this env). The "Route B: transform (fake)"
    // section asserts the deterministic fake adapter; without this it would hit the real
    // RAVE backend if models are present and break. Mirrors how SA3 stays fake here. The
    // real transform path is covered separately by scripts/verify-hardware/verify.py --rave.
    mosh::setEnvVar ("MOSH_ENABLE_TRANSFORM", "0");
    // Same pin for the FMS sing adapter: a machine with MOSH_SOULX_SSH_HOST + an enrolled
    // voice configured must still run the deterministic fake legato-beep backend here.
    mosh::setEnvVar ("MOSH_ENABLE_SOULX", "0");
    // LoRA rack double lock: the fake path never consults the registry (names key the
    // fingerprint directly), but pin the kill switch AND an empty library dir anyway so
    // the user's real ~/Library/Mosh/loras can never leak into a hermetic run.
    mosh::setEnvVar ("MOSH_ENABLE_LORAS", "0");
    {
        auto emptyLoraDir = selftestTempPath (eng, "loras-empty");
        emptyLoraDir.createDirectory();
        mosh::setEnvVar ("MOSH_LORA_DIR", emptyLoraDir.getFullPathName().toRawUTF8());
    }
    if (SystemStats::getEnvironmentVariable ("MOSH_SELFTEST_SA3", "0") != "1")
        mosh::setEnvVar ("MOSH_ENABLE_SA3", "0");
    // AGT-MEM (Phase-B memory lane, M1) — pin the global agent-memory store INSIDE this
    // run's already-isolated session dir (SLF-CONC-001) so a plain `--selftest` never
    // touches the owner's real ~/Library/Mosh/agent, and two concurrent runs on this
    // host can't collide on the same JSONL files.
    mosh::setEnvVar ("MOSH_AGENT_DIR", eng.sessionDir().getChildFile ("agent").getFullPathName().toRawUTF8());
    std::cerr << "\n===== Mosh Stage 1 command-surface harness =====\n";
    // The session dir is now per-process by default, so name it: this run's exports,
    // saved edit and mosh-log.jsonl live HERE, not in a shared fixed path.
    std::cerr << "session dir: " << eng.sessionDir().getFullPathName() << "\n";
    section ("Stage 1: command surface / cold snapshot");

    // Capture emitted events (type history + the latest full event, so a scoped-invalidation
    // check can inspect the payload).
    std::vector<String> eventTypes;
    var lastEvent;
    ops.setEventSink ([&] (const var& e) { eventTypes.push_back (e.getProperty ("type", var()).toString()); lastEvent = e; });

    auto hadEvent = [&] (const String& t) {
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

    // Lane B — RAVE model browser (non-gated fs scan; works in the default light build). Assert the
    // SHAPE (ok + a models array + an available flag), not the count — the model dir is machine-
    // dependent, so a clean CI box with no ~/AI/rave-models returns {models:[], available:false}.
    {
        auto lr = cmd (ops, "list_rave_models");
        check (ok (lr), "list_rave_models ok (fs scan, non-gated)");
        check (lr["data"].getProperty ("models", var()).isArray(), "list_rave_models returns a models array");
        check (lr["data"].hasProperty ("available"), "list_rave_models reports an available flag");
    }

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
        //
        // FIT-003 regression-lock: the sync (VST3-only) path must emit ZERO
        // 'plugin_scan_progress' events. That event (now enriched with a live
        // running count + elapsedMs from timerCallback()'s sampler) is reserved for
        // the async AU/deep sweep -- proves enriching it didn't leak sampler state
        // into the inline, message-thread-safe VST3 path.
        auto countScanEvents = [&] {
            int n = 0; for (auto& e : eventTypes) if (e == "plugin_scan_progress") ++n; return n; };
        const int scanEventsBefore = countScanEvents();
        auto rs = cmd (ops, "rescan_plugins", objN ({{ "format", "vst3" }, { "wait", true }}));
        check (ok (rs), "rescan_plugins (vst3) ok");
        check ((int) rs["data"].getProperty ("count", -1) >= total, "rescan_plugins reports a count (>= prior total)");
        check (countScanEvents() == scanEventsBefore,
               "sync VST3 rescan emits no plugin_scan_progress events (FIT-003)");

        // AUD-SCAN — an explicit AU request without the opt-in must FAIL LOUDLY. It used
        // to fall through to the VST3-only branch and answer status:"done" with a count,
        // so a caller that asked for AudioUnits was told the scan had run. That silent
        // success is how "the shipped app can never see an AU" stayed invisible: the env
        // var MOSH_SCAN_AU was the only way in, and it is set in exactly one place in the
        // tree (Main.cpp, for --scan-plugins-deep).
        //
        // Hermetic: this errors BEFORE any scanning, so no AU sweep runs here. The
        // harness never passes allowAU and never requests format:"all", so --selftest
        // still performs no AudioUnit scan of any kind.
        auto auDenied = cmd (ops, "rescan_plugins", objN ({{ "format", "au" }}));
        check (! ok (auDenied), "rescan_plugins(au) without allowAU is refused, not a silent success");
        check (auDenied.getProperty ("error", var()).toString().containsIgnoreCase ("audio unit"),
               "the AU refusal explains itself");
        check (countScanEvents() == scanEventsBefore,
               "a refused AU rescan starts no scan (no progress events)");

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
            // FIT-003: block_plugin is a MANUAL block, so its reason must read "manual"
            // (not "crash_or_hang" -- that tag is reserved for dead-mans-pedal recovery).
            bool inBlock = false;
            juce::String blockedReason;
            { auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
              if (auto* arr = bl.getArray())
                for (auto& e : *arr)
                    if (e.getProperty ("id",    var()).toString() == blockTarget ||
                        e.getProperty ("rawId", var()).toString() == blockTarget)
                        { inBlock = true; blockedReason = e.getProperty ("reason", var()).toString(); } }
            check (inBlock, "blocked id appears in get_plugin_blocklist");
            check (blockedReason == "manual", "manual block_plugin is tagged reason:\"manual\"");

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

        // FIT-003 — dead-mans-pedal crash/hang recovery tags the RIGHT reason.
        // A real in-session AU hang can't be simulated headlessly (JUCE marshals AU
        // instantiation to the message thread with no per-component timeout -- see
        // PluginHost.cpp's HONEST CAVEAT), but the recovery-and-tag bookkeeping IS
        // exactly what a real hang's *next launch* runs, and that part is fully
        // exercisable: debugSimulateCrashRecovery writes the pedal file and replays
        // the identical PluginHost::recoverFromDeadMansPedal() path initialise() runs
        // at real startup.
        {
            auto& ph = ops.pluginHostForScan();
            const String crasherId = "AudioUnit:Effect/aufx,fitkillsim,MOSH";
            ph.debugSimulateCrashRecovery (crasherId);

            auto bl = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
            bool found = false; String reason;
            if (auto* arr = bl.getArray())
                for (auto& e : *arr)
                    if (e.getProperty ("rawId", var()).toString() == crasherId)
                        { found = true; reason = e.getProperty ("reason", var()).toString(); }
            check (found, "dead-mans-pedal recovery quarantines the crasher id");
            check (reason == "crash_or_hang",
                   "dead-mans-pedal recovery is tagged reason:\"crash_or_hang\" (not \"manual\")");

            // Clean up: never leave a synthetic id in the shared, machine-wide catalog.
            check (ok (cmd (ops, "clear_plugin_blocklist")), "clear_plugin_blocklist ok (crash-recovery cleanup)");
            auto bl2 = cmd (ops, "get_plugin_blocklist")["data"].getProperty ("blocklist", var());
            check (bl2.isArray() && bl2.size() == 0, "blocklist empty after crash-recovery cleanup");
        }
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

        // G2b — count-in / pre-roll bars (smoke; full coverage in its own section below).
        cmd (ops, "set_count_in", args1 ("bars", 1));
        check ((int) sess().getProperty ("countInBars", -1) == 1, "countInBars reflects set_count_in in the Wave 2 smoke");
        cmd (ops, "set_count_in", args1 ("bars", 0));   // restore default for the rest of Wave 2

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

        // G14 — set_track_volume / pan (+ master) route through the UndoManager so undo
        // restores the prior value (previously vp->setVolumeDb() bypassed it -> empty txn).
        {
            // Track volume: set -6 dB, undo restores 0 dB, redo re-applies -6 dB.
            const double trackVolBefore = (double) trackById (tid).getProperty ("volumeDb", 999.0);
            check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", tid }, { "db", -6.0 }}))), "G14: set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: track volume applies (-6 dB)");
            check (ok (cmd (ops, "undo")), "G14: undo set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - trackVolBefore) < 0.5, "G14: undo restores prior track volume");
            check (ok (cmd (ops, "redo")), "G14: redo set_track_volume ok");
            check (std::abs ((double) trackById (tid).getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: redo re-applies track volume (-6 dB)");
            cmd (ops, "undo");   // leave the track fader where Wave 5 found it

            // Track pan: undo restores the prior pan (0.4 set just above).
            check (ok (cmd (ops, "set_track_pan", objN ({{ "trackId", tid }, { "pan", -0.7 }}))), "G14: set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - (-0.7)) < 0.02, "G14: track pan applies (-0.7)");
            check (ok (cmd (ops, "undo")), "G14: undo set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - 0.4) < 0.02, "G14: undo restores prior track pan (0.4)");
            check (ok (cmd (ops, "redo")), "G14: redo set_track_pan ok");
            check (std::abs ((double) trackById (tid).getProperty ("pan", 999.0) - (-0.7)) < 0.02, "G14: redo re-applies track pan (-0.7)");

            // Master volume: undo restores the prior master gain (-6 dB set above).
            check (ok (cmd (ops, "set_master_volume", args1 ("db", -12.0))), "G14: set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-12.0)) < 0.5, "G14: master volume applies (-12 dB)");
            check (ok (cmd (ops, "undo")), "G14: undo set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-6.0)) < 0.5, "G14: undo restores prior master volume (-6 dB)");
            check (ok (cmd (ops, "redo")), "G14: redo set_master_volume ok");
            check (std::abs ((double) master().getProperty ("volumeDb", 999.0) - (-12.0)) < 0.5, "G14: redo re-applies master volume (-12 dB)");

            // Master pan: undo restores the prior master pan (-0.5 set above).
            check (ok (cmd (ops, "set_master_pan", args1 ("pan", 0.3))), "G14: set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - 0.3) < 0.02, "G14: master pan applies (0.3)");
            check (ok (cmd (ops, "undo")), "G14: undo set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - (-0.5)) < 0.02, "G14: undo restores prior master pan (-0.5)");
            check (ok (cmd (ops, "redo")), "G14: redo set_master_pan ok");
            check (std::abs ((double) master().getProperty ("pan", 999.0) - 0.3) < 0.02, "G14: redo re-applies master pan (0.3)");
        }

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
        // G4A — rename_clip is undoable (was uncovered): undo restores the prior name, redo re-applies.
        check (ok (cmd (ops, "undo")), "undo rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() != "Renamed", "undo restores clip's prior name");
        check (ok (cmd (ops, "redo")), "redo rename_clip ok");
        check (clipById (cid).getProperty ("name", var()).toString() == "Renamed", "redo re-applies clip rename");

        check (ok (cmd (ops, "set_clip_mute", objN ({{ "clipId", cid }, { "mute", true }}))), "set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "clip mute reflects in snapshot");
        // mute is undoable (was uncovered): undo unmutes, redo re-mutes.
        check (ok (cmd (ops, "undo")), "undo set_clip_mute ok");
        check (! (bool) clipById (cid).getProperty ("mute", true), "undo restores clip unmuted");
        check (ok (cmd (ops, "redo")), "redo set_clip_mute ok");
        check ((bool) clipById (cid).getProperty ("mute", false), "redo re-applies clip mute");

        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}))), "set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 6.0) < 0.5, "clip gain reflects in snapshot");
        // gain clamps below quality-collapse (jlimit -48..+24) and is undoable — both uncovered.
        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 999.0 }}))), "set_clip_gain (over-max) ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "clip gain clamps to +24 dB");
        check (ok (cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", -999.0 }}))), "set_clip_gain (under-min) ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - (-48.0)) < 0.5, "clip gain clamps to -48 dB");
        check (ok (cmd (ops, "undo")), "undo set_clip_gain ok");
        check (std::abs ((double) clipById (cid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "undo restores prior clip gain (+24)");
        cmd (ops, "set_clip_gain", objN ({{ "clipId", cid }, { "gainDb", 6.0 }}));   // sane default for downstream

        // G4b — clip fades (fade-in / fade-out, + optional curve type). Audio-clip-only,
        // undoable, JSONL-logged undoable:true, snapshot-invalidating. Fades render NATIVELY
        // through Tracktion's AudioClipBase — no src/state schema change (free persistence
        // + undo, proven below).
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", -1.0) - 0.0) < 0.02
               && std::abs ((double) clipById (cid).getProperty ("fadeOutSec", -1.0) - 0.0) < 0.02,
               "clip fades default to 0/0");
        check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "fadeInSec", 0.5 }, { "fadeOutSec", 0.25 }}))),
               "set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "clip fadeInSec reflects in snapshot");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "clip fadeOutSec reflects in snapshot");

        // Undo/redo — the plain CachedValue.referTo(state, id, um) path (same mechanism as
        // clip gain), so this is undoable exactly like every other clip command.
        check (ok (cmd (ops, "undo")), "undo set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", -1.0) - 0.0) < 0.02, "undo restores clip fadeInSec to 0");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", -1.0) - 0.0) < 0.02, "undo restores clip fadeOutSec to 0");
        check (ok (cmd (ops, "redo")), "redo set_clip_fade ok");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "redo re-applies clip fadeInSec");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "redo re-applies clip fadeOutSec");

        // Clamp / no-boundary-move (reality-pack inv 30): an over-length fade-in clamps to
        // the clip's own length and NEVER moves the clip's start/length — the fade shapes
        // the edge, it never relocates it.
        {
            const double startBefore  = (double) clipById (cid).getProperty ("start", -1.0);
            const double lengthBefore = (double) clipById (cid).getProperty ("length", -1.0);
            check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "fadeInSec", 5.0 }}))),
                   "set_clip_fade (over-length fadeIn) ok");
            check ((double) clipById (cid).getProperty ("fadeInSec", 0.0) <= lengthBefore + 0.02,
                   "clip fadeInSec clamps to <= clip length");
            check (std::abs ((double) clipById (cid).getProperty ("start", -1.0) - startBefore) < 0.001
                   && std::abs ((double) clipById (cid).getProperty ("length", -1.0) - lengthBefore) < 0.001,
                   "fade does not move clip start/length (inv 30)");
            check (ok (cmd (ops, "undo")), "undo over-length fadeIn ok");   // restore 0.5/0.25 for downstream
        }

        // Type rejection: fades are audio-clip-only (mirrors set_clip_gain).
        {
            auto midiFade = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}));
            const auto midiFadeCid = midiFade["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", midiFadeCid }, { "fadeInSec", 0.2 }}))),
                   "set_clip_fade on a MIDI clip rejected");
            cmd (ops, "remove_clip", args1 ("clipId", midiFadeCid));   // tidy
        }

        // Save/reload persistence — proves the free-persistence claim: fades ride
        // Tracktion's own ValueTree, no src/state code at all.
        cmd (ops, "save"); cmd (ops, "reload");
        check (std::abs ((double) clipById (cid).getProperty ("fadeInSec", 0.0) - 0.5) < 0.02, "clip fadeInSec persists across save/reload");
        check (std::abs ((double) clipById (cid).getProperty ("fadeOutSec", 0.0) - 0.25) < 0.02, "clip fadeOutSec persists across save/reload");

        // JSONL: set_clip_fade logged undoable:true (mirror the warp assert).
        {
            auto flog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool fadeU = false;
            for (auto& ln : StringArray::fromLines (flog))
                if (ln.contains ("\"command\": \"set_clip_fade\"") && ln.contains ("\"undoable\": true")) fadeU = true;
            check (fadeU, "set_clip_fade logged undoable:true");
        }

        // Curve types (optional args): curveIn/curveOut map to AudioFadeCurve::Type
        // (1=linear 2=convex 3=concave 4=sCurve), surfaced on the snapshot as
        // fadeInType/fadeOutType next to the durations.
        check ((int) clipById (cid).getProperty ("fadeInType", 0) == 1
               && (int) clipById (cid).getProperty ("fadeOutType", 0) == 1,
               "clip fade curve types default to linear (1)");
        check (ok (cmd (ops, "set_clip_fade", objN ({{ "clipId", cid }, { "curveIn", "convex" }, { "curveOut", "sCurve" }}))),
               "set_clip_fade (curve) ok");
        check ((int) clipById (cid).getProperty ("fadeInType", 0) == 2, "clip fadeInType reflects curveIn=convex");
        check ((int) clipById (cid).getProperty ("fadeOutType", 0) == 4, "clip fadeOutType reflects curveOut=sCurve");

        // clip-ops wave — reverse / auto-crossfade. Mirrors the fade tests above exactly:
        // audio-clip-only, undoable via the same CachedValue.referTo path, free
        // persistence (no src/state schema change).
        check (! (bool) clipById (cid).getProperty ("reversed", true), "clip reversed defaults to false");
        check (ok (cmd (ops, "set_clip_reverse", objN ({{ "clipId", cid }, { "reversed", true }}))), "set_clip_reverse ok");
        check ((bool) clipById (cid).getProperty ("reversed", false), "clip reversed reflects in snapshot");
        check (ok (cmd (ops, "undo")), "undo set_clip_reverse ok");
        check (! (bool) clipById (cid).getProperty ("reversed", true), "undo restores clip un-reversed");
        check (ok (cmd (ops, "redo")), "redo set_clip_reverse ok");
        check ((bool) clipById (cid).getProperty ("reversed", false), "redo re-applies clip reverse");

        check (! (bool) clipById (cid).getProperty ("autoCrossfade", true), "clip autoCrossfade defaults to false");
        check (ok (cmd (ops, "set_clip_crossfade", objN ({{ "clipId", cid }, { "enabled", true }}))), "set_clip_crossfade ok");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "clip autoCrossfade reflects in snapshot (round-trips)");
        check (ok (cmd (ops, "undo")), "undo set_clip_crossfade ok");
        check (! (bool) clipById (cid).getProperty ("autoCrossfade", true), "undo restores clip autoCrossfade off");
        check (ok (cmd (ops, "redo")), "redo set_clip_crossfade ok");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "redo re-applies clip autoCrossfade");

        // Save/reload persistence — both ride Tracktion's own ValueTree (isReversed /
        // autoCrossfade CachedValues), no src/state code at all, mirrors the fade proof.
        cmd (ops, "save"); cmd (ops, "reload");
        check ((bool) clipById (cid).getProperty ("reversed", false), "clip reversed persists across save/reload");
        check ((bool) clipById (cid).getProperty ("autoCrossfade", false), "clip autoCrossfade persists across save/reload");

        // Type rejection: both are audio-clip-only (mirrors set_clip_gain/set_clip_fade).
        {
            auto midiRev = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}));
            const auto midiRevCid = midiRev["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "set_clip_reverse", objN ({{ "clipId", midiRevCid }, { "reversed", true }}))),
                   "set_clip_reverse on a MIDI clip rejected");
            check (! ok (cmd (ops, "set_clip_crossfade", objN ({{ "clipId", midiRevCid }, { "enabled", true }}))),
                   "set_clip_crossfade on a MIDI clip rejected");
            cmd (ops, "remove_clip", args1 ("clipId", midiRevCid));   // tidy
        }

        // JSONL: both logged undoable:true (mirrors the fade assert).
        {
            auto rlog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool revU = false, xfU = false;
            for (auto& ln : StringArray::fromLines (rlog))
            {
                if (ln.contains ("\"command\": \"set_clip_reverse\"")   && ln.contains ("\"undoable\": true")) revU = true;
                if (ln.contains ("\"command\": \"set_clip_crossfade\"") && ln.contains ("\"undoable\": true")) xfU = true;
            }
            check (revU, "set_clip_reverse logged undoable:true");
            check (xfU, "set_clip_crossfade logged undoable:true");
        }

        // Leave both off for downstream (the undo/redo pairs above left them ON).
        cmd (ops, "set_clip_reverse",   objN ({{ "clipId", cid }, { "reversed", false }}));
        cmd (ops, "set_clip_crossfade", objN ({{ "clipId", cid }, { "enabled",  false }}));

        // clip-ops wave — normalize_clip: non-destructive gain-to-peak. A fresh tone
        // clip (generateTestTone writes 0.25 peak amplitude) has a known source peak of
        // ~-12.04 dBFS (20*log10(0.25)); normalizing to the default target (0 dB) should
        // move the clip's gain to ~+12.04 dB — proving the gain moves toward the target
        // from a known peak, exactly as the task asks.
        {
            auto nCid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 0.3 }, { "freq", 440.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (nCid.isNotEmpty(), "tone clip created for normalize_clip");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 999.0) - 0.0) < 0.5, "fresh tone clip starts at ~0 dB gain");

            auto nres = cmd (ops, "normalize_clip", args1 ("clipId", nCid));
            check (ok (nres), "normalize_clip ok");
            check (std::abs ((double) nres["data"].getProperty ("peakDb", 0.0) - (-12.04)) < 0.5,
                   "normalize_clip measures the tone's known ~-12 dB peak");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 12.04) < 0.5,
                   "normalize_clip (default target 0 dB) moves gain toward +12 dB");

            // Undo restores the prior gain; redo re-applies (same CachedValue path as set_clip_gain).
            check (ok (cmd (ops, "undo")), "undo normalize_clip ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 999.0) - 0.0) < 0.5, "undo restores prior clip gain (~0 dB)");
            check (ok (cmd (ops, "redo")), "redo normalize_clip ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 12.04) < 0.5, "redo re-applies normalize_clip gain");

            // Explicit targetDb: normalizing to -6 dB should land gain around -6-(-12.04) = +6.04 dB.
            auto nres2 = cmd (ops, "normalize_clip", objN ({{ "clipId", nCid }, { "targetDb", -6.0 }}));
            check (ok (nres2), "normalize_clip (targetDb -6) ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 6.04) < 0.5,
                   "normalize_clip moves gain toward the requested target, not just 0 dB");

            // Clamp: an extreme target clamps to the same +24 dB ceiling as set_clip_gain.
            auto nres3 = cmd (ops, "normalize_clip", objN ({{ "clipId", nCid }, { "targetDb", 200.0 }}));
            check (ok (nres3), "normalize_clip (extreme target) ok");
            check (std::abs ((double) clipById (nCid).getProperty ("gainDb", 0.0) - 24.0) < 0.5, "normalize_clip clamps gain to +24 dB");

            // Silent clip (freq 0 -> an all-zero tone): a clear error, not a silent no-op or crash.
            auto silentCid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", et }, { "seconds", 0.2 }, { "freq", 0.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", silentCid))), "normalize_clip on a silent clip errors gracefully");

            // Type rejection: MIDI clips have no source audio to scan.
            auto midiNormCid = cmd (ops, "add_midi_clip", objN ({{ "trackId", et }, { "length", 1.0 }}))["data"].getProperty ("clipId", var()).toString();
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", midiNormCid))), "normalize_clip on a MIDI clip rejected");

            cmd (ops, "remove_clip", args1 ("clipId", nCid));
            cmd (ops, "remove_clip", args1 ("clipId", silentCid));
            cmd (ops, "remove_clip", args1 ("clipId", midiNormCid));
        }

        // normalize_clip: AUDIBLE-SPAN correctness (clipAudibleSourceSpan), not the
        // whole source file. A clip trimmed to a quiet segment of a longer take must
        // normalize against the peak that actually PLAYS, not a transient elsewhere in
        // the take that never sounds. Source WAV layout (2.5s @44.1kHz, 440Hz sine):
        // [0.0,0.5) LOUD (peak 0.9, ~-0.92 dBFS), [0.5,1.0) EXACT SILENCE,
        // [1.0,2.5) QUIET (peak 0.1, ~-20 dBFS). The core assertion below FAILS against
        // the old whole-file findSourcePeak behavior: the old code always measured the
        // loud segment's ~-0.92 dBFS peak regardless of where the clip is trimmed to,
        // landing gain around +0.9 dB even when trimmed well clear of it into the quiet
        // region — a ~19 dB silent under-normalization a producer would only catch by ear.
        {
            auto makeSpanWav = [&] () -> juce::File
            {
                const double sr = 44100.0;
                const juce::int64 n = (juce::int64) (sr * 2.5);   // 2.5s total
                juce::AudioBuffer<float> buf (1, (int) n);
                buf.clear();
                const juce::int64 loudEnd    = (juce::int64) (0.5 * sr);   // [0, loudEnd)    -> loud (0.9)
                const juce::int64 quietStart = (juce::int64) (1.0 * sr);   // [quietStart, n) -> quiet (0.1)
                                                                            // [loudEnd, quietStart) stays exact silence.
                const double inc = juce::MathConstants<double>::twoPi * 440.0 / sr;
                double phase = 0.0;
                for (juce::int64 i = 0; i < loudEnd; ++i, phase += inc)
                    buf.setSample (0, (int) i, (float) (std::sin (phase) * 0.9));
                for (juce::int64 i = quietStart; i < n; ++i, phase += inc)
                    buf.setSample (0, (int) i, (float) (std::sin (phase) * 0.1));

                auto dir = eng.sessionDir().getChildFile ("normalize-span-test");
                dir.createDirectory();
                auto f = dir.getChildFile ("loud-silent-quiet.wav");
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
            auto spanFile = makeSpanWav();
            check (spanFile.existsAsFile(), "normalize span-test WAV synthesized (loud/silent/quiet)");

            auto spanImp = cmd (ops, "import_clip", objN ({{ "trackId", et }, { "file", spanFile.getFullPathName() }}));
            check (ok (spanImp), "normalize span-test clip imported");
            const auto spanCid = spanImp["data"].getProperty ("clipId", var()).toString();

            // Baseline: UNTRIMMED (offset 0, full 2.5s source) — the audible span IS the
            // whole file here, so this must still find the LOUD peak (~-0.92 dBFS).
            // Proves the fix is behavior-preserving for the common untrimmed case.
            auto spanBase = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanBase), "normalize_clip (untrimmed) ok");
            check (std::abs ((double) spanBase["data"].getProperty ("peakDb", 0.0) - (-0.92)) < 0.5,
                   "untrimmed clip normalizes against the LOUD segment (whole file == audible span)");

            // Trim into [1.0s, 2.0s) — entirely inside the QUIET region, clear of both the
            // loud segment and the silent gap. This is the core fix assertion.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 1.0 }, { "length", 1.0 }}))),
                   "trim_clip into the quiet region ok");
            auto spanQuiet = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanQuiet), "normalize_clip (trimmed to quiet region) ok");
            check (std::abs ((double) spanQuiet["data"].getProperty ("peakDb", 0.0) - (-20.0)) < 0.5,
                   "trimmed clip measures the QUIET region's ~-20 dBFS peak, not the loud transient outside its "
                   "span (FAILS against the old whole-file scan, which would report ~-0.92 dBFS here)");
            check (std::abs ((double) clipById (spanCid).getProperty ("gainDb", 0.0) - 20.0) < 0.5,
                   "trimmed clip's normalize gain targets the audible (quiet) peak, ~+20 dB — not ~+0.9 dB");

            // Trim to the EXACT-SILENCE gap [0.5s, 1.0s) — the audible SPAN is silent even
            // though the source file as a whole isn't. Still the existing clean "silent"
            // error — and now span-accurate (the old whole-file code would NOT have
            // errored here, since it always saw the loud segment elsewhere in the file).
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 0.5 }, { "length", 0.5 }}))),
                   "trim_clip into the silent gap ok");
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", spanCid))),
                   "normalize_clip on a clip trimmed to a silent SPAN errors cleanly, even though the source file "
                   "isn't silent elsewhere");

            // EOF handling: a length running past the end of the source clamps gracefully
            // (no crash, no out-of-range read) and measures only the clamped, in-range
            // remainder (here: [2.3s, 2.5s), still inside the quiet region).
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 2.3 }, { "length", 5.0 }}))),
                   "trim_clip with length past EOF ok (accepted, not rejected)");
            auto spanEof = cmd (ops, "normalize_clip", args1 ("clipId", spanCid));
            check (ok (spanEof), "normalize_clip with a length-past-EOF span still succeeds (clamped)");
            check (std::abs ((double) spanEof["data"].getProperty ("peakDb", 0.0) - (-20.0)) < 0.5,
                   "length-past-EOF span still measures the quiet region's peak from its clamped remainder");

            // Offset entirely beyond EOF: the clamped audible range is empty -> the
            // existing clean "silent" error, not a crash or an out-of-range read.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", spanCid }, { "offset", 10.0 }, { "length", 1.0 }}))),
                   "trim_clip with offset beyond EOF ok (accepted, not rejected)");
            check (! ok (cmd (ops, "normalize_clip", args1 ("clipId", spanCid))),
                   "normalize_clip with offset entirely beyond EOF errors cleanly, not a crash");

            cmd (ops, "remove_clip", args1 ("clipId", spanCid));
        }

        const int before = trackById (et).getProperty ("clips", var()).size();
        auto dup = cmd (ops, "duplicate_clip", args1 ("clipId", cid));
        check (ok (dup), "duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "duplicate adds a clip to the track");
        const auto newId = dup["data"].getProperty ("newClipId", var()).toString();
        check ((double) clipById (newId).getProperty ("start", 0.0) > 0.5, "duplicate lands after the original");
        // duplicate is undoable (was uncovered): undo drops the copy, redo restores it.
        check (ok (cmd (ops, "undo")), "undo duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before, "undo removes the duplicated clip");
        check (ok (cmd (ops, "redo")), "redo duplicate_clip ok");
        check (trackById (et).getProperty ("clips", var()).size() == before + 1, "redo restores the duplicated clip");

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

    // ─── G10: parameter automation RECORDING (v0) ───
    // docs/superpowers/specs/2026-07-17-g10-automation-record.md — synchronous capture
    // (gated on automationMode==write, NOT transport.isPlaying()) inside cmdSetPluginParam;
    // set_track_automation_mode arms/disarms all 4 values but only write is behavioral;
    // write_automation_curve bulk-authors a curve in one undoable step.
    section ("G10: parameter automation recording");
    {
        auto paramVarG10 = [&] (const String& trkId, int plugIdx, int paramIdx) -> var {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return pr;
            return {};
        };

        auto gt = cmd (ops, "create_track", args1 ("name", "AutoRec"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", gt }, { "type", "compressor" }}));
        int gpidx = -1;
        { auto trk = trackById (gt);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") gpidx = (int) p.getProperty ("index", -1); }
        check (gpidx >= 0, "G10: compressor loaded for recording test");

        // ── set_track_automation_mode: default, round-trip, validation, undo/redo ──
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "read", "G10: fresh track defaults automationMode=read");
        check (ok (cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "write" }}))), "G10: set_track_automation_mode write ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: automationMode reflects write");
        check (! ok (cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "bogus" }}))), "G10: rejects an unknown mode");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: a rejected mode leaves the track unchanged");
        check (ok (cmd (ops, "undo")), "G10: undo set_track_automation_mode ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "read", "G10: undo reverts automationMode to read (CachedValue undo, no custom action needed)");
        check (ok (cmd (ops, "redo")), "G10: redo set_track_automation_mode ok");
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "write", "G10: redo restores automationMode to write");

        // ── write mode captures a point at the transport position; ONE undo reverts value+point together ──
        cmd (ops, "set_transport", args1 ("position", 3.0));
        const double v0 = (double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0);
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.75 }}))),
               "G10: set_plugin_param under write mode ok");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - 0.75) < 0.02, "G10: value reflects the set_plugin_param call");
        check ((bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", false), "G10: write mode captured a point (param flagged automated)");
        { auto pts = paramVarG10 (gt, gpidx, 0).getProperty ("points", var());
          check (pts.size() == 1, "G10: exactly one point captured");
          check (pts.size() == 1 && std::abs ((double) pts[0].getProperty ("t", -1.0) - 3.0) < 0.05, "G10: captured point lands at the transport position");
          check (pts.size() == 1 && std::abs ((double) pts[0].getProperty ("v", -1.0) - 0.75) < 0.02, "G10: captured point value matches the set value"); }
        check (ok (cmd (ops, "undo")), "G10: undo set_plugin_param (write mode) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 0, "G10: one undo removes the captured point");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - v0) < 0.02,
               "G10: the SAME undo reverts the value too (bug-fix regression: not stale at the pre-undo value)");
        check (ok (cmd (ops, "redo")), "G10: redo set_plugin_param (write mode) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 1, "G10: redo restores the captured point");
        check (std::abs ((double) paramVarG10 (gt, gpidx, 0).getProperty ("value", -1.0) - 0.75) < 0.02, "G10: redo restores the value");

        cmd (ops, "clear_automation", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 }}));

        // ── read mode does NOT capture ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "read" }}));
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.4 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10: read mode does not capture a point");

        // ── touch/latch are ACCEPTED (round-trip losslessly) but INERT in v0 — Phase 2 ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "touch" }}));
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "touch", "G10: touch mode stored");
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.6 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10 AUTO-MODE-INERT: touch mode does not capture in v0");

        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "latch" }}));
        check (trackById (gt).getProperty ("automationMode", "?").toString() == "latch", "G10: latch mode stored");
        cmd (ops, "set_plugin_param", objN ({{ "trackId", gt }, { "index", gpidx }, { "paramIndex", 0 }, { "value", 0.3 }}));
        check (! (bool) paramVarG10 (gt, gpidx, 0).getProperty ("automated", true), "G10 AUTO-MODE-INERT: latch mode does not capture in v0");

        // ── write_automation_curve: validate-before-mutate, replace, reject, merge, undo, JSON-string form ──
        cmd (ops, "set_track_automation_mode", objN ({{ "trackId", gt }, { "mode", "read" }}));   // don't let write-mode capture interfere below
        cmd (ops, "clear_automation", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 }}));

        var replacePoints; { Array<var> a; a.add (objN ({{ "t", 0.0 }, { "v", 0.1 }}));
                              a.add (objN ({{ "t", 1.0 }, { "v", 0.5 }}));
                              a.add (objN ({{ "t", 2.0 }, { "v", 0.9 }})); replacePoints = a; }
        auto wr = cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                              { "points", replacePoints }, { "apply", "replace" }}));
        check (ok (wr), "G10: write_automation_curve replace ok");
        check ((int) wr["data"].getProperty ("pointCount", -1) == 3, "G10: replace reports 3 points written");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: curve now has exactly the 3 replaced points");

        // reject: non-ascending t -> the WHOLE call is rejected, curve UNCHANGED (validate-before-mutate)
        var badPoints; { Array<var> a; a.add (objN ({{ "t", 1.0 }, { "v", 0.2 }}));
                          a.add (objN ({{ "t", 0.5 }, { "v", 0.4 }})); badPoints = a; }
        check (! ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                                { "points", badPoints }, { "apply", "replace" }}))),
               "G10: rejects non-ascending t");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: a rejected call leaves the curve untouched");

        // reject: v out of range
        var badV; { Array<var> a; a.add (objN ({{ "t", 5.0 }, { "v", 1.5 }})); badV = a; }
        check (! ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                                { "points", badV }, { "apply", "replace" }}))),
               "G10: rejects v outside 0..1");

        // merge: adds without clearing the existing 3
        var mergePoints; { Array<var> a; a.add (objN ({{ "t", 5.0 }, { "v", 0.3 }})); mergePoints = a; }
        auto wm = cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                                                              { "points", mergePoints }, { "apply", "merge" }}));
        check (ok (wm), "G10: write_automation_curve merge ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 4, "G10: merge adds without clearing the existing 3 points");

        // one undo reverts the WHOLE bulk write (all points added in one beginTxn)
        check (ok (cmd (ops, "undo")), "G10: undo write_automation_curve (merge) ok");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 3, "G10: undo drops the whole merged batch in one step");

        // the agent-catalog form: points as a JSON-encoded string (ArgType has no array type)
        check (ok (cmd (ops, "write_automation_curve", objN ({{ "trackId", gt }, { "pluginIndex", gpidx }, { "paramIndex", 0 },
                        { "points", String ("[{\"t\":9.0,\"v\":0.2}]") }, { "apply", "merge" }}))),
               "G10: write_automation_curve accepts a JSON-string points array");
        check (paramVarG10 (gt, gpidx, 0).getProperty ("points", var()).size() == 4, "G10: JSON-string points landed");
    }

    // ─── G10 bug fix: cmdSetPluginParam undo correctness (G14-class regression) ───
    section ("G10: set_plugin_param undo regression (G14-class)");
    {
        auto paramValueG10b = [&] (const String& trkId, int plugIdx, int paramIdx) -> double {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return (double) pr.getProperty ("value", -1.0);
            return -1.0;
        };

        auto puTrack = cmd (ops, "create_track", args1 ("name", "ParamUndo"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", puTrack }, { "type", "compressor" }}));
        int rpidx = -1;
        { auto trk = trackById (puTrack);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") rpidx = (int) p.getProperty ("index", -1); }
        check (rpidx >= 0, "G10 regression: compressor loaded");

        const double before = paramValueG10b (puTrack, rpidx, 0);
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", puTrack }, { "index", rpidx }, { "paramIndex", 0 }, { "value", 0.95 }}))),
               "G10 regression: set_plugin_param ok");
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - 0.95) < 0.02, "G10 regression: value reflects the set");
        check (ok (cmd (ops, "undo")), "G10 regression: undo ok");
        // The exact G14-class assertion: pre-fix, AutomatableParameter::currentValue (and so
        // getCurrentNormalisedValue(), what the snapshot's params[].value reads) stayed stale
        // at the post-set value even though the persisted ValueTree property correctly reverted.
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - before) < 0.02,
               "G10 regression: undo restores the LIVE param value (not stale at the pre-undo value)");
        check (ok (cmd (ops, "redo")), "G10 regression: redo ok");
        check (std::abs (paramValueG10b (puTrack, rpidx, 0) - 0.95) < 0.02, "G10 regression: redo restores the set value");
    }

    // ─── ADVERSARIAL-REVIEW FIX: SetPluginParamValueAction use-after-free (blocking) ───
    // Repro found in review: set_plugin_param pushed a SetPluginParamValueAction holding a raw
    // te::AutomatableParameter& captured at construction. remove_plugin detaches the plugin
    // (plugin->deleteFromParent()); te::PluginCache purges the underlying C++
    // Plugin/AutomatableParameter object via its own 1s JUCE::Timer once the cache is its last
    // owner (refcount hits 1) — pumped for real below via runDispatchLoopUntil, so this test
    // forces the ACTUAL purge headlessly rather than relying on same-address reuse masking the
    // bug. undo (of remove_plugin) then re-adds the plugin as a BRAND-NEW C++ object at a new
    // address (PluginList's ValueTreeObjectList rebuilds via getOrCreatePluginFor), restored
    // from the same ValueTree node -> same te::EditItemID. A second undo (of the original
    // set_plugin_param) invokes the now-STALE action's undo(): pre-fix this dereferenced the
    // freed original AutomatableParameter& (undefined behavior / crash). Post-fix the action
    // re-resolves the parameter fresh, by (pluginItemId,paramIndex) via the Edit's PluginCache,
    // on every perform()/undo() call — so the WHOLE sequence below must complete without
    // crashing, and must land the correct value on the RE-CREATED plugin object.
    section ("ADVERSARIAL-REVIEW: SetPluginParamValueAction UAF across remove_plugin+undo");
    {
        auto paramValueUAF = [&] (const String& trkId, int plugIdx, int paramIdx) -> double {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx)
                        if (auto* params = p.getProperty ("params", var()).getArray())
                            for (auto& pr : *params)
                                if ((int) pr.getProperty ("index", -1) == paramIdx) return (double) pr.getProperty ("value", -1.0);
            return -1.0;
        };
        auto hasPluginAt = [&] (const String& trkId, int plugIdx) -> bool {
            auto trk = trackById (trkId);
            if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *plugins)
                    if ((int) p.getProperty ("index", -1) == plugIdx) return true;
            return false;
        };

        auto uafTrack = cmd (ops, "create_track", args1 ("name", "ParamUAF"))["data"].getProperty ("trackId", var()).toString();
        cmd (ops, "load_builtin", objN ({{ "trackId", uafTrack }, { "type", "compressor" }}));
        int uafIdx = -1;
        { auto trk = trackById (uafTrack);
          if (auto* plugins = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *plugins) if (p.getProperty ("type", var()).toString() == "compressor") uafIdx = (int) p.getProperty ("index", -1); }
        check (uafIdx >= 0, "UAF regression: compressor loaded");

        const double uafBefore = paramValueUAF (uafTrack, uafIdx, 0);

        // T1: set_plugin_param — pushes the SetPluginParamValueAction under test.
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", uafTrack }, { "index", uafIdx }, { "paramIndex", 0 }, { "value", 0.85 }}))),
               "UAF regression: set_plugin_param ok");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.02, "UAF regression: value reflects the set");

        // T2: remove_plugin — detaches the plugin the T1 action's original param lived on.
        check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", uafTrack }, { "index", uafIdx }}))),
               "UAF regression: remove_plugin ok");
        check (! hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin gone after remove");

        // Force the REAL te::PluginCache 1s purge timer to fire (pump the message loop past
        // 1000ms in 50ms slices — mirrors the pump() idiom used elsewhere in this file for
        // async waits) so the original Plugin/AutomatableParameter C++ objects are actually
        // destroyed, not just detached — otherwise the repro is inert (same-address reuse would
        // mask the bug even pre-fix).
        {
            auto* uafMm = juce::MessageManager::getInstanceWithoutCreating();
            const auto uafPumpEnd = juce::Time::getMillisecondCounter() + (juce::uint32) 1300;
            while (juce::Time::getMillisecondCounter() < uafPumpEnd)
            {
                if (uafMm != nullptr) uafMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
            }
        }

        // Undo #1 reverts T2 (remove_plugin): Tracktion's built-in ValueTree undo restores the
        // removed node — same te::EditItemID, but (since the cache purged the original) a NEW
        // C++ Plugin object gets instantiated for it.
        check (ok (cmd (ops, "undo")), "UAF regression: undo #1 (revert remove_plugin) ok, no crash");
        check (hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin restored after undo #1");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.05,
               "UAF regression: restored plugin's param reflects the value it had when removed");

        // Undo #2 reverts T1 (set_plugin_param) — the STALE action. Pre-fix its raw
        // AutomatableParameter& pointed at the now-freed original object; post-fix it
        // re-resolves by (pluginItemId,paramIndex) against the (new) live plugin instead.
        // Reaching + passing the assertions below is itself part of the proof (a UAF here is
        // undefined behavior, not a silently-wrong-but-safe result).
        check (ok (cmd (ops, "undo")), "UAF regression: undo #2 (revert set_plugin_param on the RE-CREATED plugin) ok, no crash");
        check (hasPluginAt (uafTrack, uafIdx), "UAF regression: plugin still present after undo #2");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - uafBefore) < 0.05,
               "UAF regression: undo #2 correctly restores the pre-set value on the RE-CREATED plugin object (not a crash, not a silent no-op)");

        // Redo both, proving the re-resolving perform()/undo() path works in both directions
        // post-purge, not just undo().
        check (ok (cmd (ops, "redo")), "UAF regression: redo #1 (re-apply set_plugin_param) ok");
        check (std::abs (paramValueUAF (uafTrack, uafIdx, 0) - 0.85) < 0.05, "UAF regression: redo #1 restores the set value");
        check (ok (cmd (ops, "redo")), "UAF regression: redo #2 (re-apply remove_plugin) ok");
        check (! hasPluginAt (uafTrack, uafIdx), "UAF regression: redo #2 removes the plugin again");
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
        check (nB >= 13, "built-in palette has the full catalog plus Mosh FX");
        bool sawComp = false, sawSynth = false, sawAutoTune = false, sawOTT = false, sawXFeedback = false;
        if (auto* arr = lb["data"].getProperty ("plugins", var()).getArray())
            for (auto& p : *arr)
            {
                if (p.getProperty ("type", var()).toString() == "compressor") sawComp = true;
                if (p.getProperty ("type", var()).toString() == "4osc"
                    && (bool) p.getProperty ("isInstrument", false)) sawSynth = true;
                if (p.getProperty ("type", var()).toString() == "moshAutoTune") sawAutoTune = true;
                if (p.getProperty ("type", var()).toString() == "moshOTT") sawOTT = true;
                if (p.getProperty ("type", var()).toString() == "moshXFeedback") sawXFeedback = true;
            }
        check (sawComp, "catalog includes compressor (effect)");
        check (sawSynth, "catalog includes 4osc (instrument)");
        check (sawAutoTune, "catalog includes Mosh AutoTune");
        check (sawOTT, "catalog includes Mosh OTT");
        check (sawXFeedback, "catalog includes Mosh X-FDBK");

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

        const char* moshFxTypes[] = { "moshAutoTune", "moshOTT", "moshXFeedback" };
        for (auto* type : moshFxTypes)
        {
            const String typeId (type);
            check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", type }}))), String ("load_builtin (") + typeId + ") ok");
            const int midx = builtinIndex (trackById (bt), type);
            check (midx >= 0, typeId + " appears in the chain");
            bool hasMoshCategory = false, hasParams = false, hasReadout = false;
            { auto trk = trackById (bt);
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == midx)
                {
                    hasMoshCategory = p.getProperty ("category", var()).toString() == "Mosh FX";
                    hasParams = p.getProperty ("params", var()).size() >= 6;
                    auto mfx = p.getProperty ("moshFx", var());
                    if (typeId == "moshAutoTune")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "autotune"
                                     && mfx.hasProperty ("inputHz")
                                     && mfx.hasProperty ("targetHz")
                                     && mfx.hasProperty ("correctionCents")
                                     && mfx.hasProperty ("confidence");
                    else if (typeId == "moshOTT")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "ott"
                                     && mfx.hasProperty ("amount")
                                     && mfx.hasProperty ("timeMs");
                    else if (typeId == "moshXFeedback")
                        hasReadout = mfx.getProperty ("kind", var()).toString() == "feedback"
                                     && mfx.hasProperty ("candidates")
                                     && mfx.hasProperty ("activeCuts");
                } }
            check (hasMoshCategory, typeId + " carries Mosh FX category");
            check (hasParams, typeId + " exposes generic rack params");
            check (hasReadout, typeId + " exposes additive moshFx readout");
            if (midx >= 0)
                check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", bt }, { "index", midx }, { "paramIndex", 0 }, { "value", 0.55 }}))),
                       String ("set_plugin_param on ") + typeId + " ok");
        }

        auto xfTrack = cmd (ops, "create_track", args1 ("name", "X-FDBK Readout"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({{ "trackId", xfTrack }, { "seconds", 1.0 }, { "freq", 2600.0 }}))),
               "X-FDBK readout tone created");
        auto xfLoad = cmd (ops, "load_builtin", objN ({{ "trackId", xfTrack }, { "type", "moshXFeedback" }}));
        const int xfIdx = (int) xfLoad["data"].getProperty ("index", -1);
        check (ok (xfLoad), "X-FDBK readout plugin loaded");
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", xfTrack }, { "index", xfIdx }, { "paramIndex", 0 }, { "value", 0.85 }}))),
               "X-FDBK readout sensitivity set");
        check (ok (cmd (ops, "set_plugin_param", objN ({{ "trackId", xfTrack }, { "index", xfIdx }, { "paramIndex", 4 }, { "value", 1.0 }}))),
               "X-FDBK readout auto-suppress enabled");
        auto xfOut = selftestTempPath (eng, "xfeedback-readout.wav");
        xfOut.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({{ "file", xfOut.getFullPathName() }, { "format", "wav" }, { "bitDepth", 24 }}))),
               "X-FDBK readout export ok");
        bool activeCutHasScore = false, activeCutHasDepth = false;
        { auto trk = trackById (xfTrack);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == xfIdx)
            {
                auto cuts = p.getProperty ("moshFx", var()).getProperty ("activeCuts", var());
                if (auto* ca = cuts.getArray(); ca != nullptr && ! ca->isEmpty())
                {
                    const auto first = ca->getReference (0);
                    activeCutHasScore = (double) first.getProperty ("score", 0.0) > 0.0;
                    activeCutHasDepth = (double) first.getProperty ("depthDb", 0.0) > 0.0;
                }
            } }
        check (activeCutHasScore, "X-FDBK active cut readout carries its own score");
        check (activeCutHasDepth, "X-FDBK active cut readout carries depth");
        xfOut.deleteFile();   // per-process unique name → clean up so it can't accumulate in the temp dir

        const int autoIdx = builtinIndex (trackById (bt), "moshAutoTune");
        if (autoIdx >= 0)
        {
            check (ok (cmd (ops, "bypass_plugin", objN ({{ "trackId", bt }, { "index", autoIdx }, { "bypassed", true }}))),
                   "bypass_plugin on Mosh AutoTune ok");
            bool bypassed = false;
            { auto trk = trackById (bt);
              if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == autoIdx)
                    bypassed = ! (bool) p.getProperty ("enabled", true); }
            check (bypassed, "Mosh AutoTune bypass reflected in snapshot");
            check (ok (cmd (ops, "undo")), "undo Mosh AutoTune bypass ok");
        }

        // Persistence + validation.
        cmd (ops, "save"); cmd (ops, "reload");
        check (builtinIndex (trackById (bt), "compressor") >= 0, "built-in plugin persists across save/reload");
        check (builtinIndex (trackById (bt), "moshAutoTune") >= 0, "Mosh AutoTune persists across save/reload");
        check (builtinIndex (trackById (bt), "moshOTT") >= 0, "Mosh OTT persists across save/reload");
        check (builtinIndex (trackById (bt), "moshXFeedback") >= 0, "Mosh X-FDBK persists across save/reload");
        const int ottIdx = builtinIndex (trackById (bt), "moshOTT");
        if (ottIdx >= 0)
        {
            check (ok (cmd (ops, "remove_plugin", objN ({{ "trackId", bt }, { "index", ottIdx }}))), "remove_plugin on Mosh OTT ok");
            check (builtinIndex (trackById (bt), "moshOTT") < 0, "Mosh OTT removed from chain");
            check (ok (cmd (ops, "undo")), "undo Mosh OTT remove ok");
            check (builtinIndex (trackById (bt), "moshOTT") >= 0, "undo restores Mosh OTT");
        }
        check (! ok (cmd (ops, "load_builtin", objN ({{ "trackId", bt }, { "type", "no_such_plugin" }}))), "load_builtin rejects unknown type");
        // The scratch "Built-ins" track is left in place: the only later count
        // check in this run is relative (tracksBefore+1), and absolute-count
        // checks live in the separate runUndoSelfTest with its own fresh engine.
    }

    // ─── reorder_plugin: chain ordering + undo + out-of-bounds clamp (was 0-ref) ───
    section ("PLG reorder: plugin chain ordering (reorder_plugin)");
    {
        auto effectOrder = [&] (const String& tid) -> StringArray {
            StringArray order; auto trk = trackById (tid);
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                { auto ty = p.getProperty ("type", var()).toString();
                  if (ty == "compressor" || ty == "reverb" || ty == "delay") order.add (ty); }
            return order;
        };
        auto idxOf = [&] (const String& tid, const String& type) -> int {
            auto trk = trackById (tid);
            if (auto* arr = trk.getProperty ("plugins", var()).getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        auto rt = cmd (ops, "create_track", args1 ("name", "Reorder"))["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "compressor" }}))), "reorder: load compressor");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "reverb" }}))),     "reorder: load reverb");
        check (ok (cmd (ops, "load_builtin", objN ({{ "trackId", rt }, { "type", "delay" }}))),      "reorder: load delay");
        check (effectOrder (rt) == StringArray ({ "compressor", "reverb", "delay" }), "effects load in chain order C,R,D");

        // Move compressor to the end via an out-of-bounds toIndex — Tracktion's
        // insertPlugin clamps an out-of-range index to append (no crash / no error).
        const int compIdx = idxOf (rt, "compressor");
        check (ok (cmd (ops, "reorder_plugin", objN ({{ "trackId", rt }, { "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_plugin with an out-of-bounds toIndex clamps to append (ok, no crash)");
        check (effectOrder (rt) == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the chain");

        check (ok (cmd (ops, "undo")), "undo reorder_plugin ok");
        check (effectOrder (rt) == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the prior plugin order");

        check (! ok (cmd (ops, "reorder_plugin", objN ({{ "trackId", rt }, { "index", 99 }, { "toIndex", 0 }}))),
               "reorder_plugin with a bad from-index errors");
    }

    // ─── Master-bus plugins: host plugins (limiter, bus EQ, …) on getMasterPluginList(),
    // mirroring the per-track plugin commands one level up (no trackId). Built-ins only
    // (compressor/reverb/4bandEq/delay) — deterministic, no VST3 dependency — plus one
    // block gated on a real scanned VST3 (mirrors Stage 3's fxId-gated block above). ───
    section ("Master bus plugins (load/remove/reorder/bypass/param, undo)");
    {
        auto masterPlugins = [&] () -> var {
            return ops.snapshot().getProperty ("master", var()).getProperty ("plugins", var());
        };
        // NOTE: `masterPlugins()` returns a fresh var by value each call. getArray() hands
        // back a raw pointer into that var's (ref-counted) internal array storage, so the
        // var itself MUST be kept alive (bound to a named local) for as long as the pointer
        // is used. `if (auto* arr = masterPlugins().getArray())` looks equivalent but is a
        // real use-after-free: the condition of an if-statement is its own full-expression,
        // so the unnamed `masterPlugins()` temporary — and the array it owns — is destroyed
        // the instant the condition finishes evaluating, BEFORE the loop body runs (unlike
        // the `trk`/`snap`-named-local idiom used everywhere else in this file, where the
        // owning var outlives the condition because it's a named variable in the enclosing
        // scope). Every read below binds the result to a named local first.
        auto masterOrder = [&] () -> StringArray {
            StringArray order;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) order.add (p.getProperty ("type", var()).toString());
            return order;
        };
        auto masterIdxOf = [&] (const String& type) -> int {
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };

        check (masterOrder().isEmpty(), "master bus starts with no plugins");

        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "compressor" }}))), "load_master_builtin (compressor) ok");
        check (masterOrder() == StringArray ({ "compressor" }), "compressor appears in master.plugins");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "reverb" }}))), "load_master_builtin (reverb) ok");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "delay" }}))),  "load_master_builtin (delay) ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master effects load in chain order C,R,D");

        // set_master_plugin_param — value reflected in the snapshot.
        const int compIdx = masterIdxOf ("compressor");
        check (compIdx >= 0, "compressor index resolved");
        check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", compIdx }, { "paramIndex", 0 }, { "value", 0.65 }}))),
               "set_master_plugin_param ok");
        {
            double v = -1.0;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr)
                    if ((int) p.getProperty ("index", -1) == compIdx)
                    {
                        auto params = p.getProperty ("params", var());
                        if (auto* ps = params.getArray())
                            for (auto& pp : *ps)
                                if ((int) pp.getProperty ("index", -1) == 0)
                                    v = (double) pp.getProperty ("value", -1.0);
                    }
            check (std::abs (v - 0.65) < 0.02, "set_master_plugin_param value reflects in the snapshot");
        }

        // bypass_master_plugin + undo.
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", compIdx }, { "bypassed", true }}))), "bypass_master_plugin ok");
        {
            bool bypassed = false;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == compIdx) bypassed = ! (bool) p.getProperty ("enabled", true);
            check (bypassed, "bypass_master_plugin disabled the plugin");
        }
        check (ok (cmd (ops, "undo")), "undo bypass_master_plugin ok");

        // reorder_master_plugin — an out-of-bounds toIndex clamps INSIDE the visible
        // prefix (unlike reorder_plugin, which relies on Tracktion's raw append-at-end
        // clamp — master must never land a plugin after the (currently absent, headless)
        // internal spectral tap; see masterVisibleBoundary()).
        check (ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_master_plugin with an out-of-bounds toIndex clamps (ok, no crash)");
        check (masterOrder() == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the master chain");
        check (ok (cmd (ops, "undo")), "undo reorder_master_plugin ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the prior master plugin order");

        check (! ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", 99 }, { "toIndex", 0 }}))),
               "reorder_master_plugin with a bad from-index errors");

        // persists across save/reload.
        cmd (ops, "save"); cmd (ops, "reload");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master plugins persist across save/reload");

        // remove_master_plugin + undo.
        check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", masterIdxOf ("delay") }}))), "remove_master_plugin ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb" }), "master plugin removed from chain");
        check (ok (cmd (ops, "undo")), "undo remove_master_plugin restores it");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the removed master plugin");

        // open_master_plugin_editor — dispatches without crashing (native pop-out itself
        // is untestable headless, same posture as open_plugin_editor).
        check (ok (cmd (ops, "open_master_plugin_editor", objN ({{ "index", compIdx }}))), "open_master_plugin_editor ok");

        // bad index -> clean errors, not crashes.
        check (! ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", 99 }, { "paramIndex", 0 }, { "value", 0.5 }}))),
               "set_master_plugin_param on a bad index errors");
        check (! ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", 99 }, { "bypassed", true }}))),
               "bypass_master_plugin on a bad index errors");
        check (! ok (cmd (ops, "remove_master_plugin", objN ({{ "index", 99 }}))),
               "remove_master_plugin on a bad index errors");
        check (! ok (cmd (ops, "load_master_builtin", objN ({{ "type", "not-a-real-builtin" }}))),
               "load_master_builtin on an unknown type errors");

        // Optional: a real scanned VST3 (Stage 3's fxId-gated posture) — proves
        // load_master_plugin/pluginId end-to-end when the harness has a hostable plugin.
        {
            String masterFxId;
            auto lpMaster = cmd (ops, "list_plugins");
            if (auto* arr = lpMaster["data"].getProperty ("plugins", var()).getArray())
                for (auto& p : *arr)
                    if (isHarnessHostablePlugin (p) && ! (bool) p.getProperty ("isInstrument", false))
                    { masterFxId = p.getProperty ("id", var()).toString(); break; }

            if (masterFxId.isNotEmpty())
            {
                auto lr = cmd (ops, "load_master_plugin", objN ({{ "pluginId", masterFxId }}));
                check (ok (lr), "load_master_plugin (real VST3) ok");
                const int idx = (int) lr["data"].getProperty ("index", -1);
                check (idx >= 0 && masterOrder().size() == 4, "real VST3 appears in master.plugins");
                check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}))), "remove_master_plugin (real VST3) ok");
            }
            else
                std::cerr << "  (no hostable VST3 available — skipping load_master_plugin/pluginId check)\n";
        }

        // cleanup — leave the master bus clean for later sections/demos.
        for (int guard = 0; guard < 8 && ! masterOrder().isEmpty(); ++guard)
        {
            const int idx = (int) masterPlugins()[0].getProperty ("index", -1);
            cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}));
        }
        check (masterOrder().isEmpty(), "master bus cleaned up");
    }

    // ─── Master-bus internal-plugin boundary coverage: everything in the section
    // above exercises isInternalMasterPlugin()/masterVisibleBoundary()/findMasterPlugin()
    // only "by inspection" — the internal spectral tap is normally created lazily by
    // emitSpectrum() during REAL playback (a live PlaybackContext), which headless
    // --selftest never reaches, so the mapping logic that is supposed to protect the
    // tap from user-facing commands has never actually run against a real internal
    // plugin. This section constructs one directly — the SAME insertion call
    // cmdLoadMasterBuiltin/ensureMasterSpectralTap use (PluginCache::createNewPlugin +
    // PluginList::insertPlugin at the list's current end) — and proves the mapping
    // holds around it, then tears it down by hand (there is deliberately no user-facing
    // command that can reach an internal plugin) so later sections see a clean bus. ───
    section ("Master bus: internal plugin (spectral tap) visible-index boundary");
    {
        auto masterPlugins = [&] () -> var {
            return ops.snapshot().getProperty ("master", var()).getProperty ("plugins", var());
        };
        // See the NOTE on the masterPlugins()/masterOrder() lambdas in the section above —
        // same use-after-free trap with an unnamed temporary; every read here binds to a
        // named local first.
        auto masterOrder = [&] () -> StringArray {
            StringArray order;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) order.add (p.getProperty ("type", var()).toString());
            return order;
        };
        auto masterIdxOf = [&] (const String& type) -> int {
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if (p.getProperty ("type", var()).toString() == type) return (int) p.getProperty ("index", -1);
            return -1;
        };
        auto physicalCount = [&] { return eng.edit().getMasterPluginList().getPlugins().size(); };
        auto physicalTypeAt = [&] (int i) -> String {
            auto plugins = eng.edit().getMasterPluginList().getPlugins();
            return (i >= 0 && i < plugins.size()) ? plugins[i]->getPluginType() : String();
        };
        const String tapType (MasterSpectralTapPlugin::xmlTypeName);

        check (masterOrder().isEmpty(), "boundary section starts with a clean master bus");

        // Three visible plugins, then the internal tap.
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "compressor" }}))), "compressor loaded");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "reverb" }}))),     "reverb loaded");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "delay" }}))),      "delay loaded");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "3 visible plugins load in order before the tap exists");
        check (physicalCount() == 3, "physical master list has exactly 3 plugins pre-tap");

        {
            auto tap = eng.edit().getPluginCache().createNewPlugin (MasterSpectralTapPlugin::xmlTypeName, {});
            check (tap != nullptr, "synthetic internal plugin (spectral tap) created");
            auto& list = eng.edit().getMasterPluginList();
            list.insertPlugin (tap, list.getPlugins().size(), nullptr);   // append — same call cmdLoadMasterBuiltin/ensureMasterSpectralTap use
        }
        check (physicalCount() == 4, "physical master list now has 4 plugins (3 visible + the internal tap)");
        check (physicalTypeAt (3) == tapType, "the tap physically sits at index 3 (last)");

        // (a) master.plugins EXCLUDES the internal plugin.
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "master.plugins still reports only the 3 visible plugins with the tap present");
        check (masterPlugins().size() == 3, "master.plugins length unaffected by the internal plugin");

        // (b) user-visible indices still resolve to the RIGHT physical plugins for
        // load/remove/reorder/bypass/set_param, with the tap present.
        const int reverbIdx = masterIdxOf ("reverb");
        check (reverbIdx == 1, "reverb resolved at visible index 1");
        check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", reverbIdx }, { "paramIndex", 0 }, { "value", 0.42 }}))),
               "set_master_plugin_param on a visible index still resolves with the tap present");
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", reverbIdx }, { "bypassed", true }}))),
               "bypass_master_plugin on a visible index still resolves with the tap present");
        {
            bool bypassed = false;
            auto plugins = masterPlugins();
            if (auto* arr = plugins.getArray())
                for (auto& p : *arr) if ((int) p.getProperty ("index", -1) == reverbIdx) bypassed = ! (bool) p.getProperty ("enabled", true);
            check (bypassed, "the bypass landed on reverb, not the tap");
        }
        check (ok (cmd (ops, "undo")), "undo bypass ok");
        check (physicalTypeAt (3) == tapType, "the tap is untouched by a visible-plugin bypass+undo");

        // (d) NO OFF-BY-ONE at the boundary: index == boundary (3, the tap's own
        // physical slot) must NOT resolve. If masterVisibleBoundary()/findMasterPlugin()
        // had an off-by-one (e.g. an inclusive `<=` bound instead of `<`), this would
        // silently let a user-facing command reach into the internal tap.
        check (! ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", 3 }, { "paramIndex", 0 }, { "value", 0.5 }}))),
               "index == boundary (the tap's own slot) is rejected, not resolved to the tap");
        check (! ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", 3 }, { "bypassed", true }}))),
               "bypass at index == boundary is rejected");
        check (! ok (cmd (ops, "remove_master_plugin", objN ({{ "index", 3 }}))),
               "remove at index == boundary is rejected — the tap can't be deleted via the user command surface");
        check (physicalCount() == 4, "the tap survived every boundary-index command attempt");
        // ...and boundary - 1 (the LAST visible plugin, delay) still resolves correctly —
        // the guard isn't over-conservative either.
        const int delayIdx = masterIdxOf ("delay");
        check (delayIdx == 2, "delay resolved at visible index 2 (== boundary - 1)");
        check (ok (cmd (ops, "bypass_master_plugin", objN ({{ "index", delayIdx }, { "bypassed", true }}))),
               "bypass at boundary - 1 (the last visible plugin) still resolves");
        check (ok (cmd (ops, "undo")), "undo ok");

        // (c) reorder/insert can NEVER place a user plugin after the internal tap — the
        // tap must stay physically last so it taps the FULLY-PROCESSED master signal.
        const int compIdx = masterIdxOf ("compressor");
        check (ok (cmd (ops, "reorder_master_plugin", objN ({{ "index", compIdx }, { "toIndex", 99 }}))),
               "reorder_master_plugin with an out-of-bounds toIndex clamps (ok, no crash) with the tap present");
        check (masterOrder() == StringArray ({ "reverb", "delay", "compressor" }), "compressor moved to the end of the VISIBLE chain");
        check (physicalTypeAt (3) == tapType, "the tap is still physically last after a max-index reorder");
        check (ok (cmd (ops, "undo")), "undo reorder ok");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay" }), "undo restores the visible order");

        // A new plugin load with NO explicit index must land BEFORE the tap, pushing the
        // tap's physical slot from 3 to 4 — never after it. This is also the one check
        // in this section that depends on te::EditLimits::maxNumMasterPlugins: Tracktion
        // counts the (invisible) tap against that same cap, so without the
        // MoshEngineBehaviour::getEditLimits() +1 override (see MoshEngine.cpp) this 4th
        // VISIBLE plugin would silently fail to insert — PluginList::insertPlugin
        // returns an empty Ptr with no error, and the pre-fix cmdLoadMasterBuiltin
        // didn't check indexOf() either, so it would have reported "ok" for a plugin
        // that was never actually added. This is a real bug this coverage caught
        // (fixed alongside the coverage; see the belt-and-suspenders checks below and
        // the MoshEngine.cpp/cmdLoadMasterPlugin/cmdLoadMasterBuiltin comments).
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "4bandEq" }}))), "4bandEq loaded (4th visible plugin)");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay", "4bandEq" }), "the 4th visible plugin appended before the tap");
        check (physicalCount() == 5, "physical list now has 5 (4 visible + the tap)");
        check (physicalTypeAt (4) == tapType, "the tap was pushed to index 4 — still physically last");
        check (masterPlugins().size() == 4, "master.plugins still excludes the (now index-4) tap");

        // Make room — the master bus caps at 4 VISIBLE plugins regardless of the tap
        // (that part of the cap is pre-existing Tracktion behavior, out of scope here)
        // — before proving an explicit, absurdly-out-of-range `index` on load ALSO
        // clamps before the tap, not after it (mirrors cmdLoadMasterPlugin/
        // cmdLoadMasterBuiltin's `index > boundary -> boundary` clamp).
        check (ok (cmd (ops, "remove_master_plugin", objN ({{ "index", masterIdxOf ("4bandEq") }}))),
               "4bandEq removed to make room for the next probe");
        check (ok (cmd (ops, "load_master_builtin", objN ({{ "type", "4bandEq" }, { "index", 999 }}))),
               "load_master_builtin with an absurd explicit index still succeeds (clamped)");
        check (masterOrder() == StringArray ({ "compressor", "reverb", "delay", "4bandEq" }),
               "the absurd-index load landed at the visible end (index 999 clamped to the boundary), not literally index 999");
        check (physicalCount() == 5, "physical list is back to 5 (4 visible + the tap)");
        check (physicalTypeAt (4) == tapType, "the tap is STILL physically last after an absurd-index load");
        check (masterPlugins().size() == 4, "master.plugins reports 4 visible plugins, tap still excluded");

        // Belt-and-suspenders: findMasterPlugin/cmdSetMasterPluginParam etc. resolve a
        // freshly-loaded plugin correctly with the tap present (not the empty-Ptr/
        // index -1 shape a silently-failed insert would have left behind).
        {
            const int eqIdx = masterIdxOf ("4bandEq");
            check (eqIdx == 3, "4bandEq resolved at visible index 3, not -1");
            check (ok (cmd (ops, "set_master_plugin_param", objN ({{ "index", eqIdx }, { "paramIndex", 0 }, { "value", 0.3 }}))),
                   "set_master_plugin_param on the freshly-loaded 4th visible plugin resolves correctly");
        }

        // ── cleanup: remove every visible plugin via the command surface (proves
        // remove_master_plugin keeps working with the tap present through to the end),
        // then remove the synthetic internal plugin directly — mirrors its direct
        // construction above; there is deliberately no user-facing command that can
        // reach it — so later sections/demos see a fully clean master bus. ──
        for (int guard = 0; guard < 8 && ! masterOrder().isEmpty(); ++guard)
        {
            const int idx = (int) masterPlugins()[0].getProperty ("index", -1);
            cmd (ops, "remove_master_plugin", objN ({{ "index", idx }}));
        }
        check (masterOrder().isEmpty(), "all visible master plugins removed");
        check (physicalCount() == 1, "only the internal tap remains physically");
        {
            auto plugins = eng.edit().getMasterPluginList().getPlugins();
            if (! plugins.isEmpty())
                plugins.getLast()->deleteFromParent();
        }
        check (eng.edit().getMasterPluginList().getPlugins().isEmpty(), "synthetic internal plugin cleaned up — master bus fully empty for later sections");
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

    // ─── FMS Phase-3 Stage 2: sing mode (SoulX adapter, fake legato-beep backend) ───
    section ("FMS Stage 2: sing mode (soulx, fake backend)");
    {
        auto vt = cmd (ops, "create_track", args1 ("name", "Vocal"))["data"].getProperty ("trackId", var()).toString();
        auto vtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", vt }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        const auto vcid = vtone["data"].getProperty ("clipId", var()).toString();

        // No sheet yet → a clear error BEFORE any service/job work (never a silent render).
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", vcid }, { "adapter", "soulx" }, { "mode", "sing" }}))),
               "create_render_layer mode:sing ok");
        auto rNoSheet = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (rNoSheet), "sing without a lyric sheet errors (no silent render)");

        // Sheet + a line via commands; the Stage-1 lyricScore fixture is planted directly
        // (its landing command, build_skeleton_from_clip, needs the Basic-Pitch venv —
        // machine-dependent — while the RENDER path under test stays command-only).
        check (ok (cmd (ops, "create_lyric_sheet", args1 ("trackId", vt))), "create_lyric_sheet ok");
        check (ok (cmd (ops, "set_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "hold the flame" }}))),
               "set_lyric_line ok");
        const juce::String scoreBlob =
            R"({"v":1,"algo":"v3","bar":0,"bpm":120.0,"timeSig":[4,4],"grid":"1/16","clamped":false,)"
            R"("slots":[{"start":0.0,"end":0.5,"velocity":90,"kind":"attack","segments":[{"start":0.0,"end":0.5,"pitch":57}]},)"
            R"({"start":0.5,"end":1.0,"velocity":90,"kind":"gap","segments":[{"start":0.5,"end":1.0,"pitch":59}]},)"
            R"({"start":1.0,"end":2.0,"velocity":90,"kind":"gap","segments":[{"start":1.0,"end":1.5,"pitch":60},{"start":1.5,"end":2.0,"pitch":64}]}]})";
        bool planted = false;
        for (auto* t : te::getAudioTracks (eng.edit()))
            if (t->itemID.toString() == vt)
                if (auto sheet = t->state.getChildWithName (mosh::ids::MOSH_LYRICSHEET); sheet.isValid())
                {
                    auto lines = sheet.getChildWithName (mosh::ids::LYRIC_LINES);
                    if (lines.getNumChildren() > 0)
                    {
                        lines.getChild (0).setProperty (mosh::ids::lyricScore, scoreBlob, nullptr);
                        planted = true;
                    }
                }
        check (planted, "lyricScore fixture planted on the line");

        auto draftRender = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (draftRender), "sing render rejects scored draft text until asserted");
        check (draftRender.getProperty ("error", var()).toString().contains ("asserted words"),
               "scored draft text returns asserted-words error");
        check (! ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "___ the flame" }}))),
               "assert_lyric_line rejects unresolved gaps");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok");
        check (ok (cmd (ops, "undo")), "undo (assert_lyric_line) ok");
        auto undoneAssertRender = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (undoneAssertRender), "undoing assertion makes sing render reject again");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok after undo");

        // Full loop: render (fake sing) → HIT on identical re-render → lyric edit = MISS.
        auto s1 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (ok (s1), "sing render ok (fake legato-beep backend)");
        check (s1["data"].getProperty ("cache", var()).toString() == "miss", "first sing render is a cache MISS");
        check (s1["data"].getProperty ("status", var()).toString() == "ready", "sing render completed -> ready");
        // The authored SoulX target score is a durable job artifact next to the output.
        bool scoreArtifact = false;
        { auto renders = eng.sessionDir().getChildFile ("renders");
          for (auto& d : renders.findChildFiles (File::findDirectories, false))
              if (d.getChildFile ("target_score.json").existsAsFile())
                  scoreArtifact = true; }
        check (scoreArtifact, "target_score.json authored next to the render output");

        auto s2 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (s2["data"].getProperty ("cache", var()).toString() == "hit", "identical sing re-render is a cache HIT");

        cmd (ops, "set_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }, { "text", "hold the cold gold flame" }}));
        auto draftAfterEdit = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (! ok (draftAfterEdit), "editing asserted words returns line to draft state");
        check (ok (cmd (ops, "assert_lyric_line", objN ({{ "trackId", vt }, { "lineIndex", 0 }}))),
               "assert_lyric_line ok after edit");
        auto s3 = cmd (ops, "render_layer", objN ({{ "clipId", vcid }, { "wait", true }}));
        check (s3["data"].getProperty ("cache", var()).toString() == "miss", "lyric edit changes the sing fingerprint (cache MISS)");
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

        // Content fingerprint of the applied audio (the clip's in-place source). The MISS/HIT
        // checks alone can't see stale job-dir reuse: the layer's job dir keeps the SAME
        // output.wav path across renders, and the pollers treat an existing output+manifest
        // pair as the durable completion signal — so a re-render that never clears the pair
        // "completes" instantly with the PREVIOUS render's audio while still reporting MISS.
        auto clipSource = [&] (const String& cid) -> File {
            auto trk = trackById (gt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return File (c.getProperty ("sourceFile", var()).toString());
            return {};
        };
        const auto srcA = clipSource (gcid);
        check (srcA.existsAsFile(), "first render's applied source exists on disk");
        const auto bytesA = juce::MD5 (srcA).toHexString();

        // Re-render with identical fingerprint -> cache HIT.
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical re-render is a cache HIT (full fingerprint)");

        // Change a param -> fingerprint changes -> cache MISS (re-render).
        cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 2 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "param change -> dirty -> re-render (cache MISS)");
        // The fake adapter's output depends on the seed, so the re-render's AUDIO must actually
        // change — this is the assertion that catches stale job-dir reuse (a stale pair lands
        // the old bytes under a fresh fingerprint name and MISS/HIT still looks correct).
        const auto srcB = clipSource (gcid);
        check (srcB.existsAsFile(), "param-change re-render's applied source exists on disk");
        check (juce::MD5 (srcB).toHexString() != bytesA,
               "param-change re-render produced DIFFERENT audio bytes (no stale job-dir reuse)");

        // --- NRL-004: render-layer management (in-place apply / reset / bypass / freeze / remove) ---
        section ("NRL-004: render-layer management");
        auto layerOf = [&] (const String& cid) -> var {
            auto trk = trackById (gt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return c.getProperty ("renderLayer", var());
            return {};
        };
        auto layerStatus = [&] (const String& cid) { return layerOf (cid).getProperty ("status", var()).toString(); };
        auto neuralLanes = [&] () -> int {
            int n = 0; auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders") ++n;
            return n;
        };

        // ── In-place auto-apply (the NEW default for WAVE clips) ──
        // The render already AUTO-APPLIED in place: the clip's own source became the artifact.
        // There is no accept step and no "Neural Renders" lane for wave clips.
        check ((bool) layerOf (gcid).getProperty ("appliedInPlace", false),
               "wave render AUTO-APPLIES in place (no accept step)");
        check ((bool) layerOf (gcid).getProperty ("hasOriginal", false),
               "in-place apply stored the original source (Reset available)");

        // accept_render is a no-op for wave clips and creates NO lane.
        const int tracksBefore = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", gcid))), "accept_render ok (no-op for wave)");
        check (tracks (ops) == tracksBefore, "wave accept creates NO new track");
        check (neuralLanes() == 0, "no 'Neural Renders' lane for an in-place wave render");

        // reset_render_layer restores the ORIGINAL; the layer STAYS (re-imagine available again).
        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", gcid))), "reset_render_layer ok");
        check (! (bool) layerOf (gcid).getProperty ("appliedInPlace", true), "reset cleared appliedInPlace");
        check (layerStatus (gcid) == "dirty", "reset -> status dirty (re-imagine again)");
        check ((bool) layerOf (gcid).getProperty ("hasOriginal", false), "reset keeps the original lineage (Reset still available)");

        // Re-render after reset HITs the cache and RE-APPLIES in place.
        auto rRe = cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));
        check (ok (rRe), "re-render after reset ok");
        check ((bool) layerOf (gcid).getProperty ("appliedInPlace", false), "re-render re-applies in place");

        // ── TASTE-002: the taste-label spigot (the in-place workflow's labels) ──
        // PR #185's in-place auto-apply removed accept/reject from the wave loop, so organic
        // taste labels stopped accumulating (census 2026-07-19: 1 accept, 0 rejects survive).
        // The spigot: reset_render_layer logs an explicit NEGATIVE carrying the render join
        // keys (layerId/cacheKey/adapter), and save/export while a render is still applied
        // logs ONE render_kept soft POSITIVE per layer (deduped on layerId).
        section ("TASTE-002: taste-label spigot (reset negative + render_kept positive)");
        const auto tasteLayerId = layerOf (gcid).getProperty ("id", var()).toString();
        check (tasteLayerId.isNotEmpty(), "layer id is a visible join key in the snapshot");
        auto tasteLines = [&] (const String& command) -> Array<var>
        {
            Array<var> out;
            for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
            {
                if (! l.contains ("\"" + command + "\"")) continue;
                const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                if (row.getProperty ("command", var()).toString() == command) out.add (row);
            }
            return out;
        };
        {
            auto resets = tasteLines ("reset_render_layer");
            check (resets.size() > 0, "reset_render_layer is in the JSONL log");
            const auto ra = resets.getLast().getProperty ("args", var());
            check (ra.getProperty ("clipId", var()).toString() == gcid, "reset taste label carries clipId");
            check (ra.getProperty ("layerId", var()).toString() == tasteLayerId, "reset taste label carries layerId (joins to the render)");
            check (ra.getProperty ("cacheKey", var()).toString().isNotEmpty(), "reset taste label carries the render cacheKey");
            check (ra.getProperty ("adapter", var()).toString() == "fake", "reset taste label carries the adapter");
        }
        auto keptFor = [&] (const String& layerId) -> int
        {
            int n = 0;
            for (auto& row : tasteLines ("render_kept"))
                if (row.getProperty ("args", var()).getProperty ("layerId", var()).toString() == layerId) ++n;
            return n;
        };
        check (keptFor (tasteLayerId) == 0, "no render_kept before any save (the label fires at persistence time)");
        check (ok (cmd (ops, "save")), "save ok (render_kept sweep runs)");
        check (keptFor (tasteLayerId) == 1, "save logs render_kept for the surviving applied layer");
        {
            auto kept = tasteLines ("render_kept");
            check (kept.size() == 1, "render_kept logged ONLY for the applied layer (no spurious labels)");
            const auto ka = kept.getLast().getProperty ("args", var());
            check (ka.getProperty ("clipId", var()).toString() == gcid
                       && ka.getProperty ("cacheKey", var()).toString().isNotEmpty()
                       && ka.getProperty ("adapter", var()).toString() == "fake",
                   "render_kept carries the join keys (clipId/cacheKey/adapter)");
        }
        check (ok (cmd (ops, "save")), "second save ok");
        check (keptFor (tasteLayerId) == 1, "render_kept deduped on layerId (a second save adds NO new label)");

        // bypass_layer toggles status ready<->bypassed (the wave A/B swaps the source to the
        // original when bypassed; here we round-trip the status flag).
        check (ok (cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", true }}))), "bypass_layer ok");
        check (layerStatus (gcid) == "bypassed", "bypass_layer{true} -> status bypassed");
        cmd (ops, "bypass_layer", objN ({{ "clipId", gcid }, { "bypassed", false }}));
        check (layerStatus (gcid) == "ready", "bypass_layer{false} -> status ready");

        // Re-render so a cached artifact exists for freeze (cache HIT path).
        cmd (ops, "render_layer", objN ({{ "clipId", gcid }, { "wait", true }}));

        // freeze_layer requires a cached artifact -> status frozen.
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid))), "freeze_layer ok (artifact present)");
        check (layerStatus (gcid) == "frozen", "freeze_layer -> status frozen");

        section ("freeze_layer actually freezes (+ unfreeze_layer, the way back)");
        // ── Freeze actually freezes (it used to be a label and nothing else) ──
        // The reactive auto-re-render loop gates on ids::reactive; Ids.h declared it as the
        // per-layer opt-out from the start but NO command wrote it, so a "frozen" layer went
        // right on re-rendering. These pin the flag itself, not the word.
        auto layerReactive = [&] (const String& cid) { return (bool) layerOf (cid).getProperty ("reactive", true); };
        check (! layerReactive (gcid), "freeze_layer disarms the reactive loop (ids::reactive=false)");

        // Why the snapshot must carry `reactive` and the UI must not read `status` for this:
        // a param edit overwrites the "frozen" LABEL with "dirty" while the layer is still
        // frozen. Both facts are true at once, and only `reactive` still tells the truth.
        check (ok (cmd (ops, "set_render_param", objN ({{ "clipId", gcid }, { "seed", 4242 }}))),
               "set_render_param on a frozen layer ok");
        check (layerStatus (gcid) == "dirty", "a param edit moves the frozen layer's status to dirty");
        check (! layerReactive (gcid), "...and the layer is STILL frozen (status alone would have lost it)");

        // The way back. There was none: no command moved status off "frozen", and nothing
        // could re-arm ids::reactive, so a freeze was permanent for the life of the project.
        check (ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))), "unfreeze_layer ok");
        check (layerReactive (gcid), "unfreeze_layer re-arms the reactive loop");
        check (layerStatus (gcid) == "dirty",
               "unfreeze reports dirty, not ready (edits made while frozen skipped their re-render)");
        check (! ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))),
               "unfreeze_layer on a layer that is not frozen errors");

        // One command = one undo step, for both directions.
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", gcid))), "re-freeze ok");
        check (! layerReactive (gcid), "re-freeze disarmed it again");
        check (ok (cmd (ops, "undo")), "freeze: undo ok");
        check (layerReactive (gcid), "undoing a freeze re-arms the reactive loop (not just the label)");
        check (ok (cmd (ops, "redo")), "freeze: redo ok");
        check (! layerReactive (gcid), "redoing a freeze disarms it again");
        check (layerStatus (gcid) == "frozen", "redo restored the frozen label with the flag");

        // Persistence: a freeze that evaporates on reload is the same lie in slower motion.
        check (ok (cmd (ops, "save")), "freeze: save ok");
        check (ok (cmd (ops, "reload")), "freeze: reload ok");
        check (! layerReactive (gcid), "the freeze survives save/reload");
        check (ok (cmd (ops, "unfreeze_layer", args1 ("clipId", gcid))), "unfreeze after reload ok");

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

    // --- Route B: Tier-B transform render mode (FakeTransformAdapter) ---
    // Same job protocol / cache / accept-landing as SA3 re-imagine, exercised on the
    // new mode:"transform" with the model-agnostic target+strength surface. Runs in the
    // default build (the fake transform is stdlib-only).
    section ("Route B: transform render mode (fake)");
    {
        auto xt = cmd (ops, "create_track", args1 ("name", "Xform"))["data"].getProperty ("trackId", var()).toString();
        auto xtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", xt }, { "seconds", 1.5 }, { "freq", 207.0 }}));
        const auto xcid = xtone["data"].getProperty ("clipId", var()).toString();

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", xcid }, { "adapter", "transform" }, { "mode", "transform" }}));
        check (ok (crl), "create_render_layer (transform) ok");
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "target", "flute" }, { "strength", 70 }, { "seed", 1 }}));

        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (ok (r1), "transform render_layer ok (fake transform ran)");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first transform render is a cache MISS");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "transform render completed -> ready");
        bool xHasArtifact = false;
        { auto trk = trackById (xt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == xcid)
                xHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (xHasArtifact, "transform produced a cached artifact (output.wav)");

        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical transform re-render is a cache HIT");

        // The target is in the fingerprint: changing it must invalidate the cache.
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "target", "violin" }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "changing transform target -> cache MISS");

        // Strength is in the fingerprint too.
        cmd (ops, "set_render_param", objN ({{ "clipId", xcid }, { "strength", 95 }}));
        auto r4 = cmd (ops, "render_layer", objN ({{ "clipId", xcid }, { "wait", true }}));
        check (r4["data"].getProperty ("cache", var()).toString() == "miss", "changing transform strength -> cache MISS");

        // A whole-clip transform on a WAVE clip auto-applies in place too (same as re-imagine).
        auto xLayer = [&] () -> var {
            auto trk = trackById (xt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == xcid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        check ((bool) xLayer().getProperty ("appliedInPlace", false), "wave transform AUTO-APPLIES in place");
        check ((bool) xLayer().getProperty ("hasOriginal", false), "transform stored the original (Reset available)");

        // TASTE-002 — the EXPORT trigger: export_audio runs the same render_kept sweep as
        // save. The transform layer is applied and unlogged here; the earlier re-imagine
        // layer was already logged by save — the export must add exactly ONE new label
        // (cross-trigger dedupe on layerId).
        {
            auto keptRows = [&] () -> Array<var>
            {
                Array<var> out;
                for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                {
                    if (! l.contains ("\"render_kept\"")) continue;
                    const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                    if (row.getProperty ("command", var()).toString() == "render_kept") out.add (row);
                }
                return out;
            };
            check (keptRows().size() == 1, "before the export exactly one render_kept exists (the saved re-imagine layer)");
            auto expFile = eng.sessionDir().getChildFile ("taste-export-trigger.wav");
            check (ok (cmd (ops, "export_audio", objN ({{ "file", expFile.getFullPathName() }, { "format", "wav" }}))),
                   "export_audio ok (render_kept sweep runs on export)");
            auto rows = keptRows();
            check (rows.size() == 2, "export adds exactly ONE render_kept (new transform layer; earlier layer deduped)");
            const auto ea = rows.getLast().getProperty ("args", var());
            check (ea.getProperty ("clipId", var()).toString() == xcid
                       && ea.getProperty ("layerId", var()).toString().isNotEmpty()
                       && ea.getProperty ("cacheKey", var()).toString().isNotEmpty()
                       && ea.getProperty ("adapter", var()).toString() == "transform",
                   "export-triggered render_kept carries the join keys (clipId/layerId/cacheKey/adapter)");
        }

        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", xcid))), "reset after transform ok");
        check (! (bool) xLayer().getProperty ("appliedInPlace", true), "reset cleared the applied transform");
    }

    // ── LoRA rack: selection round-trip + full-fingerprint cache (fake adapter, hermetic).
    // The rack rides the re-imagine layer as a params modifier (like colours); the real
    // SA3 merge path is covered by verify-hardware, not selftest (service-spawning).
    section ("LoRA rack: params + fingerprint");
    {
        auto lt = cmd (ops, "create_track", args1 ("name", "LoraRack"))["data"].getProperty ("trackId", var()).toString();
        // freq 251 is unique to this section: add_test_tone_clip caches the generated
        // WAV by int(freq) and reuses it (duration is NOT in the key), so sharing a
        // frequency with another section that expects a different duration collides.
        auto ltone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", lt }, { "seconds", 1.2 }, { "freq", 251.0 }}));
        const auto lcid = ltone["data"].getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", lcid }, { "adapter", "fake" }, { "mode", "reimagine" }}))),
               "create_render_layer (reimagine, for LoRA rack) ok");

        Array<var> sel;
        { auto* lo = new DynamicObject(); lo->setProperty ("name", "ken-sa3"); lo->setProperty ("value", 100); sel.add (var (lo)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "seed", 3 }, { "nl", 0.4 }, { "loras", var (sel) }}));

        auto lLayer = [&] () -> var {
            auto trk = trackById (lt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == lcid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        { auto lv = lLayer().getProperty ("loras", var());   // keep the var alive past getArray()
          auto* larr = lv.getArray();
          check (larr != nullptr && larr->size() == 1
                 && larr->getReference (0).getProperty ("name", var()).toString() == "ken-sa3"
                 && (double) larr->getReference (0).getProperty ("value", 0) == 100.0,
                 "loras selection round-trips through the snapshot"); }

        auto lr1 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (ok (lr1), "render with a LoRA selection ok (fake)");
        check (lr1["data"].getProperty ("cache", var()).toString() == "miss", "first LoRA render is a cache MISS");
        auto lr2 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr2["data"].getProperty ("cache", var()).toString() == "hit", "identical LoRA re-render is a cache HIT");

        // Strength is in the fingerprint: 100 -> 40 must MISS.
        Array<var> sel40;
        { auto* lo = new DynamicObject(); lo->setProperty ("name", "ken-sa3"); lo->setProperty ("value", 40); sel40.add (var (lo)); }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", var (sel40) }}));
        auto lr3 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr3["data"].getProperty ("cache", var()).toString() == "miss", "LoRA strength change -> cache MISS");

        // Clearing the rack changes the fingerprint too.
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", Array<var>{} }}));
        auto lr4 = cmd (ops, "render_layer", objN ({{ "clipId", lcid }, { "wait", true }}));
        check (lr4["data"].getProperty ("cache", var()).toString() == "miss", "clearing the LoRA rack -> cache MISS");

        // The rack is UNBOUNDED and UNCLAMPED (owner call — no budget rule): all
        // entries stick in order, and value > 100 (deliberate overdrive) survives.
        Array<var> sel3;
        int v3 = 50;
        for (auto* nm : { "a", "b", "c" })
        { auto* lo = new DynamicObject(); lo->setProperty ("name", juce::String (nm)); lo->setProperty ("value", v3); sel3.add (var (lo)); v3 += 40; }
        cmd (ops, "set_render_param", objN ({{ "clipId", lcid }, { "loras", var (sel3) }}));
        { auto lv = lLayer().getProperty ("loras", var());   // keep the var alive past getArray()
          auto* larr = lv.getArray();
          check (larr != nullptr && larr->size() == 3
                 && larr->getReference (0).getProperty ("name", var()).toString() == "a"
                 && larr->getReference (2).getProperty ("name", var()).toString() == "c",
                 "LoRA rack is unbounded (3 entries, order preserved)");
          check (larr != nullptr && larr->size() == 3
                 && (double) larr->getReference (2).getProperty ("value", 0) == 130.0,
                 "LoRA overdrive (value > 100) survives unclamped"); }
    }

    // ─── NRL-MIDI: generative on a MIDI clip (auto-bounce → audio → model) ───
    // "Generative on ANY track": render_layer on a MIDI clip BOUNCES the track's
    // instrument output to audio first, then runs the same FakeAdapter pipeline. The
    // source MIDI is untouched. Because the bounce isn't bit-deterministic, the cache
    // fingerprint hashes a STABLE SOURCE SIGNATURE (MIDI note fields + instrument/FX
    // names, enabled state, param values + automation), NOT the bounced input.wav — so an
    // identical source HITs and editing a note/instrument busts the cache.
    section ("NRL-MIDI: generative on a MIDI clip (auto-bounce)");
    {
        auto mt = cmd (ops, "create_track", args1 ("name", "MidiGen"))["data"].getProperty ("trackId", var()).toString();
        // A MIDI clip with audible notes (add_midi_clip auto-loads a 4OSC instrument).
        Array<var> notes;
        for (int i = 0; i < 4; ++i) { auto* n = new DynamicObject();
            n->setProperty ("pitch", 60 + i * 2); n->setProperty ("start", (double) i * 0.5);
            n->setProperty ("length", 0.5); n->setProperty ("velocity", 100); notes.add (var (n)); }
        auto mc = cmd (ops, "add_midi_clip", objN ({{ "trackId", mt }, { "length", 2.0 }, { "notes", notes }}));
        check (ok (mc), "add_midi_clip (with notes) ok");
        const auto mcid = mc["data"].getProperty ("clipId", var()).toString();

        auto noteCount = [&] (const String& cid) -> int {
            auto trk = trackById (mt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == cid)
                    return (int) c.getProperty ("notes", var()).size();
            return -1;
        };
        const int notesBefore = noteCount (mcid);
        check (notesBefore == 4, "midi clip has 4 notes before render");

        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", mcid }, { "adapter", "fake" }}));
        check (ok (crl), "create_render_layer on a MIDI clip ok");
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();
        cmd (ops, "set_render_param", objN ({{ "clipId", mcid }, { "seed", 7 }, { "nl", 0.3 }}));

        // The headline: render SUCCEEDS on a MIDI clip (previously errored "only wave
        // clips renderable") — the auto-bounce staged input.wav and the model ran.
        auto r1 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (r1), "render_layer on a MIDI clip ok (auto-bounced to audio, model ran)");
        check (r1["data"].getProperty ("status", var()).toString() == "ready", "MIDI render -> status ready");
        check (r1["data"].getProperty ("cache", var()).toString() == "miss", "first MIDI render is a cache MISS");

        // The bounce wrote a real, non-trivial input.wav (audio, not MIDI).
        auto input = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("input.wav");
        check (input.existsAsFile() && input.getSize() > 1000, "auto-bounce wrote a non-trivial input.wav");

        bool mHasArtifact = false; bool stillMidi = false;
        { auto trk = trackById (mt);
          if (auto* arr = trk.getProperty ("clips", var()).getArray())
            for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == mcid)
            { mHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false);
              stillMidi = c.getProperty ("type", var()).toString() == "midi"; } }
        check (mHasArtifact, "MIDI render produced a cached artifact (output.wav)");

        // The SOURCE clip is untouched — still MIDI, same notes (non-destructive).
        check (stillMidi, "source clip is still a MIDI clip after render");
        check (noteCount (mcid) == notesBefore, "source MIDI clip notes unchanged after render");

        // Identical re-render -> cache HIT (the builtin-synth bounce is deterministic).
        auto r2 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (r2["data"].getProperty ("cache", var()).toString() == "hit", "identical MIDI re-render is a cache HIT");

        // Editing a NOTE changes the stable source signature -> cache MISS.
        // (Proves the source-signature fingerprint folds MIDI note content in.)
        cmd (ops, "add_note", objN ({{ "clipId", mcid }, { "pitch", 72 }, { "start", 0.0 }, { "length", 0.5 }, { "velocity", 100 }}));
        auto r3 = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (r3["data"].getProperty ("cache", var()).toString() == "miss", "editing a note -> source signature changed -> cache MISS");

        // Bypassing the instrument changes the bounced audio AND the source signature ->
        // cache MISS. Guards the enabled-state coverage: a stale render must NOT survive a
        // bypass (the dangerous "serves the wrong audio" direction).
        int instIdx = -1;
        { auto trk = trackById (mt);
          if (auto* arr = trk.getProperty ("plugins", var()).getArray())
            for (auto& pl : *arr) if ((bool) pl.getProperty ("isInstrument", false))
                { instIdx = (int) pl.getProperty ("index", -1); break; } }
        check (instIdx >= 0, "MIDI track has an instrument plugin to bypass");
        cmd (ops, "bypass_plugin", objN ({{ "trackId", mt }, { "index", instIdx }, { "bypassed", true } }));
        auto rb = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (rb["data"].getProperty ("cache", var()).toString() == "miss", "bypassing the instrument -> cache MISS (no stale render served)");

        // Phase 2 — a MIDI/drum re-imagine AUTO-APPLIES beneath the clip: the source MIDI is muted
        // and a HIDDEN, instrument-free audio render plays in its place. The hidden track is EXCLUDED
        // from the snapshot (the producer hears it but never sees it), so the structural proof that
        // the render exists is `reimagineActive` (kSourceMutedByLayer + a live landed clip). No accept
        // step, no "Neural Renders" lane, and no new VISIBLE track.
        auto midiClipVar = [&] () -> var {
            auto trk = trackById (mt);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == mcid) return c;
            return {};
        };
        auto reimagineActive = [&] () -> bool {
            return (bool) midiClipVar().getProperty ("renderLayer", var()).getProperty ("reimagineActive", false);
        };
        auto visibleTracks = [&] () -> int {
            auto snap = ops.snapshot();
            auto* arr = snap["tracks"].getArray();
            return arr != nullptr ? arr->size() : 0;
        };
        auto neuralLanesM = [&] () -> int {
            int n = 0; auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders"
                                         || t.getProperty ("name", var()).toString().contains ("hidden")) ++n;
            return n;
        };
        const int tracksBeforeApply = visibleTracks();
        check ((bool) midiClipVar().getProperty ("mute", false), "MIDI source muted under the beneath-render");
        check (reimagineActive(), "MIDI render is active beneath the clip (reimagineActive)");
        check (neuralLanesM() == 0, "no VISIBLE 'Neural Renders'/hidden lane for a MIDI beneath-render");
        check (visibleTracks() == tracksBeforeApply, "the hidden render track is excluded from the snapshot");

        // accept_render is a no-op for the beneath model — no new lane, no extra visible track.
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mcid))), "accept_render (MIDI beneath) ok (no-op)");
        check (neuralLanesM() == 0 && visibleTracks() == tracksBeforeApply, "accept created no lane and no visible track");

        // bypass routes back to the LIVE instrument: the MIDI un-mutes (reimagineActive holds — the
        // hidden clip still exists, just muted).
        check (ok (cmd (ops, "bypass_layer", objN ({{ "clipId", mcid }, { "bypassed", true }}))), "bypass_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "bypass un-mutes the source MIDI");
        cmd (ops, "bypass_layer", objN ({{ "clipId", mcid }, { "bypassed", false }}));
        check ((bool) midiClipVar().getProperty ("mute", false), "un-bypass re-mutes the source MIDI");

        // reset removes the hidden audio + un-mutes the MIDI (back to the editable instrument).
        check (ok (cmd (ops, "reset_render_layer", args1 ("clipId", mcid))), "reset_render_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "reset un-muted the MIDI");
        check (! reimagineActive(), "reset cleared reimagineActive (hidden clip gone)");

        // TASTE-002 — the beneath-model reset is the SAME negative taste event: the label
        // must carry the join keys from the layer node (layerId/cacheKey).
        {
            var lastReset;
            for (auto& l : StringArray::fromLines (eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString()))
                if (l.contains ("\"reset_render_layer\""))
                {
                    const auto row = JSON::parse (l);   // named local — the var-temporary UAF class
                    if (row.getProperty ("command", var()).toString() == "reset_render_layer") lastReset = row;
                }
            const auto ba = lastReset.getProperty ("args", var());
            check (ba.getProperty ("clipId", var()).toString() == mcid
                       && ba.getProperty ("layerId", var()).toString().isNotEmpty()
                       && ba.getProperty ("cacheKey", var()).toString().isNotEmpty(),
                   "beneath-model reset logs the taste label with join keys (clipId/layerId/cacheKey)");
        }

        // re-render after reset re-applies beneath (cache HIT re-lands the hidden clip).
        auto rRe = cmd (ops, "render_layer", objN ({{ "clipId", mcid }, { "wait", true }}));
        check (ok (rRe), "re-render after reset (MIDI) ok");
        check (reimagineActive() && (bool) midiClipVar().getProperty ("mute", false),
               "re-render re-applied beneath (reimagineActive, MIDI muted)");

        // remove_render_layer tears down the hidden clip + un-mutes (no strand).
        check (ok (cmd (ops, "remove_render_layer", args1 ("clipId", mcid))), "remove_render_layer (MIDI) ok");
        check (! (bool) midiClipVar().getProperty ("mute", true), "remove_render_layer un-muted the MIDI");
    }

    // ─── Section-scoped render (the agent "rework the hook" path) ───
    // A render layer with an explicit sub-region renders ONLY that region's audio and
    // lands the result bounded to the region — proving create_render_layer
    // regionStart/regionEnd → a sliced input.wav → a region-bounded landing.
    section ("Section-scoped render (rework-the-hook)");
    {
        auto st = cmd (ops, "create_track", args1 ("name", "Scoped"))["data"].getProperty ("trackId", var()).toString();
        auto tone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st }, { "seconds", 2.0 }, { "freq", 220.0 }}));
        const auto scid = tone["data"].getProperty ("clipId", var()).toString();

        // Scope to a 0.5 s sub-region [0.5, 1.0] of the 2 s clip.
        auto crl = cmd (ops, "create_render_layer", objN ({{ "clipId", scid }, { "adapter", "fake" },
                                                           { "regionStart", 0.5 }, { "regionEnd", 1.0 }}));
        check (ok (crl), "create_render_layer with a sub-region ok");
        const auto layerId = crl["data"].getProperty ("layerId", var()).toString();

        // The snapshot reports the clamped sub-region, not the whole clip span.
        auto layerVar = [&] () -> var {
            auto trk = trackById (st);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr) if (c.getProperty ("id", var()).toString() == scid)
                    return c.getProperty ("renderLayer", var());
            return {};
        };
        check (std::abs ((double) layerVar().getProperty ("regionStart", -1.0) - 0.5) < 1e-3, "layer region start = 0.5 s");
        check (std::abs ((double) layerVar().getProperty ("regionEnd",   -1.0) - 1.0) < 1e-3, "layer region end   = 1.0 s");

        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", scid }, { "wait", true }}));
        check (ok (rr), "section-scoped render_layer ok");

        // The staged input.wav was SLICED to ~0.5 s — not the whole 2 s clip.
        auto inputWav = eng.sessionDir().getChildFile ("renders").getChildFile (layerId).getChildFile ("input.wav");
        double inputDur = -1.0;
        { AudioFormatManager fm; fm.registerBasicFormats();
          if (std::unique_ptr<AudioFormatReader> rd { fm.createReaderFor (inputWav) }; rd && rd->sampleRate > 0.0)
              inputDur = (double) rd->lengthInSamples / rd->sampleRate; }
        check (inputWav.existsAsFile(), "section render staged an input.wav");
        check (inputDur > 0.3 && inputDur < 0.8, "input.wav is the SECTION region (~0.5 s), not the whole clip (2 s)");

        // Accept lands the render bounded to the region: start ~0.5 s, length ~0.5 s.
        check (ok (cmd (ops, "accept_render", args1 ("clipId", scid))), "section-scoped accept_render ok");
        bool scopedLanding = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                if (auto* cs = t.getProperty ("clips", var()).getArray())
                    for (auto& c : *cs)
                    {
                        const double cstart = (double) c.getProperty ("start", -1.0);
                        const double clen   = (double) c.getProperty ("length", -1.0);
                        if (std::abs (cstart - 0.5) < 0.05 && std::abs (clen - 0.5) < 0.1) scopedLanding = true;
                    } }
        check (scopedLanding, "accepted render landed bounded to the section (start ~0.5 s, length ~0.5 s)");

        // METER-001 — the auto-created "Neural Renders" lane is metered too (no explicit
        // enable_track_meter call), same as any other track-creation path.
        bool neuralLaneMetered = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                neuralLaneMetered = (bool) t.getProperty ("meterEnabled", false); }
        check (neuralLaneMetered, "METER-001: the auto-created Neural Renders lane is metered");

        // A whole-clip render (no region) still works — guards the default path.
        auto st2 = cmd (ops, "create_track", args1 ("name", "Whole"))["data"].getProperty ("trackId", var()).toString();
        auto tone2 = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", st2 }, { "seconds", 1.0 }, { "freq", 180.0 }}));
        const auto wcid = tone2["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", wcid }, { "adapter", "fake" }}));
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", wcid }, { "wait", true }}))),
               "whole-clip render (no region) still renders (default path unchanged)");

        // REGRESSION (review): the stored timeRange is frozen at create. A WHOLE-clip
        // layer whose clip is MOVED after creation must still render (whole source) and
        // land at the clip's LIVE position — the staging/landing clamp to the live clip
        // prevents a stale-region mis-stage (hard error) or a stale landing.
        auto mvt = cmd (ops, "create_track", args1 ("name", "Moved"))["data"].getProperty ("trackId", var()).toString();
        auto mvtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", mvt }, { "seconds", 1.0 }, { "freq", 175.0 }}));
        const auto mvcid = mvtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", mvcid }, { "adapter", "fake" }}));   // whole-clip, no region
        cmd (ops, "move_clip", objN ({{ "clipId", mvcid }, { "start", 3.0 }}));                  // move AFTER create
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", mvcid }, { "wait", true }}))),
               "whole-clip layer still renders after the clip moved (no stale-region error)");
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mvcid))), "accept after move ok");
        bool landedAtLive = false;
        { auto snap = ops.snapshot();
          if (auto* arr = snap["tracks"].getArray())
            for (auto& t : *arr) if (t.getProperty ("name", var()).toString() == "Neural Renders")
                if (auto* cs2 = t.getProperty ("clips", var()).getArray())
                    for (auto& c : *cs2)
                        if (std::abs ((double) c.getProperty ("start", -1.0) - 3.0) < 0.05) landedAtLive = true; }
        check (landedAtLive, "moved whole-clip render lands at the clip's LIVE position (3.0 s), not the stale create spot");
    }

    // ─── bounce_layer_to_clip: the "bounced" relabel rides the undo history ───
    // BUG (found wiring UI reachability): cmdBounceLayerToClip wrote status="bounced" with a
    // nullptr UndoManager, while the accept_render it wraps — and cmdFreezeLayer four lines
    // above it — write THROUGH the undo manager. The label therefore desynced from the clip it
    // describes: on the lane path a redo re-landed the clip but lost the "bounced" mark, and on
    // the no-op relabel paths (whole-clip wave / MIDI-beneath, where accept returns early and
    // opens no transaction at all) the mark was untracked entirely and stuck forever. A UI gate
    // keyed on status != "bounced" would then hide its own button permanently, so this is a
    // prerequisite for ever wiring that control (UI_REACH_GAPS).
    section ("bounce_layer_to_clip is undo-tracked");
    {
        auto statusOf = [&] (const String& trackId, const String& clipId) -> String {
            auto trk = trackById (trackId);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clipId)
                        return c.getProperty ("renderLayer", var()).getProperty ("status", var()).toString();
            return {};
        };
        auto nameOf = [&] (const String& trackId, const String& clipId) -> String {
            auto trk = trackById (trackId);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == clipId)
                        return c.getProperty ("name", var()).toString();
            return {};
        };
        auto neuralClipCount = [&] () -> int {
            int n = 0;
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& t : *arr)
                    if (t.getProperty ("name", var()).toString() == "Neural Renders")
                        if (auto* cs = t.getProperty ("clips", var()).getArray())
                            n += cs->size();
            return n;
        };

        // (a) LANE path — a sub-region render is not applied in place, so the accept wrapped by
        // bounce genuinely lands a clip. One command must be one undo step: undo takes the clip
        // AND the label, redo brings both back.
        auto bt = cmd (ops, "create_track", args1 ("name", "Bounce"))["data"].getProperty ("trackId", var()).toString();
        auto btone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", bt }, { "seconds", 2.0 }, { "freq", 205.0 }}));
        const auto bcid = btone["data"].getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", bcid }, { "adapter", "fake" },
                                                           { "regionStart", 0.5 }, { "regionEnd", 1.0 }}))),
               "bounce: create_render_layer (sub-region) ok");
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", bcid }, { "wait", true }}))),
               "bounce: render_layer ok");

        const int beforeBounce = neuralClipCount();
        check (ok (cmd (ops, "bounce_layer_to_clip", args1 ("clipId", bcid))), "bounce_layer_to_clip ok");
        check (statusOf (bt, bcid) == "bounced", "bounce marked the layer status \"bounced\"");
        check (neuralClipCount() == beforeBounce + 1, "bounce landed the render as a clip on the neural lane");

        check (ok (cmd (ops, "undo")), "bounce: undo ok");
        check (neuralClipCount() == beforeBounce, "undo removed the landed clip");
        check (statusOf (bt, bcid) != "bounced",
               "undo left no \"bounced\" label on a layer whose clip is gone");
        // RED before the fix: the relabel was never recorded, so replaying the transaction
        // restored the clip but not the mark — a bounced layer reading back as merely "ready".
        check (ok (cmd (ops, "redo")), "bounce: redo ok");
        check (neuralClipCount() == beforeBounce + 1, "redo re-landed the bounced clip");
        check (statusOf (bt, bcid) == "bounced", "redo restored the \"bounced\" label with its clip");

        // (b) NO-OP relabel path — a whole-clip wave render auto-applies in place, so the
        // wrapped accept returns early without opening a transaction. The relabel must still be
        // its own undo step: neither stuck forever (untracked) nor folded into whatever command
        // happened to run before it (which undo would then destroy along with the label).
        auto wt = cmd (ops, "create_track", args1 ("name", "BounceWhole"))["data"].getProperty ("trackId", var()).toString();
        auto wtone = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", wt }, { "seconds", 1.0 }, { "freq", 195.0 }}));
        const auto wcid2 = wtone["data"].getProperty ("clipId", var()).toString();
        cmd (ops, "create_render_layer", objN ({{ "clipId", wcid2 }, { "adapter", "fake" }}));
        check (ok (cmd (ops, "render_layer", objN ({{ "clipId", wcid2 }, { "wait", true }}))),
               "bounce (whole clip): render_layer ok");

        const int beforeNoop = neuralClipCount();
        check (ok (cmd (ops, "rename_clip", objN ({{ "clipId", wcid2 }, { "name", "sentinel" }}))),
               "bounce (whole clip): sentinel edit before the bounce ok");
        check (ok (cmd (ops, "bounce_layer_to_clip", args1 ("clipId", wcid2))),
               "bounce_layer_to_clip (whole clip, no-op relabel) ok");
        check (statusOf (wt, wcid2) == "bounced", "whole-clip bounce marked the layer \"bounced\"");
        check (neuralClipCount() == beforeNoop, "whole-clip bounce landed no lane clip (applied in place)");

        check (ok (cmd (ops, "undo")), "bounce (whole clip): undo ok");
        check (statusOf (wt, wcid2) != "bounced",
               "undo cleared the \"bounced\" label (not stuck forever behind a null UndoManager)");
        check (nameOf (wt, wcid2) == "sentinel",
               "undoing the relabel did NOT also revert the preceding edit");
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

        // AUD-017 — retry_audio_device is the recovery half of the bounded startup open.
        // In a headless run audio was never REQUESTED, so it must refuse without going
        // anywhere near the HAL: that guard is what keeps --selftest hermetic (a retry
        // that opened a device here would make the harness depend on this machine's
        // audio hardware, and could hang exactly the way the ticket describes).
        check (! eng.audioRequested(), "headless selftest never requests audio (hermeticity precondition)");
        check (! eng.hasAudio(), "headless selftest has no open audio device");
        auto rad = cmd (ops, "retry_audio_device");
        check (! ok (rad), "retry_audio_device refuses when the session never wanted audio");
        check (rad.getProperty ("error", var()).toString().contains ("no audio device"),
               "retry_audio_device error mentions no audio device");
        check (eng.audioDeviceError().isEmpty(),
               "a refused retry leaves no phantom device error behind");

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

    // ─── Project safety: open_recent by index (AL-007) ───
    // The Recent list (snapshot.session.recentProjects) needs a first-class "open the
    // Nth recent project" command so the UI / agent reopen by position without
    // round-tripping a path that may have been pruned. open_recent resolves the index
    // against the SAME existing-file Recent list the snapshot exposes; out-of-range and
    // already-deleted entries degrade to clean error results. It is NOT undoable (it
    // replaces the whole Edit, like open_project).
    section ("Project safety: open_recent by index (AL-007)");
    {
        const auto sessionEdit = eng.editFile();

        // Seed two distinct projects so the Recent list has a stable newest-first order:
        // open A then B → recent[0]=B (current, newest), recent[1]=A.
        check (ok (cmd (ops, "new_project", args1 ("name", "recent-A"))), "new_project recent-A ok");
        const auto editA = eng.editFile();
        check (ok (cmd (ops, "new_project", args1 ("name", "recent-B"))), "new_project recent-B ok");
        const auto editB = eng.editFile();

        auto recents = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        check (recents.isArray() && recents.size() >= 2, "recentProjects has >= 2 entries for the index test");
        check (recents[0].getProperty ("path", var()).toString() == editB.getFullPathName(), "recent[0] is the newest project (B)");

        // (a) open_recent index 1 reopens the OLDER project (A) — proves index→path resolution.
        check (ok (cmd (ops, "open_recent", args1 ("index", 1))), "open_recent index 1 ok");
        check (eng.editFile() == editA, "open_recent index 1 opened the older project (A)");
        check (eng.startupEditFile() == editA, "open_recent updates the remembered last project");

        // (b) index 0 reopens the most-recent. After (a), opening A bumped it to recent[0],
        //     so index 0 now re-resolves to A (the live list, not a stale snapshot).
        check (ok (cmd (ops, "open_recent", args1 ("index", 0))), "open_recent index 0 ok");
        check (eng.editFile() == editA, "open_recent index 0 opened the most-recent project");

        // (c) validation: missing / negative / out-of-range index → clean error, no swap.
        const auto before = eng.editFile();
        check (! ok (cmd (ops, "open_recent", var (new DynamicObject()))), "open_recent without an index errors");
        check (! ok (cmd (ops, "open_recent", args1 ("index", -1))), "open_recent with a negative index errors");
        check (! ok (cmd (ops, "open_recent", args1 ("index", 999))), "open_recent with an out-of-range index errors");
        check (eng.editFile() == before, "a rejected open_recent leaves the current Edit untouched");

        // (d) a pruned (no-longer-on-disk) recent entry is skipped by recentProjects, so an
        //     index that pointed at it now resolves past it or errors — never opens a ghost.
        editB.deleteFile();
        auto pruned = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
        bool ghostListed = false;
        for (int i = 0; i < pruned.size(); ++i)
            if (pruned[i].getProperty ("path", var()).toString() == editB.getFullPathName())
                ghostListed = true;
        check (! ghostListed, "a deleted project is dropped from recentProjects (no ghost index)");

        // (e) leaving a project and coming straight back by index. The "outgoing project
        //     stays in Recent" invariant itself is pinned at the harness's FIRST project
        //     op (see the G1 export section) — by this point every project here has
        //     already been remembered as some earlier command's INCOMING file, so a check
        //     placed here would pass with or without that fix. What this adds is the
        //     round trip: leave, then reopen the one you left, by position.
        {
            const auto leaving = eng.editFile();
            check (ok (cmd (ops, "new_project", args1 ("name", "recent-C"))), "new_project recent-C ok");
            auto rc = ops.snapshot().getProperty ("session", var()).getProperty ("recentProjects", var());
            check (rc.size() > 1 && rc[1].getProperty ("path", var()).toString() == leaving.getFullPathName(),
                   "the project we left sits directly behind the new one in Recent");
            check (ok (cmd (ops, "open_recent", args1 ("index", 1))), "open_recent index 1 reopens the project we left");
            check (eng.editFile() == leaving, "the left-behind project reopened by index");
        }

        // teardown: restore the harness session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (AL-007 teardown)");
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
        auto destDir  = selftestTempPath (eng, "portable-src");
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
        auto moved = selftestTempPath (eng, "portable-moved");
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

    // ─── AL-009 — Save-As render-artifact consolidation + portability ───
    // A Tier-B render layer's cacheArtifact (the file freeze_layer / re-accept_render
    // depend on) is written by finalizeRender as an ABSOLUTE path into the shared session
    // pool, NOT the project dir — so before AL-009 a Save-As'd + moved project's render
    // either pointed back at a pool that no longer exists (freeze/accept failed) or simply
    // wasn't portable. The fix consolidates each render artifact into the project's
    // audio/renders/ on Save-As, re-points cacheArtifact RELATIVE, and resolves it
    // move-aware at every read. This proves the rendered audio survives a project move.
    section ("AL-009: Save-As render-artifact consolidation + portability");
    {
        const auto sessionEdit = eng.editFile();
        const auto poolDir     = eng.sessionDir();

        auto trackById2 = [&] (const String& tid) -> var {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid) return trks[i];
            return var();
        };
        auto renderLayerOf = [&] (const String& tid, const String& cid) -> var {
            auto trk = trackById2 (tid);
            if (auto* arr = trk.getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == cid)
                        return c.getProperty ("renderLayer", var());
            return {};
        };
        // Find the (only) clip carrying a render layer, by scanning the live snapshot — robust
        // to any clip-id reassignment a reload might do (the open-the-moved-project step below).
        auto clipWithRenderLayer = [&] () -> String {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (auto* arr = trks[i].getProperty ("clips", var()).getArray())
                    for (auto& c : *arr)
                        if ((bool) c.getProperty ("hasRenderLayer", false))
                            return c.getProperty ("id", var()).toString();
            return {};
        };

        // Fresh project with a clip that carries a rendered layer (fake adapter, deterministic).
        check (ok (cmd (ops, "new_project", args1 ("name", "renders-portable"))), "new_project renders-portable ok");
        const auto rt  = cmd (ops, "create_track", args1 ("name", "Gen"))["data"].getProperty ("trackId", var()).toString();
        const auto rcid = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", rt }, { "seconds", 1.0 }, { "freq", 196.0 }}))["data"]
                              .getProperty ("clipId", var()).toString();
        check (ok (cmd (ops, "create_render_layer", objN ({{ "clipId", rcid }, { "adapter", "fake" }}))), "create_render_layer (fake) ok");
        cmd (ops, "set_render_param", objN ({{ "clipId", rcid }, { "seed", 7 }}));
        auto rr = cmd (ops, "render_layer", objN ({{ "clipId", rcid }, { "wait", true }}));
        check (ok (rr), "render_layer ok (artifact produced in the session pool)");
        check ((bool) renderLayerOf (rt, rcid).getProperty ("hasArtifact", false), "render produced a cached artifact");

        // Save As to a standalone dir OUTSIDE the pool → render artifacts consolidate local.
        auto destDir  = selftestTempPath (eng, "renders-portable");
        destDir.deleteRecursively(); destDir.createDirectory();
        auto destEdit = destDir.getChildFile ("renders.tracktionedit");
        check (ok (cmd (ops, "save_as", args1 ("file", destEdit.getFullPathName()))), "save_as ok");
        auto rendersDir = destDir.getChildFile ("audio").getChildFile ("renders");
        check (rendersDir.isDirectory(), "save_as created a project-local audio/renders/ dir");
        check (rendersDir.getNumberOfChildFiles (File::findFiles) >= 1, "save_as consolidated the render artifact into the project");
        check ((bool) renderLayerOf (rt, rcid).getProperty ("hasArtifact", false), "render artifact still resolves after consolidation (relative)");

        // The on-disk edit must reference the render artifact RELATIVELY (portable), never
        // the absolute session pool — otherwise the move below would break.
        const auto xml = destEdit.loadFileAsString();
        check (! xml.contains (poolDir.getFullPathName()), "saved edit has no absolute session-pool render path");
        check (xml.contains ("audio/renders/") && ! xml.contains ("../audio/renders/"),
               "saved edit references the render artifact by a co-located relative path (no ../)");

        // PROVE portability: copy the whole project elsewhere, DELETE the original pool
        // render so resolution can ONLY succeed via the co-located copy, then open the copy
        // and prove freeze/accept (the artifact-gated ops) still work — the AL-009 payoff.
        auto moved = selftestTempPath (eng, "renders-moved");
        moved.deleteRecursively();
        check (destDir.copyDirectoryTo (moved), "copied the render project to a new location");
        poolDir.getChildFile ("renders").deleteRecursively();   // hide the original pool artifact
        check (ok (cmd (ops, "open_project", args1 ("file", moved.getChildFile ("renders.tracktionedit").getFullPathName()))), "open the moved render project ok");
        const auto mcid = clipWithRenderLayer();   // re-derive from the reloaded project (id-reassign safe)
        check (mcid.isNotEmpty(), "moved project restored the clip + its render layer");
        bool movedHasArtifact = false;
        { auto trks = ops.snapshot().getProperty ("tracks", var());
          for (int i = 0; i < trks.size() && ! movedHasArtifact; ++i)
            if (auto* arr = trks[i].getProperty ("clips", var()).getArray())
                for (auto& c : *arr)
                    if (c.getProperty ("id", var()).toString() == mcid)
                        movedHasArtifact = (bool) c.getProperty ("renderLayer", var()).getProperty ("hasArtifact", false); }
        check (movedHasArtifact, "moved project's render artifact resolves to the co-located copy (portable)");
        check (ok (cmd (ops, "freeze_layer", args1 ("clipId", mcid))),
               "freeze_layer succeeds on the moved project (artifact survived the move)");
        // The in-place render survived the move: accept is a no-op for the wave clip (no lane),
        // and the layer is still applied in place (the clip plays the consolidated render).
        const int tracksBeforeAccept = tracks (ops);
        check (ok (cmd (ops, "accept_render", args1 ("clipId", mcid))), "accept_render ok on the moved project (no-op for wave)");
        check (tracks (ops) == tracksBeforeAccept, "wave accept creates no lane on the moved project");

        // teardown — restore the session edit for later sections.
        check (ok (cmd (ops, "open_project", args1 ("file", sessionEdit.getFullPathName()))), "restored the session edit (AL-009 teardown)");
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

    // ─── PRJ-FMT — project FORMAT version + migration + newer-file refusal ───
    // The Mosh format version is stamped on the MOSH_PROJECT node on every save
    // (state/Migrations.h). On open, an OLDER (or unversioned) file migrates forward; a
    // NEWER file is REFUSED outright and the current project is kept loaded + saveable. This
    // section is self-contained and self-restoring (it ends by reopening the original edit)
    // so it does not disturb later sections.
    section ("PRJ-FMT: project format version + migration + newer-file refusal");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };
        auto fmtVersion = [&] { return (int) proj().getProperty ("formatVersion", var (-1)); };

        const auto origFile = eng.editFile();

        // Save → the stamp lands on disk and the snapshot reports the current version.
        check (ok (cmd (ops, "save")), "PRJ-FMT: save ok");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: snapshot reports current formatVersion after save");

        // Save → reload → the version round-trips with the .tracktionedit.
        check (ok (cmd (ops, "reload")), "PRJ-FMT: reload ok");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: formatVersion survived save+reload");

        // Fabricate a NEWER-format file (copy the saved edit, bump moshFormatVersion) →
        // open_project REFUSES it and keeps the current project loaded.
        auto bumpFile = eng.sessionDir().getChildFile ("prjfmt-newer.tracktionedit");
        if (auto xml = juce::XmlDocument::parse (origFile))
        {
            if (auto* mp = xml->getChildByName ("MOSH_PROJECT"))
                mp->setAttribute ("moshFormatVersion", kMoshFormatVersion + 1);
            bumpFile.replaceWithText (xml->toString());
        }
        auto refused = cmd (ops, "open_project", args1 ("file", bumpFile.getFullPathName()));
        check (! ok (refused), "PRJ-FMT: open_project REFUSES a newer-format file");
        check (refused.getProperty ("error", var()).toString().contains ("newer version of Mosh"),
               "PRJ-FMT: refusal error names a newer Mosh version");
        check (eng.editFile() == origFile, "PRJ-FMT: refused open kept the current project loaded");

        // Fabricate a LEGACY file (strip the stamp ⇒ v0) → open_project MIGRATES it forward.
        auto legacyFile = eng.sessionDir().getChildFile ("prjfmt-legacy.tracktionedit");
        if (auto xml = juce::XmlDocument::parse (origFile))
        {
            if (auto* mp = xml->getChildByName ("MOSH_PROJECT"))
                mp->removeAttribute ("moshFormatVersion");
            legacyFile.replaceWithText (xml->toString());
        }
        check (ok (cmd (ops, "open_project", args1 ("file", legacyFile.getFullPathName()))),
               "PRJ-FMT: open_project accepts a legacy (unversioned) file");
        check (fmtVersion() == kMoshFormatVersion, "PRJ-FMT: legacy file migrated forward to current version");

        // Restore the original session edit so later sections are undisturbed.
        check (ok (cmd (ops, "open_project", args1 ("file", origFile.getFullPathName()))),
               "PRJ-FMT: restore original project ok");
        bumpFile.deleteFile();
        legacyFile.deleteFile();
    }

    // ─── A2 — crash-recovery liveness sentinel ───
    // The GUI writes a session.running sentinel once the window is live and deletes it on a
    // clean quit; its presence at the next launch flags an unclean exit (a prior crash). The
    // headless harness uses a wiped freshSession dir + never marks it, so it always reads
    // clean. We exercise the mark/clear primitives + the clean-start read directly (the
    // ctor latch is GUI-only). Self-contained: leaves the sentinel cleared.
    section ("A2: crash-recovery liveness sentinel");
    {
        auto sentinel = eng.sessionDir().getChildFile ("session.running");
        check (! eng.wasUncleanShutdown(), "A2: fresh headless start reads clean (no prior sentinel)");
        check (! ops.snapshot().getProperty ("session", var()).hasProperty ("recoveryAvailable"),
               "A2: snapshot omits recoveryAvailable on a clean start");
        eng.markSessionRunning();
        check (sentinel.existsAsFile(), "A2: markSessionRunning writes the sentinel");
        eng.clearSessionRunning();
        check (! sentinel.existsAsFile(), "A2: clearSessionRunning removes the sentinel (clean-quit path)");
    }

    // ─── Scoped snapshot invalidation (D1-justified) ───
    // A track-local mutation (mixer volume/pan/mute, plugin param) emits snapshot_invalidated
    // carrying JUST that track's var, so the UI patches one track instead of re-pulling the
    // whole snapshot (measured 330 ms / 3.7 MiB at 100 tracks). Structural changes still emit
    // a payload-less FULL invalidation.
    section ("Scoped invalidation: track-local mutations emit a scoped patch");
    {
        auto t = cmd (ops, "create_track", args1 ("name", "ScopeT"));
        check (ok (t), "scoped: create track ok");
        const auto trackId = t["data"].getProperty ("trackId", var()).toString();

        // create_track is structural → FULL invalidation (no scope payload).
        check (lastEvent.getProperty ("type", var()).toString() == "snapshot_invalidated",
               "scoped: create_track emitted snapshot_invalidated");
        check (! lastEvent.getProperty ("payload", var()).getProperty ("scope", var()).isString(),
               "scoped: create_track is a FULL invalidation (no scope)");

        // set_track_volume is track-local → SCOPED patch carrying this track's var.
        check (ok (cmd (ops, "set_track_volume", objN ({{ "trackId", trackId }, { "db", -6.0 }}))),
               "scoped: set_track_volume ok");
        auto payload = lastEvent.getProperty ("payload", var());
        check (payload.getProperty ("scope", var()).toString() == "track", "scoped: set_track_volume emits scope=track");
        check (payload.getProperty ("trackId", var()).toString() == trackId, "scoped: patch carries the changed trackId");
        check (payload.getProperty ("track", var()).isObject(), "scoped: patch carries the track var");
        check (payload.getProperty ("track", var()).getProperty ("id", var()).toString() == trackId,
               "scoped: patch track var has the right id");

        cmd (ops, "remove_track", args1 ("trackId", trackId));   // tidy
    }

    // ─── A3 — recovery-journal mechanics (allowlist + truncate-on-save) ───
    // execute() journals only REPLAYABLE arrangement commands to recovery-journal.jsonl; every
    // save truncates it (the saved edit supersedes the unsaved tail). The full cross-restart
    // replay + id-rebinding is proven by verify.py's check_crash_recovery (KEEP_SESSION + __crash).
    section ("A3: recovery journal mechanics");
    {
        auto journal = eng.sessionDir().getChildFile ("recovery-journal.jsonl");
        auto journalLines = [&] {
            if (! journal.existsAsFile()) return 0;
            int n = 0;
            for (auto& l : juce::StringArray::fromLines (journal.loadFileAsString())) if (l.trim().isNotEmpty()) ++n;
            return n;
        };

        check (ok (cmd (ops, "save")), "A3: save ok");
        check (journalLines() == 0, "A3: journal empty after save");

        auto jt = cmd (ops, "create_track", args1 ("name", "JT"));
        const auto jid = jt["data"].getProperty ("trackId", var()).toString();
        check (journalLines() == 1, "A3: a replayable command (create_track) is journaled");

        cmd (ops, "set_transport", args1 ("action", "stop"));   // not in the replay allowlist
        check (journalLines() == 1, "A3: a non-replayable command (set_transport) is NOT journaled");

        check (ok (cmd (ops, "save")), "A3: save again ok");
        check (journalLines() == 0, "A3: save truncates the journal (saved edit supersedes the tail)");

        cmd (ops, "remove_track", args1 ("trackId", jid));   // tidy
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

    // ─── G2b — count-in / pre-roll bars before recording ───
    // Stored on the same MOSH_PROJECT node as key/timeBase (saves/reloads with the
    // .tracktionedit); set_count_in is a NON-undoable preference (cmdSetKey template
    // exactly). ENGINE-WIRED, not just stored: MoshOps::applyCountInToEdit() pushes the
    // value into tracktion_engine's own pre-roll (te::Edit::setCountInMode), which
    // TransportControl's record-start logic already consults
    // (Edit::getNumCountInBeats()) to roll the playhead back N beats and play an audible
    // click before capture actually begins. bars is deliberately {0,1,2}, matching
    // te::Edit::CountIn::none/oneBar/twoBar (headless selftest can't exercise the
    // audible/timing behavior itself — that needs a real audio device — but proves the
    // command's validation/snapshot/persistence/non-undoable-preference contract).
    section ("G2b: count-in / pre-roll (set_count_in, snapshot.project.countInBars, persistence)");
    {
        auto sess = [&] { return ops.snapshot().getProperty ("session", var()); };
        auto proj = [&] { return sess().getProperty ("project", var()); };

        // Snapshot ALWAYS exposes session.project.countInBars with the 0 (off) default,
        // mirrored to session.countInBars (like session.key / session.project.key).
        check (proj().hasProperty ("countInBars"), "snapshot session.project.countInBars present");
        check ((int) proj().getProperty ("countInBars", -1) == 0, "session.project.countInBars defaults to 0 (off)");
        check ((int) sess().getProperty ("countInBars", -1) == 0, "session.countInBars mirror defaults to 0 (off)");

        // Required arg.
        check (! ok (cmd (ops, "set_count_in")), "set_count_in requires bars");

        // Valid sets → ok + reflected in both the nested + mirrored snapshot fields.
        check (ok (cmd (ops, "set_count_in", args1 ("bars", 1))), "set_count_in (1 bar) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 1, "session.project.countInBars == 1 after set");
        check ((int) sess().getProperty ("countInBars", -1) == 1, "session.countInBars mirror == 1 after set");
        // ENGINE-WIRED, not just stored: the stored preference actually reaches the
        // live Edit's real pre-roll (applyCountInToEdit → te::Edit::setCountInMode).
        check (eng.edit().getCountInMode() == te::Edit::CountIn::oneBar,
               "set_count_in (1 bar) lands on the live engine (te::Edit::getCountInMode)");

        check (ok (cmd (ops, "set_count_in", args1 ("bars", 2))), "set_count_in (2 bars) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "session.project.countInBars == 2 after set");

        // Invalid bars rejected; storage stays at the last good value.
        check (! ok (cmd (ops, "set_count_in", args1 ("bars", 3))), "set_count_in rejects bars > 2");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "rejected bars (3) left storage untouched (still 2)");
        check (! ok (cmd (ops, "set_count_in", args1 ("bars", -1))), "set_count_in rejects negative bars");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "rejected negative bars left storage untouched (still 2)");

        // Save → reload → the setting round-trips with the .tracktionedit.
        check (ok (cmd (ops, "save")),   "save (count-in) ok");
        check (ok (cmd (ops, "reload")), "reload (count-in) ok");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "session.project.countInBars survived save+reload");

        // NON-undoable preference: logged undoable:false, and an undo right after must NOT
        // revert it (no transaction was pushed) — mirrors the set_key check above.
        auto ciLog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
        bool ciPref = false;
        for (auto& ln : juce::StringArray::fromLines (ciLog))
            if (ln.contains ("\"command\": \"set_count_in\"") && ln.contains ("\"undoable\": false")) ciPref = true;
        check (ciPref, "set_count_in logged undoable:false (preference)");
        cmd (ops, "undo");
        check ((int) proj().getProperty ("countInBars", -1) == 2, "undo after set_count_in does NOT revert it (non-undoable)");

        // Restore the default so later blocks/gates see a clean project.
        check (ok (cmd (ops, "set_count_in", args1 ("bars", 0))), "set_count_in restore default (0/off) ok");
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

    // ─── ARR-011: opt-in RIPPLE (delete_time_range + trim_clip) ───
    // The `ripple` arg defaults FALSE, so the pre-existing lift/cut behaviour must be
    // untouched when it is absent — that is check (a) below, and it is the reason the
    // default-path asserts here duplicate the Wave C ones on purpose.
    section ("ARR-011: ripple delete / ripple trim");
    {
        // Sorted clip starts on a track. `trk` and `clipsVar` are bound to NAMED locals
        // before getArray(): trackById() hands back a var BY VALUE, and reading through a
        // pointer into a destroyed temporary is undefined behaviour.
        auto startsOf = [&] (const String& tid) -> juce::Array<double> {
            juce::Array<double> starts;
            auto trk = trackById (tid);
            auto clipsVar = trk.getProperty ("clips", var());
            if (auto* clips = clipsVar.getArray())
                for (auto& c : *clips)
                    starts.add ((double) c.getProperty ("start", -1.0));
            starts.sort();
            return starts;
        };
        auto near = [] (double a, double b) { return std::abs (a - b) < 0.05; };

        // Lay out three clips: A 0..2, B 3..4, C 5..6. Deleting [1,2] splits A and
        // removes its inside half (A -> 0..1), leaving B and C downstream of the range.
        auto layout = [&] (const String& name) -> String {
            auto tid = cmd (ops, "create_track", args1 ("name", name))["data"].getProperty ("trackId", var()).toString();
            struct { double seconds, start, freq; } spec[] = { { 2.0, 0.0, 221.0 }, { 1.0, 3.0, 223.0 }, { 1.0, 5.0, 227.0 } };
            for (auto& s : spec)
            {
                auto made = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", s.seconds }, { "freq", s.freq }}));
                const auto madeId = made["data"].getProperty ("clipId", var()).toString();
                cmd (ops, "move_clip", objN ({{ "clipId", madeId }, { "start", s.start }}));
            }
            return tid;
        };

        // (a) DEFAULT (no `ripple` arg) — the gap stays open and downstream clips do NOT move.
        {
            auto tid = layout ("RippleOff");
            check (startsOf (tid).size() == 3, "ripple-off: three clips laid out");
            auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}));
            check (ok (del), "ripple-off: delete_time_range [1,2] ok");
            check (! (bool) del["data"].getProperty ("ripple", true), "ripple-off: result reports ripple:false by default");
            auto s = startsOf (tid);
            check (s.size() == 3, "ripple-off: still three clips (A split, inside half removed)");
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-off: downstream clips UNMOVED at 3s/5s (the 1..3s gap stays open)");
        }

        // (a2) Explicit ripple:false is identical to omitting the arg.
        {
            auto tid = layout ("RippleFalse");
            check (ok (cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 }, { "ripple", false },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}))),
                   "ripple-false: delete ok");
            auto s = startsOf (tid);
            check (s.size() == 3 && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-false: explicit false leaves downstream clips unmoved");
        }

        // (b) ripple:true — the 1s range closes up: downstream clips slide LEFT by exactly 1s.
        String rippleTid;
        {
            rippleTid = layout ("RippleOn");
            auto del = cmd (ops, "delete_time_range", objN ({{ "start", 1.0 }, { "end", 2.0 }, { "ripple", true },
                                                             { "trackIds", var (juce::Array<var> { var (rippleTid) }) }}));
            check (ok (del), "ripple-on: delete_time_range [1,2] ripple:true ok");
            check ((bool) del["data"].getProperty ("ripple", false), "ripple-on: result reports ripple:true");
            auto s = startsOf (rippleTid);
            check (s.size() == 3, "ripple-on: still three clips");
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 2.0) && near (s[2], 4.0),
                   "ripple-on: downstream clips moved LEFT by exactly the 1s range length (3->2, 5->4)");
        }

        // (c) ONE undo reverts BOTH the removal and the shift (single Tracktion transaction).
        {
            check (ok (cmd (ops, "undo")), "ripple-undo: one undo ok");
            auto s = startsOf (rippleTid);
            check (s.size() == 3 && near (s[0], 0.0) && near (s[1], 3.0) && near (s[2], 5.0),
                   "ripple-undo: original clip positions fully restored (0/3/5) by ONE undo");
            auto trk = trackById (rippleTid);
            auto clipsVar = trk.getProperty ("clips", var());
            double firstLen = 0.0;
            if (auto* clips = clipsVar.getArray())
                for (auto& c : *clips)
                    if (near ((double) c.getProperty ("start", -1.0), 0.0))
                        firstLen = (double) c.getProperty ("length", 0.0);
            check (near (firstLen, 2.0), "ripple-undo: the split/removed clip is whole again (0..2s)");
        }

        // A ripple that would push a clip before 0 clamps at 0 rather than going negative.
        {
            auto tid = cmd (ops, "create_track", args1 ("name", "RippleClamp"))["data"].getProperty ("trackId", var()).toString();
            auto made = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 1.0 }, { "freq", 229.0 }}));
            cmd (ops, "move_clip", objN ({{ "clipId", made["data"].getProperty ("clipId", var()).toString() }, { "start", 1.0 }}));
            check (ok (cmd (ops, "delete_time_range", objN ({{ "start", 0.0 }, { "end", 0.5 }, { "ripple", true },
                                                             { "trackIds", var (juce::Array<var> { var (tid) }) }}))),
                   "ripple-clamp: delete ok");
            auto s = startsOf (tid);
            check (s.size() == 1 && s[0] >= -1.0e-9, "ripple-clamp: resulting start is never negative");
        }

        // trim_clip ripple — shortening a clip pulls the next one left by the trimmed amount.
        {
            auto tid = cmd (ops, "create_track", args1 ("name", "RippleTrim"))["data"].getProperty ("trackId", var()).toString();
            auto a = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 2.0 }, { "freq", 231.0 }}));
            const auto aid = a["data"].getProperty ("clipId", var()).toString();
            auto b = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", tid }, { "seconds", 1.0 }, { "freq", 233.0 }}));
            cmd (ops, "move_clip", objN ({{ "clipId", b["data"].getProperty ("clipId", var()).toString() }, { "start", 2.0 }}));

            // Default trim (no ripple arg) leaves the follower where it is.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", aid }, { "length", 1.5 }}))), "ripple-trim: plain trim ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 2.0), "ripple-trim: default trim does NOT move the follower");
            }

            // ripple:true — trimming 1.5 -> 1.0 pulls the follower from 2.0 to 1.5.
            check (ok (cmd (ops, "trim_clip", objN ({{ "clipId", aid }, { "length", 1.0 }, { "ripple", true }}))),
                   "ripple-trim: ripple trim ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 1.5), "ripple-trim: follower pulled left by the trimmed 0.5s");
            }
            check (ok (cmd (ops, "undo")), "ripple-trim: undo ok");
            {
                auto s = startsOf (tid);
                check (s.size() == 2 && near (s[1], 2.0), "ripple-trim: one undo restores BOTH the length and the follower");
            }
        }
    }

    // ─── CLP-LOOP: clip loop region (reality-pack invariant 28) ───
    section ("CLP-LOOP: set_clip_loop");
    {
        auto clipById = [&] (const String& target) -> var {
            auto snap = ops.snapshot();               // bind: snapshot() returns a var BY VALUE
            auto tracksVar = snap.getProperty ("tracks", var());
            if (auto* tracks = tracksVar.getArray())
                for (auto& tr : *tracks)
                {
                    auto clipsVar = tr.getProperty ("clips", var());
                    if (auto* clips = clipsVar.getArray())
                        for (auto& c : *clips)
                            if (c.getProperty ("id", var()).toString() == target) return c;
                }
            return {};
        };
        auto near = [] (double a, double b) { return std::abs (a - b) < 0.05; };

        auto lt = cmd (ops, "create_track", args1 ("name", "ClipLoop"))["data"].getProperty ("trackId", var()).toString();
        auto lc = cmd (ops, "add_test_tone_clip", objN ({{ "trackId", lt }, { "seconds", 4.0 }, { "freq", 241.0 }}));
        const auto lcid = lc["data"].getProperty ("clipId", var()).toString();
        check (lcid.isNotEmpty(), "loop: 0..4s tone clip created");

        // Defaults: a fresh clip does not loop, and the snapshot says so unconditionally.
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: loopEnabled defaults to false");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 0.0), "loop: loopLength defaults to 0");

        // Enable a sub-region: loop 0.5..1.5s of the source.
        auto set = cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", true },
                                                     { "start", 0.5 }, { "length", 1.0 }}));
        check (ok (set), "loop: set_clip_loop enabled ok");
        check ((bool) set["data"].getProperty ("loopEnabled", false), "loop: result echoes loopEnabled true");
        check (near ((double) set["data"].getProperty ("loopLength", -1.0), 1.0), "loop: result echoes the post-clamp loopLength");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: loopEnabled round-trips through the snapshot");
        check (near ((double) clipById (lcid).getProperty ("loopStart", -1.0), 0.5), "loop: loopStart round-trips (0.5s)");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 1.0), "loop: loopLength round-trips (1.0s)");

        // Undo / redo.
        check (ok (cmd (ops, "undo")), "loop: undo set_clip_loop ok");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: undo restores the clip un-looped");
        check (ok (cmd (ops, "redo")), "loop: redo set_clip_loop ok");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: redo re-applies the loop region");

        // Persistence — loopStart/loopLength are CachedValues on the clip's own
        // ValueTree, so save/reload is free (mirrors the reverse/crossfade proof).
        cmd (ops, "save"); cmd (ops, "reload");
        check ((bool) clipById (lcid).getProperty ("loopEnabled", false), "loop: loopEnabled persists across save/reload");
        check (near ((double) clipById (lcid).getProperty ("loopStart", -1.0), 0.5), "loop: loopStart persists across save/reload");
        check (near ((double) clipById (lcid).getProperty ("loopLength", -1.0), 1.0), "loop: loopLength persists across save/reload");

        // Disabling clears the loop WITHOUT moving/resizing the clip (we deliberately do
        // not call AudioClipBase::disableLooping(), which rewrites position + offset).
        const double preStart  = (double) clipById (lcid).getProperty ("start", -1.0);
        const double preLength = (double) clipById (lcid).getProperty ("length", -1.0);
        check (ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", false }}))), "loop: disable ok");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: disabled clip reports loopEnabled false");
        check (near ((double) clipById (lcid).getProperty ("start", -99.0), preStart)
               && near ((double) clipById (lcid).getProperty ("length", -99.0), preLength),
               "loop: disabling the loop does NOT move or resize the clip");

        // enabled:true with a zero length is rejected (and mutates nothing).
        check (! ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", lcid }, { "enabled", true }, { "length", 0.0 }}))),
               "loop: enabled with length 0 rejected");
        check (! (bool) clipById (lcid).getProperty ("loopEnabled", true), "loop: rejected zero-length call left the clip un-looped");

        // Type rejection: audio-clip-only, mirrors set_clip_gain/set_clip_reverse.
        {
            auto midiLoop = cmd (ops, "add_midi_clip", objN ({{ "trackId", lt }, { "length", 1.0 }}));
            const auto midiLoopCid = midiLoop["data"].getProperty ("clipId", var()).toString();
            auto rej = cmd (ops, "set_clip_loop", objN ({{ "clipId", midiLoopCid }, { "enabled", true }, { "length", 1.0 }}));
            check (! ok (rej), "loop: set_clip_loop on a MIDI clip rejected");
            check (! (bool) clipById (midiLoopCid).getProperty ("loopEnabled", false),
                   "loop: rejected MIDI clip was not mutated");
            cmd (ops, "remove_clip", args1 ("clipId", midiLoopCid));   // tidy
        }
        check (! ok (cmd (ops, "set_clip_loop", objN ({{ "clipId", "nope" }, { "enabled", true }}))),
               "loop: unknown clipId rejected");

        // JSONL: logged undoable:true (mirrors the fade/reverse asserts).
        {
            auto llog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool loopU = false;
            for (auto& ln : StringArray::fromLines (llog))
                if (ln.contains ("\"command\": \"set_clip_loop\"") && ln.contains ("\"undoable\": true")) loopU = true;
            check (loopU, "loop: set_clip_loop logged undoable:true");
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

    section ("Multiplayer: stable logical track IDs (MP-001)");
    {
        // The load-bearing multiplayer prerequisite: every track carries a stable
        // cross-peer UUID (moshLogicalId) that is distinct, non-empty, and survives
        // a save/reload — Tracktion's own EditItemID is allocator-dependent and so
        // differs per peer, which is why we cannot address tracks across peers by it.
        const int before = tracks (ops);
        check (ok (cmd (ops, "create_track", args1 ("name", "MP One"))), "create_track MP One ok");
        check (ok (cmd (ops, "create_track", args1 ("name", "MP Two"))), "create_track MP Two ok");

        auto idByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();   // keep the temporary alive (no dangling array)
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (tracks (ops) >= before + 2, "two MP tracks present in snapshot");
        const auto id1 = idByName (ops, "MP One");
        const auto id2 = idByName (ops, "MP Two");
        check (id1.isNotEmpty(), "track 'MP One' has a non-empty logicalId");
        check (id2.isNotEmpty(), "track 'MP Two' has a non-empty logicalId");
        check (id1 != id2, "the two tracks have distinct logicalIds");
        check (id1.length() >= 32, "logicalId looks like a juce::Uuid string");

        // Identity is stable across a session reload (persisted on the track tree).
        check (ok (cmd (ops, "save")),   "save ok (MP-001)");
        check (ok (cmd (ops, "reload")), "reload ok (MP-001)");
        check (idByName (ops, "MP One") == id1 && id1.isNotEmpty(), "logicalId of 'MP One' survives save/reload");
        check (idByName (ops, "MP Two") == id2 && id2.isNotEmpty(), "logicalId of 'MP Two' survives save/reload");
    }

    section ("Multiplayer: track serialize/apply round-trip (P1b)");
    {
        // The core commit/apply mechanism, proven entirely in-process (no network):
        // serialize a track -> mutate it -> apply the blob -> the track is restored
        // byte-faithfully, WITHOUT touching the undo stack and WITHOUT emitting (so
        // a remote apply never echoes back to the relay).

        // Resolve the engine itemID of a track by display name (for command args).
        auto trackIdByName = [] (MoshOps& o, const juce::String& name) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == name)
                        return tv.getProperty ("id", juce::var()).toString();
            return {};
        };
        // Fetch a whole track var by its stable logicalId (to read restored fields).
        auto trackByLogicalId = [] (MoshOps& o, const juce::String& lid) -> juce::var
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        return tv;
            return {};
        };

        check (ok (cmd (ops, "create_track", args1 ("name", "RT Src"))), "create RT Src");
        const auto srcId = trackIdByName (ops, "RT Src");
        check (srcId.isNotEmpty(), "RT Src engine id resolved");

        // Give it real content: a wave clip, a MIDI clip with a note, a set volume.
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", srcId }, { "seconds", 1.0 } }));
        cmd (ops, "set_track_volume",   objN ({ { "trackId", srcId }, { "db", -6.5 } }));
        auto midiRes = cmd (ops, "add_midi_clip", objN ({ { "trackId", srcId } }));
        const auto midiClipId = midiRes.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();
        check (midiClipId.isNotEmpty(), "RT Src midi clip created");
        cmd (ops, "add_note", objN ({ { "clipId", midiClipId }, { "pitch", 60 },
                                      { "beat", 0.0 }, { "length", 1.0 }, { "velocity", 100 } }));

        // Capture the original shape (clip count) before we serialize.
        auto clipCountOf = [] (const juce::var& tv) -> int
        {
            if (auto* a = tv["clips"].getArray()) return a->size();
            return 0;
        };
        // Resolve the source track's stable logicalId (for restored-state lookups).
        juce::String srcLid;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Src")
                        srcLid = tv.getProperty ("logicalId", juce::var()).toString();
        }
        const int origClipCount = clipCountOf (trackByLogicalId (ops, srcLid));
        check (origClipCount == 2, "RT Src has 2 clips (wave + midi) before serialize");
        const double srcVol = (double) trackByLogicalId (ops, srcLid).getProperty ("volumeDb", -99.0);
        check (std::abs (srcVol - (-6.5)) < 0.05, "RT Src volume is -6.5 pre-serialize (got " + juce::String (srcVol, 3) + ")");

        // 1) SERIALIZE
        auto serRes = cmd (ops, "mp_serialize_track", args1 ("trackId", srcId));
        check (ok (serRes), "mp_serialize_track ok");
        const auto blob = serRes.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = serRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialize produced a non-empty blob");
        check (lid == srcLid && lid.isNotEmpty(), "serialize reported the track's logicalId");

        // 2) MUTATE the live track away from the serialized state.
        cmd (ops, "rename_track",     objN ({ { "trackId", srcId }, { "name", "MUTATED" } }));
        cmd (ops, "set_track_volume", objN ({ { "trackId", srcId }, { "db", 0.0 } }));
        {   // remove every clip on RT Src
            auto snap = ops.snapshot();
            juce::StringArray clipIds;
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("id", juce::var()).toString() == srcId)
                        if (auto* cs = tv["clips"].getArray())
                            for (auto& cv : *cs)
                                clipIds.add (cv.getProperty ("id", juce::var()).toString());
            for (auto& cid : clipIds)
                cmd (ops, "remove_clip", args1 ("clipId", cid));
        }
        check (clipCountOf (trackByLogicalId (ops, lid)) == 0, "mutate removed all clips");

        // A sentinel: a freshly-created track is the TOP of the undo stack (create_
        // track is proven undoable). If apply does NOT push an undoable action, a
        // single undo after apply reverts THIS create, not the apply.
        cmd (ops, "create_track", args1 ("name", "RT Sentinel"));
        auto sentinelExists = [] (MoshOps& o) -> bool
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "RT Sentinel")
                        return true;
            return false;
        };
        check (sentinelExists (ops), "sentinel track present before apply");

        // 3) APPLY — zero-emit guard: clear captured events, apply, assert silence.
        eventTypes.clear();
        auto appRes = cmd (ops, "apply_remote_track", args1 ("blob", blob));
        check (ok (appRes), "apply_remote_track ok");
        check (appRes.getProperty ("data", juce::var()).getProperty ("mode", juce::var()).toString() == "replaced",
               "apply replaced the existing track (same logicalId)");
        juce::String evDump; for (auto& e : eventTypes) evDump << e << ",";
        bool emittedInvalidate = false;
        for (auto& e : eventTypes) if (e == "snapshot_invalidated") emittedInvalidate = true;
        check (! emittedInvalidate,
               "apply_remote_track does NOT emit snapshot_invalidated (no relay echo) [saw: " + evDump + "]");

        // 4) FIDELITY — the track is restored by logicalId.
        auto restored = trackByLogicalId (ops, lid);
        check (restored.isObject(), "restored track found by logicalId");
        check (restored.getProperty ("name", juce::var()).toString() == "RT Src", "name restored");
        const double rv = (double) restored.getProperty ("volumeDb", -99.0);
        check (std::abs (rv - (-6.5)) < 0.05, "volume restored (got " + juce::String (rv, 3) + ")");
        check (clipCountOf (restored) == origClipCount, "clip count restored (wave + midi)");
        int restoredMidiNotes = 0;
        if (auto* cs = restored["clips"].getArray())
            for (auto& cv : *cs)
                if (cv.getProperty ("type", juce::var()).toString() == "midi")
                    if (auto* notes = cv["notes"].getArray())
                        restoredMidiNotes = notes->size();
        check (restoredMidiNotes >= 1, "deep content survived: the MIDI note round-tripped");

        // 5) UNDO GUARD — apply was not undoable, so undo reverts the CONTROL track
        // (top of the stack), not the applied track; the applied track survives.
        check (ok (cmd (ops, "undo")), "undo ok");
        check (! sentinelExists (ops),
               "undo removed the sentinel track (apply was NOT on the undo stack)");
        check (trackByLogicalId (ops, lid).getProperty ("name", juce::var()).toString() == "RT Src",
               "applied track survives the undo (apply is outside the undo system)");
    }

    section ("Multiplayer: lock guard at the mutation path (MP-001 P3)");
    {
        // The guard sits at the single chokepoint MoshOps::execute(). When a session
        // is active, mutations to a track/clip/structure held by the OTHER peer are
        // rejected; reads always pass; deactivating restores single-player edits.
        cmd (ops, "create_track", args1 ("name", "Lock A"));
        cmd (ops, "create_track", args1 ("name", "Lock B"));
        juce::String aId, aLid, bId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                {
                    const auto nm = tv.getProperty ("name", juce::var()).toString();
                    if (nm == "Lock A") { aId = tv.getProperty ("id", juce::var()).toString();
                                          aLid = tv.getProperty ("logicalId", juce::var()).toString(); }
                    if (nm == "Lock B") { bId = tv.getProperty ("id", juce::var()).toString(); }
                }
        }
        check (aLid.isNotEmpty() && bId.isNotEmpty(), "lock-test tracks resolved (logicalId + engine ids)");

        // A clip on Lock A, added BEFORE locking, to exercise clip-scoped guarding.
        auto addc = cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto aClipId = addc.getProperty ("data", juce::var()).getProperty ("clipId", juce::var()).toString();

        // Activate: the OTHER peer holds Lock A AND the session (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (aLid, "other");
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "mp_sync_locks activates the guard with peer-held locks");

        check (! ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "HAX" } }))),
               "track mutation on a peer-locked track is BLOCKED");
        check (ok (cmd (ops, "list_plugins")), "reads pass the guard");
        check (ok (cmd (ops, "get_clip_peaks", args1 ("clipId", aClipId))),
               "a clip read on a peer-locked track is allowed");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", bId }, { "name", "Lock B2" } }))),
               "track mutation on a FREE track is allowed");
        if (aClipId.isNotEmpty())
            check (! ok (cmd (ops, "set_clip_gain", objN ({ { "clipId", aClipId }, { "gain", 0.5 } }))),
                   "clip mutation on a peer-locked track's clip is BLOCKED (clip->track->logicalId)");
        check (! ok (cmd (ops, "create_track", args1 ("name", "Nope"))),
               "session-global op BLOCKED while the session lock is peer-held");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "mp_sync_locks deactivates");
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", aId }, { "name", "Free Again" } }))),
               "deactivating restores unguarded single-player track edits");
        check (ok (cmd (ops, "create_track", args1 ("name", "Free Track"))),
               "structural ops unblocked after deactivate (single-player regression safety)");
    }

    section ("Multiplayer: project bootstrap (P6)");
    {
        // A late-joiner adopts the host's whole project. Proven in-process: build a
        // known project -> serialize the bundle -> wipe -> apply -> it comes back
        // with the same logicalIds + content (the join handshake rides this).
        auto lidByName = [] (MoshOps& o, const juce::String& nm) -> juce::String
        {
            auto snap = o.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == nm)
                        return tv.getProperty ("logicalId", juce::var()).toString();
            return {};
        };

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-src"))), "new_project (bootstrap source) ok");
        check (tracks (ops) == 0, "fresh project is empty");
        cmd (ops, "create_track", args1 ("name", "Boot A"));
        cmd (ops, "create_track", args1 ("name", "Boot B"));
        juce::String aId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        aId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", aId }, { "seconds", 1.0 } }));
        const auto lidA = lidByName (ops, "Boot A");
        const auto lidB = lidByName (ops, "Boot B");
        // A pre-existing annotation on the host must travel in the bootstrap bundle (it's a
        // top-level Edit child, not inside a track blob) so a late-joiner sees it too.
        cmd (ops, "create_annotation", objN ({ { "annotationId", "boot-ann" }, { "text", "host note" }, { "beat", 12.0 }, { "author", "host" } }));

        auto ser = cmd (ops, "mp_serialize_project");
        check (ok (ser), "mp_serialize_project ok");
        auto bundle = ser.getProperty ("data", juce::var());
        check ((int) bundle.getProperty ("count", 0) == 2, "serialized a 2-track project bundle");
        check (bundle.getProperty ("annotations", juce::var()).toString().isNotEmpty(), "bundle carries the annotations subtree");

        // REGRESSION (bootstrap audio late-join): the bundle must carry per-track by-hash
        // audioRefs so a late-joiner can fetch PRE-EXISTING audio, not just structure/MIDI.
        // Before the fix mp_serialize_project never content-addressed/uploaded → the bundle
        // had no refs and the joiner's clip stayed sourceMissing until a host re-commit.
        juce::var bootAudioRefs;
        if (auto* tarr = bundle.getProperty ("tracks", juce::var()).getArray())
            for (auto& tv : *tarr)
                if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                    bootAudioRefs = rr;
        check (bootAudioRefs.isArray() && bootAudioRefs.size() >= 1, "bootstrap bundle carries per-track audioRefs (audio late-join)");
        check (bootAudioRefs.size() > 0 && bootAudioRefs[0].getProperty ("hash", juce::var()).toString().length() == 64,
               "bootstrap audioRef hash is a sha256");
        {
            // The host's Boot A clip was content-addressed + repointed to a by-hash stem at
            // serialize time (the by-hash form, no spurious "../" — inherits the PR #104 helper).
            juce::String hostRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            hostRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (hostRef.contains ("by-hash"), "serialize content-addressed the host audio clip to a by-hash stem");
            check (! hostRef.startsWith ("../") && ! hostRef.contains ("/../"),
                   "bootstrap by-hash ref has no spurious '../' (" + hostRef + ")");
        }

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-boot-dst"))), "new_project (joiner wipe) ok");
        check (tracks (ops) == 0, "joiner starts empty before bootstrap");

        auto app = cmd (ops, "mp_apply_bootstrap", objN ({ { "tracks", bundle.getProperty ("tracks", juce::var()) },
                                                           { "annotations", bundle.getProperty ("annotations", juce::var()) } }));
        check (ok (app), "mp_apply_bootstrap ok");
        // The joiner adopts the host's annotation (id + author + text preserved).
        bool joinerHasAnn = false;
        { auto arr = ops.snapshot().getProperty ("annotations", juce::var());
          for (int i = 0; i < arr.size(); ++i)
              if (arr[i].getProperty ("id", juce::var()).toString() == "boot-ann"
                  && arr[i].getProperty ("text", juce::var()).toString() == "host note"
                  && arr[i].getProperty ("author", juce::var()).toString() == "host")
                  joinerHasAnn = true; }
        check (joinerHasAnn, "joiner adopts the host's pre-existing annotation via bootstrap");
        check ((int) app.getProperty ("data", juce::var()).getProperty ("applied", 0) == 2, "bootstrap applied 2 tracks");
        check (tracks (ops) == 2, "joiner now holds the host's 2 tracks");
        check (lidByName (ops, "Boot A") == lidA && lidA.isNotEmpty(), "Boot A logicalId preserved across bootstrap");
        check (lidByName (ops, "Boot B") == lidB && lidB.isNotEmpty(), "Boot B logicalId preserved across bootstrap");
        int aClips = 0;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Boot A")
                        if (auto* cs = tv["clips"].getArray()) aClips = cs->size();
        }
        check (aClips == 1, "Boot A's clip survived the bootstrap (deep content)");
        {
            // The repointed by-hash ref rode the bundle onto the joiner (proves the wire
            // round-trip of the audio ref). The bytes themselves ride the cloud relay's blob
            // store via the download loop that mirrors the proven commit-apply path; the
            // cloud-relay selftest branch exercises that fetch end-to-end.
            juce::String joinRef;
            for (auto* tr : te::getAllTracks (eng.edit()))
                if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                    for (auto* c : at->getClips())
                        if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                            joinRef = w->state.getProperty (juce::Identifier ("source")).toString();
            check (joinRef.contains ("by-hash"), "joiner's bootstrapped clip references the by-hash stem");
        }
    }

    section ("Multiplayer: structural sync (scalar session-global ops)");
    {
        auto tempoNow = [] (MoshOps& o) { return (double) o.snapshot()["session"].getProperty ("tempo", 0.0); };
        cmd (ops, "set_tempo", objN ({ { "bpm", 120.0 } }));
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "baseline tempo is 120");

        // The peer holds the SESSION (structural) lock.
        auto* locks = new juce::DynamicObject();
        locks->setProperty (LockManager::sessionKey(), "other");
        check (ok (cmd (ops, "mp_sync_locks",
                        objN ({ { "active", true }, { "selfPeer", "me" }, { "locks", juce::var (locks) } }))),
               "session active, peer holds the session lock");

        // A LOCAL structural change is blocked by the guard.
        check (! ok (cmd (ops, "set_tempo", objN ({ { "bpm", 140.0 } }))),
               "local tempo change blocked while the peer holds the session lock");
        check (std::abs (tempoNow (ops) - 120.0) < 0.01, "tempo unchanged after the blocked local change");

        // Applying the PEER's structural op bypasses the guard and lands (echo-free).
        check (ok (cmd (ops, "mp_apply_structural",
                        objN ({ { "command", "set_tempo" }, { "args", objN ({ { "bpm", 145.0 } }) } }))),
               "mp_apply_structural ok");
        check (std::abs (tempoNow (ops) - 145.0) < 0.01, "peer's tempo change applied (guard bypassed)");

        check (ok (cmd (ops, "mp_sync_locks", objN ({ { "active", false } }))), "session deactivated");
    }

    // Regression: export after mp_commit_track. The commit content-addresses a wave clip's
    // audio to <session>/audio/by-hash/<sha>.wav and rewrites the clip to a RELATIVE ref.
    // The ref was previously computed relative to the edit FILE (setToDirectFileReference),
    // which produced a spurious leading "../" — but the filePathResolver resolves relative
    // to the edit file's PARENT dir, so the "../" escaped the session dir to a non-existent
    // path. The offline-render WaveNode could then never open the stem, so isReadyToProcess()
    // stayed false and export_audio spun FOREVER. Guards: the ref has no "../", resolves to an
    // existing file, export COMPLETES (the render loop is also bounded now), and renders
    // NON-SILENT audio. (mpSession_ exists unconditionally, so this needs no relay.)
    //
    // The "../" is only emitted when the edit file is NOT on disk at rewrite time: JUCE's
    // getRelativePathFrom strips to the base's parent only when the base existsAsFile(), else
    // it treats the edit file's own path as a directory and prepends "../". new_project
    // persists the edit, so we remove it here to model the unsaved state (a fresh arrangement
    // before its first save) deterministically — WITHOUT this the rewrite resolves fine and
    // the section passes even on the buggy code, i.e. it would not actually guard the fix.
    {
        section ("Multiplayer: export after commit (by-hash ref resolves — guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "mp-export-selftest"))), "new_project (mp export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Stem" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto st = mkt["data"].getProperty ("trackId", var()).toString();
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", st }, { "seconds", 1.0 } }))),
               "add_test_tone_clip ok");

        // Force the bug's precondition: an edit not yet on disk at the rewrite (see above).
        const auto mpEditFile = eng.editFile();
        mpEditFile.deleteFile();
        check (! mpEditFile.existsAsFile(), "edit file is absent at commit time (the bug's precondition)");

        check (ok (cmd (ops, "mp_commit_track", args1 ("trackId", st))), "mp_commit_track (audio) ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (storedRef.contains ("by-hash"), "committed clip points at the by-hash stem");
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "by-hash ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "committed clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
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

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("mp-commit-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after mp_commit_track COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported MP-committed audio is NON-SILENT (the stem actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the mp-commit-export probe");
    }

    // Regression: export after relink_clip to a project-LOCAL copy. relink_clip rewrites a
    // wave clip's source via setToDirectFileReference(newFile, /*useRelativePath*/ local).
    // When the new file lives under the project dir (local==true), that computes the path
    // relative to the edit FILE — and if the edit file isn't on disk, JUCE treats the edit
    // file's own path as a directory, yielding a spurious leading "../" (e.g. "../audio/
    // foo.wav"). Mosh's filePathResolver (MoshEngine::wireEditResolvers) resolves relative
    // to the edit file's PARENT dir, so that "../" escapes the session dir to a path that
    // doesn't exist → the offline-render WaveNode can never open the source → export_audio
    // spins forever. This is the exact mechanism PR #104 fixed for mp_commit_track. Guards:
    // the relinked ref has no "../", resolves to an existing file, export COMPLETES (the
    // render loop is bounded too), and renders NON-SILENT.
    {
        section ("Relink: export after relink to a local copy (guards the export hang)");

        check (ok (cmd (ops, "new_project", args1 ("name", "relink-export-selftest"))),
               "new_project (relink export isolation) ok");

        auto mkt = cmd (ops, "create_track", objN ({ { "name", "Aud" } }));
        check (ok (mkt), "create_track (audio) ok");
        const auto tid = mkt["data"].getProperty ("trackId", var()).toString();

        // A clip whose source lives OUTSIDE the project dir (the shared session pool), so
        // relinking to a project-local copy exercises the relative-ref rewrite.
        check (ok (cmd (ops, "add_test_tone_clip", objN ({ { "trackId", tid }, { "seconds", 1.0 }, { "freq", 440 } }))),
               "add_test_tone_clip ok");

        auto firstClipOnTrack = [&] () -> var
        {
            auto trks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < trks.size(); ++i)
                if (trks[i].getProperty ("id", var()).toString() == tid)
                    return trks[i].getProperty ("clips", var())[0];
            return var();
        };
        const auto clipId = firstClipOnTrack().getProperty ("id", var()).toString();
        check (clipId.isNotEmpty(), "probe clip present");

        const File origSrc (firstClipOnTrack().getProperty ("sourceFile", var()).toString());
        const auto projectDir = eng.editFile().getParentDirectory();
        check (! origSrc.isAChildOf (projectDir), "probe clip's source starts OUTSIDE the project dir");

        // Copy the source to a project-LOCAL path and relink to it (local => relative ref).
        auto localCopy = projectDir.getChildFile ("audio").getChildFile ("relinked.wav");
        localCopy.getParentDirectory().createDirectory();
        localCopy.deleteFile();
        check (origSrc.copyFileTo (localCopy), "copied source to a project-local file");
        check (localCopy.isAChildOf (projectDir), "relink target is under the project dir (=> relative ref)");

        // Force the precondition that actually triggers the bug: an edit not yet on disk.
        // setToDirectFileReference(file, /*relative*/ true) -> findPathFromFile ->
        // file.getRelativePathFrom(editFileRetriever()), and JUCE's getRelativePathFrom uses
        // the base's PARENT only when the base existsAsFile() — otherwise it treats the edit
        // file's own path as a directory and emits the spurious leading "../". A real user
        // hits this when relinking on a fresh arrangement before its first save (the
        // cold-start session edit). new_project persists the edit, so we remove it here to
        // model the unsaved state deterministically. (Without this the relative ref resolves
        // fine and the bug stays hidden — which is exactly why it lay latent.)
        const auto editFile = eng.editFile();
        editFile.deleteFile();
        check (! editFile.existsAsFile(), "edit file is absent at relink time (the bug's precondition)");

        check (ok (cmd (ops, "relink_clip", objN ({ { "clipId", clipId }, { "file", localCopy.getFullPathName() } }))),
               "relink_clip to the local copy ok");

        juce::String storedRef;
        bool resolvedExists = false;
        for (auto* tr : te::getAllTracks (eng.edit()))
            if (auto* at = dynamic_cast<te::AudioTrack*> (tr))
                for (auto* c : at->getClips())
                    if (auto* w = dynamic_cast<te::WaveAudioClip*> (c))
                    {
                        storedRef      = w->state.getProperty (juce::Identifier ("source")).toString();
                        resolvedExists = w->getCurrentSourceFile().existsAsFile();
                    }
        check (! storedRef.startsWith ("../") && ! storedRef.contains ("/../"),
               "relinked ref has no spurious '../' so it resolves inside the session (" + storedRef + ")");
        check (resolvedExists, "relinked clip's resolved source exists on disk");

        auto wavMag = [] (const File& f) -> float
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

        auto outFile = eng.sessionDir().getChildFile ("exports").getChildFile ("relink-export.wav");
        outFile.deleteFile();
        check (ok (cmd (ops, "export_audio", objN ({ { "file", outFile.getFullPathName() },
                                                     { "format", "wav" }, { "bitDepth", 16 } }))),
               "export_audio after relink_clip COMPLETES (no hang)");
        check (wavMag (outFile) > 0.02f,
               "exported relinked audio is NON-SILENT (the relinked source actually rendered)");
        outFile.deleteFile();

        // Restore the on-disk edit we removed above so later sections see a persisted edit.
        check (ok (cmd (ops, "save")), "re-persist the edit after the relink-export probe");
    }

    // P2 — native↔relay transport, end to end over real HTTP. Gated (spawns a
    // relay + needs MOSH_RELAY_URL) so it stays OUT of the deterministic core run.
    if (std::getenv ("MOSH_SELFTEST_MP") != nullptr)
    {
        section ("Multiplayer: native relay round-trip (P2, gated MOSH_SELFTEST_MP)");

        MultiplayerClient a, b;   // both resolve the relay from MOSH_RELAY_URL
        const auto code = a.createSession ("Ada", "#ff0000");
        check (code.isNotEmpty(), "peer A created a session (got a room code) [" + a.lastError() + "]");
        check (code.length() >= 16, "room code is a high-entropy bearer");
        check (b.joinSession (code, "Bo", "#0000ff"), "peer B joined by code [" + b.lastError() + "]");

        // A serializes a real track and publishes the commit over the wire.
        check (ok (cmd (ops, "create_track", args1 ("name", "Net Src"))), "create Net Src");
        juce::String netId;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Net Src")
                        netId = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", netId }, { "seconds", 1.0 } }));
        auto ser = cmd (ops, "mp_serialize_track", args1 ("trackId", netId));
        const auto blob = ser.getProperty ("data", juce::var()).getProperty ("blob", juce::var()).toString();
        const auto lid  = ser.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
        check (blob.isNotEmpty(), "serialized Net Src to a commit blob");

        auto* commit = new juce::DynamicObject();
        commit->setProperty ("type", "commit");
        commit->setProperty ("logicalId", lid);
        commit->setProperty ("blob", blob);
        const int seq = a.publish (juce::var (commit));
        // seq is monotonic but its absolute value is backend-specific (a fresh local
        // relay starts at 1; the cloud relay's seq is a global serial), so assert >=1.
        check (seq >= 1, "peer A published the commit (seq " + juce::String (seq) + ") [" + a.lastError() + "]");

        // B receives exactly that commit; A does not get its own back (no echo).
        auto frames = b.poll();
        check (frames.size() == 1, "peer B received exactly one frame [" + b.lastError() + "]");
        juce::String gotBlob, gotLid;
        if (frames.size() > 0)
        {
            gotBlob = frames[0].getProperty ("msg", juce::var()).getProperty ("blob", juce::var()).toString();
            gotLid  = frames[0].getProperty ("msg", juce::var()).getProperty ("logicalId", juce::var()).toString();
        }
        check (gotBlob == blob && gotBlob.isNotEmpty(), "commit blob survived the relay round-trip byte-for-byte");
        check (gotLid == lid, "commit logicalId survived the round-trip");
        check (a.poll().isEmpty(), "peer A does not receive its own commit (no echo)");

        // Apply the wire-delivered commit (after mutating) -> the track is restored.
        cmd (ops, "rename_track", objN ({ { "trackId", netId }, { "name", "NET-MUTATED" } }));
        check (ok (cmd (ops, "apply_remote_track", args1 ("blob", gotBlob))), "apply_remote_track (from wire) ok");
        juce::String restoredName;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == lid)
                        restoredName = tv.getProperty ("name", juce::var()).toString();
        }
        check (restoredName == "Net Src", "track restored from the relayed commit (end-to-end over HTTP)");

        // Exercise the NATIVE session command path (MultiplayerSession lifecycle:
        // create -> background poll thread starts -> leave -> thread joins).
        auto created = cmd (ops, "mp_create_session", objN ({ { "name", "Cy" }, { "color", "#00ff88" } }));
        check (ok (created), "mp_create_session (native session) ok");
        check (created.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString().isNotEmpty(),
               "native session returned a room code");
        check (ok (cmd (ops, "mp_leave_session")), "mp_leave_session ok (poll thread joined)");

        // P4 — audio stems. Content-addressing + the by-hash rewrite run on any
        // relay; the upload/peer-download round-trip now runs against WHATEVER
        // relay MOSH_RELAY_URL points at — cloud or local. (Previously gated to
        // the cloud relay only, because the local dev relay had no /mp/blob/*
        // storage; relay/server.py now mirrors that contract for local/CI use —
        // see the mp_fetch_missing_stems self-heal section below.)
        auto sess = cmd (ops, "mp_create_session", objN ({ { "name", "Hz" }, { "color", "#ffff00" } }));
        check (ok (sess), "mp_create_session (audio)");
        const auto sessCode = sess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
        cmd (ops, "create_track", args1 ("name", "Stem Trk"));
        juce::String stemTrk;
        {
            auto snap = ops.snapshot();
            if (auto* arr = snap["tracks"].getArray())
                for (auto& tv : *arr)
                    if (tv.getProperty ("name", juce::var()).toString() == "Stem Trk")
                        stemTrk = tv.getProperty ("id", juce::var()).toString();
        }
        cmd (ops, "add_test_tone_clip", objN ({ { "trackId", stemTrk }, { "seconds", 1.0 } }));

        auto commitRes = cmd (ops, "mp_commit_track", args1 ("trackId", stemTrk));
        check (ok (commitRes), "mp_commit_track ok (with audio)");
        // MOSH_MP_SYNC_TRANSFER (the PR-2 kill switch, gated separately below) pins this
        // to "committed" instead; that combination is exercised in its own dedicated
        // section, so this just accepts whichever mode is actually active here.
        const auto commitStatus = commitRes.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString();
        check (commitStatus == "uploading" || commitStatus == "committed",
               "PR-2: mp_commit_track returns a recognized status (\"" + commitStatus + "\")");
        auto refs = commitRes.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
        check (refs.isArray() && refs.size() >= 1, "commit content-addressed the clip's stem");
        const auto h0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("hash", juce::var()).toString() : juce::String();
        const auto e0 = (refs.isArray() && refs.size() > 0) ? refs[0].getProperty ("ext", juce::var()).toString() : juce::String();
        check (h0.length() == 64, "stem hash is a sha256");
        const auto stemLogicalId = commitRes.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();

        // PR-2: the upload + publish now run on the transfer worker (mp_commit_track
        // returns status:"uploading" immediately) instead of inline — wait for the
        // additive mp_commit_done event before assuming the stem has actually landed
        // on the relay's blob store (a bounded drain, mirroring the async-outbox
        // check below; the shared event sink set at the top of this function
        // captures it into lastEvent).
        {
            auto* mmc = juce::MessageManager::getInstanceWithoutCreating();
            bool committed = false;
            const auto commitDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! committed && juce::Time::getMillisecondCounter() < commitDeadline)
            {
                if (mmc != nullptr) mmc->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                committed = lastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done"
                            && lastEvent.getProperty ("payload", juce::var()).getProperty ("logicalId", juce::var()).toString() == stemLogicalId;
            }
            check (committed, "mp_commit_track's async transfer completed (mp_commit_done observed)");
            check ((bool) lastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "mp_commit_done reports ok:true");
        }

        {
            MultiplayerClient peer;
            check (peer.joinSession (sessCode, "Peer", "#00ffff"), "peer joined the audio session");
            auto tmp = selftestTempPath (eng, "mp-stem-" + h0 + "." + e0);
            tmp.deleteFile();
            check (peer.downloadBlob (h0, e0, tmp), "peer fetched the stem from the relay's blob store [" + peer.lastError() + "]");
            check (tmp.existsAsFile() && tmp.getSize() > 0, "fetched stem is non-empty (" + juce::String (tmp.getSize()) + " bytes)");
            tmp.deleteFile();
            peer.leave();
        }
        cmd (ops, "mp_leave_session");

        // PR-2 — stem transfer off the message thread. Proves global apply ORDER
        // survives two quick successive commits of the SAME track (a fast second
        // commit must never jump ahead of a still-in-flight first one) through a
        // REAL live guest session (mp_join_session, not a direct apply_remote_track
        // command) — exercising the guest's own commit-frame prefetch -> apply path
        // (routeStateMutatingJob) end-to-end, including the received clip's audio
        // resolving via the worker's prefetch stage (the "receive path" case).
        section ("Multiplayer PR-2: stem transfer order + receive path (live session)");
        {
            MoshEngine ordHostEng (false, true, "pr2-order-host");
            MoshOps    ordHostOps (ordHostEng);
            MoshEngine ordGuestEng (false, true, "pr2-order-guest");
            MoshOps    ordGuestOps (ordGuestEng);

            auto ordSess = cmd (ordHostOps, "mp_create_session", objN ({ { "name", "OrdHost" }, { "color", "#101010" } }));
            check (ok (ordSess), "order: host created a session");
            const auto ordCode = ordSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (ordGuestOps, "mp_join_session",
                            objN ({ { "code", ordCode }, { "name", "OrdGuest" }, { "color", "#202020" } }))),
                   "order: guest joined the host's room (a REAL live session, not a direct apply)");
            // Settle joinSession()'s own auto-fired (harmless, 0-track) bootstrap_request
            // before creating real content -- see the identical comment in the self-heal
            // section below for why this matters once a bootstrap answer can carry a
            // (possibly slow, under MOSH_RELAY_BLOB_DELAY_MS) stem upload.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto ordMk = cmd (ordHostOps, "create_track", args1 ("name", "Order Src"));
            const auto ordTrackId = ordMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (ordHostOps, "add_test_tone_clip", objN ({ { "trackId", ordTrackId }, { "seconds", 1.0 } }))),
                   "order: host added a wave clip");

            juce::String ordLid;
            {
                auto snap = ordHostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Order Src")
                            ordLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (ordLid.isNotEmpty(), "order: host track logicalId resolved");

            // Commit #1 (original name), then IMMEDIATELY mutate + commit #2 (renamed)
            // — back-to-back, no wait in between, so both are in flight close together.
            auto ordCommit1 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit1), "order: commit #1 ok");
            check (ok (cmd (ordHostOps, "rename_track", objN ({ { "trackId", ordTrackId }, { "name", "Order Src RENAMED" } }))),
                   "order: host renamed the track");
            auto ordCommit2 = cmd (ordHostOps, "mp_commit_track", args1 ("trackId", ordTrackId));
            check (ok (ordCommit2), "order: commit #2 ok");

            // Bounded drain: the guest's own live poll loop receives BOTH commit
            // frames, each routed prefetch (download the stem) -> apply
            // (apply_remote_track) through the SAME single-worker FIFO — proving the
            // second (later) commit's apply can never be scheduled ahead of the
            // first's, even though both reference the IDENTICAL stem (so the
            // second's prefetch is a fast already-downloaded no-op, unlike the first).
            auto* ordMm = juce::MessageManager::getInstanceWithoutCreating();
            bool ordSettled = false;
            const auto ordDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            juce::String ordGuestName;
            bool ordGuestClipMissing = true;
            while (! ordSettled && juce::Time::getMillisecondCounter() < ordDeadline)
            {
                if (ordMm != nullptr) ordMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                auto t = trackSnapshotByLogicalId (ordGuestOps, ordLid);
                ordGuestName = t.getProperty ("name", juce::var()).toString();
                ordGuestClipMissing = true;
                if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                    for (auto& c : *cs)
                        if (c.getProperty ("type", juce::var()).toString() == "wave")
                            ordGuestClipMissing = (bool) c.getProperty ("sourceMissing", false);
                ordSettled = (ordGuestName == "Order Src RENAMED") && ! ordGuestClipMissing;
            }
            check (ordSettled, "order+receive: guest settles at the SECOND (later) commit's name with its clip resolved, within the bound");
            check (ordGuestName == "Order Src RENAMED",
                   "order: guest never regresses to (or gets stuck on) the FIRST commit's name -- global apply order preserved");
            check (! ordGuestClipMissing,
                   "receive path: guest's clip is NOT sourceMissing (the worker's prefetch stage downloaded the stem before commit's apply ran)");

            cmd (ordGuestOps, "mp_leave_session");
            cmd (ordHostOps, "mp_leave_session");
        }

        // PR-2 — no-freeze proxy. Gated additionally on MOSH_RELAY_BLOB_DELAY_MS (set
        // for the WHOLE relay process by relay/run-mp-selftest.sh's caller — the local
        // relay has no per-call toggle, so this only runs in a dedicated gate
        // invocation with the delay armed) so the default MOSH_SELFTEST_MP=1 run stays
        // fast. Proves mp_commit_track returns — and a second, unrelated command
        // executes — well before the artificially slow upload could possibly have
        // completed inline, deterministically demonstrating the message thread never
        // blocked on it.
        if (std::getenv ("MOSH_RELAY_BLOB_DELAY_MS") != nullptr)
        {
            section ("Multiplayer PR-2: no-freeze proxy (MOSH_RELAY_BLOB_DELAY_MS)");

            MoshEngine nfEng (false, true, "pr2-nofreeze-host");
            MoshOps    nfOps (nfEng);
            juce::var nfLastEvent;
            nfOps.setEventSink ([&] (const juce::var& e) { nfLastEvent = e; });

            auto nfSess = cmd (nfOps, "mp_create_session", objN ({ { "name", "NF" }, { "color", "#ffffff" } }));
            check (ok (nfSess), "no-freeze: host created a session");

            auto nfMk = cmd (nfOps, "create_track", args1 ("name", "NF Src"));
            const auto nfTrackId = nfMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (nfOps, "add_test_tone_clip", objN ({ { "trackId", nfTrackId }, { "seconds", 1.0 } }))),
                   "no-freeze: host added a wave clip");

            const auto nfT0 = juce::Time::getMillisecondCounterHiRes();
            auto nfCommit = cmd (nfOps, "mp_commit_track", args1 ("trackId", nfTrackId));
            const auto nfCommitElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT0;
            check (ok (nfCommit), "no-freeze: mp_commit_track ok");
            check (nfCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "uploading",
                   "no-freeze: async branch taken");
            check (nfCommitElapsedMs < 400.0,
                   "no-freeze: mp_commit_track returned near-instantly despite the delayed upload ("
                       + juce::String (nfCommitElapsedMs, 1) + "ms)");

            const auto nfT1 = juce::Time::getMillisecondCounterHiRes();
            check (ok (cmd (nfOps, "create_track", args1 ("name", "NF Trivial"))),
                   "no-freeze: a trivial command executes while the upload is still in flight");
            const auto nfTrivialElapsedMs = juce::Time::getMillisecondCounterHiRes() - nfT1;
            check (nfTrivialElapsedMs < 400.0,
                   "no-freeze: the trivial command was ALSO fast ("
                       + juce::String (nfTrivialElapsedMs, 1) + "ms) — the message thread stayed free");

            auto* nfMm = juce::MessageManager::getInstanceWithoutCreating();
            bool nfCommitted = false;
            const auto nfDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! nfCommitted && juce::Time::getMillisecondCounter() < nfDeadline)
            {
                if (nfMm != nullptr) nfMm->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                nfCommitted = nfLastEvent.getProperty ("type", juce::var()).toString() == "mp_commit_done";
            }
            check (nfCommitted, "no-freeze: the delayed upload eventually completes in the background (mp_commit_done observed)");
            check ((bool) nfLastEvent.getProperty ("payload", juce::var()).getProperty ("ok", false),
                   "no-freeze: the delayed upload succeeded");

            cmd (nfOps, "mp_leave_session");
        }

        // PR-2 — MOSH_MP_SYNC_TRANSFER kill switch. Gated on the env var being set
        // (read once at MultiplayerSession construction, so it can't be toggled
        // mid-process — a dedicated gate invocation, like the no-freeze check above).
        // Proves the switch actually reverts to the original fully synchronous/
        // inline behaviour: mp_commit_track reports status:"committed" (not
        // "uploading") and the stem is ALREADY on the relay by the time it returns
        // — no waiting for mp_commit_done required.
        if (std::getenv ("MOSH_MP_SYNC_TRANSFER") != nullptr)
        {
            section ("Multiplayer PR-2: MOSH_MP_SYNC_TRANSFER kill switch");

            MoshEngine syncEng (false, true, "pr2-syncswitch-host");
            MoshOps    syncOps (syncEng);

            auto syncSess = cmd (syncOps, "mp_create_session", objN ({ { "name", "Sync" }, { "color", "#666666" } }));
            check (ok (syncSess), "sync-switch: host created a session");
            const auto syncCode = syncSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            auto syncMk = cmd (syncOps, "create_track", args1 ("name", "Sync Src"));
            const auto syncTrackId = syncMk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (syncOps, "add_test_tone_clip", objN ({ { "trackId", syncTrackId }, { "seconds", 1.0 } }))),
                   "sync-switch: host added a wave clip");

            auto syncCommit = cmd (syncOps, "mp_commit_track", args1 ("trackId", syncTrackId));
            check (ok (syncCommit), "sync-switch: mp_commit_track ok");
            check (syncCommit.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "committed",
                   "sync-switch: status is \"committed\" (synchronous), NOT \"uploading\" — the kill switch reverted the async path");

            auto syncRefs = syncCommit.getProperty ("data", juce::var()).getProperty ("audioRefs", juce::var());
            const auto syncHash = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("hash", juce::var()).toString() : juce::String();
            const auto syncExt  = (syncRefs.isArray() && syncRefs.size() > 0) ? syncRefs[0].getProperty ("ext", juce::var()).toString() : juce::String();
            check (syncHash.length() == 64, "sync-switch: stem hash is a sha256");

            // No wait/drain here at all — under the kill switch, mp_commit_track only
            // returns once the upload+publish already completed inline, so a peer can
            // fetch the stem IMMEDIATELY.
            MultiplayerClient syncPeer;
            check (syncPeer.joinSession (syncCode, "SyncPeer", "#777777"), "sync-switch: peer joined the session");
            auto syncTmp = selftestTempPath (eng, "mp-syncswitch-" + syncHash + "." + syncExt);
            syncTmp.deleteFile();
            check (syncPeer.downloadBlob (syncHash, syncExt, syncTmp),
                   "sync-switch: peer fetched the stem immediately, no drain needed [" + syncPeer.lastError() + "]");
            check (syncTmp.existsAsFile() && syncTmp.getSize() > 0, "sync-switch: fetched stem is non-empty");
            syncTmp.deleteFile();
            syncPeer.leave();

            cmd (syncOps, "mp_leave_session");
        }

        // ── PR-2 BLOCKER: a rejected upload must surface as mp_commit_done{ok:false} ──
        // Adversarial review: MultiplayerClient::uploadBlob's raw PUT never checked the
        // HTTP status code (createInputStream() returns non-null for 4xx/5xx on macOS),
        // so a REJECTED upload (quota/auth/a transient 5xx from the relay) was reported
        // back as a false success -- mp_commit_done would fire ok:true for a commit
        // whose stem never actually landed on the relay. Drives MultiplayerSession
        // directly (constructible standalone, no MoshOps/engine needed) with a
        // synthetic audioRef under the reserved ".failtest" ext that relay/server.py's
        // MOSH_RELAY_BLOB_FAIL hook (armed for this whole gate run, like
        // MOSH_RELAY_BLOB_CORRUPT) rejects with a 503 -- proving the failure actually
        // propagates end-to-end through commit() -> uploadBlob() -> emitCommitDone(),
        // the exact chain cmdMpCommitTrack relies on. The adjacent success-path test
        // above already proves ok:true for a real commit, so this closes the other half.
        section ("Multiplayer PR-2 BLOCKER: rejected upload surfaces as mp_commit_done{ok:false}");
        {
            juce::Array<juce::var> failEvents;
            MultiplayerSession failSess (
                [] (const juce::var&) {},                                              // applyCommit (unused)
                [&failEvents] (const juce::String& type, juce::var payload)
                {
                    if (type == "mp_commit_done") failEvents.add (payload);
                },
                [] (bool, const juce::String&, const std::map<juce::String, juce::String>&) {},   // syncLocks
                [] () -> juce::var { return {}; },                                       // provideBootstrap
                [] (const juce::var&) {},                                               // applyBootstrap
                [] (const juce::var&) {});                                              // applyStructural

            const auto failCode = failSess.createSession ("FailHost", "#facade");
            check (failCode.isNotEmpty(), "commit-fail: session created");

            // A synthetic audioRef: the ext is the reserved sentinel the relay's fail
            // hook targets. The uploaded bytes/hash don't need to be a real WAV --
            // uploadBlob is rejected by the relay before any hash/content matters.
            const juce::String failPayload ("bytes-for-the-rejected-commit-upload-check");
            juce::File failSrc = selftestTempPath (eng, "commitfail-src.failtest");
            failSrc.replaceWithText (failPayload);
            juce::FileInputStream failFis (failSrc);
            const auto failHash = juce::SHA256 (failFis).toHexString();

            auto* refObj = new DynamicObject();
            refObj->setProperty ("hash", failHash);
            refObj->setProperty ("ext", "failtest");
            juce::Array<juce::var> failRefs; failRefs.add (var (refObj));
            juce::Array<juce::File> failStemFiles; failStemFiles.add (failSrc);

            const juce::String failLid ("commit-fail-logical-id");
            failSess.commit (failLid, "{\"fake\":\"blob\"}", var (failRefs), failStemFiles);

            // Bounded drain for mp_commit_done (async worker unless MOSH_MP_SYNC_TRANSFER
            // is set, in which case commit() has already returned synchronously and the
            // event was pushed inline -- either way this loop is a correct, cheap wait).
            auto* mmFail = juce::MessageManager::getInstanceWithoutCreating();
            const auto failDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (failEvents.isEmpty() && juce::Time::getMillisecondCounter() < failDeadline)
            {
                if (mmFail != nullptr) mmFail->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
            }
            check (! failEvents.isEmpty(), "commit-fail: mp_commit_done was emitted");
            if (! failEvents.isEmpty())
            {
                const auto& done = failEvents.getReference (0);
                check (done.getProperty ("logicalId", juce::var()).toString() == failLid,
                       "commit-fail: mp_commit_done carries the right logicalId");
                check (! (bool) done.getProperty ("ok", true),
                       "commit-fail: mp_commit_done reports ok:false (the rejected upload was NOT a false success)");
                check (done.getProperty ("error", juce::var()).toString().isNotEmpty(),
                       "commit-fail: mp_commit_done carries an error string");
            }

            failSrc.deleteFile();
            failSess.leaveSession();
        }

        // Async outbox (anti-jank): a fire-and-forget broadcast does NOT block the
        // message thread on HTTP — it enqueues, and the background poll thread drains
        // + publishes it. Prove the round-trip: a watcher peer eventually receives a
        // selection we broadcast through the live session.
        {
            auto host = cmd (ops, "mp_create_session", objN ({ { "name", "Sel" }, { "color", "#abcdef" } }));
            check (ok (host), "mp_create_session (outbox path) ok");
            const auto hostCode = host.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            MultiplayerClient watcher;
            check (watcher.joinSession (hostCode, "Watch", "#123456"), "watcher joined the outbox session [" + watcher.lastError() + "]");

            // Returns immediately (enqueue only — no synchronous HTTP on this thread).
            check (ok (cmd (ops, "mp_broadcast_selection", objN ({ { "trackId", "trk-7" }, { "clipId", "clip-9" } }))),
                   "mp_broadcast_selection returns without blocking");

            // Poll the watcher until the poll thread has drained + published it (bounded
            // so a stall fails the gate rather than hanging). Pump the message loop so
            // the session's callAsyncs drain too.
            auto* mm = juce::MessageManager::getInstanceWithoutCreating();
            bool gotSel = false;
            const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! gotSel && juce::Time::getMillisecondCounter() < deadline)
            {
                for (auto& f : watcher.poll())
                {
                    auto msg = f.getProperty ("msg", juce::var());
                    if (msg.getProperty ("type", juce::var()).toString() == "selection"
                        && msg.getProperty ("trackId", juce::var()).toString() == "trk-7"
                        && msg.getProperty ("clipId", juce::var()).toString() == "clip-9")
                        gotSel = true;
                }
                if (! gotSel)
                {
                    if (mm != nullptr) mm->runDispatchLoopUntil (100);
                    else juce::Thread::sleep (100);
                }
            }
            check (gotSel, "selection broadcast reached a peer via the async outbox (poll thread published it)");

            cmd (ops, "mp_leave_session");
            watcher.leave();
        }

        // Shared by both sub-sections below: a wave clip's sourceMissing flag / id,
        // read from a track located by logicalId (mirrors trackSnapshotByLogicalId's
        // own scoping, used across both the self-heal regression and the bootstrap
        // end-to-end test).
        auto clipSourceMissing = [] (MoshOps& o, const juce::String& lid) -> bool
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return (bool) c.getProperty ("sourceMissing", false);
            return false;
        };
        auto waveClipIdOf = [] (MoshOps& o, const juce::String& lid) -> juce::String
        {
            auto t = trackSnapshotByLogicalId (o, lid);
            if (auto* cs = t.getProperty ("clips", juce::var()).getArray())
                for (auto& c : *cs)
                    if (c.getProperty ("type", juce::var()).toString() == "wave")
                        return c.getProperty ("id", juce::var()).toString();
            return {};
        };

        // ── mp_fetch_missing_stems — self-healing stem resolution ───────────
        // Fresh, isolated host + guest engines (distinct session dirs, like the
        // AL-010 / "Layer 3" two-engine patterns above) so a stem download is a
        // REAL cross-directory HTTP fetch through relay/server.py's blob store,
        // not a same-directory coincidence.
        section ("Multiplayer P4: self-healing stem fetch (mp_fetch_missing_stems)");
        {
            MoshEngine hostEng (false, true, "mp-selfheal-host");
            MoshOps    hostOps (hostEng);
            MoshEngine guestEng (false, true, "mp-selfheal-guest");
            MoshOps    guestOps (guestEng);

            auto hostSess = cmd (hostOps, "mp_create_session", objN ({ { "name", "SHHost" }, { "color", "#111111" } }));
            check (ok (hostSess), "self-heal: host created a session");
            const auto shCode = hostSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();
            check (shCode.isNotEmpty(), "self-heal: host got a room code");

            check (ok (cmd (guestOps, "mp_join_session",
                            objN ({ { "code", shCode }, { "name", "SHGuest" }, { "color", "#222222" } }))),
                   "self-heal: guest joined the host's room");
            // joinSession() unconditionally fires its own bootstrap_request (the
            // normal late-join path) the instant it joins -- at this point the host
            // has zero tracks, so the round-trip answer is harmless (0 tracks -> 0
            // tracks) PROVIDED it lands before the host creates real content below.
            // Drain it here (bounded) rather than risk it landing LATE (e.g. because
            // MOSH_RELAY_BLOB_DELAY_MS is slowing down some unrelated stem upload
            // elsewhere) and overwriting the guest's own apply_remote_track state
            // via a now-stale cmdMpApplyBootstrap mid-test.
            {
                auto* mmSettle = juce::MessageManager::getInstanceWithoutCreating();
                const auto settleDeadline = juce::Time::getMillisecondCounter() + (juce::uint32) 1000;
                while (juce::Time::getMillisecondCounter() < settleDeadline)
                {
                    if (mmSettle != nullptr) mmSettle->runDispatchLoopUntil (50);
                    else juce::Thread::sleep (50);
                }
            }

            auto mk = cmd (hostOps, "create_track", args1 ("name", "SH Src"));
            const auto shTrackId = mk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip", objN ({ { "trackId", shTrackId }, { "seconds", 1.0 } }))),
                   "self-heal: host added a wave clip");

            // mp_serialize_project content-addresses + uploads the stem (the same path
            // a late-joiner's bootstrap uses) and returns the blob directly.
            auto ser = cmd (hostOps, "mp_serialize_project");
            check (ok (ser), "self-heal: host mp_serialize_project ok");
            juce::var shTrackEntry;
            if (auto* tarr = ser.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (auto rr = tv.getProperty ("audioRefs", juce::var()); rr.isArray() && rr.size() > 0)
                        shTrackEntry = tv;
            check (shTrackEntry.isObject(), "self-heal: host's bundle carries a track with audioRefs");
            const auto shBlob = shTrackEntry.getProperty ("blob", juce::var()).toString();
            check (shBlob.isNotEmpty(), "self-heal: host track blob non-empty");

            // THE REGRESSION: apply the peer's track structure directly (bypassing the
            // download-before-apply step that applyMultiplayerCommitMessage/
            // cmdMpApplyBootstrap normally run) — reproduces a transient upload/download
            // failure, where the ignored uploadBlob/downloadBlob bool result left the
            // guest's clip permanently sourceMissing with no recovery but a host re-commit.
            auto applied = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob));
            check (ok (applied), "self-heal: guest applied the track structure (no stem download)");
            const auto shLid = applied.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid.isNotEmpty(), "self-heal: applied track logicalId resolved");

            check (clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is sourceMissing before fetch (regression reproduced)");
            const auto shClipId = waveClipIdOf (guestOps, shLid);
            check (shClipId.isNotEmpty(), "self-heal: guest's wave clip id resolved");
            check (! ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks fails before the stem is fetched");

            // THE FIX: the guest self-heals by re-deriving the missing hash/ext from its
            // own clip's by-hash source ref and retrying the download.
            auto fetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (fetch), "self-heal: mp_fetch_missing_stems ok");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 1,
                   "self-heal: fetched exactly 1 missing stem");
            check ((int) fetch.getProperty ("data", juce::var()).getProperty ("failed", 0) == 0,
                   "self-heal: 0 failures");
            check (! clipSourceMissing (guestOps, shLid),
                   "self-heal: guest's clip is no longer sourceMissing after fetch");
            check (ok (cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId))),
                   "self-heal: get_clip_peaks succeeds after the fetch");

            // A second fetch with nothing missing is a cheap synchronous no-op.
            auto refetch = cmd (guestOps, "mp_fetch_missing_stems", args1 ("wait", true));
            check (ok (refetch), "self-heal: re-running mp_fetch_missing_stems is a harmless no-op");
            check ((int) refetch.getProperty ("data", juce::var()).getProperty ("fetched", 0) == 0,
                   "self-heal: nothing left to fetch");

            // Adversarial-review finding #2: every check above uses wait:true (the
            // SYNCHRONOUS branch) — the std::thread + callAsync ASYNC branch had ZERO
            // coverage. Force it directly with a second missing-stem clip on the SAME
            // host+guest room (the relay already holds the correct bytes, so this is a
            // deterministic proof the background-thread path lands correctly, not a
            // race against a deliberately-broken transfer).
            auto mk2 = cmd (hostOps, "create_track", args1 ("name", "SH Src 2"));
            const auto shTrackId2 = mk2.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (hostOps, "add_test_tone_clip",
                            objN ({ { "trackId", shTrackId2 }, { "seconds", 1.0 }, { "freq", 440.0 } }))),
                   "self-heal (async): host added a second wave clip");

            auto ser2 = cmd (hostOps, "mp_serialize_project");
            check (ok (ser2), "self-heal (async): host mp_serialize_project ok");
            juce::String shLid2;
            {
                auto snap = hostOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "SH Src 2")
                            shLid2 = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (shLid2.isNotEmpty(), "self-heal (async): host's second track logicalId resolved");

            juce::var shTrackEntry2;
            if (auto* tarr = ser2.getProperty ("data", juce::var()).getProperty ("tracks", juce::var()).getArray())
                for (auto& tv : *tarr)
                    if (tv.getProperty ("logicalId", juce::var()).toString() == shLid2)
                        shTrackEntry2 = tv;
            check (shTrackEntry2.isObject(), "self-heal (async): host's bundle carries the second track");
            const auto shBlob2 = shTrackEntry2.getProperty ("blob", juce::var()).toString();
            check (shBlob2.isNotEmpty(), "self-heal (async): second track blob non-empty");

            auto applied2 = cmd (guestOps, "apply_remote_track", args1 ("blob", shBlob2));
            check (ok (applied2), "self-heal (async): guest applied the second track structure (no stem download)");
            const auto shLid2Applied = applied2.getProperty ("data", juce::var()).getProperty ("logicalId", juce::var()).toString();
            check (shLid2Applied == shLid2, "self-heal (async): applied logicalId matches the host's second track");
            check (clipSourceMissing (guestOps, shLid2Applied),
                   "self-heal (async): guest's second clip is sourceMissing before fetch");

            // THE ASYNC PATH: no `wait` arg -> cmdMpFetchMissingStems takes the
            // std::thread + callAsync branch (mirrors cmdMpApplyBootstrap's own
            // auto-trigger call, which also omits `wait`).
            auto fetch2 = cmd (guestOps, "mp_fetch_missing_stems");
            check (ok (fetch2), "self-heal (async): mp_fetch_missing_stems (no wait) returns ok immediately");
            check (fetch2.getProperty ("data", juce::var()).getProperty ("status", juce::var()).toString() == "started",
                   "self-heal (async): took the async branch (status:\"started\")");

            // Bounded drain for the background thread's downloadBlob + its callAsync
            // completion (sourceMediaChanged + emitSnapshotInvalidated) to land.
            auto* mm2 = juce::MessageManager::getInstanceWithoutCreating();
            bool resolved2 = false;
            const auto deadline2 = juce::Time::getMillisecondCounter() + (juce::uint32) 20000;
            while (! resolved2 && juce::Time::getMillisecondCounter() < deadline2)
            {
                if (mm2 != nullptr) mm2->runDispatchLoopUntil (50);
                else juce::Thread::sleep (50);
                resolved2 = ! clipSourceMissing (guestOps, shLid2Applied);
            }
            check (resolved2, "self-heal (async): guest's clip resolved via the background thread + callAsync (previously untested code path)");
            const auto shClipId2 = waveClipIdOf (guestOps, shLid2Applied);
            auto peaksRes2 = cmd (guestOps, "get_clip_peaks", args1 ("clipId", shClipId2));
            check (ok (peaksRes2),
                   "self-heal (async): get_clip_peaks succeeds after the async fetch [clipId=" + shClipId2
                       + " err=" + peaksRes2.getProperty ("error", juce::var()).toString() + "]");

            cmd (guestOps, "mp_leave_session");
            cmd (hostOps, "mp_leave_session");
        }

        // ── PR-1 should-fix: downloadBlob rejects a corrupted transfer ───────
        // Nothing previously proved the SHA-256 integrity check in
        // MultiplayerClient::downloadBlob (see its .h doc comment) actually fires —
        // it was "correct by inspection" only. relay/server.py's MOSH_RELAY_BLOB_CORRUPT
        // hook (armed for this whole gate run by run-mp-selftest.sh, ext-scoped so it
        // can be left on without corrupting every OTHER test's real ".wav" stem) flips
        // the bytes of any raw GET whose key ends in ".corrupttest" — a reserved ext
        // used nowhere else in this file. A direct MultiplayerClient-level check (not
        // routed through MoshOps/a clip) isolates the exact mechanism cmdMpFetchMissingStems
        // depends on: its `land` lambda (MoshOps.cpp) only calls sourceMediaChanged() /
        // clears sourceMissing when downloadBlob returns true, and downloadBlob itself
        // never leaves a corrupt/truncated file on disk on a hash mismatch — so proving
        // downloadBlob's rejection here is precisely the guarantee the clip-level
        // self-heal flow (proven working above) relies on to keep a corrupted clip
        // sourceMissing (retryable) rather than falsely landing bad bytes as resolved.
        section ("Multiplayer PR-1 should-fix: downloadBlob rejects a corrupted transfer (MOSH_RELAY_BLOB_CORRUPT)");
        {
            MultiplayerClient corruptHost;
            const auto corruptCode = corruptHost.createSession ("CorruptHost", "#abcabc");
            check (corruptCode.isNotEmpty(), "corrupt: host created a session [" + corruptHost.lastError() + "]");

            MultiplayerClient corruptPeer;
            check (corruptPeer.joinSession (corruptCode, "CorruptPeer", "#cbacba"),
                   "corrupt: peer joined the room [" + corruptPeer.lastError() + "]");

            // Upload a KNOWN payload under the reserved "corrupttest" ext -- the relay's
            // hook targets exactly (and only) this ext for the whole run.
            const juce::String payload ("known-stem-bytes-for-the-corruption-rejection-check");
            juce::File srcTmp = selftestTempPath (eng, "corrupt-src.corrupttest");
            srcTmp.replaceWithText (payload);
            juce::FileInputStream fis (srcTmp);
            const auto hash = juce::SHA256 (fis).toHexString();
            check (corruptHost.uploadBlob (hash, "corrupttest", srcTmp),
                   "corrupt: host uploaded the known payload [" + corruptHost.lastError() + "]");
            srcTmp.deleteFile();

            juce::File dest = selftestTempPath (eng, "corrupt-dest-" + hash + ".corrupttest");
            dest.deleteFile();
            const bool got = corruptPeer.downloadBlob (hash, "corrupttest", dest);
            check (! got, "corrupt: downloadBlob correctly REJECTS the corrupted transfer (returns false)");
            check (! dest.existsAsFile(), "corrupt: the corrupted/truncated download was deleted, not left on disk");
            check (corruptPeer.lastError().contains ("hash mismatch"),
                   "corrupt: the error reports a hash mismatch [" + corruptPeer.lastError() + "]");

            // Retryable: a clean download (a normal ".wav"-scoped ext, untouched by the
            // hook) must still succeed right after -- the rejection above doesn't wedge
            // the client or the relay into a permanently-broken state.
            const juce::String payload2 ("clean-retry-bytes-prove-the-client-recovers");
            juce::File srcTmp2 = selftestTempPath (eng, "corrupt-retry-src.wav");
            srcTmp2.replaceWithText (payload2);
            juce::FileInputStream fis2 (srcTmp2);
            const auto hash2 = juce::SHA256 (fis2).toHexString();
            check (corruptHost.uploadBlob (hash2, "wav", srcTmp2),
                   "corrupt: host uploaded a second (clean-path) payload [" + corruptHost.lastError() + "]");
            srcTmp2.deleteFile();
            juce::File dest2 = selftestTempPath (eng, "corrupt-retry-dest-" + hash2 + ".wav");
            dest2.deleteFile();
            // NOTE: lastError() is sticky (only ever set, never cleared on success) --
            // don't print it here, it would misleadingly show the PRIOR rejection's
            // message even though this call succeeds.
            check (corruptPeer.downloadBlob (hash2, "wav", dest2),
                   "corrupt: a clean (non-corrupted-ext) retry still succeeds -- rejection is retryable, not wedged");
            check (dest2.existsAsFile(), "corrupt: the clean retry landed a real file");
            dest2.deleteFile();

            corruptPeer.leave();
            corruptHost.leave();
        }

        // ── Bootstrap end-to-end on the local/dev relay ──────────────────────
        // The NORMAL (non-regression) path: a fresh late-joiner adopts the host's
        // whole project via mp_apply_bootstrap, and the stem arrives automatically
        // (cmdMpApplyBootstrap's existing download-before-apply loop) — proving the
        // real cross-machine fetch that was previously only exercised against the
        // cloud relay now also works against relay/server.py.
        section ("Multiplayer P4: bootstrap end-to-end on the local relay");
        {
            MoshEngine bootHostEng (false, true, "mp-bootstrap-host");
            MoshOps    bootHostOps (bootHostEng);
            MoshEngine bootGuestEng (false, true, "mp-bootstrap-guest");
            MoshOps    bootGuestOps (bootGuestEng);

            auto bhSess = cmd (bootHostOps, "mp_create_session", objN ({ { "name", "BHost" }, { "color", "#333333" } }));
            check (ok (bhSess), "bootstrap: host created a session");
            const auto bhCode = bhSess.getProperty ("data", juce::var()).getProperty ("code", juce::var()).toString();

            check (ok (cmd (bootGuestOps, "mp_join_session",
                            objN ({ { "code", bhCode }, { "name", "BGuest" }, { "color", "#444444" } }))),
                   "bootstrap: guest joined the host's room");

            auto bmk = cmd (bootHostOps, "create_track", args1 ("name", "Boot Src"));
            const auto bhTrackId = bmk.getProperty ("data", juce::var()).getProperty ("trackId", juce::var()).toString();
            check (ok (cmd (bootHostOps, "add_test_tone_clip", objN ({ { "trackId", bhTrackId }, { "seconds", 1.0 } }))),
                   "bootstrap: host added a wave clip");

            auto bser = cmd (bootHostOps, "mp_serialize_project");
            check (ok (bser), "bootstrap: host mp_serialize_project ok");
            auto bBundle = bser.getProperty ("data", juce::var());
            check ((int) bBundle.getProperty ("count", 0) == 1, "bootstrap: serialized a 1-track bundle");

            auto bApp = cmd (bootGuestOps, "mp_apply_bootstrap",
                             objN ({ { "tracks", bBundle.getProperty ("tracks", juce::var()) },
                                     { "annotations", bBundle.getProperty ("annotations", juce::var()) } }));
            check (ok (bApp), "bootstrap: guest mp_apply_bootstrap ok");
            check ((int) bApp.getProperty ("data", juce::var()).getProperty ("applied", 0) == 1,
                   "bootstrap: guest applied 1 track");

            juce::String bLid;
            {
                auto snap = bootGuestOps.snapshot();
                if (auto* arr = snap["tracks"].getArray())
                    for (auto& tv : *arr)
                        if (tv.getProperty ("name", juce::var()).toString() == "Boot Src")
                            bLid = tv.getProperty ("logicalId", juce::var()).toString();
            }
            check (bLid.isNotEmpty(), "bootstrap: guest's track resolved by name");
            check (! clipSourceMissing (bootGuestOps, bLid),
                   "bootstrap: guest's clip is NOT sourceMissing (stem arrived via real cross-directory HTTP fetch)");

            cmd (bootGuestOps, "mp_leave_session");
            cmd (bootHostOps, "mp_leave_session");
        }

        a.leave();
        b.leave();
    }

    // ── SEC-001 — named song sections (MOSH_SECTIONS) end-to-end ─────────────
    {
        section ("Song sections (MOSH_SECTIONS)");
        auto sectionsArr = [&] { return ops.snapshot().getProperty ("sections", var()); };
        auto findSec = [&] (const juce::String& id) -> juce::var
        {
            auto arr = sectionsArr();
            for (int i = 0; i < arr.size(); ++i)
                if (arr[i].getProperty ("id", var()).toString() == id) return arr[i];
            return {};
        };
        const int before = sectionsArr().size();

        auto created = cmd (ops, "create_section",
                            objN ({ { "name", "Hook" }, { "startBeat", 24.0 }, { "endBeat", 40.0 }, { "color", "#f4c0d1" } }));
        check (ok (created), "create_section ok");
        const auto secId = created.getProperty ("data", var()).getProperty ("sectionId", var()).toString();
        check (secId.isNotEmpty(), "create_section returns a sectionId");
        check (sectionsArr().size() == before + 1, "snapshot.sections grew by one");
        check (findSec (secId).getProperty ("name", var()).toString() == "Hook", "new section name is Hook");
        check (std::abs ((double) findSec (secId).getProperty ("startBeat", -1.0) - 24.0) < 1e-6, "section startBeat is 24");

        check (ok (cmd (ops, "rename_section", objN ({ { "sectionId", secId }, { "name", "Chorus" } }))), "rename_section ok");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "rename reflected in snapshot");

        check (ok (cmd (ops, "move_section", objN ({ { "sectionId", secId }, { "startBeat", 32.0 }, { "endBeat", 48.0 } }))), "move_section ok");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 48.0) < 1e-6, "move reflected in snapshot");

        // Undo reverts only the last edit (the move), before save/reload resets history.
        check (ok (cmd (ops, "undo")), "undo (move_section) ok");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 40.0) < 1e-6, "undo restores the prior range");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "undo leaves the rename intact");

        // Persists across save/reload (a plain child of the Edit's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (sections) ok");
        check (ok (cmd (ops, "reload")), "reload (sections) ok");
        check (findSec (secId).getProperty ("name", var()).toString() == "Chorus", "section persists across save/reload");
        check (std::abs ((double) findSec (secId).getProperty ("endBeat", -1.0) - 40.0) < 1e-6, "section range persists across save/reload");

        check (ok (cmd (ops, "remove_section", objN ({ { "sectionId", secId } }))), "remove_section ok");
        check (! findSec (secId).isObject(), "section gone from snapshot after remove");
        check (! ok (cmd (ops, "rename_section", objN ({ { "sectionId", secId }, { "name", "Ghost" } }))), "rename of a removed section fails cleanly");
    }

    // ─── ANN-001: authored timeline annotations (MOSH_ANNOTATIONS) ───
    {
        section ("Timeline annotations (MOSH_ANNOTATIONS)");
        auto annsArr = [&] { return ops.snapshot().getProperty ("annotations", var()); };
        auto findAnn = [&] (const juce::String& id) -> juce::var
        {
            auto arr = annsArr();
            for (int i = 0; i < arr.size(); ++i)
                if (arr[i].getProperty ("id", var()).toString() == id) return arr[i];
            return {};
        };
        const int before = annsArr().size();

        auto created = cmd (ops, "create_annotation",
                            objN ({ { "text", "fix this transition" }, { "beat", 24.0 }, { "color", "#ffd166" }, { "author", "alice" } }));
        check (ok (created), "create_annotation ok");
        const auto annId = created.getProperty ("data", var()).getProperty ("annotationId", var()).toString();
        check (annId.isNotEmpty(), "create_annotation returns an annotationId");
        check (annsArr().size() == before + 1, "snapshot.annotations grew by one");
        check (findAnn (annId).getProperty ("text", var()).toString() == "fix this transition", "annotation text round-trips");
        check (findAnn (annId).getProperty ("author", var()).toString() == "alice", "annotation carries its author");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 24.0) < 1e-6, "annotation beat is 24");

        check (ok (cmd (ops, "edit_annotation", objN ({ { "annotationId", annId }, { "text", "smooth the drop" } }))), "edit_annotation ok");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "edit reflected in snapshot");

        check (ok (cmd (ops, "move_annotation", objN ({ { "annotationId", annId }, { "beat", 32.0 } }))), "move_annotation ok");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 32.0) < 1e-6, "move reflected in snapshot");

        // Undo reverts only the last edit (the move), before save/reload resets history.
        check (ok (cmd (ops, "undo")), "undo (move_annotation) ok");
        check (std::abs ((double) findAnn (annId).getProperty ("beat", -1.0) - 24.0) < 1e-6, "undo restores the prior beat");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "undo leaves the edit intact");

        // Persists across save/reload (a plain child of the Edit's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (annotations) ok");
        check (ok (cmd (ops, "reload")), "reload (annotations) ok");
        check (findAnn (annId).getProperty ("text", var()).toString() == "smooth the drop", "annotation persists across save/reload");
        check (findAnn (annId).getProperty ("author", var()).toString() == "alice", "annotation author persists across save/reload");

        // Caller-supplied id is honoured (this is how the MP broadcast keeps ids stable).
        check (ok (cmd (ops, "create_annotation", objN ({ { "annotationId", "ann-fixed" }, { "text", "shared note" }, { "beat", 4.0 } }))), "create_annotation with an explicit id ok");
        check (findAnn ("ann-fixed").getProperty ("text", var()).toString() == "shared note", "explicit-id annotation lands with that id");

        check (ok (cmd (ops, "remove_annotation", objN ({ { "annotationId", annId } }))), "remove_annotation ok");
        check (! findAnn (annId).isObject(), "annotation gone from snapshot after remove");
        check (! ok (cmd (ops, "edit_annotation", objN ({ { "annotationId", annId }, { "text", "ghost" } }))), "edit of a removed annotation fails cleanly");
    }

    // ─── LYR-001: Finish-My-Song lyric sheet (MOSH_LYRICSHEET, per-track) ───
    // State spine only (in-process, deterministic). get_rhymes is a SERVICE path
    // (covered by the Python golden test + an HTTP smoke); exercising it here would
    // spawn the generative service and break selftest isolation, so it's omitted.
    {
        section ("Lyric sheet (MOSH_LYRICSHEET)");
        auto trk = cmd (ops, "create_track", objN ({ { "name", "Vocals" } }));
        check (ok (trk), "create_track (vocals) ok");
        const auto trackId = trk.getProperty ("data", var()).getProperty ("trackId", var()).toString();

        auto sheetOf = [&] (const juce::String& tid) -> juce::var
        {
            auto tracks = ops.snapshot().getProperty ("tracks", var());
            for (int i = 0; i < tracks.size(); ++i)
                if (tracks[i].getProperty ("id", var()).toString() == tid)
                    return tracks[i].getProperty ("lyricSheet", var());
            return {};
        };
        auto linesOf = [&] (const juce::String& tid) { return sheetOf (tid).getProperty ("lines", var()); };

        check (! sheetOf (trackId).isObject(), "track starts with no lyric sheet");

        auto created = cmd (ops, "create_lyric_sheet",
                            objN ({ { "trackId", trackId }, { "grid", "1/16" }, { "topic", "comeback" } }));
        check (ok (created), "create_lyric_sheet ok");
        check (created.getProperty ("data", var()).getProperty ("sheetId", var()).toString().isNotEmpty(),
               "create_lyric_sheet returns a sheetId");
        check (sheetOf (trackId).isObject(), "snapshot.track.lyricSheet present");
        check (sheetOf (trackId).getProperty ("grid", var()).toString() == "1/16", "sheet grid is 1/16");
        check (sheetOf (trackId).getProperty ("topic", var()).toString() == "comeback", "sheet topic round-trips");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "slant",
               "default rhyme strictness is slant (rap)");
        check (! ok (cmd (ops, "create_lyric_sheet", objN ({ { "trackId", trackId } }))),
               "double create_lyric_sheet fails cleanly");

        // Append a line carrying the constraint spec (seed with ___ gaps).
        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 },
                                                       { "role", "hook" }, { "seedText", "yeah I came back ___ ___ the ___" },
                                                       { "syllableTarget", 9 }, { "rhymeGroup", "A" } }))),
               "set_lyric_line (append line 0) ok");
        check (linesOf (trackId).size() == 1, "sheet has one line");
        check (linesOf (trackId)[0].getProperty ("seedText", var()).toString() == "yeah I came back ___ ___ the ___",
               "line seedText round-trips WITH gaps");
        check ((int) linesOf (trackId)[0].getProperty ("syllableTarget", -1) == 9, "line syllableTarget is 9");
        check (linesOf (trackId)[0].getProperty ("role", var()).toString() == "hook", "line role is hook");

        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 1 },
                                                       { "role", "verse" }, { "seedText", "___ on the grind" } }))),
               "set_lyric_line (append line 1) ok");
        check (linesOf (trackId).size() == 2, "sheet has two lines");
        check (! ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 9 } }))),
               "set_lyric_line out-of-range fails (lines stay dense)");

        // Finalize line 0's text → status flips off "empty".
        check (ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 },
                                                       { "text", "yeah I came back lit the flame" } }))),
               "set_lyric_line (edit text) ok");
        check (linesOf (trackId)[0].getProperty ("text", var()).toString() == "yeah I came back lit the flame",
               "line text updated");
        check (linesOf (trackId)[0].getProperty ("status", var()).toString() == "seed",
               "a line carrying text is no longer empty");

        // Sheet-level constraint + undo.
        check (ok (cmd (ops, "set_lyric_constraint", objN ({ { "trackId", trackId }, { "mood", "defiant" }, { "rhymeStrictness", "perfect" } }))),
               "set_lyric_constraint ok");
        check (sheetOf (trackId).getProperty ("mood", var()).toString() == "defiant", "sheet mood updated");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "perfect", "sheet strictness updated");
        check (ok (cmd (ops, "undo")), "undo (set_lyric_constraint) ok");
        check (sheetOf (trackId).getProperty ("rhymeStrictness", var()).toString() == "slant",
               "undo restores the prior strictness");

        // Persists across save/reload (a plain child of the track's own ValueTree).
        check (ok (cmd (ops, "save")),   "save (lyrics) ok");
        check (ok (cmd (ops, "reload")), "reload (lyrics) ok");
        check (sheetOf (trackId).isObject(), "lyric sheet persists across save/reload");
        check (linesOf (trackId).size() == 2, "lines persist across save/reload");
        check (linesOf (trackId)[0].getProperty ("text", var()).toString() == "yeah I came back lit the flame",
               "line text persists across save/reload");

        // confirm_skeleton (Phase-2 grid gate): with no `proposed` lines it's a clean no-op
        // (confirmed:0). The proposed→seed flip itself is covered by test_lyrics.cpp (state) +
        // the --run-script skeleton end-to-end — build_skeleton_from_clip spawns the service, so
        // the full mumble→skeleton path is OUT of the hermetic selftest (mirrors build_lyrics).
        {
            auto cs = cmd (ops, "confirm_skeleton", objN ({ { "trackId", trackId } }));
            check (ok (cs), "confirm_skeleton ok (no proposed lines)");
            check ((int) cs.getProperty ("data", var()).getProperty ("confirmed", -1) == 0,
                   "confirm_skeleton confirms 0 when nothing is proposed");
        }

        // remove_lyric_line keeps indices dense.
        check (ok (cmd (ops, "remove_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 } }))),
               "remove_lyric_line ok");
        check (linesOf (trackId).size() == 1, "one line after remove");
        check ((int) linesOf (trackId)[0].getProperty ("index", -1) == 0, "remaining line re-indexed to 0");

        check (ok (cmd (ops, "remove_lyric_sheet", objN ({ { "trackId", trackId } }))), "remove_lyric_sheet ok");
        check (! sheetOf (trackId).isObject(), "lyric sheet gone from snapshot after remove");
        check (! ok (cmd (ops, "set_lyric_line", objN ({ { "trackId", trackId }, { "lineIndex", 0 }, { "text", "ghost" } }))),
               "set_lyric_line on a sheetless track fails cleanly");
        check (! ok (cmd (ops, "confirm_skeleton", objN ({ { "trackId", trackId } }))),
               "confirm_skeleton on a sheetless track fails cleanly");
    }

    // ─── AGT-MEM (Phase-B memory lane, M1): the native agent-memory store ───
    // Pure file I/O (src/moshops/AgentMemoryStore.h) — no ValueTree/Edit mutation, no
    // snapshot change, no undo transaction. MOSH_AGENT_DIR is already pinned (above)
    // to a dir inside THIS run's isolated session, so this section is hermetic against
    // both the owner's real ~/Library/Mosh/agent and any concurrent selftest run.
    {
        section ("Agent memory store (AGT-MEM)");

        // ── validation: missing/invalid scope, kind, item ──
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "kind", "preference" }, { "item", "x" } }))),
               "agent_memory_write missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write",
                          objN ({ { "scope", "nonsense" }, { "kind", "preference" }, { "item", "x" } }))),
               "agent_memory_write invalid scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "global" }, { "item", "x" } }))),
               "agent_memory_write global scope missing kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" }, { "item", "x" } }))),
               "agent_memory_write global scope invalid kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "global" }, { "kind", "preference" } }))),
               "agent_memory_write missing item fails cleanly");
        check (! ok (cmd (ops, "agent_memory_read", objN ({ { "scope", "nonsense" } }))),
               "agent_memory_read invalid scope fails cleanly");

        // ── global write -> read round-trip + kind filtering ──
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "preference" }, { "explicit", true },
                                { "item", "always keep the low end wide" } }))),
               "agent_memory_write global/preference (explicit) ok");
        auto prefWrite2 = cmd (ops, "agent_memory_write",
                               objN ({ { "scope", "global" }, { "kind", "preference" },
                                       { "item", objN ({ { "note", "leans on triplet hats" } }) } }));
        check (ok (prefWrite2), "agent_memory_write global/preference (derived, object item) ok");
        check ((int) prefWrite2.getProperty ("data", var()).getProperty ("count", -1) == 2,
               "agent_memory_write returns the post-write count");

        auto prefRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }));
        check (ok (prefRead), "agent_memory_read global/preference ok");
        auto prefItems = prefRead.getProperty ("data", var()).getProperty ("items", var());
        check (prefItems.size() == 2, "agent_memory_read returns both preference items");
        check (prefItems[0].getProperty ("item", var()).getProperty ("note", var()).toString() == "leans on triplet hats",
               "agent_memory_read is newest-first");
        check (prefItems[1].getProperty ("item", var()).toString() == "always keep the low end wide",
               "agent_memory_read's oldest item sorts last");
        check ((bool) prefItems[1].getProperty ("explicit", false), "the explicit flag round-trips");

        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "drum_pattern" },
                                { "item", "four on the floor, ghost snares" } }))),
               "agent_memory_write global/drum_pattern ok");
        auto drumRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" } }));
        check ((int) drumRead.getProperty ("data", var()).getProperty ("items", var()).size() == 1,
               "kind filtering isolates drum_pattern from preference");

        auto allRead = cmd (ops, "agent_memory_read", args1 ("scope", "global"));
        check (ok (allRead), "agent_memory_read global with no kind filter ok");
        check ((int) allRead.getProperty ("data", var()).getProperty ("items", var()).size() >= 3,
               "unfiltered global read merges every kind's store");

        // ── write survives undo (non-undoable by construction: no Tracktion txn opened) ──
        check (ok (cmd (ops, "create_track", args1 ("name", "AgtMemUndoProbe"))), "undo-probe create_track ok");
        const int tAfterCreate = tracks (ops);
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "undo-probe item" } }))),
               "agent_memory_write between the probe create_track and undo, ok");
        check (ok (cmd (ops, "undo")), "undo after agent_memory_write ok");
        check (tracks (ops) == tAfterCreate - 1,
               "undo reverted the REAL prior transaction (create_track) -- agent_memory_write left no stray empty txn");
        auto afterUndoRead = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }));
        bool undoProbeStillThere = false;
        {
            auto items = afterUndoRead.getProperty ("data", var()).getProperty ("items", var());
            for (int i = 0; i < items.size(); ++i)
                if (items[i].getProperty ("item", var()).toString() == "undo-probe item") undoProbeStillThere = true;
        }
        check (undoProbeStillThere, "agent_memory_write is NOT on the undo stack -- undo cannot remove a stored item");

        // ── mosh-log.jsonl: writes logged undoable:false; reads not logged at all ──
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool writeLogged = false, writeUndoableFalse = false, readLogged = false;
            for (auto& ln : StringArray::fromLines (slog))
            {
                if (ln.contains ("\"command\": \"agent_memory_write\""))
                {
                    writeLogged = true;
                    if (ln.contains ("\"undoable\": false")) writeUndoableFalse = true;
                }
                if (ln.contains ("\"command\": \"agent_memory_read\"")) readLogged = true;
            }
            check (writeLogged, "mosh-log.jsonl records agent_memory_write");
            check (writeUndoableFalse, "agent_memory_write logged undoable:false");
            check (! readLogged, "mosh-log.jsonl records NO agent_memory_read lines (reads are unlogged)");
        }

        // ── cap eviction: an all-derived store at cap evicts the OLDEST item ──
        {
            auto root = AgentMemoryStore::globalRoot();
            auto file = AgentMemoryStore::globalStoreFile (root, "lyric_framework");
            Array<var> seeded;
            for (int i = 0; i < AgentMemoryStore::kMaxItemsPerStore; ++i)
            {
                auto* o = new DynamicObject();
                o->setProperty ("ts", (int64) i);
                o->setProperty ("kind", "lyric_framework");
                o->setProperty ("explicit", false);
                o->setProperty ("item", "seed-" + String (i));
                seeded.add (var (o));
            }
            check (AgentMemoryStore::writeJsonlFile (file, seeded),
                   "seeded lyric_framework store to the cap (500 derived items)");

            auto atCap = cmd (ops, "agent_memory_write",
                              objN ({ { "scope", "global" }, { "kind", "lyric_framework" }, { "item", "seed-500" } }));
            check (ok (atCap), "agent_memory_write at cap (all-derived store) still succeeds");
            check ((int) atCap.getProperty ("data", var()).getProperty ("count", -1) == AgentMemoryStore::kMaxItemsPerStore,
                   "count stays at the cap after eviction");

            auto onDisk = AgentMemoryStore::readJsonlFile (file);
            check (onDisk.size() == AgentMemoryStore::kMaxItemsPerStore, "on-disk store stays at the cap");
            check (onDisk[0].getProperty ("item", var()).toString() == "seed-1",
                   "the OLDEST item (seed-0) was evicted, not an arbitrary one");
            check (onDisk[onDisk.size() - 1].getProperty ("item", var()).toString() == "seed-500",
                   "the new item was appended at the end");
        }

        // ── cap eviction: an all-EXPLICIT store rejects a derived write, but accepts
        //    (and evicts the oldest explicit item for) another explicit write ──
        {
            auto root = AgentMemoryStore::globalRoot();
            auto file = AgentMemoryStore::globalStoreFile (root, "drum_pattern");
            Array<var> seeded;
            for (int i = 0; i < AgentMemoryStore::kMaxItemsPerStore; ++i)
            {
                auto* o = new DynamicObject();
                o->setProperty ("ts", (int64) i);
                o->setProperty ("kind", "drum_pattern");
                o->setProperty ("explicit", true);
                o->setProperty ("item", "explicit-" + String (i));
                seeded.add (var (o));
            }
            check (AgentMemoryStore::writeJsonlFile (file, seeded),
                   "seeded drum_pattern store to the cap (500 explicit items)");

            auto rejected = cmd (ops, "agent_memory_write",
                                 objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "item", "should be rejected" } }));
            check (! ok (rejected), "a derived write against an all-explicit, at-cap store is rejected");
            check (rejected.getProperty ("error", var()).toString().contains ("explicit"),
                   "the rejection error is self-describing");
            check (AgentMemoryStore::readJsonlFile (file).size() == AgentMemoryStore::kMaxItemsPerStore,
                   "the rejected write did not change the on-disk store");

            auto explicitAtCap = cmd (ops, "agent_memory_write",
                                      objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "explicit", true },
                                              { "item", "explicit-500" } }));
            check (ok (explicitAtCap), "an EXPLICIT write against an all-explicit, at-cap store still succeeds");
            auto onDisk2 = AgentMemoryStore::readJsonlFile (file);
            check (onDisk2.size() == AgentMemoryStore::kMaxItemsPerStore, "count stays at the cap");
            check (onDisk2[0].getProperty ("item", var()).toString() == "explicit-1",
                   "the OLDEST explicit item (explicit-0) was the only valid eviction victim");
        }

        // ── meta.json stamped on first global write ──
        check (AgentMemoryStore::globalRoot().getChildFile ("meta.json").existsAsFile(),
               "meta.json exists after the first global write");
        check ((int) JSON::fromString (AgentMemoryStore::globalRoot().getChildFile ("meta.json").loadFileAsString())
                        .getProperty ("v", -1) == 1,
               "meta.json carries v:1");

        // ── project scope: write -> read, kind default, Save-As sidecar copy ──
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "project" }, { "item", "the bridge needs a bigger lift" } }))),
               "agent_memory_write project (kind defaults to \"note\") ok");
        check (ok (cmd (ops, "agent_memory_write",
                        objN ({ { "scope", "project" }, { "kind", "mood" }, { "explicit", true },
                                { "item", objN ({ { "mood", "triumphant" } }) } }))),
               "agent_memory_write project (explicit, custom kind) ok");

        auto projRead = cmd (ops, "agent_memory_read", args1 ("scope", "project"));
        check (ok (projRead), "agent_memory_read project ok");
        auto projItems = projRead.getProperty ("data", var()).getProperty ("items", var());
        check (projItems.size() == 2, "project sidecar carries both notes");
        check (projItems[0].getProperty ("kind", var()).toString() == "mood", "newest project note reads first");
        check (projItems[1].getProperty ("kind", var()).toString() == "note", "kind defaulted to \"note\" when omitted");

        const auto sidecarBefore = AgentMemoryStore::sidecarFileFor (eng.editFile());
        check (sidecarBefore.existsAsFile(), "the project sidecar file exists next to the edit file");

        auto agtSaFile = eng.sessionDir().getChildFile ("projects").getChildFile ("selftest-agtmem-saveas.tracktionedit");
        agtSaFile.deleteFile();
        AgentMemoryStore::sidecarFileFor (agtSaFile).deleteFile();
        check (ok (cmd (ops, "save_as", args1 ("file", agtSaFile.getFullPathName()))), "save_as (agent-memory sidecar) ok");
        check (AgentMemoryStore::sidecarFileFor (agtSaFile).existsAsFile(),
               "save_as copied the project-scope sidecar to the new location");

        auto projReadAfterSaveAs = cmd (ops, "agent_memory_read", args1 ("scope", "project"));
        check ((int) projReadAfterSaveAs.getProperty ("data", var()).getProperty ("items", var()).size() == 2,
               "both project notes survive Save-As via the copied sidecar");

        check (! ok (cmd (ops, "agent_memory_write", objN ({ { "scope", "project" } }))),
               "agent_memory_write project missing item fails cleanly");

        // ── delete / clear (M3): validation ──
        check (! ok (cmd (ops, "agent_memory_delete", objN ({ { "kind", "preference" }, { "ts", (int64) 1 } }))),
               "agent_memory_delete missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "global" }, { "kind", "preference" } }))),
               "agent_memory_delete missing ts fails cleanly");
        check (! ok (cmd (ops, "agent_memory_delete",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" }, { "ts", (int64) 1 } }))),
               "agent_memory_delete global invalid kind fails cleanly");
        check (! ok (cmd (ops, "agent_memory_clear", objN ({ { "kind", "preference" } }))),
               "agent_memory_clear missing scope fails cleanly");
        check (! ok (cmd (ops, "agent_memory_clear",
                          objN ({ { "scope", "global" }, { "kind", "nonsense" } }))),
               "agent_memory_clear global invalid kind fails cleanly");

        // ── global delete: by ts with kind given, and with kind OMITTED (search all 3) ──
        {
            auto tsOfLastWrite = [&] (const juce::String& scope, const juce::String& kind) -> int64
            {
                auto r = cmd (ops, "agent_memory_read", objN ({ { "scope", scope }, { "kind", kind }, { "limit", 1 } }));
                return (int64) r.getProperty ("data", var()).getProperty ("items", var())[0].getProperty ("ts", var ((int64) 0));
            };

            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "delete-target-1" } }))),
                   "seed for delete test 1 ok");
            const int64 ts1 = tsOfLastWrite ("global", "preference");
            check (ts1 != 0, "captured a real ts for the seeded item");

            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", (int64) 999999 } }))),
                   "agent_memory_delete with a missing ts fails cleanly");

            auto beforeCount = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" }, { "limit", 1000 } }))
                                   .getProperty ("data", var()).getProperty ("items", var()).size();
            check (ok (cmd (ops, "agent_memory_delete",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", ts1 } }))),
                   "agent_memory_delete global (kind given) ok");
            auto afterCount = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" }, { "limit", 1000 } }))
                                  .getProperty ("data", var()).getProperty ("items", var()).size();
            check (afterCount == beforeCount - 1, "delete removed exactly one item from the preference store");

            // A second delete of the SAME ts now fails (already gone).
            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "global" }, { "kind", "preference" }, { "ts", ts1 } }))),
                   "deleting an already-deleted ts fails cleanly");

            // kind OMITTED: search across all three global kind files. explicit:true
            // here because the earlier "cap eviction: an all-EXPLICIT store" checks
            // above left drum_pattern AT CAP with every item explicit — a non-explicit
            // write there would be correctly REJECTED (that's the whole point of that
            // policy); explicit:true evicts the oldest explicit one instead, same as
            // it would against a fresh/non-full store.
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "explicit", true },
                                    { "item", "delete-target-2" } }))),
                   "seed for delete test 2 (drum_pattern) ok");
            const int64 ts2 = tsOfLastWrite ("global", "drum_pattern");
            check (ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "global" }, { "ts", ts2 } }))),
                   "agent_memory_delete global with NO kind finds the right file by searching all three");
            auto drumAfter = cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" }, { "limit", 1000 } }))
                                 .getProperty ("data", var()).getProperty ("items", var());
            bool stillThere = false;
            for (int i = 0; i < drumAfter.size(); ++i)
                if (drumAfter[i].getProperty ("item", var()).toString() == "delete-target-2") stillThere = true;
            check (! stillThere, "the kind-omitted delete actually removed it from drum_pattern");
        }

        // ── global clear: per-kind vs whole-scope ──
        {
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "preference" }, { "item", "clear-pref-1" } }))),
                   "seed clear-pref-1 ok");
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "global" }, { "kind", "lyric_framework" }, { "item", "clear-lyric-1" } }))),
                   "seed clear-lyric-1 ok");

            auto clearPref = cmd (ops, "agent_memory_clear", objN ({ { "scope", "global" }, { "kind", "preference" } }));
            check (ok (clearPref), "agent_memory_clear global (kind given) ok");
            check ((int) clearPref.getProperty ("data", var()).getProperty ("cleared", -1) > 0,
                   "clear reports how many it removed");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "preference" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "preference store is empty after a kind-scoped clear");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "lyric_framework" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() > 0,
                   "a kind-scoped clear does NOT touch other kinds");

            check (ok (cmd (ops, "agent_memory_clear", args1 ("scope", "global"))),
                   "agent_memory_clear global with NO kind (whole-scope) ok");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "lyric_framework" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope clear also emptied lyric_framework");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "global" }, { "kind", "drum_pattern" } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope clear also emptied drum_pattern (incl. the earlier undo-probe item)");
        }

        // ── project delete / clear: per-kind vs whole-scope, using the note field ──
        {
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "item", "project-delete-note" } }))),
                   "seed project note (kind=note) ok");
            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "kind", "mood" }, { "item", "project-mood-x" } }))),
                   "seed project note (kind=mood) ok");

            auto projSnapshot = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                     .getProperty ("data", var()).getProperty ("items", var());
            int64 noteTs = 0;
            for (int i = 0; i < projSnapshot.size(); ++i)
                if (projSnapshot[i].getProperty ("item", var()).toString() == "project-delete-note")
                    noteTs = (int64) projSnapshot[i].getProperty ("ts", var ((int64) 0));
            check (noteTs != 0, "captured the project note's ts");

            // Wrong-kind filter refuses even with the right ts.
            check (! ok (cmd (ops, "agent_memory_delete",
                              objN ({ { "scope", "project" }, { "kind", "mood" }, { "ts", noteTs } }))),
                   "project delete with a kind filter that doesn't match the item's own kind fails cleanly");
            check (ok (cmd (ops, "agent_memory_delete", objN ({ { "scope", "project" }, { "ts", noteTs } }))),
                   "project delete by ts (no kind filter) ok");

            auto afterProjDelete = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                        .getProperty ("data", var()).getProperty ("items", var());
            bool moodStillThere = false;
            for (int i = 0; i < afterProjDelete.size(); ++i)
                if (afterProjDelete[i].getProperty ("item", var()).toString() == "project-mood-x") moodStillThere = true;
            check (moodStillThere, "deleting the \"note\"-kind item left the \"mood\"-kind item alone");

            auto clearMood = cmd (ops, "agent_memory_clear", objN ({ { "scope", "project" }, { "kind", "mood" } }));
            check (ok (clearMood), "project clear (kind=mood) ok");
            auto afterMoodClear = cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                                       .getProperty ("data", var()).getProperty ("items", var());
            bool anyMoodLeft = false;
            for (int i = 0; i < afterMoodClear.size(); ++i)
                if (afterMoodClear[i].getProperty ("kind", var()).toString() == "mood") anyMoodLeft = true;
            check (! anyMoodLeft, "project kind-scoped clear removed every \"mood\" item");

            check (ok (cmd (ops, "agent_memory_write",
                            objN ({ { "scope", "project" }, { "item", "one-more-project-note" } }))),
                   "seed one more project note before the whole-scope clear");
            check (ok (cmd (ops, "agent_memory_clear", args1 ("scope", "project"))),
                   "project clear with NO kind (whole-scope) ok");
            check ((int) cmd (ops, "agent_memory_read", objN ({ { "scope", "project" }, { "limit", 1000 } }))
                          .getProperty ("data", var()).getProperty ("items", var()).size() == 0,
                   "whole-scope project clear leaves the sidecar's notes empty");
        }

        // ── delete/clear mosh-log.jsonl posture: logged, undoable:false (they ARE mutations) ──
        {
            auto slog = eng.sessionDir().getChildFile ("mosh-log.jsonl").loadFileAsString();
            bool deleteLogged = false, deleteUndoableFalse = false, clearLogged = false, clearUndoableFalse = false;
            for (auto& ln : StringArray::fromLines (slog))
            {
                if (ln.contains ("\"command\": \"agent_memory_delete\""))
                {
                    deleteLogged = true;
                    if (ln.contains ("\"undoable\": false")) deleteUndoableFalse = true;
                }
                if (ln.contains ("\"command\": \"agent_memory_clear\""))
                {
                    clearLogged = true;
                    if (ln.contains ("\"undoable\": false")) clearUndoableFalse = true;
                }
            }
            check (deleteLogged, "mosh-log.jsonl records agent_memory_delete");
            check (deleteUndoableFalse, "agent_memory_delete logged undoable:false");
            check (clearLogged, "mosh-log.jsonl records agent_memory_clear");
            check (clearUndoableFalse, "agent_memory_clear logged undoable:false");
        }
    }

    // ── DAW-parity P6: table-driven undo + persist matrices ──────────────────────
    // The G14 bug class (a setter that applies but bypasses the UndoManager) has now
    // recurred twice (set_track_volume, set_plugin_param) — exactly when hand-written
    // per-command checks should become a TABLE. Every declared mutating command is run
    // against a shared fixture and must (a) change the canonical snapshot, (b) restore
    // it EXACTLY on one undo; then the whole mutated state must survive save/reload
    // byte-for-byte (catches non-serialized CachedValues — fade/warp/loop-region fields
    // are the fresh risk surface). NOT in the table (each deliberately): composite/async
    // commands (add_drum_pattern, render_layer — own sections), service-spawning
    // commands (lyrics/generative — hermeticity), non-undoable preferences
    // (set_key/set_count_in/set_metronome — documented posture), read-only commands,
    // and MP lock behavior (LockManager::classify fails CLOSED to SessionGlobal by
    // design; per-command lock conduct is test_multiplayer_locks' lane).
    {
        section ("matrix: undo — every declared mutating command restores on ONE undo");

        // Canonical snapshot: strip the volatile subtrees so string equality means
        // STATE equality (transport rides its own rail; dirty flips on save/undo), and
        // round every numeric leaf to 1e-6 — the fader's dB↔position curve round-trips
        // with float epsilon (undo lands at -2.4e-07, not 0.0), which is restoration,
        // not drift. (v == 0.0 assignment also normalizes negative zero.)
        std::function<void (var&)> normNums = [&normNums] (var& v)
        {
            if (v.isDouble())
            {
                double d = std::round ((double) v * 1e6) / 1e6;
                if (d == 0.0) d = 0.0;
                v = d;
            }
            else if (v.isArray())
            {
                for (auto& e : *v.getArray()) normNums (e);
            }
            else if (auto* o = v.getDynamicObject())
            {
                for (auto& p : o->getProperties())
                {
                    var e = p.value;
                    normNums (e);
                    o->setProperty (p.name, e);
                }
            }
        };
        auto canon = [&]() -> String
        {
            auto s = ops.snapshot();
            if (auto* o = s.getDynamicObject())
            {
                o->removeProperty ("transport");
                o->removeProperty ("controller");
                if (auto* sess = o->getProperty ("session").getDynamicObject())
                {
                    sess->removeProperty ("dirty");
                    sess->removeProperty ("recentProjects");
                    sess->removeProperty ("recoveryAvailable");
                    sess->removeProperty ("recoverableCount");
                }
            }
            // An AUTOMATED parameter's live `value` is DERIVED, not persisted: it is the
            // curve evaluated at the playhead. The matrix sets param 0 to 0.7 and then adds
            // a single automation point of 0.5 — one point means the curve is constant 0.5
            // everywhere, so 0.7 is merely a stale live value that automation had not yet
            // overwritten, and a reload correctly re-derives 0.5. Comparing it across
            // save/reload compares a transient, exactly like `transport`/`dirty` above.
            // The `points` array IS the persisted truth and stays in the comparison.
            std::function<void (var&)> dropAutomatedValues = [&dropAutomatedValues] (var& v)
            {
                if (auto* arr = v.getArray())
                    for (auto& e : *arr) dropAutomatedValues (e);
                else if (auto* o = v.getDynamicObject())
                {
                    if (o->hasProperty ("automated") && (bool) o->getProperty ("automated"))
                        o->removeProperty ("value");
                    for (auto& p : o->getProperties())
                    {
                        auto child = p.value;
                        dropAutomatedValues (child);
                    }
                }
            };
            dropAutomatedValues (s);
            normNums (s);
            return JSON::toString (s, false);
        };
        auto rid = [] (const var& r, const char* k) {
            return r.getProperty ("data", var()).getProperty (k, var()).toString(); };

        // Fixture: a wave track with an EQ, a MIDI track with one OFF-GRID note (so
        // quantize genuinely mutates), a disposable track+clip for the remove cases,
        // and a bus for add_send.
        const auto mt   = rid (cmd (ops, "create_track", args1 ("name", "MxWave")), "trackId");
        const auto mwc  = rid (cmd (ops, "add_test_tone_clip",
                                    objN ({ { "trackId", mt }, { "seconds", 2.0 }, { "freq", 220.0 } })), "clipId");
        const auto eqR  = cmd (ops, "load_builtin", objN ({ { "trackId", mt }, { "type", "4bandEq" } }));
        const int  eqIx = (int) eqR.getProperty ("data", var()).getProperty ("index", -1);
        const auto mmt  = rid (cmd (ops, "create_track", args1 ("name", "MxMidi")), "trackId");
        const auto mmc  = rid (cmd (ops, "add_midi_clip",
                                    objN ({ { "trackId", mmt }, { "start", 0.0 }, { "length", 4.0 } })), "clipId");
        cmd (ops, "add_note", objN ({ { "clipId", mmc }, { "pitch", 60 }, { "start", 0.13 }, { "length", 0.5 } }));
        const auto dt   = rid (cmd (ops, "create_track", args1 ("name", "MxDisposable")), "trackId");
        const auto dc   = rid (cmd (ops, "add_test_tone_clip",
                                    objN ({ { "trackId", dt }, { "seconds", 1.0 }, { "freq", 330.0 } })), "clipId");
        const int  mbus = (int) cmd (ops, "create_bus", args1 ("name", "MxBus"))
                              .getProperty ("data", var()).getProperty ("busNumber", -1);
        check (mt.isNotEmpty() && mwc.isNotEmpty() && eqIx >= 0 && mmc.isNotEmpty()
               && dc.isNotEmpty() && mbus >= 0, "matrix fixture built");

        Array<var> rippleTracks; rippleTracks.add (var (mt));
        struct MatrixCase { String name; var args; };
        const MatrixCase table[] = {
            { "rename_track",         objN ({ { "trackId", mt }, { "name", "MxRenamed" } }) },
            { "set_track_volume",     objN ({ { "trackId", mt }, { "db", -7.0 } }) },
            { "set_track_pan",        objN ({ { "trackId", mt }, { "pan", 0.4 } }) },
            { "set_track_mute",       objN ({ { "trackId", mt }, { "mute", true } }) },
            { "set_track_solo",       objN ({ { "trackId", mt }, { "solo", true } }) },
            { "move_clip",            objN ({ { "clipId", mwc }, { "start", 5.0 } }) },
            { "rename_clip",          objN ({ { "clipId", mwc }, { "name", "MxClip" } }) },
            { "set_clip_gain",        objN ({ { "clipId", mwc }, { "gainDb", -5.0 } }) },
            { "set_clip_mute",        objN ({ { "clipId", mwc }, { "mute", true } }) },
            { "set_clip_fade",        objN ({ { "clipId", mwc }, { "fadeInSec", 0.3 }, { "fadeOutSec", 0.4 } }) },
            { "set_clip_crossfade",   objN ({ { "clipId", mwc }, { "enabled", true } }) },
            // stretch_clip BEFORE set_clip_reverse, deliberately. Reversing installs an
            // async proxy render; headless never pumps it, so the reversed clip's
            // getAudioFile().getLength() stays 0 and stretch_clip fails its
            // "source has no length" guard. Proven with --run-script: stretch→ok,
            // reverse→ok, stretch→"source has no length". That is a headless artifact of
            // the un-rendered proxy, not a persist bug — the undo matrix never saw it
            // because it undoes each mutation before applying the next, so stretch_clip
            // there always ran on an unreversed clip. (Whether stretch_clip should read
            // the SOURCE length instead of the proxy's is a real product question —
            // filed as G15 in docs/auto-loop/backlog.jsonl rather than changed here.)
            { "stretch_clip",         objN ({ { "clipId", mwc }, { "bars", 1 } }) },
            { "set_clip_reverse",     objN ({ { "clipId", mwc }, { "reversed", true } }) },
            { "set_clip_loop",        objN ({ { "clipId", mwc }, { "enabled", true }, { "start", 0.0 }, { "length", 1.0 } }) },
            { "set_clip_warp",        objN ({ { "clipId", mwc }, { "autoTempo", true } }) },
            { "normalize_clip",       objN ({ { "clipId", mwc }, { "targetDb", 0.0 } }) },
            { "duplicate_clip",       objN ({ { "clipId", mwc } }) },
            { "add_note",             objN ({ { "clipId", mmc }, { "pitch", 64 }, { "start", 1.0 }, { "length", 0.5 } }) },
            { "set_note",             objN ({ { "clipId", mmc }, { "noteIndex", 0 }, { "velocity", 70 } }) },
            { "quantize_notes",       objN ({ { "clipId", mmc }, { "division", 0.25 }, { "strength", 1.0 } }) },
            { "remove_note",          objN ({ { "clipId", mmc }, { "noteIndex", 0 } }) },
            { "load_builtin",         objN ({ { "trackId", mt }, { "type", "compressor" } }) },
            { "bypass_plugin",        objN ({ { "trackId", mt }, { "index", eqIx }, { "bypassed", true } }) },
            { "set_plugin_param",     objN ({ { "trackId", mt }, { "index", eqIx }, { "paramIndex", 0 }, { "value", 0.7 } }) },
            { "add_automation_point", objN ({ { "trackId", mt }, { "pluginIndex", eqIx }, { "paramIndex", 0 },
                                              { "time", 1.0 }, { "value", 0.5 } }) },
            { "set_master_volume",    objN ({ { "db", -5.0 } }) },
            { "set_master_pan",       objN ({ { "pan", -0.3 } }) },
            { "load_master_builtin",  objN ({ { "type", "delay" } }) },
            { "set_tempo",            objN ({ { "bpm", 100.0 } }) },
            { "insert_tempo_change",  objN ({ { "time", 4.0 }, { "bpm", 140.0 } }) },
            { "set_time_signature",   objN ({ { "numerator", 3 }, { "denominator", 4 } }) },
            { "insert_time_sig_change", objN ({ { "time", 8.0 }, { "numerator", 6 }, { "denominator", 8 } }) },
            { "create_track",         objN ({ { "name", "MxNew" } }) },
            { "remove_clip",          objN ({ { "clipId", dc } }) },
            { "remove_track",         objN ({ { "trackId", dt } }) },
            { "create_bus",           objN ({ { "name", "MxBus2" } }) },
            { "add_send",             objN ({ { "trackId", mt }, { "bus", mbus }, { "db", -3.0 } }) },
            { "delete_time_range",    objN ({ { "start", 0.5 }, { "end", 1.0 },
                                              { "trackIds", var (rippleTracks) }, { "ripple", true } }) },
        };

        for (const auto& mc : table)
        {
            const auto s0 = canon();
            check (ok (cmd (ops, mc.name, mc.args)), (mc.name + " ok").toRawUTF8());
            const auto s1 = canon();
            check (s1 != s0, (mc.name + " mutates the canonical snapshot").toRawUTF8());
            check (ok (cmd (ops, "undo")), (mc.name + " undo ok").toRawUTF8());
            check (canon() == s0, (mc.name + " ONE undo restores the canonical snapshot").toRawUTF8());
        }

        section ("matrix: persist — the fully-mutated state survives save/reload");
        // Re-apply the whole table cumulatively (no undo), then save → reload and demand
        // canonical equality: ANY non-serialized property among the mutated fields fails.
        for (const auto& mc : table)
            check (ok (cmd (ops, mc.name, mc.args)), (mc.name + " re-applied for persist").toRawUTF8());
        const auto preSave = canon();
        check (ok (cmd (ops, "save")), "matrix save ok");
        check (ok (cmd (ops, "reload")), "matrix reload ok");
        const auto postLoad = canon();
        // A bare equality failure here is opaque — the same problem the golden-audio gate
        // solved with a feature vector. Print the first divergence (with a little context)
        // so a red run names the non-serialized field instead of just asserting inequality.
        if (postLoad != preSave)
        {
            int i = 0;
            const int n = juce::jmin (preSave.length(), postLoad.length());
            while (i < n && preSave[i] == postLoad[i]) ++i;
            const int from = juce::jmax (0, i - 90);
            std::cerr << "  persist-diff @char " << i << "\n"
                      << "    saved:  ..." << preSave.substring (from, i + 90) << "\n"
                      << "    loaded: ..." << postLoad.substring (from, i + 90) << "\n";
        }
        check (postLoad == preSave, "matrix: save/reload round-trips EVERY mutated field (canonical snapshot equal)");
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // FS-B2a — the agent batch-TRANSACTION contract, against a REAL engine.
    // Spec: docs/first-stranger-program/lanes/fs-b2.md, one section per acceptance
    // bullet. Runs after the undo matrix, so the fixture is a richly-mutated project —
    // a fingerprint over an empty session would prove very little.
    //
    // Two things every section here is written to avoid:
    //  • a suppression fixture that carries nothing to suppress (TXN-FOREIGN proves the
    //    refused call SUCCEEDS after commit, so "refused" means something);
    //  • trusting a `replayed` flag on its own (TXN-REPLAY asserts state is UNCHANGED).
    {
        section ("TXN-COMMIT: an identified 2-command transaction commits exactly");

        // The engine's own canonical fingerprint, read back through batch_status — so the
        // harness and the assertions here compare the SAME number the engine computes,
        // with no second implementation to drift.
        auto txnTrack = cmd (ops, "create_track", objN ({ { "name", "TXN Fixture" } }));
        const auto tid = txnTrack["data"].getProperty ("trackId", var()).toString();
        check (tid.isNotEmpty(), "TXN fixture track created");

        const juce::String t1 = "txn-commit-0001";
        auto begin = txnBegin (ops, t1, "set_track_level",
                               txnManifest ({ { "rq-a", "set_track_volume" },
                                              { "rq-b", "set_track_mute" } }));
        check (ok (begin), "batch_begin with a manifest ok");
        check (txnField (begin, "status") == "open", "status is open after begin");
        const auto preFp = txnField (begin, "preFingerprint");
        check (preFp.isNotEmpty(), "begin captured a pre-transaction fingerprint");
        check (txnField (begin, "fingerprint") == preFp,
               "begin itself mutates nothing (fingerprint == preFingerprint)");

        check (ok (txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -7.5 } }),
                           t1, "rq-a", 0)), "manifested step 0 applied");
        check (ok (txnCmd (ops, "set_track_mute", objN ({ { "trackId", tid }, { "mute", true } }),
                           t1, "rq-b", 1)), "manifested step 1 applied");

        // Step 5 of the harness protocol: read the resulting state WHILE THE TRANSACTION
        // IS STILL OPEN. This is the whole point of keeping it open — it removes the race
        // where a generic undo is attempted after batch_end.
        auto midStatus = txnStatus (ops, t1);
        check (ok (midStatus), "batch_status readable while open");
        check (txnField (midStatus, "status") == "open", "still open before commit");
        check ((int) midStatus["data"].getProperty ("applied", 0) == 2, "both steps recorded applied");
        check ((bool) midStatus["data"].getProperty ("canCommit", false), "commit is legal");
        check ((bool) midStatus["data"].getProperty ("canRollback", false), "rollback is legal");
        // ANTI-VACUITY: the fingerprint must have MOVED. If it had not, every "restores the
        // pre-state" assertion below would pass without the rollback doing anything.
        check (txnField (midStatus, "fingerprint") != preFp,
               "the open transaction HAS changed the session (fingerprint moved)");
        auto snapTrack = trackById (tid);
        check (std::abs ((double) snapTrack.getProperty ("volumeDb", 0.0) + 7.5) < 0.01,
               "the open transaction's volume is visible in the snapshot");

        auto end = cmd (ops, "batch_end", objN ({ { "transactionId", t1 } }));
        check (ok (end), "batch_end (commit) ok");
        check (txnField (end, "status") == "committed", "status is committed");
        check (txnField (txnStatus (ops, t1), "status") == "committed",
               "batch_status confirms committed");
        check ((bool) txnStatus (ops, t1)["data"].getProperty ("canRollback", true) == false,
               "a committed transaction may no longer be rolled back");
        // ONE undo still reverts the whole batch — the pre-existing guarantee is intact.
        check (ok (cmd (ops, "undo")), "undo after commit ok");
        auto afterUndo = trackById (tid);
        check (std::abs ((double) afterUndo.getProperty ("volumeDb", 0.0) + 7.5) > 0.01,
               "ONE undo reverted the whole committed transaction");
        cmd (ops, "redo");

        section ("TXN-ROLLBACK: a mid-transaction failure rolls back to the EXACT pre-state");

        const juce::String t2 = "txn-rollback-0002";
        auto begin2 = txnBegin (ops, t2, "set_track_level",
                                txnManifest ({ { "rq-a", "set_track_volume" },
                                               { "rq-b", "set_track_mute" } }));
        check (ok (begin2), "rollback fixture begin ok");
        const auto pre2 = txnField (begin2, "preFingerprint");

        check (ok (txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -12.0 } }),
                           t2, "rq-a", 0)), "step 0 applied before the failure");
        check (txnField (txnStatus (ops, t2), "fingerprint") != pre2,
               "step 0 really mutated the session (so the rollback below has work to do)");
        // Step 1 fails for a REAL engine reason: an unknown track id.
        auto failed = txnCmd (ops, "set_track_mute", objN ({ { "trackId", "no-such-track" },
                                                            { "mute", true } }), t2, "rq-b", 1);
        check (! ok (failed), "step 1 fails (unknown track)");
        auto failedStatus = txnStatus (ops, t2);
        check (txnField (failedStatus, "status") == "failed", "transaction status is failed");
        check (txnField (failedStatus, "failureCode") == "command_failed", "stable failure code");
        check ((int) failedStatus["data"].getProperty ("applied", -1) == 1, "exactly one step applied");
        check ((bool) failedStatus["data"].getProperty ("canCommit", true) == false,
               "a failed transaction may not commit");

        // Commit must REFUSE, and refuse without mutating.
        auto badCommit = cmd (ops, "batch_end", objN ({ { "transactionId", t2 } }));
        check (! ok (badCommit), "batch_end refuses an incomplete transaction");
        check (badCommit.getProperty ("error", var()).toString().contains ("transaction_incomplete"),
               "the refusal names transaction_incomplete");

        auto rolled = cmd (ops, "batch_rollback", objN ({ { "transactionId", t2 } }));
        check (ok (rolled), "batch_rollback ok");
        check (txnField (rolled, "status") == "rolled_back", "status is rolled_back");
        check (txnField (rolled, "fingerprint") == pre2,
               "rollback restored the EXACT pre-transaction fingerprint");
        // Repeating it is idempotent, not a second undo (which would eat unrelated work).
        auto rolledAgain = cmd (ops, "batch_rollback", objN ({ { "transactionId", t2 } }));
        check (ok (rolledAgain), "repeat batch_rollback is idempotent");
        check (txnField (rolledAgain, "fingerprint") == pre2,
               "the repeat undid nothing further (fingerprint unmoved)");

        section ("TXN-POSTCOND: a false postcondition rolls back the STILL-OPEN transaction");

        const juce::String t3 = "txn-postcond-0003";
        auto begin3 = txnBegin (ops, t3, "set_track_level",
                                txnManifest ({ { "rq-a", "set_track_volume" } }));
        const auto pre3 = txnField (begin3, "preFingerprint");
        check (ok (txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -3.25 } }),
                           t3, "rq-a", 0)), "the command itself succeeded");
        auto openStatus = txnStatus (ops, t3);
        check (txnField (openStatus, "status") == "open", "transaction still open for the check");
        check ((bool) openStatus["data"].getProperty ("canCommit", false),
               "commit WOULD be legal — the postcondition is the only thing stopping it");
        // The harness evaluates its postcondition here and (in this fixture) rejects.
        auto rolled3 = cmd (ops, "batch_rollback", objN ({ { "transactionId", t3 } }));
        check (ok (rolled3), "rollback of a successful-but-rejected transaction ok");
        check (txnField (rolled3, "fingerprint") == pre3, "pre-state restored exactly");
        auto t3Track = trackById (tid);
        check (std::abs ((double) t3Track.getProperty ("volumeDb", 0.0) + 3.25) > 0.01,
               "the rejected volume is gone from the snapshot");

        section ("TXN-REPLAY: response-loss injection never double-applies");

        const juce::String t4 = "txn-replay-0004";
        auto manifest4 = txnManifest ({ { "rq-a", "set_track_volume" } });
        // (1) A lost batch_begin response: retry with the identical manifest.
        auto b4 = txnBegin (ops, t4, "set_track_level", manifest4);
        check (ok (b4), "begin ok");
        auto b4again = txnBegin (ops, t4, "set_track_level",
                                 txnManifest ({ { "rq-a", "set_track_volume" } }));
        check (ok (b4again), "retried begin with an identical manifest is idempotent");
        check ((bool) b4again["data"].getProperty ("replayed", false), "the retry is marked replayed");
        check (txnField (b4again, "status") == "open", "…and did not open a second transaction");
        const auto pre4 = txnField (b4, "preFingerprint");

        // (2) A lost COMMAND response: retry the same requestId with the same envelope.
        check (ok (txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -9.0 } }),
                           t4, "rq-a", 0)), "step 0 applied");
        const auto fpAfterOnce = txnField (txnStatus (ops, t4), "fingerprint");
        auto retry = txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -9.0 } }),
                             t4, "rq-a", 0);
        check (ok (retry), "the retried command returns the recorded result");
        check ((bool) retry.getProperty ("replayed", false), "…marked replayed");
        // A `replayed` flag proves nothing on its own. THIS is the assertion that matters:
        check (txnField (txnStatus (ops, t4), "fingerprint") == fpAfterOnce,
               "the retry applied NOTHING (fingerprint unchanged)");
        check ((int) txnStatus (ops, t4)["data"].getProperty ("applied", -1) == 1,
               "…and did not double-count the step");

        // (3) A retry whose content silently changed must be REJECTED, not replayed.
        auto conflict = txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -9.5 } }),
                               t4, "rq-a", 0);
        check (! ok (conflict), "a reused requestId with different args is rejected");
        check (conflict.getProperty ("error", var()).toString().contains ("request_envelope_conflict"),
               "…naming request_envelope_conflict");
        check (txnField (txnStatus (ops, t4), "fingerprint") == fpAfterOnce,
               "the rejected retry mutated nothing");

        // (4) A lost batch_end response: repeat it.
        auto e4 = cmd (ops, "batch_end", objN ({ { "transactionId", t4 } }));
        check (ok (e4), "commit ok");
        auto e4again = cmd (ops, "batch_end", objN ({ { "transactionId", t4 } }));
        check (ok (e4again), "repeated commit is idempotent");
        check ((bool) e4again["data"].getProperty ("replayed", false), "…marked replayed");
        check (txnField (e4again, "fingerprint") == txnField (e4, "fingerprint"),
               "the repeated commit changed nothing");
        // (5) A command retry arriving AFTER commit still replays rather than re-applying.
        auto postCommitRetry = txnCmd (ops, "set_track_volume",
                                       objN ({ { "trackId", tid }, { "db", -9.0 } }), t4, "rq-a", 0);
        check (ok (postCommitRetry) && (bool) postCommitRetry.getProperty ("replayed", false),
               "a post-commit retry of a recorded step replays");
        check (txnField (txnStatus (ops, t4), "fingerprint") == fpAfterOnce,
               "…and applied nothing");
        cmd (ops, "undo");   // put the fixture back
        check (txnField (txnStatus (ops, t4), "fingerprint") == pre4,
               "undo of the committed transaction returns to its pre-state");

        // (6) THE ONE THAT ACTUALLY PROVES "never double-apply". Every leg above used
        // set_track_volume, which sets an ABSOLUTE value — so re-dispatching it a second
        // time is invisible in both the fingerprint and the applied count, and a sabotage
        // that replaced the replay with a re-dispatch slipped past all of them. A command
        // whose second application is VISIBLE is required: create_track ADDS one.
        const juce::String t4b = "txn-replay-0004b";
        check (ok (txnBegin (ops, t4b, "add_track_skill",
                             txnManifest ({ { "rq-t", "create_track" } }))), "additive begin ok");
        const int tracksBefore = tracks (ops);
        auto made = txnCmd (ops, "create_track", objN ({ { "name", "Replay Probe" } }),
                            t4b, "rq-t", 0);
        check (ok (made), "create_track applied once");
        check (tracks (ops) == tracksBefore + 1, "…adding exactly one track");
        const auto madeId = made["data"].getProperty ("trackId", var()).toString();
        auto madeAgain = txnCmd (ops, "create_track", objN ({ { "name", "Replay Probe" } }),
                                 t4b, "rq-t", 0);
        check (ok (madeAgain), "the retried create_track returns the recorded result");
        check (tracks (ops) == tracksBefore + 1,
               "THE DOUBLE-APPLY CHECK: a retried create_track added NO second track");
        check (madeAgain["data"].getProperty ("trackId", var()).toString() == madeId,
               "…and returned the SAME track id, not a new one");
        check (ok (cmd (ops, "batch_rollback", objN ({ { "transactionId", t4b } }))),
               "additive transaction rolled back");
        check (tracks (ops) == tracksBefore, "…removing the probe track exactly");

        section ("TXN-FOREIGN: untagged local and relay mutations are refused mid-transaction");

        const juce::String t5 = "txn-foreign-0005";
        auto b5 = txnBegin (ops, t5, "set_track_level",
                            txnManifest ({ { "rq-a", "set_track_volume" } }));
        check (ok (b5), "begin ok");
        const auto fpOpen = txnField (b5, "fingerprint");

        // An UNTAGGED local mutation — what a UI click would send.
        auto foreign = cmd (ops, "set_track_pan", objN ({ { "trackId", tid }, { "pan", 0.4 } }));
        check (! ok (foreign), "an untagged local mutation is refused while a transaction is open");
        check (foreign.getProperty ("error", var()).toString().contains ("transaction_in_progress"),
               "…naming transaction_in_progress");
        check (txnField (txnStatus (ops, t5), "fingerprint") == fpOpen,
               "the refused mutation changed nothing");
        check (txnField (txnStatus (ops, t5), "status") == "open",
               "…and did not move the transaction's own state");

        // A tagged call for a DIFFERENT transaction id.
        auto wrongId = txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -1.0 } }),
                               "some-other-txn", "rq-a", 0);
        check (! ok (wrongId), "a call tagged for another transaction is refused");
        check (wrongId.getProperty ("error", var()).toString().contains ("unknown_transaction"),
               "…naming unknown_transaction");

        // A read stays available (the exclusion window bounds mutation, not reading).
        check (ok (cmd (ops, "list_plugins")), "a read-only command still works while open");

        // An out-of-order manifested call.
        const juce::String t5b = "txn-order-0005b";
        cmd (ops, "batch_rollback", objN ({ { "transactionId", t5 } }));
        auto b5b = txnBegin (ops, t5b, "host_plugin",
                             txnManifest ({ { "rq-a", "set_track_volume" },
                                            { "rq-b", "set_track_mute" } }));
        check (ok (b5b), "two-step begin ok");
        auto outOfOrder = txnCmd (ops, "set_track_mute", objN ({ { "trackId", tid }, { "mute", true } }),
                                  t5b, "rq-b", 1);
        check (! ok (outOfOrder), "step 1 before step 0 is refused");
        check (outOfOrder.getProperty ("error", var()).toString().contains ("manifest_mismatch"),
               "…naming manifest_mismatch");
        // An EXTRA call not in the manifest at all.
        auto extra = txnCmd (ops, "set_track_pan", objN ({ { "trackId", tid }, { "pan", 0.2 } }),
                             t5b, "rq-not-in-manifest", 0);
        check (! ok (extra), "a call whose requestId is not in the manifest is refused");
        cmd (ops, "batch_rollback", objN ({ { "transactionId", t5b } }));

        // AND — the anti-vacuity leg — the very same untagged call SUCCEEDS once the
        // transaction is over. Without this, "refused" could just mean "always broken".
        auto afterClose = cmd (ops, "set_track_pan", objN ({ { "trackId", tid }, { "pan", 0.4 } }));
        check (ok (afterClose), "the same untagged mutation succeeds after the transaction closes");
        check (std::abs ((double) trackById (tid).getProperty ("pan", 0.0) - 0.4) < 0.01,
               "…and really landed");
        cmd (ops, "undo");

        section ("TXN-IDENTITY: ids are idempotent only for identical envelopes");

        const juce::String t6 = "txn-identity-0006";
        check (ok (txnBegin (ops, t6, "set_track_level",
                             txnManifest ({ { "rq-a", "set_track_volume" } }))), "begin ok");
        // Same id, DIFFERENT manifest → hard error.
        auto mutated = txnBegin (ops, t6, "set_track_level",
                                 txnManifest ({ { "rq-a", "set_track_pan" } }));
        check (! ok (mutated), "the same id with a different manifest is a hard error");
        check (mutated.getProperty ("error", var()).toString().contains ("transaction_identity_conflict"),
               "…naming transaction_identity_conflict");
        // Same id, different skill NAME → also a different identity.
        auto renamed = txnBegin (ops, t6, "other_skill",
                                 txnManifest ({ { "rq-a", "set_track_volume" } }));
        check (! ok (renamed), "the same id with a different skill name is a hard error");
        // A SECOND id while the first is unresolved → hard error.
        auto second = txnBegin (ops, "txn-identity-0006b", "set_track_level",
                                txnManifest ({ { "rq-a", "set_track_volume" } }));
        check (! ok (second), "a second transaction while one is unresolved is a hard error");
        check (second.getProperty ("error", var()).toString().contains ("transaction_already_open"),
               "…naming transaction_already_open");
        check (txnField (txnStatus (ops, t6), "status") == "open",
               "none of those refusals disturbed the open transaction");
        cmd (ops, "batch_rollback", objN ({ { "transactionId", t6 } }));
        // …and after it resolves, a new id is accepted.
        check (ok (txnBegin (ops, "txn-identity-0006c", "set_track_level",
                             txnManifest ({ { "rq-a", "set_track_volume" } }))),
               "a new id is accepted once the previous transaction resolved");
        cmd (ops, "batch_rollback", objN ({ { "transactionId", "txn-identity-0006c" } }));
        // An unknown id is NOT reported as "nothing happened" — it is reported as not found,
        // which the harness treats as unprovable rather than as success.
        auto unknown = txnStatus (ops, "txn-never-existed");
        check (ok (unknown), "batch_status answers for an unknown id");
        check ((bool) unknown["data"].getProperty ("found", true) == false, "…with found:false");
        auto rollbackUnknown = cmd (ops, "batch_rollback", objN ({ { "transactionId", "txn-never-existed" } }));
        check (! ok (rollbackUnknown), "rollback of an unknown id is refused");
        check (rollbackUnknown.getProperty ("error", var()).toString().contains ("unknown_transaction"),
               "…and performs NO generic undo");

        section ("TXN-PREFLIGHT: unsafe commands are rejected before any mutation");

        // Each of these is a DIFFERENT rejection class from fs-b2.md's list, and each is a
        // real command in the dispatch table — not a strawman.
        struct { const char* command; const char* code; const char* why; } unsafe[] = {
            { "set_metronome",  "manifest_rejected", "non-undoable engine/device preference" },
            { "render_layer",   "manifest_rejected", "asynchronous service render" },
            { "open_project",   "manifest_rejected", "project lifecycle" },
            { "undo",           "manifest_rejected", "undo/redo" },
            { "batch_begin",    "manifest_rejected", "nested batch" },
            { "no_such_command","manifest_rejected", "unknown command" },
        };
        for (const auto& u : unsafe)
        {
            const juce::String id = juce::String ("txn-preflight-") + u.command;
            auto rejected = txnBegin (ops, id, "unsafe_skill",
                                      txnManifest ({ { "rq-a", u.command } }));
            check (! ok (rejected),
                   (juce::String ("manifest preflight rejects ") + u.command + " (" + u.why + ")").toRawUTF8());
            check (rejected.getProperty ("error", var()).toString().contains (u.code),
                   (juce::String ("…naming ") + u.code + " for " + u.command).toRawUTF8());
            // No transaction may exist afterwards — a rejection must leave nothing open.
            check ((bool) txnStatus (ops, id)["data"].getProperty ("found", true) == false,
                   (juce::String ("…and opened no transaction for ") + u.command).toRawUTF8());
        }
        // A malformed manifest is rejected the same way, before any registry lookup.
        for (const auto& bad : { objN ({ { "transactionId", "txn-bad-1" }, { "name", "s" } }),
                                 objN ({ { "transactionId", "txn-bad-2" }, { "name", "s" },
                                         { "commands", var (juce::Array<var>()) } }) })
        {
            auto rejected = cmd (ops, "batch_begin", bad);
            check (! ok (rejected), "a missing/empty manifest is rejected");
        }
        // And the preflight really is a GATE, not a filter: a manifest whose FIRST step is
        // safe but whose second is not must open nothing at all.
        auto mixed = txnBegin (ops, "txn-preflight-mixed", "mixed_skill",
                               txnManifest ({ { "rq-a", "set_track_volume" },
                                              { "rq-b", "set_metronome" } }));
        check (! ok (mixed), "one unsafe step rejects the WHOLE manifest");
        check ((bool) txnStatus (ops, "txn-preflight-mixed")["data"].getProperty ("found", true) == false,
               "…and opens no transaction");
        check (ok (cmd (ops, "set_track_pan", objN ({ { "trackId", tid }, { "pan", 0.1 } }))),
               "an ordinary mutation still works after a rejected manifest (nothing was left open)");
        cmd (ops, "undo");

        section ("TXN-HEAD: an EMPTY transaction's rollback undoes nothing (the G14 trap)");

        // The reason rollback consults the undo head instead of just calling undo(): with
        // zero actions in the current set, UndoManager::undo() reaches back and destroys the
        // PREVIOUS edit (juce_UndoManager.cpp:256 getCurrentSet()). That is the G14
        // empty-transaction class, and it is REACHABLE — a skill whose commands all no-op,
        // or a postcondition rejected before any step ran, both produce it.
        //
        // The sibling branch (a FOREIGN transaction owning the head) is deliberately
        // unreachable from here: while a transaction is open MoshOps refuses every untagged
        // mutation, so nothing can take the head from underneath it. Rather than add a
        // test-only backdoor into the UndoManager to forge it, the decision itself is a pure
        // function — agenttxn::planRollback — with an exhaustive Catch2 decision table
        // ("planRollback: …" in tests/test_agent_txn.cpp).
        const juce::String t7 = "txn-head-0007";
        // A distinctive prior edit that must SURVIVE the rollback attempt below.
        check (ok (cmd (ops, "rename_track", objN ({ { "trackId", tid },
                                                    { "name", "TXN Head Sentinel" } }))),
               "sentinel edit applied before the transaction");
        auto b7 = txnBegin (ops, t7, "set_track_level",
                            txnManifest ({ { "rq-a", "set_track_volume" } }));
        check (ok (b7), "begin ok");
        auto emptyRollback = cmd (ops, "batch_rollback", objN ({ { "transactionId", t7 } }));
        check (ok (emptyRollback), "rolling back an empty transaction succeeds");
        check (txnField (emptyRollback, "status") == "rolled_back", "…reporting rolled_back");
        check (trackById (tid).getProperty ("name", var()).toString() == "TXN Head Sentinel",
               "…WITHOUT undoing the previous edit (the G14 trap)");
        // And the sentinel is genuinely undoable — so "it survived" means the rollback chose
        // not to undo it, not that undo was broken for everyone.
        check (ok (cmd (ops, "undo")), "the sentinel edit IS undoable");
        check (trackById (tid).getProperty ("name", var()).toString() != "TXN Head Sentinel",
               "…proven by undoing it explicitly");
        cmd (ops, "redo");

        section ("TXN-3CMD: a three-command transaction commits and rolls back exactly");

        // host_plugin's shape. load_builtin is used rather than a third-party VST3 so the
        // section is hermetic on any machine.
        const juce::String t9 = "txn-3cmd-0009";
        auto b9 = txnBegin (ops, t9, "host_plugin",
                            txnManifest ({ { "rq-a", "load_builtin" },
                                           { "rq-b", "set_plugin_param" },
                                           { "rq-c", "bypass_plugin" } }));
        check (ok (b9), "3-command begin ok");
        const auto pre9 = txnField (b9, "preFingerprint");
        auto loaded = txnCmd (ops, "load_builtin", objN ({ { "trackId", tid },
                                                          { "type", "compressor" } }), t9, "rq-a", 0);
        check (ok (loaded), "step 0 (load_builtin) applied");
        const int pluginIndex = (int) loaded["data"].getProperty ("index", -1);
        check (pluginIndex >= 0, "…and reported its rack index");
        check (ok (txnCmd (ops, "set_plugin_param", objN ({ { "trackId", tid },
                                                           { "index", pluginIndex },
                                                           { "paramIndex", 0 },
                                                           { "value", 0.75 } }), t9, "rq-b", 1)),
               "step 1 (set_plugin_param) applied");
        check (ok (txnCmd (ops, "bypass_plugin", objN ({ { "trackId", tid },
                                                        { "index", pluginIndex },
                                                        { "bypassed", true } }), t9, "rq-c", 2)),
               "step 2 (bypass_plugin) applied");
        auto s9 = txnStatus (ops, t9);
        check ((int) s9["data"].getProperty ("applied", -1) == 3, "all three steps applied");
        check ((int) s9["data"].getProperty ("manifestCount", -1) == 3, "manifest count is 3");
        check (txnField (s9, "fingerprint") != pre9, "the three steps changed the session");
        check (ok (cmd (ops, "batch_end", objN ({ { "transactionId", t9 } }))), "3-command commit ok");
        check (txnField (txnStatus (ops, t9), "status") == "committed", "committed");

        // …and the same shape rolled back exactly.
        const juce::String t10 = "txn-3cmd-0010";
        auto b10 = txnBegin (ops, t10, "host_plugin",
                             txnManifest ({ { "rq-a", "load_builtin" },
                                            { "rq-b", "set_plugin_param" },
                                            { "rq-c", "bypass_plugin" } }));
        const auto pre10 = txnField (b10, "preFingerprint");
        auto loaded10 = txnCmd (ops, "load_builtin", objN ({ { "trackId", tid },
                                                            { "type", "reverb" } }), t10, "rq-a", 0);
        check (ok (loaded10), "rollback fixture step 0 applied");
        const int idx10 = (int) loaded10["data"].getProperty ("index", -1);
        check (ok (txnCmd (ops, "set_plugin_param", objN ({ { "trackId", tid }, { "index", idx10 },
                                                           { "paramIndex", 0 }, { "value", 0.5 } }),
                           t10, "rq-b", 1)), "rollback fixture step 1 applied");
        // Step 2 fails: a rack index that does not exist.
        auto fail10 = txnCmd (ops, "bypass_plugin", objN ({ { "trackId", tid }, { "index", 9999 },
                                                           { "bypassed", true } }), t10, "rq-c", 2);
        check (! ok (fail10), "rollback fixture step 2 fails");
        auto rolled10 = cmd (ops, "batch_rollback", objN ({ { "transactionId", t10 } }));
        check (ok (rolled10), "3-command rollback ok");
        check (txnField (rolled10, "fingerprint") == pre10,
               "TWO applied steps reverted by ONE rollback to the exact pre-state");

        section ("TXN-LEDGER: the durable ledger carries ids and status, never args");

        auto ledger = eng.sessionDir().getChildFile ("agent-transactions.jsonl");
        check (ledger.existsAsFile(), "the transaction ledger exists under ~/Library/Mosh/session");
        const auto ledgerText = ledger.loadFileAsString();
        check (ledgerText.contains ("txn-commit-0001"), "it records a committed transaction's id");
        check (ledgerText.contains ("\"status\": \"committed\""), "…and its committed status");
        check (ledgerText.contains ("\"status\": \"rolled_back\""), "…and a rolled-back status");
        check (ledgerText.contains ("\"status\": \"failed\""), "…and a failed status");
        check (ledgerText.contains ("\"v\": 1"), "every record carries the ledger schema version");
        // The SUPPRESSION assertions. These are only meaningful because the transactions
        // above really did carry args worth leaking — set_track_volume's db, a trackId, a
        // plugin type — and because the session dir is a real path under the owner's home.
        check (ledgerText.contains ("set_track_volume") == false,
               "no command names leak into the ledger (only ids/status/counts)");
        check (ledgerText.contains ("\"args\"") == false, "no args key");
        check (ledgerText.contains ("trackId") == false, "no trackId");
        check (ledgerText.contains ("/Users/") == false, "no owner-home path");
        check (ledgerText.contains (tid) == false, "not even the fixture's own track id");

        // The RESTART-BLOCK fixture. An unresolved transaction is exactly what a crash
        // leaves behind: a `begin` record with no terminal record after it. Read the ledger
        // the way the NEXT process will — through the same pure helper initTxnLedger uses —
        // and require it to name the orphan. (The block itself needs a second process to
        // observe, so it is proven end-to-end in verify.py's real-restart check; here the
        // point is that the durable evidence a restart reads IS being written.)
        const juce::String orphan = "txn-orphan-0011";
        check (ok (txnBegin (ops, orphan, "set_track_level",
                             txnManifest ({ { "rq-a", "set_track_volume" } }))), "orphan begin ok");
        check (ok (txnCmd (ops, "set_track_volume", objN ({ { "trackId", tid }, { "db", -2.0 } }),
                           orphan, "rq-a", 0)), "orphan applied a real mutation");
        check (unresolvedIdsInLedger (ledger).contains (orphan),
               "an unresolved transaction IS visible to the next launch (would block skills)");
        // Resolve it properly so this harness run leaves nothing that would block the
        // owner's next real launch — JUCE ignores $HOME, so that file is under their home.
        check (ok (cmd (ops, "batch_rollback", objN ({ { "transactionId", orphan } }))),
               "the orphan is resolved by an exact rollback");
        check (unresolvedIdsInLedger (ledger).isEmpty(),
               "…leaving nothing unresolved for the next launch");

        // Clean up the fixture track so the harness leaves the session as it found it.
        cmd (ops, "remove_track", objN ({ { "trackId", tid } }));
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
        // FS-B2a — forward the `transaction` sibling of command/args (transaction metadata
        // rides BESIDE the handler's args, never inside them). Without this the runner
        // silently dropped it and every scripted call read as an untagged mutation, which
        // an open transaction correctly refuses. ${VAR} substitution applies here too, so a
        // golden script can capture an engine-assigned id into a later step's envelope.
        if (const auto txnMeta = command.getProperty ("transaction", var()); txnMeta.isObject())
            co->setProperty ("transaction", subst (txnMeta));

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
