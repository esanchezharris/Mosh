// Stage 8 — replay-harness commands (phase0 §4): the canonical state hash and
// pure asset generation (the Tier-B leg of seeded latent ops).

#include "MoshOps.h"
#include "state/StateHash.h"
#include <juce_cryptography/juce_cryptography.h>

namespace mosh
{
using namespace juce;

juce::var MoshOps::cmdGetStateHash (const juce::var& args)
{
    // Read-only: no transaction, no log, no events.
    auto* d = new DynamicObject();
    d->setProperty ("hash", stateHash (eng.edit()));
    if ((bool) args.getProperty ("projection", false))
        d->setProperty ("projection", stateProjection (eng.edit()));
    return okResult ("get_state_hash", var (d));
}

juce::var MoshOps::cmdGenerateAsset (const juce::var& args)
{
    // Stochastic by definition: seed is REQUIRED, never defaulted (§4 req 3).
    if (! args.hasProperty ("seed"))
        return errResult ("generate_asset", "seed required (stochastic op, no default seed)");

    const auto outPath = args.getProperty ("file", var()).toString();
    if (outPath.isEmpty())
        return errResult ("generate_asset", "missing 'file'");
    File output (outPath);
    output.getParentDirectory().createDirectory();

    const auto mode = args.getProperty ("mode", "text_to_audio").toString();
    File input;
    if (mode == "audio_to_audio")
    {
        input = File (args.getProperty ("initFile", var()).toString());
        if (! input.existsAsFile())
            return errResult ("generate_asset", "audio_to_audio requires an existing initFile");
    }

    if (! jobManager.ensureServiceRunning())
        return errResult ("generate_asset", "generative service unavailable");

    auto* p = new DynamicObject();
    p->setProperty ("mode", mode);
    p->setProperty ("prompt", args.getProperty ("prompt", ""));
    p->setProperty ("seed", args.getProperty ("seed", 0));
    p->setProperty ("seconds", args.getProperty ("seconds", 4.0));
    p->setProperty ("nl", args.getProperty ("strength", 0.4));

    const auto manifest = output.getSiblingFile (output.getFileNameWithoutExtension() + "_manifest.json");
    const auto adapter = args.getProperty ("adapter", "fake").toString();
    const auto jobId = jobManager.submitJob (adapter, input, output, manifest, var (p));
    if (jobId.isEmpty())
        return errResult ("generate_asset", "job submit failed");

    // Asset generation is a synchronous primitive (the IR executor and the
    // harness depend on its result file); renders that must not block playback
    // go through the RenderLayer flow instead.
    const int waitTimeoutMs = jmax (1000, SystemStats::getEnvironmentVariable (
        "MOSH_RENDER_WAIT_TIMEOUT_MS", "120000").getIntValue());
    String status;
    for (int i = 0; i < jmax (1, waitTimeoutMs / 50); ++i)
    {
        auto st = jobManager.jobStatus (jobId);
        status = st.getProperty ("status", var()).toString();
        if (status == "ready" || status == "error" || status == "cancelled") break;
        Thread::sleep (50);
    }
    const bool ok = status == "ready" && output.existsAsFile() && output.getSize() > 0;
    logLine ("generate_asset", args, ok, ok ? String() : ("job ended: " + status), false);
    if (! ok)
        return errResult ("generate_asset", "generation failed (status: " + status + ")");

    auto* d = new DynamicObject();
    d->setProperty ("file", output.getFullPathName());
    d->setProperty ("manifest", manifest.getFullPathName());
    d->setProperty ("bytes", (int64) output.getSize());
    d->setProperty ("contentHash", MD5 (output).toHexString());
    return okResult ("generate_asset", var (d));
}

} // namespace mosh
