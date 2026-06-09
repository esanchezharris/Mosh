#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{
namespace te = tracktion::engine;

/** VST3 hosting (04 PART 1), driven entirely through MoshOps commands.
    Owns plugin scanning (into the engine's KnownPluginList) and the native
    editor pop-out windows (03 §4). No UI coupling beyond the command surface. */
class PluginHost
{
public:
    explicit PluginHost (te::Engine& e);
    ~PluginHost();

    /** Initialise formats + scan VST3s into the KnownPluginList. Scanning is
        in-process and curated to avoid the cost/crash risk of a full blind
        scan; bundles without VST3 moduleinfo use the slow scan only when
        MOSH_SCAN_SLOW_VST3=1 is set. */
    void initialise();

    /** Available plugin descriptions (from the KnownPluginList). */
    juce::Array<juce::PluginDescription> available() const;

    /** Find a description by Tracktion identifier string; scans the file lazily
        if the id looks like a path we haven't seen. Slow VST3 scanning is
        opt-in via MOSH_SCAN_SLOW_VST3=1. Returns false if unknown. */
    bool findDescription (const juce::String& pluginId, juce::PluginDescription& out);

    /** Open (or focus) the native editor window for a hosted plugin (03 §4). */
    void openEditor (te::Plugin&);
    void closeEditor (te::Plugin&);

    static juce::String idFor (const juce::PluginDescription&);

private:
    void scanFile (const juce::File&);
    void closeEditorByKey (const juce::String& key);

    te::Engine& engine;
    juce::OwnedArray<juce::DocumentWindow> editorWindows;
    juce::HashMap<juce::String, juce::DocumentWindow*> windowByPlugin;
    bool initialised = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginHost)
};

} // namespace mosh
