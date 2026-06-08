#pragma once
#include "DslExecutor.h"
#include "Generative.h"
#include <map>

// ──────────────────────────────────────────────────────────────────────────────
// GenerativeCommands — the Tier-B render flow driven through the MoshOps command
// surface (05 / the Stage-5 Fake gate's "full loop via commands"). Model-neutral:
// renders via an injected GenerativeModelAdapter (FakeAdapter for bring-up) + a
// RenderCache, emits layer_status / layer_render_progress / layer_rendered events,
// and — because every command is logged — accept_render / reject_render are
// captured as JSONL TASTE LABELS for free (02 §5).
//
// Spine-level (no Tracktion): the RenderLayers live in a flat store here. In the
// engine they live under the source clip's tree and accept_render also lands the
// render as a Tracktion take (docs/TRACKTION_API_NOTES.md §9) — the only
// engine-specific addition.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    class RenderLayerStore
    {
    public:
        RenderLayer create();                         // new layer, id "rl:N"
        RenderLayer* find (const juce::String& ref);  // by "rl:<id>" or bare id
        int size() const { return (int) layers.size(); }

    private:
        std::map<juce::String, RenderLayer> layers;
        int seq = 0;
    };

    // Registers create_render_layer / set_render_param / render_layer /
    // accept_render / reject_render / cancel_render into the executor.
    void registerGenerativeCommands (DslExecutor&, RenderLayerStore&,
                                     GenerativeModelAdapter&, RenderCache&);
}
