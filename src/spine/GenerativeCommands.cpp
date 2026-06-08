#include "GenerativeCommands.h"
#include "Ids.h"

namespace mosh
{
    RenderLayer RenderLayerStore::create()
    {
        const auto id = juce::String (++seq);
        auto layer = RenderLayer::create (id);
        layers.emplace (id, layer);
        return RenderLayer (layers.at (id).getState());
    }

    RenderLayer* RenderLayerStore::find (const juce::String& ref)
    {
        juce::String type, id;
        if (! ids::parseRef (ref, type, id))
            id = ref;
        auto it = layers.find (id);
        return it == layers.end() ? nullptr : &it->second;
    }

    // Build the full fingerprint from a layer's params + the source context the
    // caller supplies (in the engine this comes from the source clip; here via args).
    static FingerprintInputs fingerprintFor (RenderLayer& layer, const MoshCommand& cmd,
                                             const juce::String& adapterName)
    {
        FingerprintInputs fp;
        auto params = layer.getState().getChildWithName (ids::params);
        fp.prompt = params[ids::prompt].toString();
        fp.colors = layer.getColors();
        fp.seed = (juce::int64) layer.getState()[ids::seed];
        fp.modelAdapter = adapterName;
        fp.modelVersion = cmd.argString ("modelVersion", "0");
        fp.adapterVersion = cmd.argString ("adapterVersion", "0");
        fp.serviceBuild = cmd.argString ("serviceBuild", "dev");
        fp.safetyMappingVersion = cmd.argString ("safetyMappingVersion", "astd-1");
        // Source context (defaults keep tests simple; the engine fills these from the clip).
        fp.upstreamHash = cmd.argString ("sourceHash", "src");
        fp.sampleRate = cmd.argDouble ("sampleRate", 44100.0);
        fp.numChannels = cmd.argInt ("numChannels", 2);
        fp.tempoBpm = cmd.argDouble ("tempoBpm", 120.0);
        fp.clipRangeStart = cmd.argDouble ("clipStart", 0.0);
        fp.clipRangeEnd = cmd.argDouble ("clipEnd", 4.0);
        fp.cfg = cmd.argDouble ("cfg", 7.0);
        fp.steps = cmd.argInt ("steps", 30);
        fp.nl = cmd.argDouble ("nl", 0.0);
        return fp;
    }

    void registerGenerativeCommands (DslExecutor& exec, RenderLayerStore& store,
                                     GenerativeModelAdapter& adapter, RenderCache& cache)
    {
        // create_render_layer {mode?, prompt?, colors?, seed?}
        exec.registerCommand ("create_render_layer", [&store] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto layer = store.create();
            auto* um = &ctx.undoManager();
            if (cmd.hasArg ("mode"))   layer.setMode (cmd.argString ("mode"), um);
            if (cmd.hasArg ("prompt")) layer.getState().getOrCreateChildWithName (ids::params, um)
                                            .setProperty (ids::prompt, cmd.argString ("prompt"), um);
            if (cmd.hasArg ("seed"))   layer.getState().setProperty (ids::seed, (juce::int64) cmd.argInt ("seed"), um);
            if (cmd.hasArg ("colors"))
            {
                juce::StringArray cols;
                const auto colorsVar = cmd.arg ("colors");
                if (auto* arr = colorsVar.getArray())
                    for (auto& c : *arr) cols.add (c.toString());
                layer.setColors (cols, um);
            }
            const auto ref = ids::layerRef (layer.getId());
            ctx.emit (events::layerStatus (ref, "idle"));
            auto* data = new juce::DynamicObject(); data->setProperty ("id", ref);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Created render layer", changed, juce::var (data));
        });

        // set_render_param {layer, prompt?|seed?|colors?|mode?}
        exec.registerCommand ("set_render_param", [&store, &adapter] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* layer = store.find (cmd.argString ("layer"));
            if (layer == nullptr)
                return MoshResult::failure (error::noSuchLayer, "No such render layer");
            auto* um = &ctx.undoManager();
            if (cmd.hasArg ("prompt")) layer->getState().getOrCreateChildWithName (ids::params, um)
                                             .setProperty (ids::prompt, cmd.argString ("prompt"), um);
            if (cmd.hasArg ("seed"))   layer->getState().setProperty (ids::seed, (juce::int64) cmd.argInt ("seed"), um);
            if (cmd.hasArg ("mode"))   layer->setMode (cmd.argString ("mode"), um);
            if (cmd.hasArg ("colors"))
            {
                juce::StringArray cols;
                const auto colorsVar = cmd.arg ("colors");
                if (auto* arr = colorsVar.getArray())
                    for (auto& c : *arr) cols.add (c.toString());
                layer->setColors (cols, um);
            }
            // A param change may invalidate the cache → mark dirty if so.
            const auto fp = fingerprintFor (*layer, cmd, adapter.name());
            const bool dirtied = layer->markDirtyIfChanged (fp, um);
            const auto ref = ids::layerRef (layer->getId());
            if (dirtied)
                ctx.emit (events::layerStatus (ref, "idle"));
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Set render param", changed);
        });

        // render_layer {layer, ...source context} → renders via the adapter (cache-aware)
        exec.registerCommand ("render_layer", [&store, &adapter, &cache] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* layer = store.find (cmd.argString ("layer"));
            if (layer == nullptr)
                return MoshResult::failure (error::noSuchLayer, "No such render layer");

            const auto ref = ids::layerRef (layer->getId());
            RenderRequest req;
            req.mode = layer->getMode();
            req.fingerprint = fingerprintFor (*layer, cmd, adapter.name());
            req.prompt = req.fingerprint.prompt;
            req.colors = req.fingerprint.colors;
            req.seed = req.fingerprint.seed;

            ctx.emit (events::layerStatus (ref, "rendering"));
            auto out = renderLayer (*layer, req, adapter, cache,
                                    [&] (double pct) { ctx.emit (events::layerRenderProgress (ref, pct * 100.0, 0.0)); });

            if (! out.ok)
            {
                ctx.emit (events::layerStatus (ref, "error"));
                return MoshResult::failure (error::internalError, out.error);
            }

            // takeId is the cache key here; the engine maps it to a real Tracktion take.
            ctx.emit (events::layerRendered (ref, "take:" + out.cacheKey));
            ctx.emit (events::layerStatus (ref, "ready"));
            auto* data = new juce::DynamicObject();
            data->setProperty ("fromCache", out.fromCache);
            data->setProperty ("cacheKey", out.cacheKey);
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success (out.fromCache ? "Render (cache hit)" : "Rendered", changed, juce::var (data));
        });

        // accept_render {layer} — keep the render (a JSONL TASTE LABEL, logged for free)
        exec.registerCommand ("accept_render", [&store] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* layer = store.find (cmd.argString ("layer"));
            if (layer == nullptr)
                return MoshResult::failure (error::noSuchLayer, "No such render layer");
            acceptRender (*layer, &ctx.undoManager());
            const auto ref = ids::layerRef (layer->getId());
            ctx.emit (events::layerStatus (ref, "ready"));
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Accepted render", changed);
        });

        // reject_render {layer} — discard the kept flag (also a TASTE LABEL)
        exec.registerCommand ("reject_render", [&store] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* layer = store.find (cmd.argString ("layer"));
            if (layer == nullptr)
                return MoshResult::failure (error::noSuchLayer, "No such render layer");
            rejectRender (*layer, &ctx.undoManager());
            const auto ref = ids::layerRef (layer->getId());
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Rejected render", changed);
        });

        // cancel_render {layer} — in-process Fake completes synchronously; surface for
        // the command catalog (the service path has real cancellation).
        exec.registerCommand ("cancel_render", [&store] (const MoshCommand& cmd, DslExecutor::Context& ctx) -> MoshResult
        {
            auto* layer = store.find (cmd.argString ("layer"));
            if (layer == nullptr)
                return MoshResult::failure (error::noSuchLayer, "No such render layer");
            const auto ref = ids::layerRef (layer->getId());
            ctx.emit (events::layerStatus (ref, "idle"));
            juce::StringArray changed; changed.add (ref);
            return MoshResult::success ("Cancelled render", changed);
        });
    }
}
