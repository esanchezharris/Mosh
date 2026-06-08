#include "GenerativeJobManager.h"

namespace mosh
{
    juce::var GenerativeJobManager::httpGet (const juce::String& path)
    {
        juce::URL url (baseUrl() + path);
        auto opts = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                        .withConnectionTimeoutMs (4000);
        if (auto stream = url.createInputStream (opts))
            return juce::JSON::parse (stream->readEntireStreamAsString());
        return {};
    }

    juce::var GenerativeJobManager::httpSend (const juce::String& method,
                                              const juce::String& path,
                                              const juce::var& body)
    {
        juce::URL url (baseUrl() + path);
        if (! body.isVoid())
            url = url.withPOSTData (juce::JSON::toString (body));

        auto opts = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                        .withHttpRequestCmd (method)
                        .withExtraHeaders ("Content-Type: application/json")
                        .withConnectionTimeoutMs (4000);
        if (auto stream = url.createInputStream (opts))
            return juce::JSON::parse (stream->readEntireStreamAsString());
        return {};
    }

    bool GenerativeJobManager::isHealthy()
    {
        auto v = httpGet ("/health");
        return v.isObject() && (bool) v["ok"];
    }

    bool GenerativeJobManager::ensureServiceRunning (int timeoutMs)
    {
        if (isHealthy())
            return true;

        // Spawn: `py -3.12 <serviceDir>/server.py --port <port>` (StringArray form
        // avoids path-quoting issues). Falls back to `python` if the py launcher
        // isn't present.
        const auto server = serviceDir.getChildFile ("server.py").getFullPathName();
        proc = std::make_unique<juce::ChildProcess>();

        const juce::StringArray withPy { "py", "-3.12", server, "--port", juce::String (port) };
        const juce::StringArray withPython { "python", server, "--port", juce::String (port) };

        if (! proc->start (withPy))
            proc->start (withPython);
        weStartedIt = true;

        const auto deadline = juce::Time::getMillisecondCounter() + (juce::uint32) timeoutMs;
        while (juce::Time::getMillisecondCounter() < deadline)
        {
            if (isHealthy())
                return true;
            juce::Thread::sleep (100);
        }
        return false;
    }

    juce::String GenerativeJobManager::submit (const RenderRequest& req, const juce::File& outDir)
    {
        outDir.createDirectory();

        auto* b = new juce::DynamicObject();
        b->setProperty ("mode", req.mode);
        b->setProperty ("prompt", req.prompt);
        juce::Array<juce::var> colours;
        for (auto& c : req.colors) colours.add (c);
        b->setProperty ("colors", colours);
        b->setProperty ("seed", (juce::int64) req.seed);
        b->setProperty ("cacheKey", req.cacheKey());
        b->setProperty ("outDir", outDir.getFullPathName());

        auto resp = httpSend ("POST", "/jobs", juce::var (b));
        if (resp.isObject() && (bool) resp["ok"])
            return resp["jobId"].toString();
        return {};
    }

    ServiceJobStatus GenerativeJobManager::poll (const juce::String& jobId)
    {
        ServiceJobStatus s;
        auto v = httpGet ("/jobs/" + jobId);
        if (! v.isObject() || ! (bool) v["ok"])
        {
            s.status = "unknown";
            return s;
        }
        s.status = v["status"].toString();
        s.progress = (double) v["progress"];
        s.manifest = v["manifest"];
        s.error = v["error"].toString();
        return s;
    }

    bool GenerativeJobManager::cancel (const juce::String& jobId)
    {
        auto v = httpSend ("DELETE", "/jobs/" + jobId, {});
        return v.isObject() && (bool) v["ok"];
    }

    void GenerativeJobManager::shutdown()
    {
        if (weStartedIt && proc != nullptr && proc->isRunning())
            proc->kill();
        proc.reset();
        weStartedIt = false;
    }

    // ── service-backed orchestration ──────────────────────────────────────────
    RenderOutcome renderLayerViaService (RenderLayer& layer,
                                         const RenderRequest& req,
                                         GenerativeJobManager& manager,
                                         RenderCache& cache,
                                         const juce::File& outDir,
                                         RenderProgress progress,
                                         std::function<bool()> shouldCancel)
    {
        RenderOutcome out;
        out.cacheKey = req.cacheKey();
        layer.setFingerprint (req.fingerprint);

        if (cache.has (out.cacheKey))
        {
            out.ok = true;
            out.fromCache = true;
            layer.setStatus (RenderStatus::ready);
            if (progress) progress (1.0);
            return out;
        }

        layer.setStatus (RenderStatus::rendering);
        const auto jobId = manager.submit (req, outDir);
        if (jobId.isEmpty())
        {
            layer.setStatus (RenderStatus::error);
            out.error = "submit failed";
            return out;
        }

        for (;;)
        {
            if (shouldCancel && shouldCancel())
            {
                manager.cancel (jobId);
                layer.setStatus (RenderStatus::dirty);
                out.error = "canceled";
                return out;
            }

            const auto st = manager.poll (jobId);
            if (progress) progress (st.progress);

            if (st.isTerminal())
            {
                if (st.status == "done" && st.manifest.isObject())
                {
                    const auto wavPath = st.manifest["wavPath"].toString();
                    juce::File wav (wavPath);
                    juce::MemoryBlock bytes;
                    if (wav.existsAsFile())
                        wav.loadFileAsData (bytes);
                    cache.put (out.cacheKey, std::move (bytes));
                    layer.setCacheArtifact ("file:" + wavPath);
                    layer.setStatus (RenderStatus::ready);
                    out.ok = true;
                    out.fromCache = false;
                    return out;
                }

                layer.setStatus (RenderStatus::error);
                out.error = st.status == "canceled" ? "canceled" : st.error;
                return out;
            }

            juce::Thread::sleep (20);
        }
    }
}
