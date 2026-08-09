#include "AudioRefValidation.h"

namespace mosh::audioref
{
namespace
{
ValidationResult validateRef (const juce::var& ref)
{
    if (! ref.isObject())
        return { Error::objectRequired };

    const auto hashValue = ref.getProperty ("hash", juce::var());
    const auto extValue = ref.getProperty ("ext", juce::var());
    if (! hashValue.isString() || ! extValue.isString())
        return { Error::stringFieldsRequired };

    const auto hash = hashValue.toString();
    if (hash.length() != 64 || ! hash.containsOnly ("0123456789abcdefABCDEF"))
        return { Error::invalidHash };

    const auto ext = extValue.toString();
    if (ext.isEmpty() || ext.length() > 16
        || ! ext.containsOnly ("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"))
        return { Error::invalidExtension };

    return {};
}
}

ValidationResult validate (const juce::var& audioRefs)
{
    if (audioRefs.isVoid())
        return {};

    const auto* refs = audioRefs.getArray();
    if (refs == nullptr)
        return { Error::arrayRequired };

    for (const auto& ref : *refs)
        if (const auto result = validateRef (ref); ! result.ok())
            return result;

    return {};
}

DestinationResult resolveContainedDestination (const juce::File& byHashDir,
                                               const juce::var& audioRef)
{
    if (const auto result = validateRef (audioRef); ! result.ok())
        return { result.error, {} };

    const auto hash = audioRef.getProperty ("hash", juce::var()).toString();
    const auto ext = audioRef.getProperty ("ext", juce::var()).toString();
    const auto destination = byHashDir.getChildFile (hash + "." + ext);
    if (! destination.isAChildOf (byHashDir) || destination.getParentDirectory() != byHashDir)
        return { Error::destinationOutsideRoot, {} };

    return { Error::none, destination };
}
}
