#pragma once

#include <juce_core/juce_core.h>

#include <functional>

namespace mosh::ownercheckpoint
{
using Writer = std::function<bool(const juce::File&)>;

#if MOSH_TESTING
struct SaveTestHooks
{
    std::function<bool(const juce::File&)> secureStagedFile;
};
#endif

/** Writes a replacement in an owner-only sibling directory, secures it, then
    atomically renames it over target. The existing target is left untouched on
    every pre-commit failure. */
bool savePrivateReplacement (
    const juce::File& target,
    const Writer& writer
   #if MOSH_TESTING
    , const SaveTestHooks* hooks = nullptr
   #endif
);
}
