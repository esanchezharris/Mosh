#pragma once

#include <juce_core/juce_core.h>
#include <functional>

namespace mosh
{
class MoshEngine;
class MoshOps;

struct VocalPresetSelfTestCallbacks
{
    std::function<void (const juce::String&)> section;
    std::function<void (bool, const juce::String&)> check;
    /** A per-process-unique temp path (SelfTest.cpp's selftestTempPath). */
    std::function<juce::File (const juce::String&)> tempPath;
};

/** Track-chain presets ("Mosh Clean Lead v0"): the pinned processor table against the
    live engine, the measured DSP behaviour of the chain, and apply_track_preset's
    transaction, ownership, failure and persistence contracts.

    Starts with new_project, so it must run LAST in the deterministic core run. */
void runVocalPresetSelfTest (MoshEngine&, MoshOps&, const VocalPresetSelfTestCallbacks&);
}
