#include "OwnerRuntime.h"

#include <sys/stat.h>

namespace mosh
{
using namespace juce;

OwnerRuntimeConfig OwnerRuntimeConfig::fromVar (const var& root)
{
    OwnerRuntimeConfig c;
    c.enabled = (bool) root.getProperty ("enabled", false);
    c.autoStart = (bool) root.getProperty ("autoStart", false);
    c.modelPathRaw = root.getProperty ("modelPath", var()).toString().trim();
    c.pythonRuntimeRaw = root.getProperty ("pythonRuntime", var()).toString().trim();
    if (File::isAbsolutePath (c.modelPathRaw)) c.modelPath = File (c.modelPathRaw);
    if (File::isAbsolutePath (c.pythonRuntimeRaw)) c.pythonRuntime = File (c.pythonRuntimeRaw);
    c.preferredPort = jlimit (1024, 65500, (int) root.getProperty ("preferredPort", 8091));
    c.stableAudioReleaseIdle = jlimit (0.0, 1.0, (double) root.getProperty ("stableAudioReleaseIdle", 0.99));
    c.prewarmAfterUnload = (bool) root.getProperty ("prewarmAfterUnload", true);
    c.preferredShell = root.getProperty ("preferredShell", var()).toString().trim();
    return c;
}

OwnerRuntimeConfig OwnerRuntimeConfig::load()
{
    const auto overridePath = SystemStats::getEnvironmentVariable ("MOSH_OWNER_RUNTIME_CONFIG", {}).trim();
    auto file = overridePath.isNotEmpty()
        ? File (overridePath)
        : File::getSpecialLocation (File::userHomeDirectory).getChildFile (".config/mosh/owner-runtime.json");
    if (! file.existsAsFile()) return {};

   #if JUCE_MAC || JUCE_LINUX
    struct stat info {};
    if (::stat (file.getFullPathName().toRawUTF8(), &info) != 0 || (info.st_mode & 077) != 0)
    {
        OwnerRuntimeConfig bad; bad.enabled = true; bad.sourceFile = file;
        return bad;
    }
   #endif
    auto c = fromVar (JSON::parse (file.loadFileAsString()));
    c.sourceFile = file;
    return c;
}

String OwnerRuntimeConfig::validationError() const
{
    if (! enabled) return {};
    if (sourceFile.existsAsFile())
    {
       #if JUCE_MAC || JUCE_LINUX
        struct stat info {};
        if (::stat (sourceFile.getFullPathName().toRawUTF8(), &info) != 0 || (info.st_mode & 077) != 0)
            return "owner runtime config must have mode 600";
       #endif
    }
    if (modelPathRaw.contains ("://"))
        return "owner runtime refuses remote model paths";
    if (modelPathRaw.isEmpty() || ! File::isAbsolutePath (modelPathRaw))
        return "owner runtime modelPath must be an absolute local path";
    if (pythonRuntimeRaw.isEmpty() || ! File::isAbsolutePath (pythonRuntimeRaw))
        return "owner runtime pythonRuntime must be an absolute local path";
    if (preferredShell.isNotEmpty() && preferredShell != "live" && preferredShell != "protools"
        && preferredShell != "v2" && preferredShell != "classic")
        return "owner runtime preferredShell is invalid";
    return {};
}
}
