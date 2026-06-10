#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh::ir
{
namespace te = tracktion::engine;

/** lift(): native MoshOps command → MoshIR op(s), for the op logger
    (phase0 §5 telemetry hook: "the client logs every human action as MoshIR").

    Returns an ARRAY var of 0..2 IR ops. Empty array = no IR equivalent (the
    native command + args are always kept alongside in the trajectory step, so
    nothing is lost — the IR is the training-corpus view, the native record is
    the exact-replay view).

    Fidelity notes (documented, graded by the verifier later):
    - Engine ids are synthesized into symbolic ids ("t1010", "c1014") — stable
      within a session, never engine-coupled in the corpus.
    - clip.move/clip.create positions round to the nearest bar (IR is
      tutorial-step granular; UI drags are continuous). Exact replay uses the
      native record.
    - import_clip lifts to asset.resolve (descriptor = filename) + sample.place,
      mirroring how a tutorial would express it.
    - mute/solo and the RenderLayer flow have no IR family in v0.1 — lifted as
      empty; logged as IR v0.2 candidates in the gap ledger review. */
juce::var lift (const juce::String& command, const juce::var& args,
                const juce::var& result, te::Edit& edit);

} // namespace mosh::ir
