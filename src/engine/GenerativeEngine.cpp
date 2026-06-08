#include "GenerativeEngine.h"
#include "EngineSnapshot.h"   // clipToVar
#include "AsyncRenderPool.h"
#include "Ids.h"
#include <memory>

namespace mosh
{
    namespace te = tracktion;

    static te::Clip* findClipById (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            for (auto* c : t->getClips())
                if (c->itemID.toString() == id) return c;
        return nullptr;
    }

    struct FoundLayer
    {
        te::Clip* clip = nullptr;
        juce::ValueTree tree;
        bool valid() const { return clip != nullptr && tree.isValid(); }
    };

    static FoundLayer findLayer (te::Edit& edit, const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id)) id = ref;
        for (auto* t : te::getAudioTracks (edit))
            for (auto* c : t->getClips())
                for (auto child : c->state)
                    if (child.hasType (ids::MOSH_RENDERLAYER) && child[ids::id].toString() == id)
                        return { c, child };
        return {};
    }

    static te::AudioTrack* findOrCreateNeuralTrack (te::Edit& edit)
    {
        for (auto* t : te::getAudioTracks (edit))
            if (t->getName() == "Neural") return t;
        auto t = edit.insertNewAudioTrack (te::TrackInsertPoint::getEndOfTracks (edit), nullptr);
        if (t != nullptr) t->setName ("Neural");
        return t.get();
    }

    // The source clip's backing audio file (for reimagine input + a content hash in
    // the fingerprint). // VERIFY AudioClipBase::getSourceFileReference() on the clone.
    static juce::File sourceFileFor (te::Clip* clip)
    {
        if (auto* ac = dynamic_cast<te::AudioClipBase*> (clip))
            return ac->getSourceFileReference().getFile();
        return {};
    }

    static FingerprintInputs fingerprintFor (te::Clip* clip, juce::ValueTree layerTree, const juce::String& adapterName)
    {
        FingerprintInputs fp;
        RenderLayer rl (layerTree);
        auto params = layerTree.getChildWithName (ids::params);
        fp.prompt = params[ids::prompt].toString();
        fp.colors = rl.getColors();
        { auto v = rl.getColorValues(); fp.colorValues.assign (v.begin(), v.end()); }
        fp.lab = rl.getLab();
        fp.seed = (juce::int64) layerTree[ids::seed];
        fp.modelAdapter = adapterName;
        // Upstream hash = clip identity + a content signature of its source audio,
        // so re-recording/replacing the source invalidates the cache (05 §5).
        juce::String upstream = clip->itemID.toString();
        if (const auto src = sourceFileFor (clip); src.existsAsFile())
            upstream << "|" << juce::String (src.getSize())
                     << "|" << juce::String (src.getLastModificationTime().toMilliseconds());
        fp.upstreamHash = upstream;
        const auto pos = clip->getPosition();
        fp.clipRangeStart = pos.getStart().inSeconds();
        fp.clipRangeEnd = pos.getEnd().inSeconds();
        fp.sampleRate = 44100.0;
        fp.numChannels = 2;
        return fp;
    }

    // Parse a `colors` arg as either ["name", ...] or [{name, value 0–100}, ...] plus an
    // optional `lab` flag, applying them to the layer (≤3, ordered — 05 §6). Mirrors the
    // spine command path so the UI Color Rack drives the same model in the app.
    static void applyColorArgs (RenderLayer& layer, const MoshCommand& cmd, juce::UndoManager* um)
    {
        if (cmd.hasArg ("colors"))
        {
            juce::StringArray names;
            juce::Array<int> values;
            if (auto* arr = cmd.arg ("colors").getArray())
                for (auto& c : *arr)
                {
                    if (auto* o = c.getDynamicObject())
                    {
                        names.add (o->getProperty ("name").toString());
                        values.add (o->hasProperty ("value") ? (int) o->getProperty ("value") : 100);
                    }
                    else { names.add (c.toString()); values.add (100); }
                }
            layer.setColors (names, values, um);
        }
        if (cmd.hasArg ("lab"))
            layer.setLab (cmd.argBool ("lab"), um);
    }

    void registerGenerativeEngineCommands (DslExecutor& exec, MoshEngine& engine,
                                           GenerativeJobManager& jobs, RenderCache& cache,
                                           AsyncRenderPool* pool)
    {
        auto layerSeq = std::make_shared<int> (0);

        // The active adapter (matches the service's MOSH_ADAPTER) is part of the cache
        // key so Fake and SA3 renders never collide. Read once at registration.
        const auto adapterName = juce::SystemStats::getEnvironmentVariable ("MOSH_ADAPTER", "fake");

        // The pool runs render jobs off the message thread and calls this back ON the
        // message thread to land the terminal status/artifact on the (re-found) layer.
        if (pool != nullptr)
            pool->setFinalize ([&engine] (const juce::String& layerId, RenderStatus st,
                                          const juce::String& artifact, const juce::var& quality)
            {
                auto found = findLayer (engine.getEdit(), layerId);
                if (! found.valid()) return;                       // deleted mid-render
                RenderLayer layer (found.tree);
                if (artifact.isNotEmpty()) layer.setCacheArtifact (artifact);
                if (quality.isObject())                            // judge readout for the UI
                    found.tree.setProperty (ids::quality, juce::JSON::toString (quality, true), nullptr);
                layer.setStatus (st);
            });

        // get_colors {} → the Color Rack descriptor (each color's ASTD ceiling — 05 §6)
        // so the UI can build clamped sliders. Non-blocking; returns [] until the service
        // is up (the UI retries). Couples the UI to the seam, not the service HTTP.
        exec.registerCommand ("get_colors", [&jobs] (const MoshCommand&, DslExecutor::Context&) -> MoshResult
        {
            auto colors = jobs.getColors();
            auto* data = new juce::DynamicObject();
            data->setProperty ("colors", colors.isArray() ? colors : juce::var (juce::Array<juce::var>{}));
            return MoshResult::success ("colors", juce::StringArray {}, juce::var (data));
        }, /*transactional*/ false);

        // create_render_layer {clip, prompt?, seed?, mode?} → MOSH_RENDERLAYER under the clip
        exec.registerCommand ("create_render_layer", [&engine, layerSeq] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = engine.getEdit();
            auto* clip = findClipById (edit, cmd.argString ("clip"));
            if (clip == nullptr)
                return MoshResult::failure (error::noSuchClip, "No such clip: " + cmd.argString ("clip"));

            auto* um = &ctx.undoManager();
            const auto id = juce::String (++(*layerSeq));
            auto rl = RenderLayer::create (id);   // standalone; built then parented
            if (cmd.hasArg ("prompt"))
                rl.getState().getOrCreateChildWithName (ids::params, nullptr).setProperty (ids::prompt, cmd.argString ("prompt"), nullptr);
            if (cmd.hasArg ("seed"))
                rl.getState().setProperty (ids::seed, (juce::int64) cmd.argInt ("seed"), nullptr);
            if (cmd.hasArg ("mode"))
                rl.setMode (cmd.argString ("mode"));
            applyColorArgs (rl, cmd, nullptr);   // colors/lab at creation (Color Rack)
            rl.getState().setProperty (ids::inputRef, ids::clipRef (clip->itemID.toString()), nullptr);

            clip->state.appendChild (rl.getState(), um);   // travels with the clip; undoable

            const auto ref = ids::layerRef (id);
            ctx.emit (events::layerStatus (ref, "idle"));
            ctx.emit (events::snapshotInvalidated());   // structural: surface the new layer
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Created render layer", changed, juce::var (data));
        });

        // set_render_param {layer, prompt?|seed?|mode?|colors?|lab?} → edit the layer's
        // params (the Color Rack drives this). A change to any fingerprint input marks
        // the cache dirty so the next render_layer re-renders. Undoable.
        exec.registerCommand ("set_render_param", [&engine, adapterName] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findLayer (engine.getEdit(), cmd.argString ("layer"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchLayer, "No such render layer");

            RenderLayer layer (found.tree);
            auto* um = &ctx.undoManager();
            if (cmd.hasArg ("prompt")) layer.getState().getOrCreateChildWithName (ids::params, um)
                                            .setProperty (ids::prompt, cmd.argString ("prompt"), um);
            if (cmd.hasArg ("seed"))   layer.getState().setProperty (ids::seed, (juce::int64) cmd.argInt ("seed"), um);
            if (cmd.hasArg ("mode"))   layer.setMode (cmd.argString ("mode"), um);
            applyColorArgs (layer, cmd, um);

            const auto ref = ids::layerRef (layer.getId());
            const auto fp = fingerprintFor (found.clip, found.tree, adapterName);
            if (layer.markDirtyIfChanged (fp, um))
                ctx.emit (events::layerStatus (ref, "idle"));   // params changed → needs re-render
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Set render param", juce::StringArray { ref });
        });

        // render_layer {layer} → render through the job service (TIER WALL). NON-
        // transactional: the artifact is a re-derivable cache result, and in the app
        // it lands ASYNCHRONOUSLY (seconds-to-minutes for the real model) so it must
        // not sit inside an undo transaction. With a pool → async (returns "rendering"
        // immediately, progress/ready arrive as events); without one (tests/CI) →
        // synchronous via renderLayerViaService.
        exec.registerCommand ("render_layer", [&engine, &jobs, &cache, pool, adapterName] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findLayer (engine.getEdit(), cmd.argString ("layer"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchLayer, "No such render layer");

            RenderLayer layer (found.tree);
            const auto ref = ids::layerRef (layer.getId());
            const auto pos = found.clip->getPosition();

            RenderRequest req;
            req.mode = layer.getMode();
            req.fingerprint = fingerprintFor (found.clip, found.tree, adapterName);
            req.prompt = req.fingerprint.prompt;
            req.colors = req.fingerprint.colors;
            req.colorValues = req.fingerprint.colorValues;
            req.lab = req.fingerprint.lab;
            req.seed = req.fingerprint.seed;
            req.durationSec = juce::jmax (1.0, pos.getLength().inSeconds());
            if (req.mode == "reimagine")
            {
                if (const auto src = sourceFileFor (found.clip); src.existsAsFile())
                {
                    req.inputWavPath = src.getFullPathName();
                    req.inputStartSec = pos.getOffset().inSeconds();
                    req.inputLengthSec = pos.getLength().inSeconds();
                }
            }

            layer.setFingerprint (req.fingerprint);   // durable cache identity (no undo)
            const auto cacheKey = req.cacheKey();
            const auto outDir = engine.getEditFile().getParentDirectory().getChildFile ("renders");

            // CACHE HIT — complete now. Materialize the cached bytes to a file if this
            // layer has no artifact yet, so accept_render can land it.
            if (cache.has (cacheKey))
            {
                if (! layer.getCacheArtifact().startsWith ("file:"))
                {
                    outDir.createDirectory();
                    auto f = outDir.getChildFile (cacheKey + ".wav");
                    if (const auto* bytes = cache.get (cacheKey))
                        f.replaceWithData (bytes->getData(), bytes->getSize());
                    layer.setCacheArtifact ("file:" + f.getFullPathName());
                }
                layer.setStatus (RenderStatus::ready);
                ctx.emit (events::layerRendered (ref, "render:" + cacheKey));
                ctx.emit (events::layerStatus (ref, "ready"));
                auto* data = new juce::DynamicObject();
                data->setProperty ("fromCache", true);
                data->setProperty ("cacheKey", cacheKey);
                return MoshResult::success ("Render (cache hit)", juce::StringArray { ref }, juce::var (data));
            }

            layer.setStatus (RenderStatus::rendering);
            ctx.emit (events::layerStatus (ref, "rendering"));

            if (pool != nullptr)
            {
                // ASYNC (app) — enqueue and return; the worker emits progress + ready.
                pool->enqueue ({ ref, req, outDir, cacheKey });
                auto* data = new juce::DynamicObject();
                data->setProperty ("status", "rendering");
                data->setProperty ("cacheKey", cacheKey);
                return MoshResult::success ("Rendering", juce::StringArray { ref }, juce::var (data));
            }

            // SYNC (tests/CI) — block on the service (the FakeAdapter is fast).
            if (! jobs.ensureServiceRunning())
            {
                layer.setStatus (RenderStatus::error);
                ctx.emit (events::layerStatus (ref, "error"));
                return MoshResult::failure (error::modelBusy, "generative service unavailable");
            }
            auto out = renderLayerViaService (layer, req, jobs, cache, outDir,
                [&] (double pct) { ctx.emit (events::layerRenderProgress (ref, pct * 100.0, 0.0)); });
            if (! out.ok)
            {
                ctx.emit (events::layerStatus (ref, "error"));
                return MoshResult::failure (error::internalError, out.error);
            }
            ctx.emit (events::layerRendered (ref, "render:" + out.cacheKey));
            ctx.emit (events::layerStatus (ref, "ready"));
            auto* data = new juce::DynamicObject();
            data->setProperty ("fromCache", out.fromCache);
            data->setProperty ("cacheKey", out.cacheKey);
            return MoshResult::success (out.fromCache ? "Render (cache hit)" : "Rendered", juce::StringArray { ref }, juce::var (data));
        }, /*transactional*/ false);

        // cancel_render {layer} → flag the pool to abort + DELETE the service job.
        exec.registerCommand ("cancel_render", [&engine, pool] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            const auto layerArg = cmd.argString ("layer");
            auto found = findLayer (engine.getEdit(), layerArg);
            const auto ref = found.valid() ? ids::layerRef (found.tree[ids::id].toString()) : layerArg;
            if (pool != nullptr) pool->cancel (ref);
            if (found.valid()) RenderLayer (found.tree).setStatus (RenderStatus::dirty);
            ctx.emit (events::layerStatus (ref, "idle"));
            return MoshResult::success ("Canceled render", juce::StringArray { ref });
        }, /*transactional*/ false);

        // accept_render {layer} → land NON-DESTRUCTIVELY as a new clip on the Neural lane
        exec.registerCommand ("accept_render", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto& edit = engine.getEdit();
            auto found = findLayer (edit, cmd.argString ("layer"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchLayer, "No such render layer");

            RenderLayer layer (found.tree);
            auto* um = &ctx.undoManager();

            const auto artifact = layer.getCacheArtifact();
            if (! artifact.startsWith ("file:"))
                return MoshResult::failure (error::invalidArgs, "render layer has no rendered artifact");
            juce::File wav { artifact.fromFirstOccurrenceOf ("file:", false, false) };
            if (! wav.existsAsFile())
                return MoshResult::failure (error::invalidArgs, "rendered file missing");

            auto* neural = findOrCreateNeuralTrack (edit);
            if (neural == nullptr)
                return MoshResult::failure (error::internalError, "could not create Neural track");

            te::AudioFile af (edit.engine, wav);
            const double len = af.getLength();
            const auto srcPos = found.clip->getPosition();
            const te::ClipPosition pos { { srcPos.getStart(), te::TimeDuration::fromSeconds (len) }, {} };
            auto clip = neural->insertWaveClip (wav.getFileNameWithoutExtension(), wav, pos, false);
            if (clip == nullptr)
                return MoshResult::failure (error::internalError, "insertWaveClip failed");

            layer.setUserKept (true, um);   // the source clip is untouched (non-destructive)

            const auto clipRef = ids::clipRef (clip->itemID.toString());
            ctx.emit (events::clipAdded (ids::trackRef (neural->itemID.toString()), clipToVar (clip.get())));
            ctx.emit (events::layerStatus (ids::layerRef (layer.getId()), "ready"));
            ctx.emit (events::snapshotInvalidated());   // the Neural lane may be brand-new
            juce::StringArray changed; changed.add (clipRef); changed.add (ids::layerRef (layer.getId()));
            auto* data = new juce::DynamicObject(); data->setProperty ("clipId", clipRef);
            return MoshResult::success ("Accepted render (new clip on Neural lane)", changed, juce::var (data));
        });

        // reject_render {layer}
        exec.registerCommand ("reject_render", [&engine] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findLayer (engine.getEdit(), cmd.argString ("layer"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchLayer, "No such render layer");
            RenderLayer (found.tree).setUserKept (false, &ctx.undoManager());
            juce::StringArray changed; changed.add (ids::layerRef (found.tree[ids::id].toString()));
            return MoshResult::success ("Rejected render", changed);
        });
    }
}
