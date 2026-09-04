#include "DirectoryListing.h"
#include "engine/SessionOwnership.h"

#include <algorithm>
#include <vector>

namespace mosh::directory_listing
{
namespace
{
using juce::Array;
using juce::DynamicObject;
using juce::File;
using juce::String;
using juce::StringArray;
using juce::var;

const StringArray audioExtensions { ".wav", ".aif", ".aiff", ".flac", ".mp3", ".ogg" };

struct Entry
{
    File file;
    bool isDirectory = false;
};

Array<File> allowedRootsFor (const File& sessionDir, const Array<File>& sampleFolders)
{
    Array<File> roots { sessionDir.getChildFile ("imports") };
    for (const auto& folder : sampleFolders)
        roots.addIfNotAlreadyThere (folder);
    return roots;
}

Array<var> rootsFor (const Array<File>& allowedRoots)
{
    Array<var> roots;
    auto addRoot = [&] (const String& name, const File& directory)
    {
        if (! directory.isDirectory())
            return;

        auto* object = new DynamicObject();
        object->setProperty ("name", name);
        object->setProperty ("path", directory.getFullPathName());
        roots.add (var (object));
    };

    for (int index = 0; index < allowedRoots.size(); ++index)
        addRoot (index == 0 ? String ("Imports")
                            : allowedRoots.getReference (index).getFileName(),
                 allowedRoots.getReference (index));
    return roots;
}

const File* containingRoot (const Array<File>& roots, const File& candidate)
{
    for (const auto& root : roots)
        if (candidate == root
            || mosh::sessionpaths::isContainedWithoutSymlinks (root, candidate))
            return &root;
    return nullptr;
}

var resultData (const File& directory,
                const Array<var>& roots,
                bool exists,
                const String& error,
                const Array<var>& entries,
                const File* parent,
                bool truncated,
                int visited)
{
    auto* data = new DynamicObject();
    data->setProperty ("path", directory.getFullPathName());
    if (parent != nullptr && *parent != directory && parent->isDirectory())
        data->setProperty ("parent", parent->getFullPathName());
    else
        data->setProperty ("parent", var());
    data->setProperty ("exists", exists);
    data->setProperty ("error", error.isNotEmpty() ? var (error) : var());
    data->setProperty ("roots", roots);
    data->setProperty ("entries", entries);
    data->setProperty ("truncated", truncated);
    data->setProperty ("limit", kMaxEntries);
    data->setProperty ("visited", visited);
    return var (data);
}
}

var buildData (const File& sessionDir, const var& args, Array<File> sampleFolders)
{
    const auto allowedRoots = allowedRootsFor (sessionDir, sampleFolders);
    const auto roots = rootsFor (allowedRoots);
    const auto requested = args.getProperty ("path", var()).toString();

    File directory;
    if (requested.isEmpty())
    {
        directory = sessionDir.getChildFile ("imports");
    }
    else if (! File::isAbsolutePath (requested))
    {
        auto* data = new DynamicObject();
        data->setProperty ("path", requested);
        data->setProperty ("parent", var());
        data->setProperty ("exists", false);
        data->setProperty ("error", "invalid path (must be absolute)");
        data->setProperty ("roots", roots);
        data->setProperty ("entries", Array<var>());
        data->setProperty ("truncated", false);
        data->setProperty ("limit", kMaxEntries);
        data->setProperty ("visited", 0);
        return var (data);
    }
    else
    {
        directory = File (requested);
    }

    const auto* root = containingRoot (allowedRoots, directory);
    if (root == nullptr)
        return resultData (directory, roots, false, "folder not added to Mosh",
                           Array<var>(), nullptr, false, 0);

    auto parent = directory.getParentDirectory();
    const File* visibleParent = directory == *root ? nullptr : &parent;
    if (! directory.isDirectory())
        return resultData (directory, roots, false, "not a directory or not found",
                           Array<var>(), visibleParent, false, 0);
    if (! directory.hasReadAccess())
        return resultData (directory, roots, false, "permission denied",
                           Array<var>(), visibleParent, false, 0);

    std::vector<Entry> found;
    found.reserve ((size_t) kMaxEntries);
    bool truncated = false;
    int visited = 0;
    for (const auto entry : juce::RangedDirectoryIterator (
             directory,
             false,
             "*",
             File::findFilesAndDirectories | File::ignoreHiddenFiles))
    {
        if (visited >= kMaxVisitedEntries)
        {
            truncated = true;
            break;
        }
        ++visited;

        const auto file = entry.getFile();
        const bool isDirectory = entry.isDirectory();
        if (! isDirectory
            && ! audioExtensions.contains (file.getFileExtension().toLowerCase()))
            continue;

        if ((int) found.size() >= kMaxEntries)
        {
            truncated = true;
            break;
        }
        found.push_back ({ file, isDirectory });
    }

    std::sort (found.begin(), found.end(), [] (const Entry& a, const Entry& b)
    {
        if (a.isDirectory != b.isDirectory)
            return a.isDirectory;
        return a.file.getFileName().compareIgnoreCase (b.file.getFileName()) < 0;
    });

    Array<var> entries;
    for (const auto& entry : found)
    {
        auto* object = new DynamicObject();
        object->setProperty ("name", entry.file.getFileName());
        object->setProperty ("path", entry.file.getFullPathName());
        object->setProperty ("isDir", entry.isDirectory);
        object->setProperty ("size", entry.isDirectory
            ? var()
            : var ((double) entry.file.getSize()));
        entries.add (var (object));
    }

    return resultData (directory, roots, true, {}, entries, visibleParent, truncated, visited);
}
}
