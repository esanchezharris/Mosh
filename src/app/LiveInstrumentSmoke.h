#pragma once

namespace mosh
{
class MoshEngine;
class MoshOps;

/** Developer-only physical instrument gate. Opens the already-selected real device,
    creates a MIDI note, optionally hot-swaps 4OSC to the named installed instrument,
    and requires live callback plus track/master level evidence. */
int runLiveInstrumentSmoke (MoshEngine&, MoshOps&);
}
