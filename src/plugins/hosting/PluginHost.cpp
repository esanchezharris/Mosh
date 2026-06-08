#include "PluginHost.h"
#include "plugins/neural/NeuralInsertPlugin.h"

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
}

PluginHost::PluginHost (te::Engine& e) : engine (e) {}
PluginHost::~PluginHost() = default;

String PluginHost::idFor (const PluginDescription& d)
{
    return te::createIdentifierString (d);
}

void PluginHost::initialise()
{
    // Scan in-process only (our curated scanFile() path) — avoid the engine
    // spawning a child Mosh for out-of-process scanning, which deadlocks against
    // the single-instance lock in headless --selftest/--demo runs.
    engine.getPluginManager().setUsesSeparateProcessForScanning (false);
    engine.getPluginManager().initialise();

    // Register Mosh's built-in Tier-A neural insert (04 §2.2) once.
    engine.getPluginManager().createBuiltInType<NeuralInsertPlugin>();

    // Curated in-process scan (avoids a slow/crashy full blind scan; any other
    // file is scanned lazily by findDescription()).
    static const char* curated[] = {
        "Vital.vst3", "OTT.vst3", "TAL-Chorus-LX.vst3",
        "JamPilotTestGain.vst3", "ValhallaDelay.vst3", "Serum2.vst3"
    };
    const File sysDir ("/Library/Audio/Plug-Ins/VST3");
    const File usrDir (File::getSpecialLocation (File::userHomeDirectory)
                           .getChildFile ("Library/Audio/Plug-Ins/VST3"));
    for (auto* name : curated)
    {
        auto sys = sysDir.getChildFile (name);
        auto usr = usrDir.getChildFile (name);
        if (sys.exists())      scanFile (sys);
        else if (usr.exists()) scanFile (usr);
    }
}

void PluginHost::scanFile (const File& file)
{
    VST3PluginFormat vst3;
    OwnedArray<PluginDescription> found;
    vst3.findAllTypesForFile (found, file.getFullPathName());
    for (auto* d : found)
        engine.getPluginManager().knownPluginList.addType (*d);
}

Array<PluginDescription> PluginHost::available() const
{
    return engine.getPluginManager().knownPluginList.getTypes();
}

bool PluginHost::findDescription (const String& pluginId, PluginDescription& out)
{
    for (auto& d : available())
        if (idFor (d) == pluginId || d.name == pluginId)
            { out = d; return true; }

    // Lazily scan if the id is a VST3 path we haven't indexed yet.
    File f (pluginId);
    if (f.existsAsFile() || f.exists())
    {
        scanFile (f);
        for (auto& d : available())
            if (idFor (d) == pluginId || d.fileOrIdentifier == pluginId)
                { out = d; return true; }
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
