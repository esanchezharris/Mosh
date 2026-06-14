#include "PluginHost.h"
#include "plugins/neural/NeuralInsertPlugin.h"
#include "plugins/spectral/MasterSpectralTapPlugin.h"
#include <thread>
#include <unistd.h>   // getpid

namespace mosh
{
using namespace juce;

namespace
{
    // Kill the out-of-process plugin-scan child (Tracktion launches it with a
    // "--PluginScan:<pipe>" command line). The deep-scan watchdog calls this when a
    // child hangs loading a plugin (e.g. a license/cloud helper blocked on a socket):
    // te's master sees the broken pipe as a crash, gives the plugin one retry, then
    // blocklists it and continues — turning an unrecoverable hang into a skip.
    //
    // Scoped to DIRECT CHILDREN of THIS process (-P getpid) so a second Mosh instance's
    // scan worker — or any unrelated process — is never collaterally killed; the te
    // master is in-process, so its worker is always our direct child.
    void killScanWorkers()
    {
        juce::ChildProcess pk;
        pk.start (juce::StringArray { "/usr/bin/pkill", "-9",
                                      "-P", juce::String ((int) getpid()),
                                      "-f", "PluginScan:" });
        pk.waitForProcessToFinish (2000);
    }

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

    // Default OFF at startup: the cold catalog populate below + --selftest scan only
    // the cheap moduleinfo.json fast path in-process (no module load, no child). The
    // out-of-process scanner is enabled TRANSIENTLY inside rescan() for an explicit
    // deep (module-loading) sweep, so launch/headless never spawn a scan child.
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
        scanFilesProcessed.fetch_add (1, std::memory_order_relaxed);   // watchdog heartbeat
    }
   #endif
}

int PluginHost::rescan (bool clearFirst, bool includeVST3, bool includeAU, bool slowVST3)
{
    auto& pm = engine.getPluginManager();
    auto& list = pm.knownPluginList;

    // Single-flight: only one scan at a time. A second concurrent rescan (the remote
    // command surface firing again, or CLI + GUI) would race the OOP flag, the watchdog
    // heartbeat, and the dead-mans-pedal. If one is already running, return the current
    // count rather than launching a racing second sweep.
    bool expected = false;
    if (! scanInProgress.compare_exchange_strong (expected, true))
        return list.getNumTypes();

    const bool oop = slowVST3;
    std::atomic<bool> scanRunning { true };
    std::thread watchdog;

    // RAII teardown — runs on EVERY exit path (normal return OR stack-unwind from an
    // exception in scanInstalledVST3/scanAUComponents/saveCatalog). It always stops +
    // joins the watchdog (an un-joined std::thread dtor would call std::terminate and
    // hard-crash the app, defeating the crash isolation), restores the OOP flag, and
    // releases the single-flight latch. Declared AFTER scanRunning + watchdog so it
    // destructs FIRST — joining the thread while scanRunning is still alive.
    struct ScanGuard
    {
        te::PluginManager& pm; std::atomic<bool>& running; std::thread& wd;
        bool& slowFlag; std::atomic<bool>& inProgress; bool oop;
        ~ScanGuard()
        {
            running.store (false, std::memory_order_relaxed);
            if (wd.joinable()) wd.join();
            slowFlag = false;
            if (oop) pm.setUsesSeparateProcessForScanning (false);
            inProgress.store (false, std::memory_order_relaxed);
        }
    } guard { pm, scanRunning, watchdog, vst3SlowScan, scanInProgress, oop };

    // Re-arm crash recovery BEFORE a module-loading sweep (quarantine a prior crasher
    // before re-scanning it).
    if (includeAU || (includeVST3 && slowVST3))
        recoverFromDeadMansPedal();

    // Enable Tracktion's out-of-process scanner for the deep (module-loading) sweep:
    // scanFile()'s slow path routes through knownPluginList.scanAndAddFile -> te's
    // CustomScanner -> a child Mosh process, so a plugin that crashes/asserts on load
    // takes down only the child (te relaunches + blocklists it). The guard restores it.
    if (oop) pm.setUsesSeparateProcessForScanning (true);
    vst3SlowScan = slowVST3;   // scanFile() consults this to load bundles w/o moduleinfo

    if (clearFirst)
        list.clear();          // drops types; the blocklist is preserved

    // Per-plugin hang watchdog (OOP sweep only): te's waitForReply has no timeout, so a
    // child blocked loading a plugin (e.g. a cloud/license helper on a socket) would
    // stall forever. scanFile()/scanAUComponents() bump scanFilesProcessed per plugin;
    // if it stops advancing for kStallMs the watchdog kills our scan child so te sees a
    // "crash" and skips+blocklists the offender. False positives self-heal (te re-scans).
    if (oop)
    {
        watchdog = std::thread ([this, &scanRunning]
        {
            constexpr int kStallMs = 25000;
            int last = scanFilesProcessed.load (std::memory_order_relaxed);
            auto lastAdvance = juce::Time::getMillisecondCounter();
            while (scanRunning.load (std::memory_order_relaxed))
            {
                juce::Thread::sleep (500);
                const int now = scanFilesProcessed.load (std::memory_order_relaxed);
                const auto t = juce::Time::getMillisecondCounter();
                if (now != last) { last = now; lastAdvance = t; continue; }
                if (t - lastAdvance > (uint32) kStallMs)
                {
                    killScanWorkers();      // hung child -> te sees a crash -> skip + blocklist
                    lastAdvance = t;        // give the retry/next plugin a fresh window
                }
            }
        });
    }

    if (includeVST3)
        scanInstalledVST3();
    if (includeVST3 && includeAU)
        saveCatalog();         // persist the VST3 result BEFORE the in-process AU sweep,
                               // so a slow/hanging AU can never lose a good VST3 catalog.
    if (includeAU)
        scanAUComponents();    // bumps the heartbeat per component (watchdog-tracked too)

    saveCatalog();
    return list.getNumTypes();   // guard runs here: stops watchdog, restores OOP flag, releases latch
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
    if (list.getBlacklistedFiles().contains (path))
        return;

    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> found;

    if (needsModuleLoad)
    {
        // Module-loading scan -> route through te's KnownPluginList CustomScanner.
        // With OOP enabled (rescan() turns it on for the deep sweep) the binary loads
        // in a CHILD Mosh process, so a crash/assert on load kills only the child: te
        // relaunches it, blocklists the offender, and the sweep continues. The dead-
        // mans-pedal is armed as belt-and-suspenders for the in-process fallback (an
        // env-only MOSH_SCAN_SLOW_VST3 sweep with OOP off). scanAndAddFile adds the
        // results to the list itself and blacklists a file whose scan returns false.
        deadMansPedal().replaceWithText (path);
        list.scanAndAddFile (path, true /*dontRescanIfAlreadyInList*/, found, vst3);
        deadMansPedal().deleteFile();
    }
    else
    {
        // moduleinfo.json fast path: JUCE reads the JSON without loading the binary --
        // safe + instant in-process, no child spawn. findAllTypesForFile only FINDS,
        // so add the results here (honoring the blocklist).
        vst3.findAllTypesForFile (found, path);
        for (auto* d : found)
            if (! list.getBlacklistedFiles().contains (d->fileOrIdentifier))
                list.addType (*d);
    }

    scanFilesProcessed.fetch_add (1, std::memory_order_relaxed);   // per-plugin heartbeat (watchdog)
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
