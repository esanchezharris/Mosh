#pragma once

#include "VocalPresetSelfTest.h"

namespace mosh
{
/** "Mosh Tuned Lead v0": Mosh AutoTune as a track-chain preset stage. Checks that the
    pinned AutoTune row in TrackPreset.h matches the plugin this build links, and that
    the bundled preset applies as AutoTune -> high-pass -> compressor in one undo step.

    Runs straight after runVocalPresetSelfTest, in the clean project that leaves, so it
    is still LAST in the deterministic core run. Proves the wiring; it is not a
    listening test. */
void runTunedLeadPresetSelfTest (MoshEngine&, MoshOps&, const VocalPresetSelfTestCallbacks&);
}
