#pragma once

#include "VocalPresetSelfTest.h"

namespace mosh
{
/** The V3 Start page's recipe (ui/src/v3/StartPage.tsx, vocalSetup.ts, beatImport.ts),
    driven through MoshOps::execute with the same JSON the UI sends:

      START-FLOW      new_project {template:"vocal"} -> a beat on Backing at 0 -> detect
                      the BPM -> set the tempo and loop -> loop_setup on Vocal -> Clean Lead
                      on Lead and Takes -> the Clean->Tuned switch as ONE undo step, and the
                      import_clip fallback the UI guards against.
      START-RELAUNCH  a project carrying Tuned Lead on both lanes, saved and opened by a
                      cold engine with no MoshOps, keeps exactly one real Mosh AutoTune
                      per lane.

    Starts with new_project, so it runs straight after the preset sections, which already
    own the tail of the deterministic core run. Proves the wiring, not the sound: no
    listening, and arming is checked only with an audio device. */
void runStartFlowSelfTest (MoshEngine&, MoshOps&, const VocalPresetSelfTestCallbacks&);
}
