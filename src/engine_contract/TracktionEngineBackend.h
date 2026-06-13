#pragma once

#include "engine_contract/MoshEngineBackend.h"
#include "engine/MoshEngine.h"

namespace mosh
{

class TracktionEngineBackend final : public MoshEngineBackend
{
public:
    TracktionEngineBackend (MoshEngine& engineToUse, EngineBackendContext contextToUse);

    juce::String backendId() const override;
    juce::String displayName() const override;
    juce::var capabilities() const override;
    juce::var diagnostics() const override;

private:
    MoshEngine& engine;
};

} // namespace mosh

