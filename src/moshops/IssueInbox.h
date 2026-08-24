#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>
#include <algorithm>
#if JUCE_MAC || JUCE_LINUX
 #include <sys/stat.h>
#endif

namespace mosh
{
struct IssueInbox
{
    static juce::File root()
    {
        const auto override = juce::SystemStats::getEnvironmentVariable ("MOSH_FEEDBACK_DIR", {}).trim();
        if (override.isNotEmpty()) return juce::File (override).getChildFile ("inbox");
        return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
            .getChildFile ("Mosh").getChildFile ("feedback").getChildFile ("inbox");
    }

    static juce::String scrub (juce::String text)
    {
        const auto home = juce::File::getSpecialLocation (juce::File::userHomeDirectory).getFullPathName();
        if (home.isNotEmpty()) text = text.replace (home, "~");
        return text.substring (0, 2000);
    }

    static juce::String makeId (const juce::String& description, juce::int64 timestamp)
    {
        const auto digest = juce::SHA256 (description.toRawUTF8(), (size_t) description.getNumBytesAsUTF8())
                                .toHexString().substring (0, 8);
        return juce::Time (timestamp).formatted ("%Y%m%d-%H%M%S") + "-" + digest;
    }

    static juce::Array<juce::var> readAll()
    {
        juce::Array<juce::var> out;
        if (! root().isDirectory()) return out;
        juce::Array<juce::File> dirs;
        root().findChildFiles (dirs, juce::File::findDirectories, false);
        std::sort (dirs.begin(), dirs.end(), [] (const auto& a, const auto& b) {
            return a.getFileName() > b.getFileName();
        });
        for (const auto& dir : dirs)
        {
            auto report = juce::JSON::fromString (dir.getChildFile ("report.json").loadFileAsString());
            if (report.isObject()) out.add (report);
        }
        return out;
    }

    static bool validStatus (const juce::String& status)
    {
        return status == "inbox" || status == "triaged" || status == "fixed" || status == "dismissed";
    }

    static juce::File issueDir (const juce::String& id)
    {
        if (id.isEmpty() || id.contains ("/") || id.contains ("..")) return {};
        return root().getChildFile (id);
    }

    static bool writeReport (const juce::File& dir, const juce::var& report)
    {
        if ((! dir.isDirectory() && ! dir.createDirectory().wasOk())) return false;
       #if JUCE_MAC || JUCE_LINUX
        ::chmod (root().getParentDirectory().getFullPathName().toRawUTF8(), 0700);
        ::chmod (root().getFullPathName().toRawUTF8(), 0700);
        ::chmod (dir.getFullPathName().toRawUTF8(), 0700);
       #endif
        const auto file = dir.getChildFile ("report.json");
        if (! file.replaceWithText (juce::JSON::toString (report, true))) return false;
       #if JUCE_MAC || JUCE_LINUX
        ::chmod (file.getFullPathName().toRawUTF8(), 0600);
       #endif
        return true;
    }
};
}
