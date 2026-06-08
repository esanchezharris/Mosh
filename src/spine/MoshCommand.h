#pragma once
#include <juce_core/juce_core.h>

namespace mosh
{
    // A typed command crossing the spine: a verb name + typed args (JSON/var).
    // The WebView bridge passes args as a JSON string; the executor accepts either
    // a parsed var or a JSON string (see DslExecutor::execute overloads).
    struct MoshCommand
    {
        juce::String name;
        juce::var    args;   // object

        MoshCommand() = default;
        MoshCommand (juce::String n, juce::var a = juce::var()) : name (std::move (n)), args (std::move (a)) {}

        // Build from a JSON args string (what the WebView bridge sends).
        static MoshCommand fromJsonArgs (juce::String name, const juce::String& argsJson)
        {
            return MoshCommand (std::move (name), juce::JSON::parse (argsJson));
        }

        // Typed arg accessors with defaults (validation helpers).
        bool hasArg (const juce::Identifier& key) const
        {
            return args.isObject() && args.hasProperty (key);
        }
        juce::var arg (const juce::Identifier& key, juce::var fallback = juce::var()) const
        {
            return args.isObject() && args.hasProperty (key) ? args[key] : fallback;
        }
        juce::String argString (const juce::Identifier& key, juce::String fallback = {}) const
        {
            return hasArg (key) ? args[key].toString() : fallback;
        }
        double argDouble (const juce::Identifier& key, double fallback = 0.0) const
        {
            return hasArg (key) ? (double) args[key] : fallback;
        }
        int argInt (const juce::Identifier& key, int fallback = 0) const
        {
            return hasArg (key) ? (int) args[key] : fallback;
        }
        bool argBool (const juce::Identifier& key, bool fallback = false) const
        {
            return hasArg (key) ? (bool) args[key] : fallback;
        }
    };
}
