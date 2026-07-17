#include "TelemetryConfig.h"

namespace mosh::telemetry
{

namespace
{
    // MOSH_TELEMETRY_DIR overrides the ~/Library/Mosh root — test/harness use only.
    juce::File resolveRoot()
    {
        const auto override = juce::SystemStats::getEnvironmentVariable ("MOSH_TELEMETRY_DIR", {});
        if (override.trim().isNotEmpty())
            return juce::File (override.trim());
        return juce::File::getSpecialLocation (juce::File::userApplicationDataDirectory)
                   .getChildFile ("Mosh");
    }
}

juce::File TelemetryConfig::root() { return resolveRoot(); }

juce::File TelemetryConfig::diagnosticsDir()
{
    auto dir = root().getChildFile ("diagnostics");
    dir.createDirectory();
    return dir;
}

juce::File TelemetryConfig::telemetryStateDir()
{
    auto dir = root().getChildFile ("telemetry");
    dir.createDirectory();
    return dir;
}

juce::File TelemetryConfig::optInFile()
{
    return root().getChildFile ("telemetry.optin");
}

bool TelemetryConfig::isOptedIn()
{
    return optInFile().existsAsFile();
}

void TelemetryConfig::setOptedIn (bool optIn)
{
    auto f = optInFile();
    if (optIn)
    {
        f.getParentDirectory().createDirectory();
        // Content is human-debuggable but deliberately not load-bearing — presence
        // alone is the contract (see class comment).
        f.replaceWithText ("1\n");
    }
    else
    {
        f.deleteFile();
    }
}

juce::String TelemetryConfig::installId()
{
    // 1. Read-only probe of the engine's own identity file, if it exists.
    auto engineIdentity = root().getChildFile ("session").getChildFile ("identity.json");
    if (engineIdentity.existsAsFile())
    {
        auto parsed = juce::JSON::parse (engineIdentity.loadFileAsString());
        auto id = parsed.getProperty ("installId", juce::var()).toString();
        if (id.isNotEmpty())
            return id;
    }

    // 2. This module's own persisted id.
    auto ownIdentity = telemetryStateDir().getChildFile ("identity.json");
    if (ownIdentity.existsAsFile())
    {
        auto parsed = juce::JSON::parse (ownIdentity.loadFileAsString());
        auto id = parsed.getProperty ("installId", juce::var()).toString();
        if (id.isNotEmpty())
            return id;
    }

    // 3. Mint + persist a fresh one.
    const auto fresh = juce::Uuid().toString();
    auto* obj = new juce::DynamicObject();
    obj->setProperty ("installId", fresh);
    ownIdentity.getParentDirectory().createDirectory();
    ownIdentity.replaceWithText (juce::JSON::toString (juce::var (obj)));
    return fresh;
}

} // namespace mosh::telemetry
