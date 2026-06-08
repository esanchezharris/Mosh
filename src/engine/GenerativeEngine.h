#pragma once
#include "DslExecutor.h"
#include "MoshEngine.h"
#include "GenerativeJobManager.h"
#include "Generative.h"

// ──────────────────────────────────────────────────────────────────────────────
// Engine-bound Tier-B commands (05) — the generative render flow integrated with
// the Tracktion Edit. RenderLayers live as MOSH_RENDERLAYER children UNDER the
// source clip (so they travel with it and serialize for free). Renders go through
// the out-of-process job service (TIER WALL: Tier B is a job, never an insert);
// accept_render lands the result NON-DESTRUCTIVELY as a new clip on a "Neural" lane
// — the source clip is untouched (the documented landing; the take-based landing is
// the alternative per `neural_render_landing`, docs §9).
//
// This pairs the proven spine GenerativeCommands with real Tracktion clips/tracks +
// the real service, all wrapped by MoshOps transactions (one undo step per command).
// ──────────────────────────────────────────────────────────────────────────────
namespace mosh
{
    void registerGenerativeEngineCommands (DslExecutor&, MoshEngine&,
                                           GenerativeJobManager&, RenderCache&);
}
