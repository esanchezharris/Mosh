#pragma once

#include <juce_core/juce_core.h>

namespace mosh::recovery
{
/** Rebind ids anywhere inside a journal argument tree. Multi-target commands such
    as create_clip_group carry clipIds in an array, so top-level strings alone are
    insufficient after earlier replayed commands mint replacement ids. */
inline juce::var substituteIds (
    const juce::var& value,
    const juce::HashMap<juce::String, juce::String>& idMap)
{
    if (value.isString())
    {
        const auto text = value.toString();
        return idMap.contains (text) ? juce::var (idMap[text]) : value;
    }
    if (const auto* values = value.getArray())
    {
        juce::Array<juce::var> out;
        out.ensureStorageAllocated (values->size());
        for (const auto& item : *values)
            out.add (substituteIds (item, idMap));
        return juce::var (out);
    }
    if (const auto* object = value.getDynamicObject())
    {
        auto* out = new juce::DynamicObject();
        for (const auto& property : object->getProperties())
            out->setProperty (property.name, substituteIds (property.value, idMap));
        return juce::var (out);
    }
    return value;
}
}
