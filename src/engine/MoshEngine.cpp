#include "MoshEngine.h"
#include "NeuralInsertPlugin.h"

namespace mosh
{
    juce::File MoshEngine::defaultEditFile()
    {
        auto dir = juce::File::getSpecialLocation (juce::File::userDocumentsDirectory)
                       .getChildFile ("Mosh");
        dir.createDirectory();
        return dir.getChildFile ("untitled.tracktionedit");
    }

    MoshEngine::MoshEngine()
    {
        // One Engine for the app lifetime; device auto-inits during construction.
        // The 1-arg ctor uses the default UIBehaviour/EngineBehaviour — correct for a
        // headless/WebView app (no native dialog prompts). (ExtendedUIBehaviour is an
        // examples/common helper, not part of the engine module.) A custom
        // EngineBehaviour can be slotted in later via the 3-arg ctor if needed.
        engine = std::make_unique<te::Engine> ("Mosh");
        // Register Mosh's Tier-A neural insert as a built-in plugin type (04).
        engine->getPluginManager().createBuiltInType<NeuralInsertPlugin>();
        newEdit (defaultEditFile());
    }

    MoshEngine::~MoshEngine()
    {
        if (edit != nullptr)
            edit->getTransport().freePlaybackContext();   // detach before teardown
        edit.reset();
        engine.reset();
    }

    void MoshEngine::newEdit (juce::File file)
    {
        editFile = file != juce::File() ? file : defaultEditFile();
        edit = te::createEmptyEdit (*engine, editFile);
    }

    bool MoshEngine::load (const juce::File& file)
    {
        if (auto loaded = te::loadEditFromFile (*engine, file))
        {
            edit = std::move (loaded);
            editFile = file;
            return true;
        }
        return false;
    }

    bool MoshEngine::save()
    {
        if (edit == nullptr)
            return false;
        // (warnOfFailure=false, forceSaveEvenIfNotModified=true, offerToDiscard=false)
        return te::EditFileOperations (*edit).save (false, true, false);
    }

    bool MoshEngine::saveAs (const juce::File& file)
    {
        if (edit == nullptr)
            return false;
        if (te::EditFileOperations (*edit).saveAs (file, true))
        {
            editFile = file;
            return true;
        }
        return false;
    }
}
