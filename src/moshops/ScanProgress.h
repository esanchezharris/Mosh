// FIT-003 — plugin-scan progress event payload. Header-only, juce_core/
// juce_data_structures only (no tracktion, no engine), so tests/test_plugin_scan_progress.cpp
// runs it hermetically, exactly like DrumPattern.h.
//
// Shared by MoshOps.cpp (real emits) and the Catch2 test (payload-shape assertions),
// so there is exactly one place that defines the 'plugin_scan_progress' event shape:
//   { format: string, done: bool, count: int, elapsedMs: int,
//     quarantined: string[] }
// `count` is the running KnownPluginList size (a lower bound / running count, NOT a
// determinate "X of N" — the total plugin count isn't knowable without duplicating
// PluginHost's enumeration; see docs/superpowers/specs/2026-07-10-fit-003-*.md §6).
#pragma once

#include <juce_core/juce_core.h>
#include <juce_data_structures/juce_data_structures.h>

namespace mosh
{

inline juce::var makeScanProgressPayload (const juce::String& format, int count,
                                           bool done, int elapsedMs,
                                           juce::StringArray quarantined = {})
{
    auto* o = new juce::DynamicObject();
    o->setProperty ("format",    format);
    o->setProperty ("done",      done);
    o->setProperty ("count",     count);
    o->setProperty ("elapsedMs", elapsedMs);
    juce::Array<juce::var> quarantinedValues;
    for (const auto& name : quarantined)
        quarantinedValues.add (name);
    o->setProperty ("quarantined", juce::var (quarantinedValues));
    return juce::var (o);
}

inline juce::StringArray newlyQuarantinedPluginNames (const juce::StringArray& before,
                                                       const juce::StringArray& after)
{
    juce::StringArray names;
    for (const auto& id : after)
    {
        if (before.contains (id))
            continue;
        names.add (juce::File::isAbsolutePath (id) ? juce::File (id).getFileName() : id);
    }
    return names;
}

} // namespace mosh
