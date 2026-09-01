#include <catch2/catch_test_macros.hpp>

#include "webview/WebViewCursor.h"

TEST_CASE ("Editor cursor parser accepts only the packaged cursor contract", "[webview][cursor]")
{
    using mosh::EditorCursorKind;
    using mosh::parseEditorCursorKind;

    CHECK (parseEditorCursorKind ("default") == EditorCursorKind::defaultCursor);
    CHECK (parseEditorCursorKind ("crosshair") == EditorCursorKind::crosshair);
    CHECK (parseEditorCursorKind ("open-hand") == EditorCursorKind::openHand);
    CHECK (parseEditorCursorKind ("closed-hand") == EditorCursorKind::closedHand);
    CHECK (parseEditorCursorKind ("resize-left-right") == EditorCursorKind::resizeLeftRight);
    CHECK_FALSE (parseEditorCursorKind ("grab").has_value());
    CHECK_FALSE (parseEditorCursorKind ("").has_value());
}
