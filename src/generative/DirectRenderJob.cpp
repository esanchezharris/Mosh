#include "DirectRenderJob.h"
#include "AudioStaging.h"
#include <juce_cryptography/juce_cryptography.h>
#if JUCE_MAC
#include <sys/clonefile.h>
#endif

namespace mosh
{
void DirectRenderJob::publish (const juce::String& state, const juce::String& reason)
{
    const juce::ScopedLock guard (lock);
    status = state;
    error = reason;
}

juce::Result createDirectSourceSnapshot (const juce::File& source, const juce::File& destination)
{
    if (! source.existsAsFile()) return juce::Result::fail ("Original source audio is missing.");
    if (source.isSymbolicLink()) return juce::Result::fail ("Symbolic-link audio sources cannot be frozen safely. Copy the audio into the project first.");
    if (! destination.getParentDirectory().createDirectory())
        return juce::Result::fail ("Cannot create the request artifact directory.");
#if JUCE_MAC
    if (::clonefile (source.getFullPathName().toRawUTF8(), destination.getFullPathName().toRawUTF8(), 0) == 0)
        return juce::Result::ok();
    return juce::Result::fail ("The source could not be frozen atomically on this volume. Move or copy it into the project before using Re-Imagine.");
#else
    juce::ignoreUnused (destination);
    return juce::Result::fail ("Direct Re-Imagine source freezing is currently available on macOS only.");
#endif
}

void DirectRenderJob::run (const std::shared_ptr<GenerativeJobManager>& manager)
{
    struct Finish { std::atomic<bool>& flag; ~Finish() { flag.store (true); } } finish { finished };
    const auto fail = [this] (const juce::String& reason) { publish ("error", reason); };
    if (cancelled) { publish ("cancelled"); return; }

    if (purpose == Purpose::decisionValidation)
    {
        if (expectedSourceHash.isEmpty() || expectedOutputHash.isEmpty()
            || ! originalSource.existsAsFile() || ! output.existsAsFile())
        { fail ("Pending source or result identity is missing. Generate again."); return; }
        const auto currentSourceHash = juce::SHA256 (originalSource).toHexString();
        if (cancelled) { publish ("cancelled"); return; }
        const auto currentOutputHash = juce::SHA256 (output).toHexString();
        if (currentSourceHash != expectedSourceHash || currentOutputHash != expectedOutputHash)
        { fail ("Source or pending result audio changed after generation. The result was not applied."); return; }
        publish (cancelled ? "cancelled" : "ready");
        return;
    }

    if (! directory.createDirectory()) { fail ("Cannot create the request artifact directory."); return; }
    const auto input = directory.getChildFile ("input.wav");
    originalSourceHash = juce::SHA256 (source).toHexString();
    if (! originalSource.existsAsFile() || juce::SHA256 (originalSource).toHexString() != originalSourceHash)
    { fail ("Source audio changed before generation started. The request was not submitted."); return; }
    juce::AudioFormatManager formats; formats.registerBasicFormats();
    std::unique_ptr<juce::AudioFormatReader> sourceReader (formats.createReaderFor (source));
    if (! sourceReader || sourceReader->sampleRate <= 0 || sourceStart < 0 || duration <= 0
        || sourceStart + duration > double (sourceReader->lengthInSamples) / sourceReader->sampleRate + 1.0e-6)
    { fail ("The selected source span is unavailable. Render an ordinary full audio clip first."); return; }
    sourceReader.reset();
    if (! stageWavRegionAt44k (source, sourceStart, sourceStart + duration, input))
    { fail ("Could not stage the selected source span."); return; }
    sourceHash = juce::SHA256 (input).toHexString();
    params.getDynamicObject()->setProperty ("source_sha256", sourceHash);
    if (cancelled) { publish ("cancelled"); return; }
    if (! manager->ensureServiceRunning()) { fail ("Local SA3 service unavailable. Check the existing local service and model setup."); return; }
    const auto capabilities = manager->listColors();
    if (! (bool) capabilities.getProperty ("explicitRenderDecision", false)
        || (! fixture && ! (bool) capabilities.getProperty ("sa3", false)))
    { fail ("Local SA3 capability was not confirmed. No alternate backend was used."); return; }
    if (cancelled) { publish ("cancelled"); return; }
    if (! originalSource.existsAsFile() || juce::SHA256 (originalSource).toHexString() != originalSourceHash)
    { fail ("Source audio changed before inference. The request was not submitted."); return; }
    const auto id = manager->submitJob (fixture ? "fake" : "stable_audio3", input, output, manifest, params);
    { const juce::ScopedLock guard (lock); jobId = id; }
    if (id.isEmpty()) { fail ("The local service refused the Re-Imagine request."); return; }
    const auto deadline = juce::Time::getMillisecondCounterHiRes() + 30.0 * 60.0 * 1000.0;
    while (juce::Time::getMillisecondCounterHiRes() < deadline)
    {
        if (cancelled)
        {
            const bool acknowledged = manager->cancelJob (id);
            publish ("cancelled", acknowledged ? "Result cancelled. Running inference may continue."
                : "Result cancelled locally. The service did not acknowledge cancellation; inference may continue.");
            return;
        }
        const auto response = manager->jobStatus (id, 2000);
        if (! (bool) response.getProperty ("ok", false))
        { fail ("The local render job is unavailable. Any returned files remain in its request directory."); return; }
        const auto state = response.getProperty ("status", {}).toString();
        if (state == "error" || state == "cancelled")
        { publish (state, response.getProperty ("error", "Render did not complete.").toString()); return; }
        if (state == "ready")
        {
            const auto info = juce::JSON::parse (manifest);
            const auto backend = info.getProperty ("backend", {}).toString();
            const auto adapter = info.getProperty ("adapter", {}).toString();
            const bool identityOK = (bool) info.getProperty ("ok", false) && info.getProperty ("request_id", {}).toString() == requestId
                && info.getProperty ("source_sha256", {}).toString() == sourceHash
                && (fixture ? (backend == "fixture" && adapter == "fake" && (bool) info.getProperty ("test_fixture", false))
                            : (backend == "mlx" && adapter == "stable_audio3" && info.getProperty ("model_variant", {}).toString() == "sa3-medium"));
            std::unique_ptr<juce::AudioFormatReader> reader (formats.createReaderFor (output));
            if (! identityOK || ! reader || reader->lengthInSamples <= 0 || reader->sampleRate <= 0)
            { fail ("Invalid result audio or provenance. The returned assets were preserved, but cannot be applied."); return; }
            // Never stretch, normalize or trim an unexpected model duration to conceal a defect.
            if (std::abs (double (reader->lengthInSamples) / reader->sampleRate - duration) > 1.0 / reader->sampleRate)
            { fail ("SA3 returned a different duration. The unmodified output was preserved and cannot replace this clip."); return; }
            if (! originalSource.existsAsFile() || juce::SHA256 (originalSource).toHexString() != originalSourceHash)
            { fail ("Source audio changed during generation. The result was preserved but will not be applied."); return; }
            outputHash = juce::SHA256 (output).toHexString();
            publish (cancelled ? "cancelled" : "ready");
            return;
        }
        if (state != "queued" && state != "running" && state != "rendering")
        { fail ("The service reported an unknown render state."); return; }
        { const juce::ScopedLock guard (lock); status = state == "queued" ? "queued" : "rendering";
          progress = double (response.getProperty ("progress", 0.0)); }
        juce::Thread::sleep (100);
    }
    cancelled = true;
    manager->cancelJob (id);
    fail ("Local generation timed out. Result application is cancelled; inference may continue.");
}
}
