#include "DirectRenderJob.h"
#include "AudioStaging.h"
#include <juce_cryptography/juce_cryptography.h>

namespace mosh
{
void DirectRenderJob::publish (const juce::String& state, const juce::String& reason)
{
    const juce::ScopedLock guard (lock);
    status = state;
    error = reason;
}

void DirectRenderJob::run (const std::shared_ptr<GenerativeJobManager>& manager)
{
    struct Finish { std::atomic<bool>& flag; ~Finish() { flag.store (true); } } finish { finished };
    const auto fail = [this] (const juce::String& reason) { publish ("error", reason); };
    if (cancelled) { publish ("cancelled"); return; }
    if (! directory.createDirectory()) { fail ("Cannot create the request artifact directory."); return; }
    const auto input = directory.getChildFile ("input.wav");
    const auto originalHash = juce::SHA256 (source).toHexString();
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
            if (juce::SHA256 (source).toHexString() != originalHash)
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
