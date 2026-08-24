#include "ReImagineService.h"

#include <algorithm>
#include <cstdlib>

namespace mosh::reimagine
{
namespace
{
void setEnvironment (const char* key, const juce::String& value)
{
   #if JUCE_WINDOWS
    _putenv_s (key, value.toRawUTF8());
   #else
    ::setenv (key, value.toRawUTF8(), 1);
   #endif
}

}

std::vector<LoraCatalogItem> loraCatalogFromResponse (const juce::var& response)
{
    std::vector<LoraCatalogItem> result;
    if (! static_cast<bool> (response.getProperty ("ok", false)))
        return result;
    const auto* rows = response.getProperty ("loras", {}).getArray();
    if (rows == nullptr)
        return result;
    result.reserve (static_cast<size_t> (rows->size()));
    for (const auto& row : *rows)
    {
        if (! static_cast<bool> (row.getProperty ("valid", false)))
            continue;
        LoraCatalogItem item;
        item.id = row.getProperty ("name", {}).toString().trim();
        if (item.id.isEmpty())
            continue;
        item.displayName = row.getProperty ("displayName", {}).toString().trim();
        if (item.displayName.isEmpty())
            item.displayName = item.id;
        item.trigger = row.getProperty ("trigger", {}).toString().trim();
        item.hint = row.getProperty ("hint", {}).toString().trim();
        item.notes = row.getProperty ("notes", {}).toString().trim();
        item.isLab = row.getProperty ("family", {}).toString() == "lab";
        result.push_back (std::move (item));
    }
    return result;
}

juce::var serviceParamsForRack (const RackSettings& rack, bool lab)
{
    auto* params = new juce::DynamicObject();
    params->setProperty ("prompt", rack.prompt);
    params->setProperty ("nl", rack.reimagine);
    params->setProperty ("seed", static_cast<juce::int64> (rack.seed));
    params->setProperty ("lab", lab);
    juce::Array<juce::var> colors;
    for (const auto& color : rack.colors)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("name", color.id);
        row->setProperty ("value", color.amount);
        colors.add (juce::var (row));
    }
    params->setProperty ("colors", colors);
    juce::Array<juce::var> loras;
    for (const auto& lora : rack.loras)
    {
        auto* row = new juce::DynamicObject();
        row->setProperty ("name", lora.id);
        row->setProperty ("value", lora.scale * 100.0f);
        loras.add (juce::var (row));
    }
    params->setProperty ("loras", loras);
    return juce::var (params);
}

AssetStore::AssetStore()
    : AssetStore (juce::File::getSpecialLocation (juce::File::userHomeDirectory)
                      .getChildFile ("Library/Mosh/ReImagine/assets"))
{
}

AssetStore::AssetStore (juce::File rootDirectory) : storeRoot (std::move (rootDirectory))
{
    storeRoot.getChildFile ("sources").createDirectory();
    storeRoot.getChildFile ("renders").createDirectory();
}

juce::File AssetStore::sourceFile (const juce::String& hash) const
{
    return storeRoot.getChildFile ("sources").getChildFile (hash + ".wav");
}

juce::File AssetStore::renderFile (const juce::String& hash) const
{
    return storeRoot.getChildFile ("renders").getChildFile (hash + ".wav");
}

juce::String AssetStore::importWav (const juce::File& wav, bool source, juce::String& error) const
{
    if (! wav.existsAsFile())
    {
        error = "Audio asset does not exist";
        return {};
    }
    juce::FileInputStream stream (wav);
    if (! stream.openedOk())
    {
        error = "Could not read audio asset";
        return {};
    }
    const auto hash = juce::SHA256 (stream).toHexString();
    auto target = source ? sourceFile (hash) : renderFile (hash);
    if (! target.existsAsFile() && ! wav.copyFileTo (target))
    {
        error = "Could not store content-addressed audio";
        return {};
    }
    return hash;
}

bool AssetStore::verify (const juce::File& file, const juce::String& expected) const
{
    if (! file.existsAsFile())
        return false;
    juce::FileInputStream stream (file);
    return stream.openedOk() && juce::SHA256 (stream).toHexString() == expected;
}

bool AssetStore::selectedAssetsAvailable (const TransferRegion& region) const
{
    if (! verify (sourceFile (region.sourceHash), region.sourceHash))
        return false;
    const auto selected = std::find_if (region.takes.begin(), region.takes.end(), [&] (const auto& take)
    {
        return take.id == region.selectedTakeId;
    });
    return selected != region.takes.end()
        && verify (renderFile (selected->assetHash), selected->assetHash);
}

bool AssetStore::relink (const juce::File& wav, const juce::String& expected,
                         bool source, juce::String& error) const
{
    if (! verify (wav, expected))
    {
        error = "Relink refused: WAV hash does not match the missing asset";
        return false;
    }
    const auto destination = source ? sourceFile (expected) : renderFile (expected);
    if (destination.existsAsFile() || wav.copyFileTo (destination))
        return true;
    error = "Relink failed while copying the verified WAV";
    return false;
}

juce::File SharedServiceClient::stateDirectory()
{
    return juce::File::getSpecialLocation (juce::File::userHomeDirectory)
        .getChildFile ("Library/Application Support/Mosh/ReImagine");
}

SharedServiceClient::SharedServiceClient()
{
    const auto host = juce::SystemStats::getEnvironmentVariable ("MOSH_SERVICE_HOST", "127.0.0.1");
    const auto port = juce::SystemStats::getEnvironmentVariable ("MOSH_SERVICE_PORT", "8770");
    baseUrl = "http://" + host + ":" + port;
    adoptHandshake();
}

juce::var SharedServiceClient::get (const juce::String& path, int timeoutMs)
{
    auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                       .withConnectionTimeoutMs (timeoutMs);
    if (auto stream = juce::URL (baseUrl + path).createInputStream (options))
        return juce::JSON::parse (stream->readEntireStreamAsString());
    return {};
}

juce::var SharedServiceClient::post (const juce::String& path, const juce::var& body, int timeoutMs)
{
    auto url = juce::URL (baseUrl + path).withPOSTData (juce::JSON::toString (body));
    auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                       .withConnectionTimeoutMs (timeoutMs)
                       .withExtraHeaders ("Content-Type: application/json");
    if (auto stream = url.createInputStream (options))
        return juce::JSON::parse (stream->readEntireStreamAsString());
    return {};
}

void SharedServiceClient::adoptHandshake()
{
    auto portFile = stateDirectory().getChildFile ("service.port");
    const auto port = portFile.loadFileAsString().trim().getIntValue();
    if (port > 0)
        baseUrl = "http://" + juce::SystemStats::getEnvironmentVariable ("MOSH_SERVICE_HOST", "127.0.0.1")
                + ":" + juce::String (port);
}

juce::File SharedServiceClient::locateHelper() const
{
    if (auto explicitPath = juce::SystemStats::getEnvironmentVariable ("MOSH_SERVICE_SCRIPT", {});
        explicitPath.isNotEmpty())
        return juce::File (explicitPath);
    auto installed = stateDirectory().getChildFile ("service/server.py");
    if (installed.existsAsFile())
        return installed;
    auto development = juce::File::getCurrentWorkingDirectory().getChildFile ("service/server.py");
    return development.existsAsFile() ? development : juce::File();
}

bool SharedServiceClient::health (int timeoutMs)
{
    const auto response = get ("/health", timeoutMs);
    if (! static_cast<bool> (response.getProperty ("ok", false)))
        return false;
    protocolVersion = static_cast<int> (response.getProperty ("protocolVersion", 0));
    return compatible();
}

bool SharedServiceClient::ensureRunning (juce::String& error)
{
    adoptHandshake();
    if (health())
        return true;
    juce::InterProcessLock processLock ("studio.mosh.reimagine.shared-service");
    juce::InterProcessLock::ScopedLockType processLockScope (processLock);
    if (! processLockScope.isLocked())
    {
        error = "Timed out waiting for the shared Mosh helper start lock";
        return false;
    }
    adoptHandshake();
    if (health())
        return true;
    const auto helper = locateHelper();
    if (! helper.existsAsFile())
    {
        error = "Shared Mosh Re-Imagine helper is not installed";
        return false;
    }
    auto dir = stateDirectory();
    dir.createDirectory();
    auto portFile = dir.getChildFile ("service.port");
    setEnvironment ("MOSH_SERVICE_PORTFILE", portFile.getFullPathName());
    setEnvironment ("MOSH_SERVICE_PIDFILE", dir.getChildFile ("service.pid").getFullPathName());
    auto launcher = helper.getSiblingFile ("run-reimagine.sh");
    if (! launcher.existsAsFile())
        launcher = helper.getSiblingFile ("run.sh");
    const auto command = launcher.existsAsFile()
        ? juce::StringArray { "/bin/bash", launcher.getFullPathName() }
        : juce::StringArray { "/usr/bin/python3", helper.getFullPathName() };
    if (! spawnedHelper.start (command, 0))
    {
        error = "Could not start shared Mosh helper";
        return false;
    }
    for (int attempt = 0; attempt < 150; ++attempt)
    {
        if (! spawnedHelper.isRunning())
            break;
        juce::Thread::sleep (200);
        adoptHandshake();
        if (health())
            return true;
    }
    error = protocolVersion > 0 ? "Mosh helper protocol is too old" : "Mosh helper did not become healthy";
    return false;
}

juce::var SharedServiceClient::colors() { return get ("/colors"); }
juce::var SharedServiceClient::loras() { return get ("/loras"); }

juce::String SharedServiceClient::submit (const juce::File& input, const juce::File& output,
                                          const juce::File& manifest, const RackSettings& rack, bool lab,
                                          juce::String& error)
{
    auto* body = new juce::DynamicObject();
    body->setProperty ("adapter", "stable_audio3");
    body->setProperty ("inputWav", input.getFullPathName());
    body->setProperty ("outputWav", output.getFullPathName());
    body->setProperty ("manifest", manifest.getFullPathName());
    body->setProperty ("params", serviceParamsForRack (rack, lab));
    const auto response = post ("/submit", juce::var (body));
    if (! static_cast<bool> (response.getProperty ("ok", false)))
    {
        error = response.getProperty ("error", "Render submission failed").toString();
        return {};
    }
    return response.getProperty ("jobId", {}).toString();
}

juce::var SharedServiceClient::status (const juce::String& jobId)
{
    return get ("/status?jobId=" + juce::URL::addEscapeChars (jobId, true));
}

bool SharedServiceClient::cancel (const juce::String& jobId)
{
    auto* body = new juce::DynamicObject();
    body->setProperty ("jobId", jobId);
    return static_cast<bool> (post ("/cancel", juce::var (body)).getProperty ("ok", false));
}
}
