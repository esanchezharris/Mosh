#pragma once
#include "DslExecutor.h"
#include "MoshEngine.h"

namespace mosh
{
    // Registers the Tracktion-bound command handlers into the executor (01 calls
    // wrapped by 02's transaction/validation/events/log machinery). The executor's
    // UndoManager IS edit.getUndoManager(), so each command is one undo step.
    //
    // Stage 1: create_track, import_clip, set_transport, set_tempo, rename_track,
    // set_track_gain/mute/solo, delete_track. Stage 2 adds move/trim/split_clip
    // (included here, exercised by the arrangement UI).
    void registerEngineHandlers (DslExecutor&, MoshEngine&);
}
