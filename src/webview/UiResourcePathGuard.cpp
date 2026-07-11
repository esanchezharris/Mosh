#include "UiResourcePathGuard.h"
#include <filesystem>
#include <system_error>

namespace mosh::ui_resource_guard
{
namespace
{
    int hexValue (juce::juce_wchar c)
    {
        if (c >= '0' && c <= '9') return (int) (c - '0');
        if (c >= 'a' && c <= 'f') return 10 + (int) (c - 'a');
        if (c >= 'A' && c <= 'F') return 10 + (int) (c - 'A');
        return -1;
    }

    std::optional<juce::String> decodePercents (const juce::String& in)
    {
        juce::String out;
        for (int i = 0; i < in.length(); ++i)
        {
            auto c = in[i];
            if (c != '%')
            {
                out << juce::String::charToString (c);
                continue;
            }

            if (i + 2 >= in.length())
                return std::nullopt;

            auto hi = hexValue (in[i + 1]);
            auto lo = hexValue (in[i + 2]);
            if (hi < 0 || lo < 0)
                return std::nullopt;

            out << juce::String::charToString ((juce::juce_wchar) ((hi << 4) | lo));
            i += 2;
        }
        return out;
    }

    bool hasSchemeOrDrive (const juce::String& path)
    {
        auto colon = path.indexOfChar (':');
        if (colon < 0)
            return false;

        auto slash = path.indexOfChar ('/');
        return slash < 0 || colon < slash;
    }

    bool staysWithin (const std::filesystem::path& root, const std::filesystem::path& child)
    {
        std::error_code ec;
        auto canonicalRoot = std::filesystem::weakly_canonical (root, ec);
        if (ec)
            return false;

        auto canonicalChild = std::filesystem::weakly_canonical (child, ec);
        if (ec)
            return false;

        auto rel = std::filesystem::relative (canonicalChild, canonicalRoot, ec);
        if (ec)
            return false;

        for (const auto& part : rel)
            if (part == "..")
                return false;

        return true;
    }
}

std::optional<juce::String> normalisePath (const juce::String& url)
{
    auto path = url.upToFirstOccurrenceOf ("?", false, false)
                   .upToFirstOccurrenceOf ("#", false, false);
    if (path.isEmpty() || path == "/")
        path = "/index.html";

    if (path.startsWith ("//") || path.startsWith ("\\\\") || path.containsChar ('\\') || hasSchemeOrDrive (path))
        return std::nullopt;

    auto rel = path.startsWith ("/") ? path.substring (1) : path;
    auto decoded = decodePercents (rel);
    if (! decoded)
        return std::nullopt;

    if (decoded->startsWith ("/") || decoded->startsWith ("\\\\") || decoded->containsChar ('\\') || hasSchemeOrDrive (*decoded))
        return std::nullopt;

    juce::StringArray parts;
    parts.addTokens (*decoded, "/", {});

    juce::StringArray clean;
    for (const auto& part : parts)
    {
        if (part.isEmpty())
            continue;
        if (part == "." || part == "..")
            return std::nullopt;
        clean.add (part);
    }

    return clean.isEmpty() ? juce::String ("index.html") : clean.joinIntoString ("/");
}

bool isSafePath (const juce::String& url)
{
    return normalisePath (url).has_value();
}

bool isSafePath (const juce::File& uiDir, const juce::String& url)
{
    auto rel = normalisePath (url);
    if (! rel)
        return false;

    return staysWithin (
        std::filesystem::path (uiDir.getFullPathName().toStdString()),
        std::filesystem::path (uiDir.getChildFile (*rel).getFullPathName().toStdString()));
}
}
