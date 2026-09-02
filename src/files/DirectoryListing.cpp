#include "DirectoryListing.h"

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

Array<var> rootsFor (const File& sessionDir)
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

    addRoot ("Imports", sessionDir.getChildFile ("imports"));
    return roots;
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

var buildData (const File& sessionDir, const var& args)
{
    const auto roots = rootsFor (sessionDir);
    const auto requested = args.getProperty ("path", var()).toString();

    File directory;
    if (requested.isEmpty())
    {
        const auto imports = sessionDir.getChildFile ("imports");
        directory = imports.isDirectory() ? imports : sessionDir;
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

    auto parent = directory.getParentDirectory();
    if (! directory.isDirectory())
        return resultData (directory, roots, false, "not a directory or not found",
                           Array<var>(), &parent, false, 0);
    if (! directory.hasReadAccess())
        return resultData (directory, roots, false, "permission denied",
                           Array<var>(), &parent, false, 0);

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

    return resultData (directory, roots, true, {}, entries, &parent, truncated, visited);
}
}
