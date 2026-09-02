#include "SampleFolderStore.h"

namespace mosh
{
SampleFolderStore::SampleFolderStore (juce::File storageFileToUse)
    : storageFile (std::move (storageFileToUse))
{
}

juce::Array<SampleFolderRecord> SampleFolderStore::records() const
{
    juce::Array<SampleFolderRecord> result;
    if (! storageFile.existsAsFile())
        return result;

    const auto parsed = juce::JSON::parse (storageFile);
    const auto folders = parsed.getProperty ("folders", juce::var());
    if (! folders.isArray())
        return result;

    for (const auto& item : *folders.getArray())
    {
        const auto path = item.getProperty ("path", juce::var()).toString();
        if (! juce::File::isAbsolutePath (path))
            continue;
        auto name = item.getProperty ("name", juce::var()).toString();
        if (name.isEmpty())
            name = juce::File (path).getFileName();
        result.add ({ name, path,
                      item.getProperty ("bookmark", juce::var()).toString() });
    }
    return result;
}

juce::Result SampleFolderStore::remember (const juce::File& directory,
                                           const juce::String& bookmark) const
{
    auto current = records();
    for (int index = current.size(); --index >= 0;)
        if (juce::File (current.getReference (index).path) == directory)
            current.remove (index);
    current.add ({ directory.getFileName(), directory.getFullPathName(), bookmark });

    juce::Array<juce::var> folders;
    for (const auto& record : current)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty ("name", record.name);
        item->setProperty ("path", record.path);
        item->setProperty ("bookmark", record.bookmark);
        folders.add (juce::var (item));
    }

    auto* root = new juce::DynamicObject();
    root->setProperty ("version", 1);
    root->setProperty ("folders", folders);
    if (! storageFile.getParentDirectory().createDirectory().wasOk())
        return juce::Result::fail ("could not create Mosh settings storage");
    if (! storageFile.replaceWithText (juce::JSON::toString (juce::var (root), true)))
        return juce::Result::fail ("could not save the sample folder");
    return juce::Result::ok();
}
}
