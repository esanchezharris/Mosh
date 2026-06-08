#pragma once
#include <juce_data_structures/juce_data_structures.h>

// ──────────────────────────────────────────────────────────────────────────────
// Stable identifiers used across the spine: ValueTree type/property names for the
// Mosh-specific RenderLayer schema (01 §4.2), and the entity-ref helpers that key
// the snapshot / events / results / JSONL log (02 §6 — "key off ids, never index").
//
// Tracktion owns TRACK/CLIP/PLUGIN trees; the spine stays Tracktion-free and only
// defines Mosh's own schema + the cross-cutting ref helpers.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh::ids
{
#define MOSH_DECLARE_ID(name) inline const juce::Identifier name { #name };

    // RenderLayer (MOSH_RENDERLAYER) tree + fields — 01 §4.2.
    MOSH_DECLARE_ID (MOSH_RENDERLAYER)
    MOSH_DECLARE_ID (id)
    MOSH_DECLARE_ID (inputRef)
    MOSH_DECLARE_ID (timeRangeStart)
    MOSH_DECLARE_ID (timeRangeEnd)
    MOSH_DECLARE_ID (modelAdapter)
    MOSH_DECLARE_ID (modelVersion)
    MOSH_DECLARE_ID (adapterVersion)
    MOSH_DECLARE_ID (mode)                 // "generate" | "reimagine"
    MOSH_DECLARE_ID (params)               // PARAMS child tree
    MOSH_DECLARE_ID (prompt)
    MOSH_DECLARE_ID (colors)               // COLORS child tree (≤3, ordered — 01 §4.4)
    MOSH_DECLARE_ID (color)                // a single COLOR child
    MOSH_DECLARE_ID (name)
    MOSH_DECLARE_ID (amount)
    MOSH_DECLARE_ID (cfg)
    MOSH_DECLARE_ID (steps)
    MOSH_DECLARE_ID (nl)                   // re-imagine re-noise level (≤0.5 — 05)
    MOSH_DECLARE_ID (seed)
    MOSH_DECLARE_ID (safetyMappingVersion)
    MOSH_DECLARE_ID (sourceFingerprint)
    MOSH_DECLARE_ID (cacheKey)
    MOSH_DECLARE_ID (cacheArtifact)
    MOSH_DECLARE_ID (status)               // empty|queued|rendering|ready|error|dirty
    MOSH_DECLARE_ID (createdBy)            // "user" | (future) "monster"
    MOSH_DECLARE_ID (userKept)

#undef MOSH_DECLARE_ID

    // ── Entity-ref helpers (the stable string ids used everywhere) ─────────────
    inline juce::String trackRef  (const juce::String& id) { return "track:" + id; }
    inline juce::String clipRef   (const juce::String& id) { return "clip:"  + id; }
    inline juce::String pluginRef (const juce::String& id) { return "plg:"   + id; }
    inline juce::String layerRef  (const juce::String& id) { return "rl:"    + id; }
    inline juce::String jobRef    (const juce::String& id) { return "job:"   + id; }

    // Split "<type>:<id>" → { type, id }; returns false if malformed.
    inline bool parseRef (const juce::String& ref, juce::String& type, juce::String& id)
    {
        const auto colon = ref.indexOfChar (':');
        if (colon <= 0)
            return false;
        type = ref.substring (0, colon);
        id   = ref.substring (colon + 1);
        return id.isNotEmpty();
    }
}
