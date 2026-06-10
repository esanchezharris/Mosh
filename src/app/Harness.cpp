#include "Harness.h"
#include "engine/MoshEngine.h"
#include "moshops/MoshOps.h"
#include <juce_cryptography/juce_cryptography.h>
#include <atomic>
#include <cstdlib>
#include <iostream>
#include <thread>

namespace mosh
{
using namespace juce;

namespace
{
    std::atomic<bool> harnessDone { false };

    var cmd (MoshOps& ops, const String& name, var args = {})
    {
        auto* c = new DynamicObject();
        c->setProperty ("command", name);
        if (! args.isVoid()) c->setProperty ("args", args);
        return ops.execute (var (c));
    }

    void writeResult (const File& outFile, const var& result)
    {
        const auto text = JSON::toString (result, true);
        outFile.replaceWithText (text + "\n");
        std::cout << "MOSH_HARNESS_RESULT " << text << std::endl;
    }

    String argAfter (const StringArray& tokens, const String& flag)
    {
        const int i = tokens.indexOf (flag);
        return (i >= 0 && i + 1 < tokens.size()) ? tokens[i + 1].unquoted() : String();
    }

    /** MD5 over the WAV's fmt+data chunks only. The engine stamps a BWAV
        'bext' chunk with wall-clock OriginationTime, so whole-file bytes can
        never replay identically — the AUDIO must (and does). This is the
        byte-identity the conformance suite asserts (§4 req 1). */
    String audioContentMd5 (const File& wav)
    {
        MemoryBlock mb;
        if (! wav.loadFileAsData (mb) || mb.getSize() < 12) return {};
        auto* d = static_cast<const uint8*> (mb.getData());
        const size_t n = mb.getSize();
        MemoryBlock audio;
        size_t pos = 12;
        while (pos + 8 <= n)
        {
            const auto size = (size_t) ByteOrder::littleEndianInt (d + pos + 4);
            if (memcmp (d + pos, "fmt ", 4) == 0 || memcmp (d + pos, "data", 4) == 0)
                audio.append (d + pos, jmin (8 + size, n - pos));
            pos += 8 + size + (size & 1);
        }
        return MD5 (audio).toHexString();
    }
}

int runHarness (MoshEngine& eng, MoshOps& ops, const String& commandLine)
{
    auto tokens = StringArray::fromTokens (commandLine, true);
    const auto jobPath = argAfter (tokens, "--harness");
    File jobFile (File::getCurrentWorkingDirectory().getChildFile (jobPath));
    const auto outPath = argAfter (tokens, "--harness-out");
    File outFile = outPath.isNotEmpty()
                       ? File::getCurrentWorkingDirectory().getChildFile (outPath)
                       : jobFile.getSiblingFile (jobFile.getFileNameWithoutExtension() + ".result.json");

    auto fail = [&] (const String& error, int code)
    {
        auto* o = new DynamicObject();
        o->setProperty ("ok", false);
        o->setProperty ("error", error);
        writeResult (outFile, var (o));
        return code;
    };

    if (! jobFile.existsAsFile())
        return fail ("job file not found: " + jobPath, 2);
    auto job = JSON::parse (jobFile.loadFileAsString());
    const bool hasOps = job.getProperty ("ops", var()).isArray();
    const bool hasCommands = job.getProperty ("commands", var()).isArray();
    if (! hasOps && ! hasCommands)
        return fail ("job needs an 'ops' (MoshIR) or 'commands' (native) array", 2);

    // Watchdog (§4 req 4): structured failure, never a hang. Detached on
    // purpose — when it fires we are wedged, so it reports and hard-exits.
    const double timeoutS = (double) job.getProperty ("timeout_s", 120.0);
    std::thread ([outFile, timeoutS]
    {
        const auto deadline = Time::getMillisecondCounterHiRes() + timeoutS * 1000.0;
        while (Time::getMillisecondCounterHiRes() < deadline)
        {
            if (harnessDone.load()) return;
            Thread::sleep (50);
        }
        if (harnessDone.load()) return;
        auto* o = new DynamicObject();
        o->setProperty ("ok", false);
        o->setProperty ("error", "timeout after " + String (timeoutS) + "s");
        writeResult (outFile, var (o));
        std::_Exit (124);
    }).detach();

    // Optional starting state: replay-from-checkpoint (Stage 10 sync uses this).
    if (const auto before = job.getProperty ("state_before", var()).toString(); before.isNotEmpty())
    {
        File beforeFile (File::getCurrentWorkingDirectory().getChildFile (before));
        if (! beforeFile.existsAsFile())
            return fail ("state_before not found: " + before, 2);
        beforeFile.copyFileTo (eng.editFile());
        eng.reloadFromFile();
    }

    // Execute through the one mutation path. Two job dialects:
    //   ops:      [MoshIR...]            → one execute_ir batch (the replay path)
    //   commands: [{command, args}...]   → native script (collab tests, drivers)
    var ir;
    Array<var> commandResults;
    bool commandsOk = true;
    if (hasOps)
    {
        auto* irArgs = new DynamicObject();
        irArgs->setProperty ("ops", job.getProperty ("ops", var()));
        if (job.hasProperty ("tutorialId"))
            irArgs->setProperty ("tutorialId", job.getProperty ("tutorialId", var()));
        ir = cmd (ops, "execute_ir", var (irArgs));
    }
    if (hasCommands)
    {
        for (auto& c : *job.getProperty ("commands", var()).getArray())
        {
            auto r = ops.execute (c);
            commandsOk = commandsOk && (bool) r.getProperty ("ok", false);
            commandResults.add (r);
        }
    }
    auto data = ir.getProperty ("data", var());

    // L2 symbolic diff (phase0 §8) reads the canonical projection — ask for it
    // alongside the hash when the job wants it.
    const bool wantProjection = (bool) job.getProperty ("projection", false);
    auto hashRes = cmd (ops, "get_state_hash",
                        wantProjection ? [] { auto* a = new DynamicObject();
                                              a->setProperty ("projection", true);
                                              return var (a); }()
                                       : var());
    auto hash = hashRes.getProperty ("data", var()).getProperty ("hash", var()).toString();

    auto* result = new DynamicObject();
    const bool ok = (! hasOps || (bool) ir.getProperty ("ok", false)) && commandsOk;
    result->setProperty ("ok", ok);
    result->setProperty ("state_hash", hash);
    result->setProperty ("counts", data.getProperty ("counts", var()));
    result->setProperty ("results", data.getProperty ("results", var()));
    if (hasCommands)
        result->setProperty ("commandResults", commandResults);
    if (wantProjection)
        result->setProperty ("projection",
                             hashRes.getProperty ("data", var()).getProperty ("projection", var()));

    if ((bool) job.getProperty ("bounce", false))
    {
        auto bounceFile = eng.sessionDir().getChildFile ("renders").getChildFile ("harness_bounce.wav");
        auto br = cmd (ops, "export_audio", [&] {
            auto* a = new DynamicObject();
            a->setProperty ("file", bounceFile.getFullPathName());
            return var (a); }());
        auto* bo = new DynamicObject();
        bo->setProperty ("ok", (bool) br.getProperty ("ok", false));
        bo->setProperty ("file", bounceFile.getFullPathName());
        if (bounceFile.existsAsFile())
        {
            bo->setProperty ("md5", MD5 (bounceFile).toHexString());
            bo->setProperty ("audio_md5", audioContentMd5 (bounceFile));
        }
        result->setProperty ("bounce", var (bo));
    }

    // Persist: multi-invocation scenarios (collab sync) continue this session.
    cmd (ops, "save");

    harnessDone.store (true);
    writeResult (outFile, var (result));
    return ok ? 0 : 1;
}

} // namespace mosh
