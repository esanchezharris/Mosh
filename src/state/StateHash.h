#pragma once

#include <tracktion_engine/tracktion_engine.h>

namespace mosh
{
namespace te = tracktion::engine;

/** Canonical state projection + hash (phase0 §4, hard requirement 2).

    `stateHash(edit)` walks the engine directly and serializes a CANONICAL
    projection of the musical state: fixed key order, floats at 6 decimals,
    EditItemIDs replaced by structural ordinals (track index / clip index /
    plugin index), file references reduced to basenames, and nothing
    machine- or time-dependent (no wall-clock, no absolute paths, no device
    sample rate, no cache keys). Identical (state, ops, seed) must yield an
    identical hash on every machine — this is conformance test #1, the
    multiplayer merge check (Stage 10), and verifier L1, all in one.

    Covered: tempo/time-sig/key/sections; per track: name, mute/solo,
    volume/pan, output routing (track ordinal), plugin chain (type, enabled,
    parameter values — ALL params for builtins, first 128 for externals — and
    automation curve points); per clip: type, name, start/length/offset,
    source basename, pitch/speed, MIDI notes (sorted), RenderLayer musical
    identity (mode/variant/seed/prompt/colors/status-if-kept).

    Known cap (documented, revisit if it bites): external plugins hash their
    first 128 automatable parameters, not their opaque state blob — blobs are
    plugin-version-fragile and may contain nondeterministic bytes. */
juce::String stateHash (te::Edit& edit);

/** The canonical projection text itself (what gets hashed) — exposed for
    debugging hash mismatches: diff two projections, not two digests. */
juce::String stateProjection (te::Edit& edit);

} // namespace mosh
