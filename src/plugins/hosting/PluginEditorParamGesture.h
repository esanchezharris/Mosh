#pragma once

#include <cmath>
#include <optional>

namespace mosh
{

/** Coalesces native plugin-editor parameter notifications into undo-sized changes.
    A compliant plugin wraps a drag in begin/end; a plugin without gestures still
    emits one change for each distinct value notification. */
class PluginEditorParamGesture
{
public:
    struct Change
    {
        float before = 0.0f;
        float after = 0.0f;
    };

    explicit PluginEditorParamGesture (float initialValue) noexcept
        : lastValue (initialValue), gestureStart (initialValue) {}

    void begin() noexcept
    {
        gestureActive = true;
        gestureChanged = false;
        gestureStart = lastValue;
    }

    std::optional<Change> valueChanged (float newValue) noexcept
    {
        if (sameValue (lastValue, newValue))
            return std::nullopt;

        const auto before = lastValue;
        lastValue = newValue;
        if (gestureActive)
        {
            gestureChanged = true;
            return std::nullopt;
        }

        return Change { before, newValue };
    }

    std::optional<Change> end() noexcept
    {
        if (! gestureActive)
            return std::nullopt;

        gestureActive = false;
        if (! gestureChanged || sameValue (gestureStart, lastValue))
        {
            gestureChanged = false;
            return std::nullopt;
        }

        gestureChanged = false;
        return Change { gestureStart, lastValue };
    }

    std::optional<Change> finish() noexcept { return end(); }

    void cancel() noexcept
    {
        gestureStart = lastValue;
        gestureActive = false;
        gestureChanged = false;
    }

    void sync (float value) noexcept
    {
        lastValue = value;
        gestureStart = value;
        gestureActive = false;
        gestureChanged = false;
    }

private:
    static bool sameValue (float a, float b) noexcept
    {
        return std::abs (a - b) <= 1.0e-7f;
    }

    float lastValue = 0.0f;
    float gestureStart = 0.0f;
    bool gestureActive = false;
    bool gestureChanged = false;
};

} // namespace mosh
