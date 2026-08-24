#pragma once

#include "ReImagineCore.h"

#include <juce_core/juce_core.h>
#include <juce_cryptography/juce_cryptography.h>

namespace mosh::reimagine
{
juce::var serviceParamsForRack (const RackSettings&, bool lab);

struct LoraCatalogItem
{
    juce::String id;
    juce::String displayName;
    juce::String trigger;
    juce::String hint;
    juce::String notes;
    bool isLab = false;
};

enum class LoraCatalogStatus
{
    idle,
    loading,
    ready,
    error
};

struct LoraCatalogSnapshot
{
    LoraCatalogStatus status = LoraCatalogStatus::idle;
    std::vector<LoraCatalogItem> items;
    juce::String error;
    uint64_t revision = 0;
};

std::vector<LoraCatalogItem> loraCatalogFromResponse (const juce::var&);

class AssetStore
{
public:
    AssetStore();
    explicit AssetStore (juce::File rootDirectory);

    juce::File sourceFile (const juce::String& sha256) const;
    juce::File renderFile (const juce::String& sha256) const;
    juce::String importWav (const juce::File& wav, bool source, juce::String& error) const;
    bool relink (const juce::File& wav, const juce::String& expectedSha256,
                 bool source, juce::String& error) const;
    bool verify (const juce::File&, const juce::String& expectedSha256) const;
    bool selectedAssetsAvailable (const TransferRegion&) const;
    const juce::File& root() const noexcept { return storeRoot; }

private:
    juce::File storeRoot;
};

class SharedServiceClient
{
public:
    SharedServiceClient();

    bool ensureRunning (juce::String& error);
    bool health (int timeoutMs = 1000);
    bool compatible() const noexcept { return protocolVersion >= kServiceProtocolVersion; }
    int discoveredProtocolVersion() const noexcept { return protocolVersion; }
    juce::var colors();
    juce::var loras();
    juce::String submit (const juce::File& input, const juce::File& output,
                         const juce::File& manifest, const RackSettings&, bool lab,
                         juce::String& error);
    juce::var status (const juce::String& jobId);
    bool cancel (const juce::String& jobId);

private:
    juce::var get (const juce::String&, int timeoutMs = 3000);
    juce::var post (const juce::String&, const juce::var&, int timeoutMs = 10000);
    void adoptHandshake();
    juce::File locateHelper() const;
    static juce::File stateDirectory();

    juce::String baseUrl;
    juce::ChildProcess spawnedHelper;
    int protocolVersion = 0;
};
}
