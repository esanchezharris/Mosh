#pragma once
#include <juce_core/juce_core.h>
#include <map>

// ──────────────────────────────────────────────────────────────────────────────
// Typed events (02 §4.2). Serialized to the WebView as a flat object
//   { "type": "<name>", ...fields }
// matching the frontend's discriminated union (ui/src/bridge.ts). Pushed on the
// "mosh_event" channel. transport_position / meter_update are DECIMATED 30–60 Hz
// (Decimator below); nothing audio-rate crosses the bridge.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    struct MoshEvent
    {
        juce::String type;
        juce::var    fields;   // object of the non-"type" fields (may be void)

        MoshEvent() = default;
        MoshEvent (juce::String t, juce::var f = juce::var()) : type (std::move (t)), fields (std::move (f)) {}

        // Flat serialization: { type, ...fields }.
        juce::var toVar() const
        {
            auto* o = new juce::DynamicObject();
            if (auto* src = fields.getDynamicObject())
                for (auto& prop : src->getProperties())
                    o->setProperty (prop.name, prop.value);
            o->setProperty ("type", type);
            return juce::var (o);
        }

        juce::String toJson() const { return juce::JSON::toString (toVar()); }
    };

    // Convenience builders — one per event in the frontend union, names/fields
    // matched exactly to ui/src/bridge.ts.
    namespace events
    {
        inline juce::var obj (std::initializer_list<std::pair<const char*, juce::var>> kv)
        {
            auto* o = new juce::DynamicObject();
            for (auto& p : kv)
                o->setProperty (juce::Identifier (p.first), p.second);
            return juce::var (o);
        }

        inline MoshEvent trackAdded   (juce::var track)                       { return { "track_added",   obj ({ { "track", track } }) }; }
        inline MoshEvent trackRemoved (const juce::String& id)                { return { "track_removed", obj ({ { "id", id } }) }; }
        inline MoshEvent trackChanged (const juce::String& id, juce::var f)   { return { "track_changed", obj ({ { "id", id }, { "fields", f } }) }; }
        inline MoshEvent clipAdded    (const juce::String& trackId, juce::var clip) { return { "clip_added", obj ({ { "trackId", trackId }, { "clip", clip } }) }; }
        inline MoshEvent clipMoved    (const juce::String& id, double start, double end)
        {
            juce::Array<juce::var> range { start, end };
            return { "clip_moved", obj ({ { "id", id }, { "range", range } }) };
        }
        inline MoshEvent clipSplit    (const juce::String& trackId, juce::var clips) { return { "clip_split", obj ({ { "trackId", trackId }, { "clips", clips } }) }; }
        inline MoshEvent clipRemoved  (const juce::String& id)                { return { "clip_removed", obj ({ { "id", id } }) }; }
        inline MoshEvent pluginAdded  (const juce::String& trackId, juce::var plugin) { return { "plugin_added", obj ({ { "trackId", trackId }, { "plugin", plugin } }) }; }
        inline MoshEvent pluginParamChanged (const juce::String& pluginId, const juce::String& param, double value)
        {
            return { "plugin_param_changed", obj ({ { "pluginId", pluginId }, { "param", param }, { "value", value } }) };
        }
        inline MoshEvent pluginBypassed (const juce::String& pluginId, bool bypassed) { return { "plugin_bypassed", obj ({ { "pluginId", pluginId }, { "bypassed", bypassed } }) }; }
        inline MoshEvent layerStatus  (const juce::String& id, const juce::String& status) { return { "layer_status", obj ({ { "id", id }, { "status", status } }) }; }
        inline MoshEvent layerRenderProgress (const juce::String& id, double pct, double etaSec)
        {
            return { "layer_render_progress", obj ({ { "id", id }, { "pct", pct }, { "etaSec", etaSec } }) };
        }
        inline MoshEvent layerRendered (const juce::String& id, const juce::String& takeId) { return { "layer_rendered", obj ({ { "id", id }, { "takeId", takeId } }) }; }
        inline MoshEvent transportPosition (double pos)                       { return { "transport_position", obj ({ { "pos", pos } }) }; }
        inline MoshEvent meterUpdate  (const juce::String& trackId, double rms, double peak)
        {
            return { "meter_update", obj ({ { "trackId", trackId }, { "rms", rms }, { "peak", peak } }) };
        }
        inline MoshEvent snapshotInvalidated()                               { return { "snapshot_invalidated", juce::var() }; }
    }

    // Listener interface (the C++ side of the bridge subscribes one of these and
    // forwards toVar() across the WebView "mosh_event" channel — module 03).
    struct MoshEventListener
    {
        virtual ~MoshEventListener() = default;
        virtual void onMoshEvent (const MoshEvent&) = 0;
    };

    // ── Decimator — enforce 30–60 Hz on high-rate telemetry (02 §4.2) ─────────
    // Keyed by an arbitrary string (e.g. "transport" or "meter:<trackId>") so each
    // stream is throttled independently. "now" is injected (millis) for testability.
    class Decimator
    {
    public:
        explicit Decimator (double hz = 45.0) : minIntervalMs (1000.0 / juce::jmax (1.0, hz)) {}

        // True if an update on `key` should be forwarded at `nowMs` (and records it).
        bool shouldEmit (const juce::String& key, double nowMs)
        {
            auto it = lastMs.find (key);
            if (it == lastMs.end() || (nowMs - it->second) >= minIntervalMs)
            {
                lastMs[key] = nowMs;
                return true;
            }
            return false;
        }

        void setRateHz (double hz) { minIntervalMs = 1000.0 / juce::jmax (1.0, hz); }
        void reset() { lastMs.clear(); }

    private:
        double minIntervalMs;
        std::map<juce::String, double> lastMs;
    };
}
