#include <catch2/catch_test_macros.hpp>
#include "webview/UiResourcePathGuard.h"
#include <unistd.h>

TEST_CASE ("WebBridge resource paths allow bundle-local assets", "[webbridge]")
{
    auto root = juce::File::getSpecialLocation (juce::File::tempDirectory)
                    .getNonexistentChildFile ("mosh-webbridge-safe", {});
    root.createDirectory();
    root.getChildFile ("index.html").replaceWithText ("ok");
    root.getChildFile ("assets").createDirectory();
    root.getChildFile ("assets/app.js").replaceWithText ("ok");

    REQUIRE (mosh::ui_resource_guard::isSafePath (root, "/"));
    REQUIRE (mosh::ui_resource_guard::isSafePath (root, "/index.html"));
    REQUIRE (mosh::ui_resource_guard::isSafePath (root, "/assets/app.js?cache=1#main"));
    REQUIRE (mosh::ui_resource_guard::normalisePath ("/assets/app.js?cache=1#main").value_or (juce::String()) == "assets/app.js");

    root.deleteRecursively();
}

TEST_CASE ("WebBridge resource paths reject traversal and absolute escapes", "[webbridge]")
{
    auto parent = juce::File::getSpecialLocation (juce::File::tempDirectory)
                      .getNonexistentChildFile ("mosh-webbridge-block", {});
    auto root = parent.getChildFile ("ui");
    auto outside = parent.getChildFile ("outside");
    root.createDirectory();
    outside.createDirectory();
    outside.getChildFile ("secret.txt").replaceWithText ("no");
    root.getChildFile ("index.html").replaceWithText ("ok");
    ::symlink (outside.getFullPathName().toRawUTF8(), root.getChildFile ("escape").getFullPathName().toRawUTF8());

    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "/../outside/secret.txt"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "/%2e%2e/outside/secret.txt"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "file:///etc/passwd"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "//etc/passwd"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "C:/Windows/win.ini"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "/assets\\secret.txt"));
    REQUIRE_FALSE (mosh::ui_resource_guard::isSafePath (root, "/escape/secret.txt"));

    parent.deleteRecursively();
}
