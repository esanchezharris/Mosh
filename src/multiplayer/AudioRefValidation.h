#pragma once

#include <juce_core/juce_core.h>

namespace mosh::audioref
{
enum class Error
{
    none,
    arrayRequired,
    objectRequired,
    stringFieldsRequired,
    invalidHash,
    invalidExtension,
    destinationOutsideRoot
};

struct ValidationResult
{
    Error error = Error::none;
    bool ok() const { return error == Error::none; }
};

struct DestinationResult
{
    Error error = Error::none;
    juce::File destination;
    bool ok() const { return error == Error::none; }
};

/** Validates an untrusted wire audioRefs value without scalar coercion. Void is
    the legacy absent value and is accepted. Any malformed array member rejects
    the aggregate. */
ValidationResult validate (const juce::var& audioRefs);

/** Revalidates one raw wire ref and returns only a direct child of byHashDir. */
DestinationResult resolveContainedDestination (const juce::File& byHashDir,
                                               const juce::var& audioRef);
}
