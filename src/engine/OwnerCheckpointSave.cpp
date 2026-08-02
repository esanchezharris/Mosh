#include "OwnerCheckpointSave.h"

#if JUCE_MAC
 #include <sys/stat.h>
 #include <unistd.h>
#endif

namespace mosh::ownercheckpoint
{
namespace
{
    bool secureOwnerFile (const juce::File& file)
    {
       #if JUCE_MAC
        struct stat info {};
        const auto* path = file.getFullPathName().toRawUTF8();
        if (::lstat (path, &info) != 0 || ! S_ISREG (info.st_mode)
            || ::chmod (path, S_IRUSR | S_IWUSR) != 0)
            return false;

        info = {};
        return ::lstat (path, &info) == 0 && S_ISREG (info.st_mode)
            && (info.st_mode & 0777) == 0600;
       #else
        return file.existsAsFile() && ! file.isSymbolicLink();
       #endif
    }
}

bool savePrivateReplacement (
    const juce::File& target,
    const Writer& writer
   #if MOSH_TESTING
    , const SaveTestHooks* hooks
   #endif
)
{
    if (! writer || ! target.existsAsFile() || target.isSymbolicLink())
        return false;

   #if JUCE_MAC
    const auto parent = target.getParentDirectory();
    if (! parent.isDirectory())
        return false;

    const auto staging = parent.getChildFile (
        ".mosh-private-save-" + juce::Uuid().toString());
    const auto stagingPath = staging.getFullPathName();
    if (::mkdir (stagingPath.toRawUTF8(), S_IRWXU) != 0)
        return false;

    const auto cleanup = [&]
    {
        // This exact UUID directory was created above and never exposed as a
        // writable root. Tracktion/JUCE may leave an internal temp on failure.
        staging.deleteRecursively();
    };
    const auto stagedFile = staging.getChildFile (target.getFileName());
    if (! writer (stagedFile))
    {
        cleanup();
        return false;
    }

   #if MOSH_TESTING
    const bool secured = hooks != nullptr && hooks->secureStagedFile
        ? hooks->secureStagedFile (stagedFile)
        : secureOwnerFile (stagedFile);
   #else
    const bool secured = secureOwnerFile (stagedFile);
   #endif
    if (! secured)
    {
        cleanup();
        return false;
    }

    if (::rename (stagedFile.getFullPathName().toRawUTF8(),
                  target.getFullPathName().toRawUTF8()) != 0)
    {
        cleanup();
        return false;
    }
    cleanup();

    // rename preserves the staged inode's 0600 mode. If the post-condition
    // cannot be proven, remove the checkpoint replacement rather than leave
    // project metadata readable in a shared directory.
    if (! secureOwnerFile (target))
    {
        target.deleteFile();
        return false;
    }
    return true;
   #else
    return writer (target);
   #endif
}
}
