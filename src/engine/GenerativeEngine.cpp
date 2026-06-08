#include "GenerativeEngine.h"
#include "EngineSnapshot.h"   // clipToVar
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

    static FingerprintInputs fingerprintFor (te::Clip* clip, juce::ValueTree layerTree, const juce::String& adapterName)
    {
        FingerprintInputs fp;
        auto params = layerTree.getChildWithName (ids::params);
        fp.prompt = params[ids::prompt].toString();
        fp.colors = RenderLayer (layerTree).getColors();
        fp.seed = (juce::int64) layerTree[ids::seed];
        fp.modelAdapter = adapterName;
        fp.upstreamHash = clip->itemID.toString();
        const auto pos = clip->getPosition();
        fp.clipRangeStart = pos.getStart().inSeconds();
        fp.clipRangeEnd = pos.getEnd().inSeconds();
        fp.sampleRate = 44100.0;
        fp.numChannels = 2;
        return fp;
    }

    void registerGenerativeEngineCommands (DslExecutor& exec, MoshEngine& engine,
                                           GenerativeJobManager& jobs, RenderCache& cache)
    {
        auto layerSeq = std::make_shared<int> (0);

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
            rl.getState().setProperty (ids::inputRef, ids::clipRef (clip->itemID.toString()), nullptr);

            clip->state.appendChild (rl.getState(), um);   // travels with the clip; undoable

            const auto ref = ids::layerRef (id);
            ctx.emit (events::layerStatus (ref, "idle"));
            ctx.emit (events::snapshotInvalidated());   // structural: surface the new layer
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Created render layer", changed, juce::var (data));
        });

        // render_layer {layer} → render through the job service (TIER WALL)
        exec.registerCommand ("render_layer", [&engine, &jobs, &cache] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto found = findLayer (engine.getEdit(), cmd.argString ("layer"));
            if (! found.valid())
                return MoshResult::failure (error::noSuchLayer, "No such render layer");

            RenderLayer layer (found.tree);
            const auto ref = ids::layerRef (layer.getId());

            RenderRequest req;
            req.mode = layer.getMode();
            req.fingerprint = fingerprintFor (found.clip, found.tree, "fake");
            req.prompt = req.fingerprint.prompt;
            req.colors = req.fingerprint.colors;
            req.seed = req.fingerprint.seed;

            if (! jobs.ensureServiceRunning())
                return MoshResult::failure (error::modelBusy, "generative service unavailable");

            const auto outDir = engine.getEditFile().getParentDirectory().getChildFile ("renders");
            ctx.emit (events::layerStatus (ref, "rendering"));
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
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success (out.fromCache ? "Render (cache hit)" : "Rendered", changed, juce::var (data));
        });

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
