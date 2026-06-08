#pragma once
#include <juce_data_structures/juce_data_structures.h>
#include "Ids.h"
#include "Fingerprint.h"

// ──────────────────────────────────────────────────────────────────────────────
// RenderLayer — the Tier-B transform record (01 §4.2). Stored as a MOSH_RENDERLAYER
// sub-tree parented under a clip (default) so it travels with the source. The
// PARAMS are the durable, reversible artifact; the rendered audio is a CACHE keyed
// by the full fingerprint (Fingerprint.h). Lives inside the Edit tree → inherits
// undo / serialization / observation for free.
//
// This is a pure ValueTree wrapper — no Tracktion. In the app the tree is parented
// under the Edit and writes bind edit.getUndoManager() (a juce::UndoManager); in
// tests it stands alone.
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    enum class RenderStatus { empty, queued, rendering, ready, error, dirty };

    inline juce::String toString (RenderStatus s)
    {
        switch (s)
        {
            case RenderStatus::empty:     return "empty";
            case RenderStatus::queued:    return "queued";
            case RenderStatus::rendering: return "rendering";
            case RenderStatus::ready:     return "ready";
            case RenderStatus::error:     return "error";
            case RenderStatus::dirty:     return "dirty";
        }
        return "empty";
    }

    inline RenderStatus renderStatusFromString (const juce::String& s)
    {
        if (s == "queued")    return RenderStatus::queued;
        if (s == "rendering") return RenderStatus::rendering;
        if (s == "ready")     return RenderStatus::ready;
        if (s == "error")     return RenderStatus::error;
        if (s == "dirty")     return RenderStatus::dirty;
        return RenderStatus::empty;
    }

    // Max simultaneous SA3 colors — a measured product limit, ordered, earlier
    // dominates later (01 §4.4, SA3 research §6). Enforced here.
    inline constexpr int maxColors = 3;

    class RenderLayer
    {
    public:
        explicit RenderLayer (juce::ValueTree stateToUse) : state (std::move (stateToUse)) {}

        // Create a fresh MOSH_RENDERLAYER tree with sensible defaults.
        static RenderLayer create (const juce::String& id, juce::UndoManager* um = nullptr)
        {
            juce::ValueTree t (ids::MOSH_RENDERLAYER);
            t.setProperty (ids::id, id, um);
            t.setProperty (ids::mode, "generate", um);
            t.setProperty (ids::status, toString (RenderStatus::empty), um);
            t.setProperty (ids::createdBy, "user", um);
            t.setProperty (ids::userKept, false, um);
            t.setProperty (ids::seed, (juce::int64) 0, um);
            return RenderLayer (t);
        }

        juce::ValueTree& getState()             { return state; }
        const juce::ValueTree& getState() const { return state; }
        bool isValid() const { return state.hasType (ids::MOSH_RENDERLAYER); }

        juce::String getId() const { return state[ids::id].toString(); }

        RenderStatus getStatus() const { return renderStatusFromString (state[ids::status].toString()); }
        void setStatus (RenderStatus s, juce::UndoManager* um = nullptr)
        {
            state.setProperty (ids::status, toString (s), um);
        }

        juce::String getMode() const { return state[ids::mode].toString(); }
        void setMode (const juce::String& m, juce::UndoManager* um = nullptr) { state.setProperty (ids::mode, m, um); }

        bool getUserKept() const { return (bool) state[ids::userKept]; }
        void setUserKept (bool kept, juce::UndoManager* um = nullptr) { state.setProperty (ids::userKept, kept, um); }

        juce::String getCacheKey() const     { return state[ids::cacheKey].toString(); }
        juce::String getCacheArtifact() const { return state[ids::cacheArtifact].toString(); }
        void setCacheArtifact (const juce::String& ref, juce::UndoManager* um = nullptr)
        {
            state.setProperty (ids::cacheArtifact, ref, um);
        }

        // ── Fingerprint / dirty logic ─────────────────────────────────────────
        // Store the full fingerprint + its cache key (the durable cache identity).
        void setFingerprint (const FingerprintInputs& fp, juce::UndoManager* um = nullptr)
        {
            state.setProperty (ids::sourceFingerprint, fp.build().canonical(), um);
            state.setProperty (ids::cacheKey, fp.cacheKey(), um);
        }

        // True when the CURRENT inputs differ from what produced the cache (any
        // fingerprint input changed) — i.e. the cache may not be reused.
        bool isDirtyAgainst (const FingerprintInputs& current) const
        {
            const auto stored = getCacheKey();
            return stored.isEmpty() || stored != current.cacheKey();
        }

        // Convenience: flip status→dirty when the inputs changed; no-op otherwise.
        // Returns true if it marked dirty.
        bool markDirtyIfChanged (const FingerprintInputs& current, juce::UndoManager* um = nullptr)
        {
            if (isDirtyAgainst (current))
            {
                setStatus (RenderStatus::dirty, um);
                return true;
            }
            return false;
        }

        // ── Colors (≤3, ordered) — 01 §4.4 ───────────────────────────────────
        // Returns the colors actually stored (capped at maxColors, order preserved).
        juce::StringArray setColors (const juce::StringArray& requested, juce::UndoManager* um = nullptr)
        {
            auto params = state.getOrCreateChildWithName (ids::params, um);
            auto colorsTree = params.getOrCreateChildWithName (ids::colors, um);
            colorsTree.removeAllChildren (um);

            juce::StringArray accepted;
            for (const auto& c : requested)
            {
                if (accepted.size() >= maxColors)
                    break;
                if (c.isEmpty())
                    continue;
                juce::ValueTree col (ids::color);
                col.setProperty (ids::name, c, um);
                colorsTree.appendChild (col, um);
                accepted.add (c);
            }
            return accepted;
        }

        juce::StringArray getColors() const
        {
            juce::StringArray out;
            auto params = state.getChildWithName (ids::params);
            auto colorsTree = params.getChildWithName (ids::colors);
            for (auto c : colorsTree)
                out.add (c[ids::name].toString());
            return out;
        }

    private:
        juce::ValueTree state;
    };
}
