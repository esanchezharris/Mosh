#pragma once
#include <juce_core/juce_core.h>

// ──────────────────────────────────────────────────────────────────────────────
// The result envelope every command returns (02 §2). Serialized to the WebView as
// a JSON object of exactly this shape:
//   { ok, message, changed_entities, error_code, data }
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    // Stable, machine-readable error codes (02 §2). Keep these stable: tests, the
    // UI, and the JSONL log all key off them.
    namespace error
    {
        inline constexpr const char* unknownCommand = "UNKNOWN_COMMAND";
        inline constexpr const char* invalidArgs    = "INVALID_ARGS";
        inline constexpr const char* noSuchTrack     = "NO_SUCH_TRACK";
        inline constexpr const char* noSuchClip      = "NO_SUCH_CLIP";
        inline constexpr const char* noSuchPlugin    = "NO_SUCH_PLUGIN";
        inline constexpr const char* noSuchLayer     = "NO_SUCH_LAYER";
        inline constexpr const char* invalidRange    = "INVALID_RANGE";
        inline constexpr const char* modelBusy       = "MODEL_BUSY";
        inline constexpr const char* internalError   = "INTERNAL_ERROR";
        inline constexpr const char* notImplemented  = "NOT_IMPLEMENTED";
    }

    struct MoshResult
    {
        bool             ok = true;
        juce::String     message;
        juce::StringArray changedEntities;   // stable "<type>:<id>" refs (02 §2)
        juce::String     errorCode;          // empty when ok; a stable code otherwise
        juce::var        data;               // command-specific payload (object)

        // ── Builders ──────────────────────────────────────────────────────────
        static MoshResult success (juce::String msg = {},
                                   juce::StringArray changed = {},
                                   juce::var payload = juce::var())
        {
            MoshResult r;
            r.ok = true;
            r.message = std::move (msg);
            r.changedEntities = std::move (changed);
            r.data = std::move (payload);
            return r;
        }

        static MoshResult failure (juce::String code, juce::String msg = {})
        {
            MoshResult r;
            r.ok = false;
            r.errorCode = std::move (code);
            r.message = std::move (msg);
            return r;
        }

        // ── Serialization (the exact JSON envelope crossing the bridge) ───────
        juce::var toVar() const
        {
            auto* obj = new juce::DynamicObject();
            obj->setProperty ("ok", ok);
            obj->setProperty ("message", message);

            juce::Array<juce::var> changed;
            for (const auto& e : changedEntities)
                changed.add (e);
            obj->setProperty ("changed_entities", changed);

            obj->setProperty ("error_code", errorCode.isEmpty() ? juce::var() : juce::var (errorCode));
            obj->setProperty ("data", data.isVoid() ? juce::var (new juce::DynamicObject()) : data);
            return juce::var (obj);
        }

        juce::String toJson() const { return juce::JSON::toString (toVar()); }
    };
}
