#pragma once

#include <juce_core/juce_core.h>

#include <optional>

namespace mosh
{
enum class EditorCursorKind
{
    defaultCursor,
    crosshair,
    openHand,
    closedHand,
    resizeLeftRight,
};

inline std::optional<EditorCursorKind> parseEditorCursorKind (const juce::String& value)
{
    if (value == "default") return EditorCursorKind::defaultCursor;
    if (value == "crosshair") return EditorCursorKind::crosshair;
    if (value == "open-hand") return EditorCursorKind::openHand;
    if (value == "closed-hand") return EditorCursorKind::closedHand;
    if (value == "resize-left-right") return EditorCursorKind::resizeLeftRight;
    return std::nullopt;
}

inline bool editorCursorNeedsNativeRefresh (EditorCursorKind kind)
{
    return kind != EditorCursorKind::defaultCursor;
}

#if JUCE_MAC
void setMacEditorCursor (EditorCursorKind kind);
#endif
}
