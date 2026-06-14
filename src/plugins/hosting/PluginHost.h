#pragma once

#include <tracktion_engine/tracktion_engine.h>
#include <atomic>

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

    /** Initialise formats + load/scan plugins into the KnownPluginList. The
        catalog is PERSISTED (plugin-catalog.xml beside the session dir) and
        restored on startup; the curated VST3 scan runs only on a cold catalog.
        Scanning is in-process and curated to avoid the cost/crash risk of a
        full blind scan; bundles without VST3 moduleinfo use the slow scan only
        when MOSH_SCAN_SLOW_VST3=1 is set.
        AU cataloging is an opt-in (MOSH_SCAN_AU=1) experimental feature.
        WARNING: a misbehaving AudioUnit can hang the UI during scan -- JUCE
        marshals component instantiation to the message thread and there is NO
        per-component timeout; a HANG requires a forced app restart.  Only
        CRASHes are recovered on the next launch via the dead-mans-pedal/blocklist.
        VST3 (the primary format) is always scanned and safe.
        NOTE: only one Mosh process should scan AUs at a time -- the dead-mans-pedal
        file is shared under ~/Library/Application Support/Mosh/ and is not
        multi-process-safe.  INS-002 / INS-005. */
    void initialise();

    /** Re-enumerate the catalog (INS-005). VST3 (curated, fast) and/or AudioUnit
        (env/opt-in, slow + risky) are cataloged into the KnownPluginList and the
        result persisted.
        IMPORTANT: when includeAU is true, this function MUST be called from a
        background thread.  JUCE marshals AU component instantiation to the message
        thread and there is no per-component timeout, so a hanging AU stalls the UI.
        Only crashes are recovered on the next launch (dead-mans-pedal/blocklist);
        a hang requires a forced restart.  MoshOps.cmdRescanPlugins() always routes
        AU-including scans to a background std::thread for this reason.
        VST3-only rescans (includeAU=false) are fast + safe on any thread.
        @param clearFirst  drop the existing types before scanning.
        @param includeVST3  re-enumerate the VST3 plug-in folders.
        @param includeAU    also enumerate+catalog .component AudioUnits.
        @param slowVST3    load modules for VST3 bundles without moduleinfo.json
                           (catches plug-ins the fast path can't see); the dead-
                           mans-pedal makes a crasher recoverable. Must NOT run on
                           the message thread — MoshOps drives it on a background
                           thread, like the AU path. */
    int rescan (bool clearFirst, bool includeVST3, bool includeAU, bool slowVST3 = false);

    /** Available plugin descriptions (from the KnownPluginList). */
    juce::Array<juce::PluginDescription> available() const;

    /** The plugin blocklist (INS-005) — file identifiers a crashing scan quarantined
        (via the dead-mans-pedal) or the user blocked manually. These never appear in
        available()/list_plugins. */
    juce::StringArray blocklist() const;
    void blockPlugin   (const juce::String& pluginId);   // manual quarantine
    void clearBlocklist();                                // un-quarantine all

    /** Find a description by Tracktion identifier string; scans the file lazily
        if the id looks like a path we haven't seen. Slow VST3 scanning is
        opt-in via MOSH_SCAN_SLOW_VST3=1. Returns false if unknown. */
    bool findDescription (const juce::String& pluginId, juce::PluginDescription& out);

    /** Open (or focus) the native editor window for a hosted plugin (03 §4). */
    void openEditor (te::Plugin&);
    void closeEditor (te::Plugin&);

    static juce::String idFor (const juce::PluginDescription&);

private:
    void scanFile (const juce::File&);                   // VST3 (path-based)
    void scanInstalledVST3();                            // enumerate the VST3 plug-in folders
    void scanAUComponents();                             // AudioUnit (.component) catalog (slow/risky)
    void loadCatalog();                                  // recreateFromXml if present
    void saveCatalog();                                  // createXml → plugin-catalog.xml
    void recoverFromDeadMansPedal();                     // blocklist a prior crasher, then clear
    juce::File catalogFile()   const;
    juce::File deadMansPedal() const;
    void closeEditorByKey (const juce::String& key);

    te::Engine& engine;
    juce::OwnedArray<juce::DocumentWindow> editorWindows;
    juce::HashMap<juce::String, juce::DocumentWindow*> windowByPlugin;
    bool initialised = false;
    bool vst3SlowScan = false;   // set during a rescan(slowVST3=true): scanFile loads modules
    // Bumped per plugin (scanFile + the AU sweep): a progress heartbeat the deep-scan
    // watchdog polls. A hung out-of-process child stops this advancing, so the watchdog
    // kills the child (te treats it as a crash -> blocklist -> continue).
    std::atomic<int> scanFilesProcessed { 0 };
    // Single-flight latch: only one rescan() runs at a time (a second concurrent scan
    // would race the OOP flag, the watchdog, and the dead-mans-pedal).
    std::atomic<bool> scanInProgress { false };

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (PluginHost)
};

} // namespace mosh
