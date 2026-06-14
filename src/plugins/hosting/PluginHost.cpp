#include "PluginHost.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"

namespace mosh
{
using namespace juce;

namespace
{
    // A native plugin-editor pop-out (03 §4) that notifies on close.
    struct EditorWindow : DocumentWindow
    {
        std::function<void()> onClose;
        EditorWindow (const String& name) : DocumentWindow (name, Colours::black, closeButton)
        {
            setUsingNativeTitleBar (true);
            setResizable (true, false);
        }
        void closeButtonPressed() override { if (onClose) onClose(); }
    };

    String keyFor (te::Plugin& p) { return String ((pointer_sized_int) &p); }

    bool hasModuleInfo (const File& vst3)
    {
        return vst3.getChildFile ("Contents")
                   .getChildFile ("Resources")
                   .getChildFile ("moduleinfo.json")
                   .existsAsFile()
            || vst3.getChildFile ("Contents")
                   .getChildFile ("moduleinfo.json")
                   .existsAsFile();
    }
}

PluginHost::PluginHost (te::Engine& e) : engine (e) {}
PluginHost::~PluginHost()
{
    windowByPlugin.clear();
    editorWindows.clear();
}

String PluginHost::idFor (const PluginDescription& d)
{
    return te::createIdentifierString (d);
}

// The persisted catalog + dead-mans-pedal live BESIDE the per-session dir (under
// .../Mosh/), so one catalog is shared across the GUI session and the isolated
// --selftest session and survives both.
File PluginHost::catalogFile() const
{
    return File::getSpecialLocation (File::userApplicationDataDirectory)
               .getChildFile ("Mosh").getChildFile ("plugin-catalog.xml");
}

File PluginHost::deadMansPedal() const
{
    return File::getSpecialLocation (File::userApplicationDataDirectory)
               .getChildFile ("Mosh").getChildFile ("plugin-scan-inflight.txt");
}

void PluginHost::loadCatalog()
{
    auto f = catalogFile();
    if (! f.existsAsFile()) return;
    if (auto xml = parseXML (f))                     // restores BOTH types and the blocklist
        engine.getPluginManager().knownPluginList.recreateFromXml (*xml);
}

void PluginHost::saveCatalog()
{
    auto f = catalogFile();
    f.getParentDirectory().createDirectory();
    if (auto xml = engine.getPluginManager().knownPluginList.createXml())
        xml->writeTo (f);
}

// If the pedal file survived from the last run, the plugin named in it crashed
// (or hung) mid-scan -> blocklist it so it is skipped from now on, then clear the
// pedal. This is the safety net that makes AU cataloging non-fatal.
void PluginHost::recoverFromDeadMansPedal()
{
    auto f = deadMansPedal();
    if (! f.existsAsFile()) return;
    const auto crasherId = f.loadFileAsString().trim();
    if (crasherId.isNotEmpty())
    {
        engine.getPluginManager().knownPluginList.addToBlacklist (crasherId);
        saveCatalog();
    }
    f.deleteFile();
}

void PluginHost::initialise()
{
    if (initialised)
        return;

    // Scan in-process only (our curated scanFile() path) -- avoid the engine
    // spawning a child Mosh for out-of-process scanning, which deadlocks against
    // the single-instance lock in headless --selftest/--demo runs.
    engine.getPluginManager().setUsesSeparateProcessForScanning (false);
    if (engine.getPluginManager().pluginFormatManager.getNumFormats() == 0)
        engine.getPluginManager().initialise();

    // Register Mosh's built-in Tier-A neural insert (04 §2.2) once.
    engine.getPluginManager().createBuiltInType<NeuralInsertPlugin>();
    // Register the master spectral tap (Moshi reactivity, Part B) — a pure-measure
    // passthrough appended to the master plugin list, drained at 30 Hz.
    engine.getPluginManager().createBuiltInType<MasterSpectralTapPlugin>();

    // A pedal left from the previous run means a component crashed mid-scan ->
    // quarantine it before we scan anything (INS-005 crash recovery).
    recoverFromDeadMansPedal();

    // Restore the persisted catalog. recreateFromXml brings back both the types
    // and the blocklist in one shot, so launch 2+ is instant and quarantines stick.
    loadCatalog();

    // Cold catalog -> populate it. The curated VST3 sweep is cheap + safe and
    // always runs on the message thread. AU is the slow/risky path: only when
    // explicitly opted in (MOSH_SCAN_AU=1), and we run it inline here ONLY for the
    // opt-in interactive case -- the dead-mans-pedal makes a crasher recoverable.
    // --selftest never sets MOSH_SCAN_AU, so the harness performs NO AU sweep.
    if (engine.getPluginManager().knownPluginList.getNumTypes() == 0)
    {
        scanInstalledVST3();
        if (SystemStats::getEnvironmentVariable ("MOSH_SCAN_AU", {}) == "1")
            scanAUComponents();
        saveCatalog();
    }

    initialised = true;
}

void PluginHost::scanInstalledVST3()
{
    // Enumerate EVERY .vst3 bundle in the standard macOS locations and catalog each
    // via scanFile(). This replaces the old hardcoded curated-filename list (which
    // only ever surfaced a fixed handful) so the browser reflects what the user
    // actually has installed. scanFile() keeps the moduleinfo.json fast-path (no
    // module load) unless MOSH_SCAN_SLOW_VST3=1, and honors the blocklist, so this
    // stays in-process and crash-safe. Bundles without moduleinfo still need the
    // slow-scan opt-in (Debug shutdown noise is why it is not the default).
    const File sysDir ("/Library/Audio/Plug-Ins/VST3");
    const File usrDir (File::getSpecialLocation (File::userHomeDirectory)
                           .getChildFile ("Library/Audio/Plug-Ins/VST3"));
    for (const auto& root : { sysDir, usrDir })
    {
        if (! root.isDirectory())
            continue;

        // Standard flat layout: top-level *.vst3 bundles.
        for (const auto& f : root.findChildFiles (File::findDirectories, false, "*.vst3"))
            scanFile (f);

        // Plus one level of vendor subfolders (e.g. .../VST3/Vendor/Name.vst3),
        // WITHOUT recursing into the bundles' own internals.
        for (const auto& sub : root.findChildFiles (File::findDirectories, false, "*"))
            if (! sub.getFileName().endsWithIgnoreCase (".vst3"))
                for (const auto& f : sub.findChildFiles (File::findDirectories, false, "*.vst3"))
                    scanFile (f);
    }
}

// AudioUnit cataloging (INS-002). UNLIKE VST3 there is no moduleinfo.json
// fast-path: findAllTypesForFile (via scanAndAddFile) ALWAYS instantiates the
// component, so a bad one can hang or hard-crash.
//
// HONEST CAVEAT: JUCE's AudioPluginFormat::createInstanceFromDescription marshals
// component instantiation BACK to the message thread, so a HANGING AU will still
// freeze the UI even though this function is called from a background thread.  There
// is NO per-component timeout -- a hang requires a forced app restart.  Only a CRASH
// is recoverable: the dead-mans-pedal names the current id; on the next launch
// recoverFromDeadMansPedal() quarantines it so it is never loaded again.
//
// Summary of mitigations (all that are practically achievable with stock JUCE):
//   * a dead-mans-pedal naming the id we are about to load, deleted on clean
//     return -> a crasher is blocklisted on the NEXT launch.
//   * repeated in-session rescans call recoverFromDeadMansPedal() first (rescan()).
//   * already-blocklisted ids are skipped.
//   * this function MUST be called from a background thread (MoshOps enforces this).
//   * only ONE Mosh process should run this at a time (shared pedal file, no lock).
// v0 scope: AUv2 .component only (allowAsync=false). AUv3 (.appex) is a later rung.
void PluginHost::scanAUComponents()
{
   #if JUCE_PLUGINHOST_AU && JUCE_MAC
    AudioUnitPluginFormat au;

    // Cheap enumeration -- AudioComponentFindNext, no component load. Returns
    // 'AudioUnit:...' identifier strings (NOT file paths).
    const auto ids = au.searchPathsForPlugins (FileSearchPath(), false, false);

    auto& list = engine.getPluginManager().knownPluginList;
    // Snapshot the blocklist by value. Holding a const-ref across the scan loop
    // is a data race: the message thread can call addToBlacklist() at any time and
    // getBlacklistedFiles() takes no lock in this JUCE build.
    const juce::StringArray blocked = list.getBlacklistedFiles();
    auto pedal = deadMansPedal();

    for (auto& id : ids)
    {
        if (blocked.contains (id))
            continue;   // a prior crasher -- never load it again

        // Arm the pedal: if loading this id crashes/hangs, the file survives and
        // names the culprit so the next launch quarantines it.
        pedal.replaceWithText (id);

        OwnedArray<PluginDescription> found;
        list.scanAndAddFile (id, true /*dontRescanIfAlreadyInList*/, found, au);

        pedal.deleteFile();   // clean return -> disarm
    }
   #endif
}

int PluginHost::rescan (bool clearFirst, bool includeVST3, bool includeAU, bool slowVST3)
{
    // Re-arm crash recovery BEFORE a module-loading sweep.  recoverFromDeadMansPedal()
    // runs once in initialise() for the launch-time case; repeated in-session rescans
    // (e.g. user-triggered rescan_plugins) need the same protection so a crasher
    // detected by a previous in-session scan is quarantined before the next sweep.
    // A slow VST3 sweep loads modules too, so it gets the same pre-recovery.
    if (includeAU || (includeVST3 && slowVST3))
        recoverFromDeadMansPedal();

    // scanFile() consults this to load bundles without moduleinfo.json. Scoped to
    // this call: the launch-time scanInstalledVST3() (not via rescan) stays fast.
    vst3SlowScan = slowVST3;

    auto& list = engine.getPluginManager().knownPluginList;
    if (clearFirst)
        list.clear();          // drops types; blocklist is preserved by createXml/recreateFromXml

    if (includeVST3)
        scanInstalledVST3();
    if (includeAU)
        scanAUComponents();    // may run on a background thread (MoshOps drives it there)

    vst3SlowScan = false;
    saveCatalog();
    return list.getNumTypes();
}

void PluginHost::scanFile (const File& file)
{
    const bool allowSlowScan = vst3SlowScan
        || SystemStats::getEnvironmentVariable ("MOSH_SCAN_SLOW_VST3", {}) == "1";
    const bool needsModuleLoad = ! hasModuleInfo (file);   // no moduleinfo -> JUCE loads the binary
    if (needsModuleLoad && ! allowSlowScan)
        return;

    auto& list = engine.getPluginManager().knownPluginList;
    const auto path = file.getFullPathName();

    // A module-loading scan can crash on a bad bundle. Skip a previously-quarantined
    // file, and arm the dead-mans-pedal around the load so a crasher is blocklisted
    // on the next launch (mirrors the AU path). moduleinfo.json scans don't load the
    // binary, so they need neither guard.
    if (needsModuleLoad)
    {
        if (list.getBlacklistedFiles().contains (path))
            return;
        deadMansPedal().replaceWithText (path);
    }

    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> found;
    vst3.findAllTypesForFile (found, path);

    if (needsModuleLoad)
        deadMansPedal().deleteFile();   // clean return -> disarm

    for (auto* d : found)
    {
        // Honor the blocklist: a manually blocked or crash-recovered plugin must
        // NOT be re-added on the next scan (the blocklist is keyed on fileOrIdentifier).
        if (list.getBlacklistedFiles().contains (d->fileOrIdentifier))
            continue;
        list.addType (*d);
    }
}

Array<PluginDescription> PluginHost::available() const
{
    // Filter out blocklisted entries: JUCE's getTypes() returns ALL known types
    // without consulting the blacklist, so we must exclude them here to ensure
    // list_plugins and the plugin browser never surface a blocked plugin.
    const auto& list = engine.getPluginManager().knownPluginList;
    const auto blocked = list.getBlacklistedFiles();
    Array<PluginDescription> result;
    for (auto& d : list.getTypes())
        if (! blocked.contains (d.fileOrIdentifier))
            result.add (d);
    return result;
}

StringArray PluginHost::blocklist() const
{
    return engine.getPluginManager().knownPluginList.getBlacklistedFiles();
}

void PluginHost::blockPlugin (const String& pluginId)
{
    engine.getPluginManager().knownPluginList.addToBlacklist (pluginId);
    saveCatalog();
}

void PluginHost::clearBlocklist()
{
    engine.getPluginManager().knownPluginList.clearBlacklistedFiles();
    saveCatalog();
}

bool PluginHost::findDescription (const String& pluginId, PluginDescription& out)
{
    for (auto& d : available())
        if (idFor (d) == pluginId || d.name == pluginId)
            { out = d; return true; }

    // Lazily scan if the id is an absolute VST3 path we haven't indexed yet.
    // Guard with an absolute-path check to avoid a JUCE assertion (juce_File.cpp)
    // which fires when File() is constructed from a non-absolute/non-relative string.
    if (pluginId.startsWithChar ('/'))
    {
        File f (pluginId);
        if (f.existsAsFile() || f.exists())
        {
            scanFile (f);
            for (auto& d : available())
                if (idFor (d) == pluginId || d.fileOrIdentifier == pluginId)
                    { out = d; return true; }
        }
    }
    return false;
}

void PluginHost::openEditor (te::Plugin& plugin)
{
    const auto key = keyFor (plugin);
    if (windowByPlugin.contains (key))
    {
        windowByPlugin[key]->toFront (true);
        return;
    }

    auto* ext = dynamic_cast<te::ExternalPlugin*> (&plugin);
    if (ext == nullptr) return;
    auto* inst = ext->getAudioPluginInstance();
    if (inst == nullptr) return;

    auto win = std::make_unique<EditorWindow> (plugin.getName());
    AudioProcessorEditor* ed = inst->hasEditor() ? inst->createEditorIfNeeded() : nullptr;
    if (ed != nullptr) win->setContentOwned (ed, true);
    else               win->setContentOwned (new GenericAudioProcessorEditor (*inst), true);

    win->onClose = [this, key] { closeEditorByKey (key); };
    win->centreWithSize (jmax (320, win->getWidth()), jmax (240, win->getHeight()));
    win->setVisible (true);

    windowByPlugin.set (key, win.get());
    editorWindows.add (win.release());
}

void PluginHost::closeEditor (te::Plugin& plugin)
{
    closeEditorByKey (keyFor (plugin));
}

void PluginHost::closeEditorByKey (const juce::String& key)
{
    if (! windowByPlugin.contains (key)) return;
    auto* w = windowByPlugin[key];
    windowByPlugin.remove (key);
    for (int i = editorWindows.size(); --i >= 0;)
        if (editorWindows[i] == w)
            editorWindows.remove (i);   // OwnedArray deletes it
}

} // namespace mosh
