#pragma once

#include <juce_core/juce_core.h>

// G7 — per-track stem export, common zero point (docs/superpowers/specs/
// 2026-07-10-g7-stem-export-per-track-common-zero-point.md).
//
// This header holds ONLY the pure, engine-free naming primitive so it can be
// exercised directly in the Catch2 suite (tests/test_stem_export.cpp) without
// dragging in tracktion_engine (MoshOps.cpp's real render loop needs a live
// te::Edit and is covered instead by --selftest / verify.py — see the spec).

namespace mosh
{
    // The on-disk base name (no extension) for one stem file: a zero-padded
    // snapshot-order index + the track's filesystem-sanitized name, e.g. index 3
    // named "Lead Vocal" -> "03-Lead Vocal". The index is what guarantees
    // uniqueness — two tracks may share a display name, but never an index —
    // so this never collides even when createLegalFileName maps two different
    // names onto the same sanitized string.
    inline juce::String stemFileBaseName (int index, const juce::String& trackName)
    {
        return juce::String (index).paddedLeft ('0', 2) + "-" + juce::File::createLegalFileName (trackName);
    }
}
